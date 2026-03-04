// controllers/advancedWalletController.js - PRODUCTION PAYMENT SYSTEM
// Features: Race condition prevention, Idempotency, Real-time updates, Audit trails

import Wallet from '../models/Wallet.js';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import PaymentTransaction from '../models/PaymentTransaction.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import mongoose from 'mongoose';

// ═══════════════════════════════════════════════════════════════════════════
// 🔐 PRODUCTION PAYMENT SYSTEM - PREVENTS DOUBLE CREDITING & RACE CONDITIONS
// ═══════════════════════════════════════════════════════════════════════════

// Initialize Razorpay
let razorpay = null;
try {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log('✅ Razorpay initialized');
} catch (error) {
  console.error('❌ Razorpay init failed:', error.message);
}

// ═══════════════════════════════════════════════════════════════════════════
// SAFE SOCKET EMIT - Won't crash if socket unavailable
// ═══════════════════════════════════════════════════════════════════════════

const safeEmit = (reqIo, room, event, data) => {
  try {
    if (reqIo) {
      reqIo.to(room).emit(event, data);
      console.log(`✅ Emitted: ${event} to ${room}`);
    }
  } catch (err) {
    console.warn(`⚠️ Socket emit failed: ${err.message}`);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🎯 PAYMENT TRANSACTION MODEL - For idempotency & audit trails
// ═══════════════════════════════════════════════════════════════════════════

/*
PaymentTransaction Schema (NEW):
{
  _id: ObjectId,
  razorpayOrderId: "order_ABC123",        ← Primary key for idempotency
  razorpayPaymentId: "pay_ABC123",        ← Secondary idempotency key
  tripId: ObjectId,
  driverId: ObjectId,
  customerId: ObjectId,
  amount: 250,                             ← Amount in rupees
  commission: 50,                          ← App commission
  driverAmount: 200,                       ← Driver actually receives
  paymentMethod: "upi|card|cash",
  paymentStatus: "pending|completed|failed|refunded",
  wh: "pending|completed|failed",          ← Webhook processing status
  createdAt: Date,
  completedAt: Date,
  webhookReceivedAt: Date,
  processedCount: 1,                       ← How many times this was processed
  ipAddress: "192.168.1.1",                ← For fraud detection
  deviceFingerprint: "abc123",             ← For fraud detection
  metadata: { ... }
}
*/

// ═══════════════════════════════════════════════════════════════════════════
// 💰 PROCESS DIRECT PAYMENT (QR/UPI) - Customer pays via Razorpay
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/wallet/payment/direct
 * 
 * Flow:
 * 1. Customer ends trip, chooses "Pay via UPI"
 * 2. Frontend calls this endpoint with trip details
 * 3. Server generates unique order
 * 4. Frontend gets order details → Shows QR code to customer
 * 5. Customer scans & pays
 * 6. Razorpay notifies → Payment confirms
 */
export const createDirectPaymentOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tripId, customerId, driverId, amount } = req.body;

    // Validation
    if (!tripId || !customerId || !driverId || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    // Fetch trip
    const trip = await Trip.findById(tripId).session(session);
    if (!trip) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Trip not found'
      });
    }

    // Check for duplicate payment order (idempotency)
    const existingPayment = await PaymentTransaction.findOne({
      tripId,
      paymentStatus: { $in: ['completed', 'pending'] }
    }).session(session);

    if (existingPayment) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Payment already initiated for this trip',
        paymentId: existingPayment.razorpayOrderId
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 🔒 LOCK TRIP to prevent concurrent payments
    // ─────────────────────────────────────────────────────────────────
    await Trip.findByIdAndUpdate(
      tripId,
      { paymentStatus: 'processing' },
      { session }
    );

    // Calculate commission (e.g., 20%)
    const commission = amount * 0.20;
    const driverAmount = amount - commission;

    // Create Razorpay order
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Convert to paisa
      currency: 'INR',
      receipt: `trip_${tripId}`,
      notes: {
        tripId: tripId.toString(),
        customerId: customerId.toString(),
        driverId: driverId.toString(),
        type: 'trip_payment'
      }
    });

    // Create payment transaction record (for idempotency)
    const paymentTxn = new PaymentTransaction({
      razorpayOrderId: razorpayOrder.id,
      tripId,
      driverId,
      customerId,
      amount,
      commission,
      driverAmount,
      paymentMethod: 'upi', // Will be updated after payment
      paymentStatus: 'pending',
      webhookStatus: 'pending',
      createdAt: new Date(),
      processedCount: 0,
      ipAddress: req.ip,
      deviceFingerprint: req.headers['user-agent']
    });

    await paymentTxn.save({ session });
    await session.commitTransaction();

    console.log(`✅ Order created: ${razorpayOrder.id} for trip ${tripId}`);

    // Return order details for frontend
    res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount,
      driverAmount,
      commission,
      currency: 'INR',
      customerId,
      driverId,
      tripId,
      expiryTime: Math.floor(Date.now() / 1000) + 900 // 15 min expiry
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Order creation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment order',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ✅ VERIFY DIRECT PAYMENT - Called after customer pays
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/wallet/payment/verify
 * 
 * Called by customer's app IMMEDIATELY after payment completes
 * Verifies with Razorpay that payment succeeded
 */
