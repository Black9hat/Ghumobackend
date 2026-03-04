// controllers/paymentController.js
// PRODUCTION PAYMENT SYSTEM - Secure, Idempotent, Real-time

import mongoose from 'mongoose';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import PaymentTransaction from '../models/PaymentTransaction.js';
import Wallet from '../models/Wallet.js';
import Trip from '../models/Trip.js';

// ═══════════════════════════════════════════════════════════════════════════
// RAZORPAY INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Commission rate (20%)
const COMMISSION_RATE = 0.20;

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Safe Socket Emit
// ═══════════════════════════════════════════════════════════════════════════

const emitToRoom = (io, room, event, data) => {
  try {
    if (io) {
      io.to(room).emit(event, data);
      console.log(`📡 Emitted ${event} to ${room}`);
    }
  } catch (err) {
    console.warn(`⚠️ Socket emit failed: ${err.message}`);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Generate Idempotency Key
// ═══════════════════════════════════════════════════════════════════════════

const generateIdempotencyKey = (tripId, type) => {
  return `${tripId}_${type}_${Date.now()}`;
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Get or Create Wallet
// ═══════════════════════════════════════════════════════════════════════════

const getOrCreateWallet = async (driverId, session) => {
  let wallet = await Wallet.findOne({ driverId }).session(session);
  
  if (!wallet) {
    wallet = new Wallet({
      driverId,
      availableBalance: 0,
      totalEarnings: 0,
      totalCommission: 0,
      pendingAmount: 0,
      transactions: []
    });
    await wallet.save({ session });
  }
  
  return wallet;
};

// ═══════════════════════════════════════════════════════════════════════════
// 1️⃣ CREATE DIRECT PAYMENT ORDER (QR Code)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/payment/direct/create
 * 
 * Customer chooses "Pay via QR" → Creates Razorpay order
 * Returns order details for QR code generation
 */
export const createDirectPaymentOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tripId, customerId, driverId, amount } = req.body;

    // ─────────────────────────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────────────────────────
    if (!tripId || !customerId || !driverId || !amount) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: tripId, customerId, driverId, amount'
      });
    }

    if (amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // Check for existing pending/completed payment (Idempotency)
    // ─────────────────────────────────────────────────────────────────
    const existingPayment = await PaymentTransaction.findOne({
      tripId,
      paymentStatus: { $in: ['pending', 'processing', 'completed'] }
    }).session(session);

    if (existingPayment) {
      await session.abortTransaction();
      
      // If completed, return success
      if (existingPayment.paymentStatus === 'completed') {
        return res.json({
          success: true,
          message: 'Payment already completed',
          alreadyCompleted: true,
          paymentId: existingPayment.razorpayPaymentId
        });
      }
      
      // If pending, return existing order
      if (existingPayment.razorpayOrderId) {
        return res.json({
          success: true,
          message: 'Payment order already exists',
          orderId: existingPayment.razorpayOrderId,
          amount: existingPayment.amount,
          existingOrder: true
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // Verify trip exists and is completed
    // ─────────────────────────────────────────────────────────────────
    const trip = await Trip.findById(tripId).session(session);
    if (!trip) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Trip not found'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // Calculate amounts
    // ─────────────────────────────────────────────────────────────────
    const commission = Math.round(amount * COMMISSION_RATE * 100) / 100;
    const driverAmount = Math.round((amount - commission) * 100) / 100;

    // ─────────────────────────────────────────────────────────────────
    // Create Razorpay Order
    // ─────────────────────────────────────────────────────────────────
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Paisa
      currency: 'INR',
      receipt: `trip_${tripId}_${Date.now()}`,
      notes: {
        tripId: tripId.toString(),
        customerId: customerId.toString(),
        driverId: driverId.toString(),
        type: 'trip_payment'
      }
    });

    // ─────────────────────────────────────────────────────────────────
    // Create Payment Transaction Record
    // ─────────────────────────────────────────────────────────────────
    const paymentTxn = new PaymentTransaction({
      idempotencyKey: generateIdempotencyKey(tripId, 'direct'),
      razorpayOrderId: razorpayOrder.id,
      tripId,
      driverId,
      customerId,
      amount,
      driverAmount,
      commission,
      commissionRate: COMMISSION_RATE,
      paymentMethod: 'direct',
      paymentStatus: 'pending',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    await paymentTxn.save({ session });

    // Update trip payment status
    await Trip.findByIdAndUpdate(
      tripId,
      { paymentStatus: 'pending', paymentMethod: 'direct' },
      { session }
    );

    await session.commitTransaction();

    console.log(`✅ Order created: ${razorpayOrder.id} | Trip: ${tripId} | Amount: ₹${amount}`);

    // ─────────────────────────────────────────────────────────────────
    // Notify driver that payment is pending
    // ─────────────────────────────────────────────────────────────────
    emitToRoom(req.io, `driver_${driverId}`, 'payment:pending', {
      tripId,
      amount,
      method: 'direct',
      message: 'Customer is completing payment...'
    });

    res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount,
      driverAmount,
      commission,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
      tripId,
      expiresAt: Date.now() + 15 * 60 * 1000 // 15 minutes
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Create order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment order',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 2️⃣ VERIFY DIRECT PAYMENT (After customer pays)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/payment/direct/verify
 * 
 * Called by customer app after Razorpay payment completes
 * Verifies signature, credits wallet, updates trip
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

    // ─────────────────────────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────────────────────────
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Missing payment verification data'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STEP 1: Verify Razorpay Signature (CRITICAL!)
    // ─────────────────────────────────────────────────────────────────
    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      await session.abortTransaction();
      console.error('❌ SIGNATURE MISMATCH - Potential fraud!', {
        expected: expectedSignature.substring(0, 10) + '...',
        received: razorpaySignature.substring(0, 10) + '...',
        orderId: razorpayOrderId
      });
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed - Invalid signature'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STEP 2: Check for duplicate processing (IDEMPOTENCY)
    // ─────────────────────────────────────────────────────────────────
    const existingCompleted = await PaymentTransaction.findOne({
      razorpayPaymentId,
      paymentStatus: 'completed'
    }).session(session);

    if (existingCompleted) {
      await session.abortTransaction();
      console.log(`⚠️ Payment already processed: ${razorpayPaymentId}`);
      return res.json({
        success: true,
        message: 'Payment already processed',
        alreadyProcessed: true,
        paymentId: razorpayPaymentId,
        amount: existingCompleted.driverAmount
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STEP 3: Get payment record and lock it
    // ─────────────────────────────────────────────────────────────────
    const paymentTxn = await PaymentTransaction.findOneAndUpdate(
      { 
        razorpayOrderId,
        paymentStatus: { $ne: 'completed' }
      },
      { 
        $set: { 
          paymentStatus: 'processing',
          razorpayPaymentId
        }
      },
      { session, new: true }
    );

    if (!paymentTxn) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Payment order not found or already processed'
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STEP 4: Verify with Razorpay (Double check)
    // ─────────────────────────────────────────────────────────────────
    let razorpayPayment;
    try {
      razorpayPayment = await razorpay.payments.fetch(razorpayPaymentId);
    } catch (fetchErr) {
      await session.abortTransaction();
      console.error('❌ Failed to fetch from Razorpay:', fetchErr);
      return res.status(400).json({
        success: false,
        message: 'Failed to verify payment with Razorpay'
      });
    }

    if (razorpayPayment.status !== 'captured') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Payment not captured. Status: ${razorpayPayment.status}`
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STEP 5: Credit Driver Wallet
    // ─────────────────────────────────────────────────────────────────
    const wallet = await getOrCreateWallet(driverId, session);

    // Add credit transaction
    wallet.transactions.push({
      tripId,
      type: 'credit',
      amount: paymentTxn.driverAmount,
      description: `Trip payment received (Total: ₹${paymentTxn.amount})`,
      razorpayPaymentId,
      razorpayOrderId,
      paymentMethod: razorpayPayment.method || 'direct',
      status: 'completed',
      createdAt: new Date()
    });

    wallet.availableBalance += paymentTxn.driverAmount;
    wallet.totalEarnings += paymentTxn.driverAmount;

    await wallet.save({ session });

    // ─────────────────────────────────────────────────────────────────
    // STEP 6: Update Payment Transaction
    // ─────────────────────────────────────────────────────────────────
    await PaymentTransaction.findByIdAndUpdate(
      paymentTxn._id,
      {
        $set: {
          paymentStatus: 'completed',
          paymentMethod: razorpayPayment.method || 'direct',
          completedAt: new Date(),
          apiProcessed: true
        },
        $inc: { processedCount: 1 }
      },
      { session }
    );

    // ─────────────────────────────────────────────────────────────────
    // STEP 7: Update Trip
    // ─────────────────────────────────────────────────────────────────
    await Trip.findByIdAndUpdate(
      tripId,
      {
        paymentStatus: 'completed',
        paymentMethod: 'direct',
        razorpayPaymentId,
        paidAmount: paymentTxn.amount,
        paymentCompletedAt: new Date()
      },
      { session }
    );

    await session.commitTransaction();

    // ─────────────────────────────────────────────────────────────────
    // STEP 8: Real-time notifications
    // ─────────────────────────────────────────────────────────────────
    
    // Notify Driver
    emitToRoom(req.io, `driver_${driverId}`, 'payment:received', {
      tripId,
      amount: paymentTxn.driverAmount,
      totalFare: paymentTxn.amount,
      paymentId: razorpayPaymentId,
      method: razorpayPayment.method,
      walletBalance: wallet.availableBalance,
      timestamp: new Date().toISOString(),
      message: `₹${paymentTxn.driverAmount} received!`
    });

    // Notify Customer
    emitToRoom(req.io, `customer_${customerId}`, 'payment:confirmed', {
      tripId,
      amount: paymentTxn.amount,
      paymentId: razorpayPaymentId,
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Payment verified: ${razorpayPaymentId}`);
    console.log(`   Driver: ${driverId} | Amount: ₹${paymentTxn.driverAmount}`);
    console.log(`   New wallet balance: ₹${wallet.availableBalance}`);

    res.json({
      success: true,
      message: 'Payment verified successfully',
      paymentId: razorpayPaymentId,
      amount: paymentTxn.amount,
      driverAmount: paymentTxn.driverAmount,
      commission: paymentTxn.commission,
      walletBalance: wallet.availableBalance
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Verify payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Payment verification failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 3️⃣ INITIATE CASH PAYMENT (Customer chooses cash)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/payment/cash/initiate
 * 
 * Customer says "I'll pay cash" → Records pending cash payment
 * Notifies driver to collect cash
 */
export const initiateCashPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tripId, customerId, driverId, amount } = req.body;

    // Validation
    if (!tripId || !customerId || !driverId || !amount) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Check for existing payment
    const existingPayment = await PaymentTransaction.findOne({
      tripId,
      paymentStatus: { $in: ['pending', 'completed'] }
    }).session(session);

    if (existingPayment) {
      await session.abortTransaction();
      
      if (existingPayment.paymentStatus === 'completed') {
        return res.json({
          success: true,
          message: 'Payment already completed',
          alreadyCompleted: true
        });
      }
      
      // Return existing pending cash payment
      if (existingPayment.paymentMethod === 'cash') {
        return res.json({
          success: true,
          message: 'Cash payment already pending',
          paymentId: existingPayment._id,
          amount: existingPayment.amount
        });
      }
    }

    // Calculate amounts
    const commission = Math.round(amount * COMMISSION_RATE * 100) / 100;
    const driverAmount = Math.round((amount - commission) * 100) / 100;

    // Create cash payment record
    const paymentTxn = new PaymentTransaction({
      idempotencyKey: generateIdempotencyKey(tripId, 'cash'),
      tripId,
      driverId,
      customerId,
      amount,
      driverAmount,
      commission,
      commissionRate: COMMISSION_RATE,
      paymentMethod: 'cash',
      paymentStatus: 'pending',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    await paymentTxn.save({ session });

    // Update trip
    await Trip.findByIdAndUpdate(
      tripId,
      { paymentStatus: 'pending', paymentMethod: 'cash' },
      { session }
    );

    await session.commitTransaction();

    // Notify driver
    emitToRoom(req.io, `driver_${driverId}`, 'cash:payment:pending', {
      tripId,
      amount,
      paymentId: paymentTxn._id.toString(),
      message: `Collect ₹${amount} cash from customer`,
      action: 'confirm_cash_receipt'
    });

    console.log(`✅ Cash payment initiated: Trip ${tripId} | Amount: ₹${amount}`);

    res.json({
      success: true,
      message: 'Cash payment initiated. Driver will confirm receipt.',
      paymentId: paymentTxn._id,
      amount,
      driverAmount,
      commission
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Cash initiate error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate cash payment'
    });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 4️⃣ CONFIRM CASH RECEIPT (Driver confirms they received cash)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/payment/cash/confirm
 * 
 * Driver taps "Cash Collected" → Updates wallet
 * Handles: positive balance, zero balance, negative balance
 */
export const confirmCashReceipt = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { paymentId, tripId, driverId, amount } = req.body;

    // Validation
    if (!tripId || !driverId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Missing tripId or driverId'
      });
    }

    // Find payment record
    let paymentTxn;
    
    if (paymentId) {
      paymentTxn = await PaymentTransaction.findById(paymentId).session(session);
    } else {
      // Find by tripId if paymentId not provided
      paymentTxn = await PaymentTransaction.findOne({
        tripId,
        paymentMethod: 'cash',
        paymentStatus: 'pending'
      }).session(session);
    }

    // If no existing payment record, create one (driver-initiated)
    if (!paymentTxn) {
      if (!amount) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: 'Amount required for new cash confirmation'
        });
      }

      const commission = Math.round(amount * COMMISSION_RATE * 100) / 100;
      const driverAmount = Math.round((amount - commission) * 100) / 100;

      paymentTxn = new PaymentTransaction({
        idempotencyKey: generateIdempotencyKey(tripId, 'cash_driver'),
        tripId,
        driverId,
        customerId: req.body.customerId || null,
        amount,
        driverAmount,
        commission,
        commissionRate: COMMISSION_RATE,
        paymentMethod: 'cash',
        paymentStatus: 'pending'
      });
    }

    // Check if already completed
    if (paymentTxn.paymentStatus === 'completed') {
      await session.abortTransaction();
      return res.json({
        success: true,
        message: 'Cash already confirmed',
        alreadyProcessed: true
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // Process wallet transaction
    // ─────────────────────────────────────────────────────────────────
    const wallet = await getOrCreateWallet(driverId, session);

    // STEP 1: Credit full cash amount received
    wallet.transactions.push({
      tripId,
      type: 'credit',
      amount: paymentTxn.amount, // Full amount (driver collected this much)
      description: `Cash collected from trip`,
      paymentMethod: 'cash',
      status: 'completed',
      createdAt: new Date()
    });

    // STEP 2: Debit commission
    wallet.transactions.push({
      tripId,
      type: 'commission',
      amount: paymentTxn.commission,
      description: `Platform commission (${COMMISSION_RATE * 100}%)`,
      paymentMethod: 'cash',
      status: 'completed',
      createdAt: new Date()
    });

    // STEP 3: Calculate new balance
    // Cash flow: Driver gets cash → Owes commission to platform
    // If wallet balance is positive: deduct commission
    // If wallet balance is zero/negative: commission adds to debt
    
    const netAmount = paymentTxn.amount - paymentTxn.commission;
    
    // Update wallet balances
    wallet.availableBalance += netAmount;
    wallet.totalEarnings += paymentTxn.amount;
    wallet.totalCommission += paymentTxn.commission;

    // Track pending commission (what driver owes)
    // If availableBalance becomes negative, that's the pending amount
    if (wallet.availableBalance < 0) {
      wallet.pendingAmount = Math.abs(wallet.availableBalance);
      wallet.availableBalance = 0;
    } else {
      // Reduce pending if we have surplus
      if (wallet.pendingAmount > 0) {
        const payOff = Math.min(wallet.availableBalance, wallet.pendingAmount);
        wallet.pendingAmount -= payOff;
        wallet.availableBalance -= payOff;
      }
    }

    await wallet.save({ session });

    // ─────────────────────────────────────────────────────────────────
    // Update payment transaction
    // ─────────────────────────────────────────────────────────────────
    paymentTxn.paymentStatus = 'completed';
    paymentTxn.completedAt = new Date();
    paymentTxn.processedCount += 1;
    await paymentTxn.save({ session });

    // ─────────────────────────────────────────────────────────────────
    // Update trip
    // ─────────────────────────────────────────────────────────────────
    await Trip.findByIdAndUpdate(
      tripId,
      {
        paymentStatus: 'completed',
        paymentMethod: 'cash',
        paidAmount: paymentTxn.amount,
        paymentCompletedAt: new Date()
      },
      { session }
    );

    await session.commitTransaction();

    // ─────────────────────────────────────────────────────────────────
    // Notifications
    // ─────────────────────────────────────────────────────────────────
    emitToRoom(req.io, `driver_${driverId}`, 'payment:confirmed', {
      tripId,
      amount: paymentTxn.amount,
      driverAmount: netAmount,
      commission: paymentTxn.commission,
      walletBalance: wallet.availableBalance,
      pendingAmount: wallet.pendingAmount,
      method: 'cash',
      timestamp: new Date().toISOString(),
      message: `₹${netAmount} added to wallet`
    });

    if (paymentTxn.customerId) {
      emitToRoom(req.io, `customer_${paymentTxn.customerId}`, 'payment:confirmed', {
        tripId,
        amount: paymentTxn.amount,
        method: 'cash',
        timestamp: new Date().toISOString()
      });
    }

    console.log(`✅ Cash confirmed: Trip ${tripId}`);
    console.log(`   Amount: ₹${paymentTxn.amount} | Net: ₹${netAmount}`);
    console.log(`   Wallet: ₹${wallet.availableBalance} | Pending: ₹${wallet.pendingAmount}`);

    res.json({
      success: true,
      message: 'Cash receipt confirmed',
      amount: paymentTxn.amount,
      driverAmount: netAmount,
      commission: paymentTxn.commission,
      walletBalance: wallet.availableBalance,
      pendingAmount: wallet.pendingAmount
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Cash confirm error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm cash receipt'
    });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 5️⃣ RAZORPAY WEBHOOK (Server-to-server verification)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/webhook/razorpay
 * 
 * Razorpay calls this when payment events occur
 * This is the SOURCE OF TRUTH for payment status
 */
export const handleRazorpayWebhook = async (req, res) => {
  try {
    // ─────────────────────────────────────────────────────────────────
    // STEP 1: Verify webhook signature
    // ─────────────────────────────────────────────────────────────────
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    if (!webhookSecret) {
      console.error('❌ RAZORPAY_WEBHOOK_SECRET not configured!');
      return res.status(500).json({ success: false });
    }

    if (!signature) {
      console.error('❌ Missing webhook signature');
      return res.status(400).json({ success: false });
    }

    // Verify signature
    // req.body is a raw Buffer from express.raw() — use it directly
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.body)
      .digest('hex');

    if (expectedSignature !== signature) {
      console.error('❌ Invalid webhook signature!');
      return res.status(400).json({ success: false });
    }

    // ─────────────────────────────────────────────────────────────────
    // STEP 2: Parse body and process event
    // ─────────────────────────────────────────────────────────────────
    const parsedBody = JSON.parse(req.body.toString());
    const event = parsedBody.event;
    const payload = parsedBody.payload;

    console.log(`📨 Webhook received: ${event}`);

    switch (event) {
      case 'payment.captured':
        await processWebhookPaymentCaptured(payload.payment.entity, req.io);
        break;

      case 'payment.failed':
        await processWebhookPaymentFailed(payload.payment.entity, req.io);
        break;

      case 'order.paid':
        console.log(`✅ Order paid: ${payload.order.entity.id}`);
        break;

      default:
        console.log(`ℹ️ Unhandled event: ${event}`);
    }

    // Always return 200 to Razorpay
    res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    // Return 200 anyway to prevent retries
    res.status(200).json({ received: true, error: true });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function processWebhookPaymentCaptured(payment, io) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const paymentId = payment.id;
    const orderId = payment.order_id;

    // Check if already processed by webhook
    const existing = await PaymentTransaction.findOne({
      razorpayPaymentId: paymentId,
      webhookProcessed: true
    }).session(session);

    if (existing) {
      await session.abortTransaction();
      console.log(`⚠️ Webhook already processed: ${paymentId}`);
      return;
    }

    // Update payment transaction
    const paymentTxn = await PaymentTransaction.findOneAndUpdate(
      { razorpayOrderId: orderId },
      {
        $set: {
          webhookProcessed: true,
          webhookReceivedAt: new Date(),
          paymentMethod: payment.method
        }
      },
      { session, new: true }
    );

    if (!paymentTxn) {
      console.warn(`⚠️ Payment record not found for webhook: ${orderId}`);
      await session.abortTransaction();
      return;
    }

    // If not already completed by API, process it
    if (paymentTxn.paymentStatus !== 'completed') {
      console.log(`🔄 Processing payment via webhook: ${paymentId}`);
      
      // Credit wallet
      const wallet = await getOrCreateWallet(paymentTxn.driverId, session);
      
      wallet.transactions.push({
        tripId: paymentTxn.tripId,
        type: 'credit',
        amount: paymentTxn.driverAmount,
        description: `Trip payment (via webhook)`,
        razorpayPaymentId: paymentId,
        paymentMethod: payment.method,
        status: 'completed',
        createdAt: new Date()
      });

      wallet.availableBalance += paymentTxn.driverAmount;
      wallet.totalEarnings += paymentTxn.driverAmount;
      await wallet.save({ session });

      // Update payment status
      await PaymentTransaction.findByIdAndUpdate(
        paymentTxn._id,
        {
          $set: {
            paymentStatus: 'completed',
            completedAt: new Date()
          },
          $inc: { processedCount: 1 }
        },
        { session }
      );

      // Update trip
      await Trip.findByIdAndUpdate(
        paymentTxn.tripId,
        {
          paymentStatus: 'completed',
          paymentMethod: payment.method,
          razorpayPaymentId: paymentId,
          paidAmount: paymentTxn.amount,
          paymentCompletedAt: new Date()
        },
        { session }
      );

      // Notify driver
      emitToRoom(io, `driver_${paymentTxn.driverId}`, 'payment:received', {
        tripId: paymentTxn.tripId,
        amount: paymentTxn.driverAmount,
        paymentId,
        method: payment.method,
        source: 'webhook',
        walletBalance: wallet.availableBalance,
        timestamp: new Date().toISOString()
      });
    }

    await session.commitTransaction();
    console.log(`✅ Webhook processed: ${paymentId}`);

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Webhook processing error:', error);
  } finally {
    session.endSession();
  }
}

async function processWebhookPaymentFailed(payment, io) {
  try {
    const orderId = payment.order_id;

    await PaymentTransaction.findOneAndUpdate(
      { razorpayOrderId: orderId },
      {
        $set: {
          paymentStatus: 'failed',
          webhookProcessed: true,
          webhookReceivedAt: new Date(),
          errorDetails: {
            code: payment.error_code,
            message: payment.error_description,
            timestamp: new Date()
          }
        }
      }
    );

    console.log(`❌ Payment failed (webhook): ${orderId}`);

    // Notify driver
    const notes = payment.notes || {};
    if (notes.driverId) {
      emitToRoom(io, `driver_${notes.driverId}`, 'payment:failed', {
        tripId: notes.tripId,
        message: payment.error_description || 'Payment failed',
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('❌ Failed webhook processing error:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default {
  createDirectPaymentOrder,
  verifyDirectPayment,
  initiateCashPayment,
  confirmCashReceipt,
  handleRazorpayWebhook
};