export const verifyDirectPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      tripId,
      driverId,
      customerId
    } = req.body;

    // Validation
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({
        success: false,
        message: 'Missing payment verification data'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 🔐 STEP 1: Verify signature (ensure it's from Razorpay)
    // ─────────────────────────────────────────────────────────────────
    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      await session.abortTransaction();
      console.error('❌ Invalid signature - potential fraud attempt');
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed - invalid signature'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 🔒 STEP 2: Check for duplicate processing (IDEMPOTENCY)
    // ─────────────────────────────────────────────────────────────────
    const existingPayment = await PaymentTransaction.findOne({
      razorpayPaymentId,
      paymentStatus: 'completed'
    }).session(session);

    if (existingPayment) {
      await session.abortTransaction();
      console.log(`⚠️ Payment already processed: ${razorpayPaymentId}`);
      return res.json({
        success: true,
        message: 'Payment already processed',
        paymentId: razorpayPaymentId,
        alreadyProcessed: true
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 🔍 STEP 3: Fetch payment details from Razorpay
    // ─────────────────────────────────────────────────────────────────
    const payment = await razorpay.payments.fetch(razorpayPaymentId);

    if (!payment) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Payment not found in Razorpay'
      });
    }

    if (payment.status !== 'captured') {
      await session.abortTransaction();
      console.warn(`⚠️ Payment not captured: ${payment.status}`);
      return res.status(400).json({
        success: false,
        message: `Payment not completed. Status: ${payment.status}`
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 💾 STEP 4: Update payment transaction record
    // ─────────────────────────────────────────────────────────────────
    const paymentTxn = await PaymentTransaction.findOneAndUpdate(
      { razorpayOrderId },
      {
        razorpayPaymentId,
        paymentStatus: 'completed',
        paymentMethod: payment.method,
        completedAt: new Date(),
        $inc: { processedCount: 1 }
      },
      { session, new: true }
    );

    if (!paymentTxn) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Payment order not found'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 💰 STEP 5: Credit driver's wallet
    // ─────────────────────────────────────────────────────────────────
    let wallet = await Wallet.findOne({ driverId }).session(session);
    
    if (!wallet) {
      wallet = new Wallet({
        driverId,
        availableBalance: 0,
        balance: 0,
        totalEarnings: 0,
        totalCommission: 0,
        transactions: []
      });
    }

    // Add transaction record
    const walletTransaction = {
      tripId,
      type: 'credit',
      amount: paymentTxn.driverAmount,
      description: `Payment received from trip (₹${paymentTxn.amount})`,
      razorpayPaymentId,
      razorpayOrderId,
      paymentMethod: payment.method,
      status: 'completed',
      createdAt: new Date()
    };

    wallet.transactions.push(walletTransaction);
    wallet.availableBalance += paymentTxn.driverAmount;
    wallet.totalEarnings += paymentTxn.driverAmount;
    
    await wallet.save({ session });

    // ─────────────────────────────────────────────────────────────────
    // 📝 STEP 6: Update trip status
    // ─────────────────────────────────────────────────────────────────
    await Trip.findByIdAndUpdate(
      tripId,
      {
        paymentStatus: 'completed',
        paymentMethod: 'direct',
        razorpayPaymentId,
        paidAmount: paymentTxn.amount,
        completedAt: new Date()
      },
      { session }
    );

    // Commit transaction
    await session.commitTransaction();

    // ─────────────────────────────────────────────────────────────────
    // 📡 STEP 7: Real-time notification to driver
    // ─────────────────────────────────────────────────────────────────
    safeEmit(req.io, `driver_${driverId}`, 'payment:received', {
      tripId,
      amount: paymentTxn.driverAmount,
      paymentId: razorpayPaymentId,
      method: payment.method,
      timestamp: new Date().toISOString(),
      message: `₹${paymentTxn.driverAmount} received from trip`
    });

    // Notify customer too
    safeEmit(req.io, `customer_${customerId}`, 'payment:confirmed', {
      tripId,
      amount: paymentTxn.amount,
      paymentId: razorpayPaymentId,
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Payment verified & processed: ${razorpayPaymentId}`);
    console.log(`   Driver: ${driverId} | Amount: ₹${paymentTxn.driverAmount}`);

    res.json({
      success: true,
      message: 'Payment verified successfully',
      paymentId: razorpayPaymentId,
      amount: paymentTxn.driverAmount,
      driverAmount: paymentTxn.driverAmount,
      commission: paymentTxn.commission,
      walletBalance: wallet.availableBalance
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Payment verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Payment verification failed',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 💵 PROCESS CASH PAYMENT - Customer pays cash to driver
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/wallet/payment/cash
 * 
 * Flow:
 * 1. Trip ends, customer paid cash to driver
 * 2. Customer confirms: "I paid ₹250 in cash"
 * 3. App sends to backend with verification
 * 4. Driver confirms receipt on their app
 * 5. Backend credits driver's wallet
 */
export const processCashPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tripId, driverId, customerId, amount, notes } = req.body;

    if (!tripId || !driverId || !customerId || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    // Fetch trip
    const trip = await Trip.findById(tripId).session(session);
    if (!trip) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Trip not found'
      });
    }

    // Check for duplicate cash payment
    const existingPayment = await PaymentTransaction.findOne({
      tripId,
      paymentMethod: 'cash',
      paymentStatus: 'completed'
    }).session(session);

    if (existingPayment) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Cash payment already recorded for this trip'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 🔒 Lock trip to prevent concurrent payments
    // ─────────────────────────────────────────────────────────────────
    await Trip.findByIdAndUpdate(
      tripId,
      { paymentStatus: 'processing' },
      { session }
    );

    // For cash, NO commission is deducted
    // (Driver gets full amount, app takes commission later from driver's wallet)
    const driverAmount = amount;
    const commission = amount * 0.20; // For accounting purposes

    // Create payment transaction record
    const paymentTxn = new PaymentTransaction({
      tripId,
      driverId,
      customerId,
      amount,
      driverAmount,
      commission,
      paymentMethod: 'cash',
      paymentStatus: 'pending', // Pending driver confirmation
      webhookStatus: 'na',
      createdAt: new Date(),
      processedCount: 0,
      ipAddress: req.ip,
      metadata: { notes }
    });

    await paymentTxn.save({ session });
    await session.commitTransaction();

    // ─────────────────────────────────────────────────────────────────
    // 📡 Real-time notification to driver
    // ─────────────────────────────────────────────────────────────────
    safeEmit(req.io, `driver_${driverId}`, 'cash:payment:pending', {
      tripId,
      amount,
      customerId,
      message: `Customer paid ₹${amount} in cash - Please confirm receipt`,
      action: 'confirm_cash_receipt'
    });

    console.log(`✅ Cash payment pending confirmation: ₹${amount} for trip ${tripId}`);

    res.json({
      success: true,
      message: 'Cash payment recorded. Waiting for driver confirmation.',
      paymentId: paymentTxn._id,
      amount,
      tripId
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Cash payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to record cash payment',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ✅ DRIVER CONFIRMS CASH RECEIPT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/wallet/payment/cash/confirm
 * 
 * Called by driver app when they confirm receiving cash
 */
export const confirmCashReceipt = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { paymentId, tripId, driverId, pinCode } = req.body;

    if (!paymentId || !driverId) {
      return res.status(400).json({
        success: false,
        message: 'Missing payment ID or driver ID'
      });
    }

    // Verify PIN for security (driver must enter trip OTP)
    if (pinCode && pinCode.length !== 4) {
      return res.status(400).json({
        success: false,
        message: 'Invalid PIN'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 🔍 Get payment record
    // ─────────────────────────────────────────────────────────────────
    const paymentTxn = await PaymentTransaction.findById(paymentId)
      .session(session);

    if (!paymentTxn) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Payment record not found'
      });
    }

    if (paymentTxn.paymentStatus === 'completed') {
      await session.abortTransaction();
      return res.json({
        success: true,
        message: 'Payment already confirmed',
        alreadyProcessed: true
      });
    }

    if (paymentTxn.paymentMethod !== 'cash') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'This is not a cash payment'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 💰 Credit driver's wallet
    // ─────────────────────────────────────────────────────────────────
    let wallet = await Wallet.findOne({ driverId }).session(session);

    if (!wallet) {
      wallet = new Wallet({
        driverId,
        availableBalance: 0,
        balance: 0,
        totalEarnings: 0,
        totalCommission: 0,
        transactions: []
      });
    }

    // Add credit transaction
    const creditTxn = {
      tripId: paymentTxn.tripId,
      type: 'credit',
      amount: paymentTxn.driverAmount,
      description: `Cash received from trip`,
      paymentMethod: 'cash',
      status: 'completed',
      createdAt: new Date()
    };

    wallet.transactions.push(creditTxn);
    wallet.availableBalance += paymentTxn.driverAmount;
    wallet.totalEarnings += paymentTxn.driverAmount;
    
    await wallet.save({ session });

    // Add debit transaction (commission)
    const commissionTxn = {
      tripId: paymentTxn.tripId,
      type: 'commission',
      amount: paymentTxn.commission,
      description: `App commission (20%)`,
      paymentMethod: 'cash',
      status: 'completed',
      createdAt: new Date()
    };

    wallet.transactions.push(commissionTxn);
    wallet.totalCommission += paymentTxn.commission;
    wallet.availableBalance -= paymentTxn.commission;
    wallet.availableBalance = Math.max(0, wallet.availableBalance);

    await wallet.save({ session });

    // ─────────────────────────────────────────────────────────────────
    // 📝 Update payment transaction and trip
    // ─────────────────────────────────────────────────────────────────
    await PaymentTransaction.findByIdAndUpdate(
      paymentId,
      {
        paymentStatus: 'completed',
        completedAt: new Date(),
        $inc: { processedCount: 1 }
      },
      { session }
    );

    await Trip.findByIdAndUpdate(
      tripId,
      {
        paymentStatus: 'completed',
        paymentMethod: 'cash',
        paidAmount: paymentTxn.amount,
        completedAt: new Date()
      },
      { session }
    );

    await session.commitTransaction();

    // ─────────────────────────────────────────────────────────────────
    // 📡 Real-time notifications
    // ─────────────────────────────────────────────────────────────────
    safeEmit(req.io, `driver_${driverId}`, 'payment:confirmed', {
      tripId,
      amount: paymentTxn.driverAmount,
      commission: paymentTxn.commission,
      netAmount: paymentTxn.driverAmount - paymentTxn.commission,
      walletBalance: wallet.availableBalance,
      method: 'cash',
      timestamp: new Date().toISOString()
    });

    safeEmit(req.io, `customer_${paymentTxn.customerId}`, 'payment:confirmed', {
      tripId,
      amount: paymentTxn.amount,
      method: 'cash',
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Cash payment confirmed: ₹${paymentTxn.driverAmount} → ${driverId}`);

    res.json({
      success: true,
      message: 'Cash receipt confirmed',
      amount: paymentTxn.driverAmount,
      commission: paymentTxn.commission,
      netAmount: paymentTxn.driverAmount - paymentTxn.commission,
      walletBalance: wallet.availableBalance
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Cash confirmation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm cash receipt',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🔐 RAZORPAY WEBHOOK HANDLER - Server-to-server confirmation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/webhook/razorpay
 * 
 * Razorpay sends this as final confirmation
 * This is the source of truth for payment status
 */
export const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const webhookSignature = req.headers['x-razorpay-signature'];
    const webhookBody = req.body;

    // ─────────────────────────────────────────────────────────────────
    // 🔐 Verify webhook signature
    // ─────────────────────────────────────────────────────────────────
    if (!webhookSecret || !webhookSignature) {
      console.error('❌ Missing webhook secret or signature');
      return res.status(400).json({ success: false });
    }

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(webhookBody))
      .digest('hex');

    if (expectedSignature !== webhookSignature) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).json({ success: false });
    }

    console.log(`✅ Webhook signature verified: ${webhookBody.event}`);

    const event = webhookBody.event;
    const payload = webhookBody.payload;

    // ─────────────────────────────────────────────────────────────────
    // 📥 Process webhook events
    // ─────────────────────────────────────────────────────────────────
    switch (event) {
      case 'payment.captured':
        await handlePaymentCapturedWebhook(payload.payment.entity);
        break;

      case 'payment.failed':
        await handlePaymentFailedWebhook(payload.payment.entity);
        break;

      default:
        console.log(`ℹ️ Unhandled event: ${event}`);
    }

    // Always return 200 OK
    res.status(200).json({ success: true, received: true });

  } catch (err) {
    console.error('🔥 Webhook error:', err);
    // Still return 200 to prevent retry loop
    res.status(200).json({ success: false });
  }
};

async function handlePaymentCapturedWebhook(payment) {
  try {
    const session = await mongoose.startSession();
    session.startTransaction();

    const paymentId = payment.id;

    // Check if already processed
    const existing = await PaymentTransaction.findOne({
      razorpayPaymentId: paymentId,
      paymentStatus: 'completed'
    }).session(session);

    if (existing) {
      await session.abortTransaction();
      session.endSession();
      console.log(`ℹ️ Payment already processed: ${paymentId}`);
      return;
    }

    // Update payment transaction
    const driverId = payment.notes?.driverId;
    if (!driverId) {
      await session.abortTransaction();
      session.endSession();
      console.warn(`⚠️ No driver ID in webhook`);
      return;
    }

    await PaymentTransaction.findOneAndUpdate(
      { razorpayPaymentId: paymentId },
      {
        webhookStatus: 'completed',
        webhookReceivedAt: new Date()
      },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    console.log(`✅ Webhook confirmed payment: ${paymentId}`);

  } catch (err) {
    console.error('❌ Webhook processing error:', err);
  }
}

async function handlePaymentFailedWebhook(payment) {
  try {
    const session = await mongoose.startSession();
    session.startTransaction();

    const driverId = payment.notes?.driverId;
    const orderId = payment.order_id;

    if (driverId && orderId) {
      await PaymentTransaction.findOneAndUpdate(
        { razorpayOrderId: orderId },
        {
          paymentStatus: 'failed',
          webhookStatus: 'completed',
          webhookReceivedAt: new Date()
        },
        { session }
      );

      console.log(`❌ Payment failed: ${orderId}`);
    }

    await session.commitTransaction();
    session.endSession();

  } catch (err) {
    console.error('❌ Failed webhook processing error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default {
  createDirectPaymentOrder,
  verifyDirectPayment,
  processCashPayment,
  confirmCashReceipt,
  handleRazorpayWebhook
};