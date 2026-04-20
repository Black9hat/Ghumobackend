// controllers/walletController.js - PRODUCTION PAYMENT SYSTEM

import Wallet from '../models/Wallet.js';
import Trip from '../models/Trip.js';
import PaymentTransaction from '../models/PaymentTransaction.js';
import WithdrawalRequest from '../models/WithdrawalRequest.js';
import User from '../models/User.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import mongoose from 'mongoose';

// ═══════════════════════════════════════════════════════════════════
// RAZORPAY HELPER: Promisify callback-based API
// ═══════════════════════════════════════════════════════════════════
async function razorpayApiCall(method, path, data = {}, options = {}) {
  const keyId = options.keyId || process.env.RAZORPAY_KEY_ID;
  const keySecret = options.keySecret || process.env.RAZORPAY_KEY_SECRET;
  const baseUrl = options.baseUrl || process.env.RAZORPAY_BASE_URL || 'https://api.razorpay.com/v1';

  if (!keyId || !keySecret) {
    throw new Error('Razorpay credentials missing');
  }

  const url = `${baseUrl}${path}`;
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  const response = await fetch(url, {
    method: method.toUpperCase(),
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) ? JSON.stringify(data) : undefined
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }

  if (!response.ok) {
    const message = payload?.error?.description || payload?.error?.reason || payload?.error?.code || `Razorpay API ${response.status}`;
    throw new Error(message);
  }

  console.log(`   ✅ API response for ${method.toUpperCase()} ${path}:`, payload?.id || 'success');
  return payload;
}

async function razorpayPayoutApiCall(method, path, data = {}) {
  const payoutKeyId = process.env.RAZORPAYX_KEY_ID || process.env.RAZORPAY_KEY_ID;
  const payoutKeySecret = process.env.RAZORPAYX_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET;
  const payoutBaseUrl = process.env.RAZORPAYX_BASE_URL || process.env.RAZORPAY_BASE_URL || 'https://api.razorpay.com/v1';

  return razorpayApiCall(method, path, data, {
    keyId: payoutKeyId,
    keySecret: payoutKeySecret,
    baseUrl: payoutBaseUrl
  });
}

function getWithdrawalPayoutCapability() {
  const simulationMode = process.env.WITHDRAWAL_SIMULATION_ONLY === 'true';
  const hasLiveKeys = !!(process.env.RAZORPAYX_KEY_ID && process.env.RAZORPAYX_KEY_SECRET);
  const hasAccountNumber = !!(process.env.RAZORPAYX_ACCOUNT_NUMBER || process.env.RAZORPAY_ACCOUNT_NUMBER);
  const liveReady = hasLiveKeys && hasAccountNumber;
  // Auto-fallback to manual flow when live payout setup is unavailable.
  const manualMode = process.env.WITHDRAWAL_MANUAL_MODE === 'true' || (!liveReady && !simulationMode);

  return {
    simulationMode,
    manualMode,
    liveReady
  };
}

function getPublicWithdrawalFailureReason(error) {
  const raw = String(error?.message || '').toLowerCase();

  if (raw.includes('payout api not accessible') || raw.includes('requested url was not found')) {
    return 'Withdrawal service temporarily unavailable. Please try again later.';
  }

  if (raw.includes('mode')) {
    return 'Withdrawal could not be processed. Please retry in a few minutes.';
  }

  return 'Withdrawal failed due to a temporary payment service issue.';
}

function normalizeWithdrawalClientRequestId(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;

  // Keep this tight to avoid accidental/unsafe id formats in logs and indexes.
  if (value.length < 8 || value.length > 100) return null;
  if (!/^[a-zA-Z0-9:_-]+$/.test(value)) return null;

  return value.toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════
// RAZORPAY INIT
// ═══════════════════════════════════════════════════════════════════
let razorpay = null;

// Debug: Log environment at startup
console.log('📋 Razorpay Environment Check:');
console.log('   RAZORPAY_KEY_ID exists:', !!process.env.RAZORPAY_KEY_ID);
console.log('   RAZORPAY_KEY_SECRET exists:', !!process.env.RAZORPAY_KEY_SECRET);
console.log('   RAZORPAY_ACCOUNT_NUMBER exists:', !!process.env.RAZORPAY_ACCOUNT_NUMBER);
console.log('   RAZORPAYX_KEY_ID exists:', !!process.env.RAZORPAYX_KEY_ID);
console.log('   RAZORPAYX_KEY_SECRET exists:', !!process.env.RAZORPAYX_KEY_SECRET);
console.log('   RAZORPAYX_ACCOUNT_NUMBER exists:', !!process.env.RAZORPAYX_ACCOUNT_NUMBER);

try {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET');
  }

  console.log('🔄 Attempting to initialize Razorpay...');
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  
  console.log('✅ Razorpay initialized successfully');
  console.log('   Key ID:', process.env.RAZORPAY_KEY_ID.substring(0, 10) + '...');
  console.log('   Available methods:', Object.keys(razorpay).join(', '));
  console.log('   Has .contacts:', !!razorpay.contacts);
  console.log('   Has .payouts:', !!razorpay.payouts);
  console.log('   Has .fundAccounts:', !!razorpay.fundAccounts);
  
} catch (error) {
  console.error('❌ Razorpay initialization FAILED:', error.message);
  console.error('   Full Error:', error);
  razorpay = null;
}

// ═══════════════════════════════════════════════════════════════════
// SAFE SOCKET EMIT
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// CREATE DIRECT PAYMENT ORDER (QR/UPI)
// POST /api/payment/direct/create
// ═══════════════════════════════════════════════════════════════════
export const createDirectPaymentOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { tripId, customerId, driverId, amount } = req.body;

    if (!tripId || !customerId || !driverId || !amount) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Missing required fields: tripId, customerId, driverId, amount' });
    }
    if (amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const trip = await Trip.findById(tripId).session(session);
    if (!trip) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

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

    await Trip.findByIdAndUpdate(tripId, { paymentStatus: 'processing' }, { session });

    const commission = amount * 0.20;
    const driverAmount = amount - commission;

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `trip_${tripId}`,
      notes: {
        tripId: tripId.toString(),
        customerId: customerId.toString(),
        driverId: driverId.toString(),
        type: 'trip_payment'
      }
    });

    const paymentTxn = new PaymentTransaction({
      razorpayOrderId: razorpayOrder.id,
      tripId,
      driverId,
      customerId,
      amount,
      commission,
      driverAmount,
      paymentMethod: 'upi',
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

    return res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount,
      driverAmount,
      commission,
      currency: 'INR',
      customerId,
      driverId,
      tripId,
      expiryTime: Math.floor(Date.now() / 1000) + 900
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Order creation error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create payment order', error: error.message });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// VERIFY DIRECT PAYMENT
// POST /api/payment/direct/verify
// ═══════════════════════════════════════════════════════════════════
export const verifyDirectPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, tripId, driverId, customerId } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Missing payment verification data' });
    }

    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Payment verification failed - invalid signature' });
    }

    const existingPayment = await PaymentTransaction.findOne({
      razorpayPaymentId,
      paymentStatus: 'completed'
    }).session(session);

    if (existingPayment) {
      await session.abortTransaction();
      return res.json({ success: true, message: 'Payment already processed', paymentId: razorpayPaymentId, alreadyProcessed: true });
    }

    const payment = await razorpay.payments.fetch(razorpayPaymentId);
    if (!payment || payment.status !== 'captured') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Payment not completed. Status: ${payment?.status}` });
    }

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
      return res.status(404).json({ success: false, message: 'Payment order not found' });
    }

    let wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      wallet = new Wallet({ driverId, availableBalance: 0, balance: 0, totalEarnings: 0, totalCommission: 0, transactions: [] });
    }

    wallet.transactions.push({
      tripId,
      type: 'credit',
      amount: paymentTxn.driverAmount,
      description: `Payment received from trip (₹${paymentTxn.amount})`,
      razorpayPaymentId,
      razorpayOrderId,
      paymentMethod: payment.method,
      status: 'completed',
      createdAt: new Date()
    });
    wallet.availableBalance += paymentTxn.driverAmount;
    wallet.totalEarnings += paymentTxn.driverAmount;
    await wallet.save({ session });

    await Trip.findByIdAndUpdate(tripId, {
      paymentStatus: 'completed',
      paymentMethod: 'direct',
      razorpayPaymentId,
      paidAmount: paymentTxn.amount,
      completedAt: new Date()
    }, { session });

    await session.commitTransaction();

    safeEmit(req.io, `driver_${driverId}`, 'payment:received', {
      tripId, amount: paymentTxn.driverAmount, paymentId: razorpayPaymentId,
      method: payment.method, timestamp: new Date().toISOString()
    });
    safeEmit(req.io, `customer_${customerId}`, 'payment:confirmed', {
      tripId, amount: paymentTxn.amount, paymentId: razorpayPaymentId, timestamp: new Date().toISOString()
    });

    console.log(`✅ Payment verified: ${razorpayPaymentId} | Driver: ${driverId} | ₹${paymentTxn.driverAmount}`);

    return res.json({
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
    return res.status(500).json({ success: false, message: 'Payment verification failed', error: error.message });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// INITIATE CASH PAYMENT (Customer side)
// POST /api/payment/cash/initiate
// ═══════════════════════════════════════════════════════════════════
export const initiateCashPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { tripId, driverId, customerId, amount, notes } = req.body;

    if (!tripId || !driverId || !customerId || !amount) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Missing required fields: tripId, driverId, customerId, amount' });
    }
    if (amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const trip = await Trip.findById(tripId).session(session);
    if (!trip) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    const existingPayment = await PaymentTransaction.findOne({
      tripId, paymentMethod: 'cash', paymentStatus: 'completed'
    }).session(session);

    if (existingPayment) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Cash payment already recorded for this trip' });
    }

    await Trip.findByIdAndUpdate(tripId, { paymentStatus: 'processing' }, { session });

    const commission = amount * 0.20;
    const driverAmount = amount;

    const paymentTxn = new PaymentTransaction({
      tripId, driverId, customerId, amount, driverAmount, commission,
      paymentMethod: 'cash',
      paymentStatus: 'pending',
      webhookStatus: 'na',
      createdAt: new Date(),
      processedCount: 0,
      ipAddress: req.ip,
      metadata: { notes }
    });

    await paymentTxn.save({ session });
    await session.commitTransaction();

    safeEmit(req.io, `driver_${driverId}`, 'cash:payment:pending', {
      tripId, amount, customerId,
      message: `Customer paid ₹${amount} in cash - Please confirm receipt`,
      action: 'confirm_cash_receipt'
    });

    console.log(`✅ Cash payment pending: ₹${amount} for trip ${tripId}`);

    return res.json({
      success: true,
      message: 'Cash payment recorded. Waiting for driver confirmation.',
      paymentId: paymentTxn._id,
      amount,
      tripId
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Cash initiate error:', error);
    return res.status(500).json({ success: false, message: 'Failed to record cash payment', error: error.message });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// CONFIRM CASH RECEIPT (Driver side)
// POST /api/payment/cash/confirm
// ═══════════════════════════════════════════════════════════════════
export const confirmCashReceipt = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { paymentId, tripId, driverId } = req.body;

    if (!paymentId || !driverId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Missing required fields: paymentId, driverId' });
    }

    const paymentTxn = await PaymentTransaction.findById(paymentId).session(session);
    if (!paymentTxn) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }
    if (paymentTxn.paymentStatus === 'completed') {
      await session.abortTransaction();
      return res.json({ success: true, message: 'Payment already confirmed', alreadyProcessed: true });
    }
    if (paymentTxn.paymentMethod !== 'cash') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'This is not a cash payment' });
    }

    let wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      wallet = new Wallet({ driverId, availableBalance: 0, balance: 0, totalEarnings: 0, totalCommission: 0, transactions: [] });
    }

    // Credit full amount
    wallet.transactions.push({
      tripId: paymentTxn.tripId, type: 'credit',
      amount: paymentTxn.driverAmount,
      description: 'Cash received from trip',
      paymentMethod: 'cash', status: 'completed', createdAt: new Date()
    });
    wallet.availableBalance += paymentTxn.driverAmount;
    wallet.totalEarnings += paymentTxn.driverAmount;
    await wallet.save({ session });

    // Deduct commission
    wallet.transactions.push({
      tripId: paymentTxn.tripId, type: 'commission',
      amount: paymentTxn.commission,
      description: 'App commission (20%)',
      paymentMethod: 'cash', status: 'completed', createdAt: new Date()
    });
    wallet.totalCommission += paymentTxn.commission;
    wallet.availableBalance = Math.max(0, wallet.availableBalance - paymentTxn.commission);
    await wallet.save({ session });

    await PaymentTransaction.findByIdAndUpdate(paymentId, {
      paymentStatus: 'completed', completedAt: new Date(), $inc: { processedCount: 1 }
    }, { session });

    await Trip.findByIdAndUpdate(tripId || paymentTxn.tripId, {
      paymentStatus: 'completed', paymentMethod: 'cash',
      paidAmount: paymentTxn.amount, completedAt: new Date()
    }, { session });

    await session.commitTransaction();

    safeEmit(req.io, `driver_${driverId}`, 'payment:confirmed', {
      tripId, amount: paymentTxn.driverAmount, commission: paymentTxn.commission,
      netAmount: paymentTxn.driverAmount - paymentTxn.commission,
      walletBalance: wallet.availableBalance, method: 'cash', timestamp: new Date().toISOString()
    });
    safeEmit(req.io, `customer_${paymentTxn.customerId}`, 'payment:confirmed', {
      tripId, amount: paymentTxn.amount, method: 'cash', timestamp: new Date().toISOString()
    });

    console.log(`✅ Cash confirmed: ₹${paymentTxn.driverAmount} → driver ${driverId}`);

    return res.json({
      success: true, message: 'Cash receipt confirmed',
      amount: paymentTxn.driverAmount,
      commission: paymentTxn.commission,
      netAmount: paymentTxn.driverAmount - paymentTxn.commission,
      walletBalance: wallet.availableBalance
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Cash confirmation error:', error);
    return res.status(500).json({ success: false, message: 'Failed to confirm cash receipt', error: error.message });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// PROCESS CASH COLLECTION (alias used by tripRoutes confirm-cash)
// POST /api/trip/confirm-cash
// ═══════════════════════════════════════════════════════════════════
export const processCashCollection = async (req, res) => {
  try {
    const { tripId, driverId, amount, paymentMethod = 'cash' } = req.body;

    const missing = [];
    if (!tripId)   missing.push('tripId');
    if (!driverId) missing.push('driverId');
    if (!amount && amount !== 0) missing.push('amount');

    if (missing.length > 0) {
      console.error('❌ processCashCollection - missing:', missing, '| received:', req.body);
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(', ')}`,
        received: { tripId, driverId, amount }
      });
    }

    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const trip = await Trip.findById(tripId).session(session);
      if (!trip) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'Trip not found' });
      }

      let wallet = await Wallet.findOne({ driverId }).session(session);
      if (!wallet) {
        wallet = new Wallet({ driverId, availableBalance: 0, balance: 0, totalEarnings: 0, totalCommission: 0, transactions: [] });
      }

      const commission = numericAmount * 0.20;
      const driverNet = numericAmount - commission;

      wallet.transactions.push({
        tripId, type: 'credit', amount: numericAmount,
        description: `Cash collected for trip`, paymentMethod, status: 'completed', createdAt: new Date()
      });
      wallet.transactions.push({
        tripId, type: 'commission', amount: commission,
        description: 'App commission (20%)', paymentMethod, status: 'completed', createdAt: new Date()
      });

      wallet.availableBalance = Math.max(0, wallet.availableBalance + driverNet);
      wallet.totalEarnings += numericAmount;
      wallet.totalCommission += commission;
      await wallet.save({ session });

      await Trip.findByIdAndUpdate(tripId, {
        paymentStatus: 'completed', paymentMethod, paidAmount: numericAmount, completedAt: new Date()
      }, { session });

      await session.commitTransaction();

      safeEmit(req.io, `driver_${driverId}`, 'payment:confirmed', {
        tripId, amount: driverNet, commission, method: paymentMethod, timestamp: new Date().toISOString()
      });

      console.log(`✅ Cash collected: ₹${numericAmount} for trip ${tripId} | driver net: ₹${driverNet}`);

      return res.json({
        success: true, message: 'Cash collection recorded',
        amount: numericAmount, commission, driverNet,
        walletBalance: wallet.availableBalance
      });
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error('❌ processCashCollection error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// RAZORPAY WEBHOOK
// POST /api/payment/webhook/razorpay
// ═══════════════════════════════════════════════════════════════════
export const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const webhookSignature = req.headers['x-razorpay-signature'];
    const webhookBody = req.body;

    if (!webhookSecret || !webhookSignature) {
      return res.status(400).json({ success: false });
    }

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(webhookBody)
      .digest('hex');

    if (expectedSignature !== webhookSignature) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).json({ success: false });
    }

    const parsedBody = JSON.parse(webhookBody.toString());
    const { event, payload } = parsedBody;

    switch (event) {
      case 'payment.captured':
        await handlePaymentCapturedWebhook(payload.payment.entity);
        break;
      case 'payment.failed':
        await handlePaymentFailedWebhook(payload.payment.entity);
        break;
      default:
        console.log(`ℹ️ Unhandled webhook event: ${event}`);
    }

    return res.status(200).json({ success: true, received: true });
  } catch (err) {
    console.error('🔥 Webhook error:', err);
    return res.status(200).json({ success: false });
  }
};

async function handlePaymentCapturedWebhook(payment) {
  try {
    const session = await mongoose.startSession();
    session.startTransaction();
    const existing = await PaymentTransaction.findOne({
      razorpayPaymentId: payment.id, paymentStatus: 'completed'
    }).session(session);

    if (existing) {
      await session.abortTransaction();
      session.endSession();
      return;
    }

    await PaymentTransaction.findOneAndUpdate(
      { razorpayPaymentId: payment.id },
      { webhookStatus: 'completed', webhookReceivedAt: new Date() },
      { session }
    );

    await session.commitTransaction();
    session.endSession();
    console.log(`✅ Webhook confirmed: ${payment.id}`);
  } catch (err) {
    console.error('❌ Webhook captured handler error:', err);
  }
}

async function handlePaymentFailedWebhook(payment) {
  try {
    const session = await mongoose.startSession();
    session.startTransaction();
    await PaymentTransaction.findOneAndUpdate(
      { razorpayOrderId: payment.order_id },
      { paymentStatus: 'failed', webhookStatus: 'completed', webhookReceivedAt: new Date() },
      { session }
    );
    await session.commitTransaction();
    session.endSession();
    console.log(`❌ Webhook failed: ${payment.order_id}`);
  } catch (err) {
    console.error('❌ Webhook failed handler error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════
// GET WALLET BY DRIVER ID
// GET /api/wallet/:driverId
// ═══════════════════════════════════════════════════════════════════
export const getWalletByDriverId = async (req, res) => {
  try {
    const { driverId } = req.params;
    if (!driverId) return res.status(400).json({ success: false, message: 'driverId required' });

    const wallet = await Wallet.findOne({ driverId })
      .sort({ updatedAt: -1, lastUpdated: -1, createdAt: -1 })
      .lean();
    if (!wallet) {
      return res.json({
        success: true,
        wallet: { driverId, availableBalance: 0, totalEarnings: 0, totalCommission: 0, pendingAmount: 0, pendingWithdrawalAmount: 0, transactions: [] }
      });
    }
    
    // ✅ CRITICAL: Remove any cached or stale referral fields
    // Frontend will derive referral balance from actual transactions
    delete wallet.referralBalance;
    delete wallet.referralAmount;
    delete wallet.referralEarnings;
    delete wallet.referralWalletAmount;
    delete wallet.totalReferralEarnings;
    delete wallet.referredEarnings;
    
    return res.json({ success: true, wallet });
  } catch (error) {
    console.error('❌ getWalletByDriverId error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch wallet' });
  }
};

// ═══════════════════════════════════════════════════════════════════
// GET TODAY'S EARNINGS
// GET /api/wallet/today/:driverId
// ═══════════════════════════════════════════════════════════════════
export const getTodayEarnings = async (req, res) => {
  try {
    const { driverId } = req.params;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const wallet = await Wallet.findOne({ driverId }).lean();
    if (!wallet) {
      return res.json({ success: true, todayEarnings: 0, todayTrips: 0, todayCommission: 0 });
    }

    const todayTxns = (wallet.transactions || []).filter(
      t => t.type === 'credit' && new Date(t.createdAt) >= startOfDay
    );
    const todayEarnings = todayTxns.reduce((sum, t) => sum + (t.amount || 0), 0);
    const todayCommission = Math.round(todayEarnings * 0.20 * 100) / 100;

    return res.json({
      success: true,
      todayEarnings: Math.round(todayEarnings * 100) / 100,
      todayTrips: todayTxns.length,
      todayCommission,
      availableBalance: wallet.availableBalance || 0
    });
  } catch (error) {
    console.error('❌ getTodayEarnings error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch today earnings' });
  }
};

// ═══════════════════════════════════════════════════════════════════
// GET PAYMENT PROOFS
// GET /api/wallet/payment-proof/:driverId
// ═══════════════════════════════════════════════════════════════════
export const getPaymentProofs = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { limit = 20, skip = 0 } = req.query;

    const wallet = await Wallet.findOne({ driverId }).lean();
    if (!wallet) return res.json({ success: true, proofs: [], total: 0 });

    const proofs = (wallet.transactions || [])
      .filter(t => t.status === 'completed' && (t.razorpayPaymentId || t.paymentMethod))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(Number(skip), Number(skip) + Number(limit));

    return res.json({
      success: true, proofs,
      total: wallet.transactions?.filter(t => t.status === 'completed').length || 0
    });
  } catch (error) {
    console.error('❌ getPaymentProofs error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch payment proofs' });
  }
};

// ═══════════════════════════════════════════════════════════════════
// GET ALL WALLETS (Admin)
// GET /api/wallet/admin/wallets
// ═══════════════════════════════════════════════════════════════════
export const getAllWallets = async (req, res) => {
  try {
    const { page = 1, limit = 20, sortBy = 'totalEarnings', order = 'desc' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const sortOrder = order === 'asc' ? 1 : -1;
    const allowedSort = ['availableBalance', 'totalEarnings', 'totalCommission', 'pendingAmount'];
    const sortField = allowedSort.includes(sortBy) ? sortBy : 'totalEarnings';

    const [wallets, total] = await Promise.all([
      Wallet.find({})
        .select('driverId availableBalance totalEarnings totalCommission pendingAmount pendingWithdrawalAmount transactions lastUpdated')
        .sort({ [sortField]: sortOrder })
        .skip(skip).limit(Number(limit))
        .populate('driverId', 'name phone vehicleType vehicleNumber')
        .lean(),
      Wallet.countDocuments({})
    ]);

    return res.json({
      success: true, wallets,
      pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) }
    });
  } catch (error) {
    console.error('❌ getAllWallets error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch wallets' });
  }
};

// ═══════════════════════════════════════════════════════════════════
// GET WALLET DETAILS (Admin - single driver)
// GET /api/wallet/admin/wallets/:driverId
// ═══════════════════════════════════════════════════════════════════
export const getWalletDetails = async (req, res) => {
  try {
    const { driverId } = req.params;
    const wallet = await Wallet.findOne({ driverId })
      .populate('driverId', 'name phone vehicleType vehicleNumber isOnline').lean();

    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found for this driver' });

    return res.json({
      success: true,
      wallet: {
        ...wallet,
        summary: {
          totalTransactions: wallet.transactions?.length || 0,
          completedTransactions: wallet.transactions?.filter(t => t.status === 'completed').length || 0,
          netEarnings: (wallet.totalEarnings || 0) - (wallet.totalCommission || 0),
          reservedWithdrawalAmount: wallet.pendingWithdrawalAmount || 0
        }
      }
    });
  } catch (error) {
    console.error('❌ getWalletDetails error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch wallet details' });
  }
};

// ═══════════════════════════════════════════════════════════════════
// GET WALLET TRANSACTIONS (Admin - paginated)
// GET /api/wallet/admin/wallets/:driverId/transactions
// ═══════════════════════════════════════════════════════════════════
export const getWalletTransactions = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { page = 1, limit = 50, type, status } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const wallet = await Wallet.findOne({ driverId }).lean();
    if (!wallet) return res.json({ success: true, transactions: [], total: 0 });

    let transactions = wallet.transactions || [];
    if (type)   transactions = transactions.filter(t => t.type === type);
    if (status) transactions = transactions.filter(t => t.status === status);
    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = transactions.length;
    const paginated = transactions.slice(skip, skip + Number(limit));

    return res.json({
      success: true, transactions: paginated,
      pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) }
    });
  } catch (error) {
    console.error('❌ getWalletTransactions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
};

// ═══════════════════════════════════════════════════════════════════
// PROCESS MANUAL PAYOUT (Admin)
// POST /api/wallet/admin/wallets/:driverId/payout
// ═══════════════════════════════════════════════════════════════════
export const processManualPayout = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { driverId } = req.params;
    const { amount, description, adminId } = req.body;

    if (!amount || amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }

    const wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Wallet not found' });
    }
    if (wallet.availableBalance < amount) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Insufficient balance. Available: ₹${wallet.availableBalance}` });
    }

    wallet.transactions.push({
      type: 'debit', amount,
      description: description || 'Manual payout by admin',
      paymentMethod: 'unknown', status: 'completed', createdAt: new Date()
    });
    wallet.availableBalance -= amount;
    await wallet.save({ session });
    await session.commitTransaction();

    console.log(`✅ Manual payout: ₹${amount} from driver ${driverId} by admin ${adminId}`);
    return res.json({ success: true, message: `₹${amount} payout processed`, newBalance: wallet.availableBalance });
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ processManualPayout error:', error);
    return res.status(500).json({ success: false, message: 'Failed to process payout' });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// PROCESS DRIVER WITHDRAWAL (Driver)
// POST /api/wallet/withdraw
// Body: { amount }
// ═══════════════════════════════════════════════════════════════════
export const processDriverWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const authenticatedDriverId = req.user?._id?.toString();
    if (!authenticatedDriverId) {
      await session.abortTransaction();
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }

    const wallet = await Wallet.findOne({ driverId: authenticatedDriverId }).session(session);
    if (!wallet) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Wallet not found' });
    }

    if ((wallet.availableBalance || 0) < amount) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Insufficient withdrawable balance. Available: ₹${Number(wallet.availableBalance || 0).toFixed(2)}`,
      });
    }

    wallet.transactions.push({
      type: 'debit',
      amount,
      description: 'Driver withdrawal request',
      paymentMethod: 'bank_transfer',
      status: 'completed',
      createdAt: new Date(),
    });

    wallet.availableBalance = Number(wallet.availableBalance || 0) - amount;
    wallet.lastUpdated = new Date();
    await wallet.save({ session });

    await User.findByIdAndUpdate(
      authenticatedDriverId,
      { $inc: { wallet: -amount } },
      { session }
    );

    await session.commitTransaction();

    return res.json({
      success: true,
      message: `Withdrawal of ₹${amount.toFixed(2)} processed`,
      withdrawnAmount: amount,
      availableBalance: Number(wallet.availableBalance || 0),
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ processDriverWithdrawal error:', error);
    return res.status(500).json({ success: false, message: 'Failed to process withdrawal' });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// GET WALLET STATS SUMMARY (Admin)
// GET /api/wallet/admin/wallets/stats/summary
// ═══════════════════════════════════════════════════════════════════
export const getWalletStats = async (req, res) => {
  try {
    const [stats, todayStats] = await Promise.all([
      Wallet.aggregate([{
        $group: {
          _id: null,
          totalDrivers: { $sum: 1 },
          totalAvailableBalance: { $sum: '$availableBalance' },
          totalEarnings: { $sum: '$totalEarnings' },
          totalCommission: { $sum: '$totalCommission' },
          totalPending: { $sum: '$pendingAmount' },
          avgBalance: { $avg: '$availableBalance' }
        }
      }]),
      Wallet.aggregate([
        { $unwind: '$transactions' },
        { $match: {
          'transactions.createdAt': { $gte: (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })() },
          'transactions.type': 'credit',
          'transactions.status': 'completed'
        }},
        { $group: { _id: null, todayTotalEarnings: { $sum: '$transactions.amount' }, todayTransactions: { $sum: 1 } } }
      ])
    ]);

    const summary = stats[0] || { totalDrivers: 0, totalAvailableBalance: 0, totalEarnings: 0, totalCommission: 0, totalPending: 0, avgBalance: 0 };
    const today = todayStats[0] || { todayTotalEarnings: 0, todayTransactions: 0 };

    return res.json({
      success: true,
      stats: {
        ...summary,
        todayTotalEarnings: Math.round((today.todayTotalEarnings || 0) * 100) / 100,
        todayTransactions: today.todayTransactions || 0,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ getWalletStats error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch wallet stats' });
  }
};

// ═══════════════════════════════════════════════════════════════════
// NAMED ALIASES (for backward compatibility)
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// CREATE COMMISSION PAYMENT ORDER (Driver pays pending commission)
// POST /api/wallet/create-commission-order
// Only needs driverId + amount — no tripId/customerId required
// ═══════════════════════════════════════════════════════════════════
export const createCommissionOrder = async (req, res) => {
  try {
    const { driverId, amount } = req.body;

    if (!driverId || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields: driverId, amount' });
    }

    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number' });
    }

    if (!razorpay) {
      return res.status(500).json({ success: false, message: 'Razorpay not configured' });
    }

    const receipt = `comm_${driverId.toString().slice(-8)}_${Date.now().toString().slice(-6)}`;

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(numericAmount * 100), // paise
      currency: 'INR',
      receipt,
      notes: {
        driverId: driverId.toString(),
        type: 'commission_payment'
      }
    });

    console.log(`✅ Commission order created: ${razorpayOrder.id} | driver: ${driverId} | ₹${numericAmount}`);

    return res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount: numericAmount,
      currency: 'INR',
      driverId,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID  // ✅ send key to Flutter
    });
  } catch (error) {
    console.error('❌ createCommissionOrder error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create commission order', error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// VERIFY COMMISSION PAYMENT
// POST /api/wallet/verify-commission
// After Razorpay success, clears pendingAmount from wallet
// ═══════════════════════════════════════════════════════════════════
export const verifyCommissionPayment = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { driverId, paymentId, orderId, signature } = req.body;

    if (!driverId || !paymentId || !orderId || !signature) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // ✅ Step 1: Verify Razorpay signature FIRST — before any DB work
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (expectedSig !== signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    // ✅ Step 2: Check idempotency BEFORE fetching from Razorpay
    // If webhook already wrote this paymentId, return early with current wallet state
    const existingCheck = await Wallet.findOne({
      driverId,
      'transactions.razorpayPaymentId': paymentId,
      'transactions.status': 'completed'
    }).select('pendingAmount availableBalance').lean();

    if (existingCheck) {
      console.log(`ℹ️ verifyCommission: ${paymentId} already processed — returning current state`);
      return res.json({
        success: true,
        message: 'Commission already processed',
        alreadyProcessed: true,
        paidAmount: 0,
        pendingAmount: existingCheck.pendingAmount,
        availableBalance: existingCheck.availableBalance
      });
    }

    // ✅ Step 3: Fetch from Razorpay with timeout — prevents session leak if Razorpay is slow
    let payment;
    try {
      const fetchWithTimeout = Promise.race([
        razorpay.payments.fetch(paymentId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Razorpay fetch timeout after 10s')), 10000)
        )
      ]);
      payment = await fetchWithTimeout;
    } catch (fetchErr) {
      console.error('❌ Razorpay fetch error:', fetchErr.message);
      return res.status(502).json({ success: false, message: 'Could not verify payment with Razorpay. Try again.' });
    }

    if (!payment || !['captured', 'authorized'].includes(payment.status)) {
      return res.status(400).json({
        success: false,
        message: `Payment not completed. Status: ${payment?.status ?? 'unknown'}`
      });
    }

    const paidAmount = payment.amount / 100;
    const paymentMethod = payment.method || 'upi';

    // ✅ Step 4: Atomic transaction — prevents race with webhook
    session.startTransaction();

    const wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Wallet not found' });
    }

    // ✅ Re-check inside transaction (double-checked locking)
    const doubleCheck = wallet.transactions.some(
      t => t.razorpayPaymentId === paymentId && t.status === 'completed'
    );
    if (doubleCheck) {
      await session.abortTransaction();
      return res.json({
        success: true,
        message: 'Commission already processed',
        alreadyProcessed: true,
        paidAmount: 0,
        pendingAmount: wallet.pendingAmount,
        availableBalance: wallet.availableBalance
      });
    }

    // ✅ Deduct pendingAmount and track in totalCommission
    const deducted = Math.min(wallet.pendingAmount, paidAmount);
    wallet.pendingAmount = Math.max(0, wallet.pendingAmount - deducted);
    wallet.totalCommission = (wallet.totalCommission || 0) + paidAmount;

    wallet.transactions.push({
      type: 'commission',                               // ← 'commission' type so UI shows it distinctly
      amount: paidAmount,
      description: `Commission paid via Razorpay`,
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId,
      paymentMethod,
      status: 'completed',
      createdAt: new Date()
    });

    await wallet.save({ session });
    await session.commitTransaction();

    console.log(`✅ Commission verified: ₹${paidAmount} | driver: ${driverId} | pending: ₹${wallet.pendingAmount}`);

    // ✅ Emit socket
    if (req.io) {
      req.io.to(`driver_${driverId}`).emit('commission:paid', {
        paidAmount,
        pendingAmount: wallet.pendingAmount,
        availableBalance: wallet.availableBalance,
        paymentId,
        timestamp: new Date().toISOString()
      });
    }

    return res.json({
      success: true,
      message: 'Commission payment verified',
      paidAmount,
      pendingAmount: wallet.pendingAmount,
      availableBalance: wallet.availableBalance
    });

  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ verifyCommissionPayment error:', error);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  } finally {
    session.endSession();
  }
};

export const createRazorpayOrder     = createDirectPaymentOrder;
export const verifyRazorpayPayment   = verifyDirectPayment;
export const processCashPaymentHandler = initiateCashPayment;
export const confirmCashPayment      = confirmCashReceipt;
export const razorpayWebhook         = handleRazorpayWebhook;

// ═══════════════════════════════════════════════════════════════════════════
// 💳 WITHDRAWAL SYSTEM - REFERRED AMOUNT PAYOUT VIA RAZORPAY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/withdrawal/request-payout
 * Request withdrawal of referred amount to UPI
 * 
 * SECURITY:
 * - Atomic transaction: check balance → debit → create withdrawal record
 * - Idempotency key ensures one withdrawal per timestamp
 * - Balance debited immediately to prevent double-payout
 * - Razorpay payout is async; webhook confirms actual transfer
 * - Auto-retry on transient MongoDB errors
 */
export const requestWithdrawalPayout = async (req, res) => {
  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await processWithdrawalRequest(req, res);
    } catch (error) {
      lastError = error;
      // If transient error and not last attempt, retry
      if (error.errorResponse?.errorLabels?.includes('TransientTransactionError') && attempt < MAX_RETRIES) {
        console.log(`⚠️ Transient error on attempt ${attempt}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 100 * attempt)); // Exponential backoff
        continue;
      }
      // Non-transient error or last attempt failed
      throw error;
    }
  }

  // Fallback (should not reach here)
  throw lastError;
};

/**
 * Internal: Process withdrawal request with atomic operations
 */
async function processWithdrawalRequest(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { driverId, amount, upiId } = req.body;
    const rawClientRequestId = req.body?.clientRequestId || req.body?.requestId || req.headers['x-request-id'];
    const clientRequestId = normalizeWithdrawalClientRequestId(rawClientRequestId);

    // ✅ Validate input
    if (!driverId || !amount) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        message: 'Missing required fields: driverId, amount' 
      });
    }

    if (amount <= 0 || amount < 100) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: 'Minimum withdrawal amount is ₹100' 
      });
    }

    if (!clientRequestId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'clientRequestId is required (8-100 chars, letters/numbers/:/_/-).',
      });
    }

    // ✅ Fetch driver and validate
    const driver = await User.findById(driverId).session(session);
    if (!driver) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    // ✅ Calculate referral balance from wallet transactions (same as frontend)
    let wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      wallet = new Wallet({
        driverId,
        availableBalance: 0,
        totalEarnings: 0,
        transactions: []
      });
    }

    // Calculate referral balance from transactions
    let referredBalance = 0;
    for (const txn of wallet.transactions) {
      const type = (txn.type || '').toLowerCase();
      const description = (txn.description || '').toLowerCase();
      const status = (txn.status || 'completed').toLowerCase();

      // Skip failed/cancelled transactions
      if (status === 'failed' || status === 'cancelled' || status === 'rejected') {
        continue;
      }

      // Identify referral transactions
      const isReferral = 
        type.includes('referral') ||
        description.includes('referral') ||
        description.includes('refer');

      if (!isReferral) continue;

      // Add/subtract based on transaction type
      const isDebit = type === 'debit' || type.includes('withdraw') || type.includes('payout');
      referredBalance += isDebit ? -txn.amount : txn.amount;
    }

    referredBalance = Math.max(0, referredBalance);

    if (referredBalance < amount) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: `Insufficient referred balance. Available: ₹${referredBalance.toFixed(2)}`
      });
    }

    const reservedWithdrawalAmount = Number(wallet.pendingWithdrawalAmount || 0);
    const withdrawableReferralBalance = Math.max(0, referredBalance - reservedWithdrawalAmount);
    if (withdrawableReferralBalance < amount) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Insufficient withdrawable balance. Available after pending withdrawals: ₹${withdrawableReferralBalance.toFixed(2)}`
      });
    }

    // ✅ Determine which UPI to use
    const finalUpiId = upiId || driver.driverPaymentDetails?.upiId;
    if (!finalUpiId || finalUpiId.trim() === '') {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: 'UPI ID required. Please save your UPI ID first.' 
      });
    }

    // ✅ Validate UPI format (basic)
    if (!finalUpiId.includes('@')) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid UPI format. Example: yourname@bankname' 
      });
    }

    // ✅ Preflight payout capability check before any debit.
    const payoutCapability = getWithdrawalPayoutCapability();
    if (!payoutCapability.liveReady && !payoutCapability.simulationMode && !payoutCapability.manualMode) {
      await session.abortTransaction();
      return res.status(503).json({
        success: false,
        message: 'Withdrawals are temporarily unavailable. RazorpayX payout setup is incomplete.',
        details: {
          missing: [
            !process.env.RAZORPAYX_KEY_ID ? 'RAZORPAYX_KEY_ID' : null,
            !process.env.RAZORPAYX_KEY_SECRET ? 'RAZORPAYX_KEY_SECRET' : null,
            !(process.env.RAZORPAYX_ACCOUNT_NUMBER || process.env.RAZORPAY_ACCOUNT_NUMBER) ? 'RAZORPAYX_ACCOUNT_NUMBER' : null
          ].filter(Boolean)
        }
      });
    }

    // ✅ Stable idempotency key derived from driver + client request id.
    const idempotencyKey = `wd_${driverId}_${clientRequestId}`;

    // ✅ Status-aware replay handling for duplicate client request ids.
    const existingWithdrawal = await WithdrawalRequest.findOne({
      driverId,
      clientRequestId,
    }).session(session);
    if (existingWithdrawal) {
      await session.abortTransaction();

      const normalizedStatus = String(existingWithdrawal.status || '').toLowerCase();
      if (normalizedStatus === 'pending' || normalizedStatus === 'processing') {
        return res.status(200).json({
          success: true,
          message: 'Withdrawal already in progress for this request ID.',
          idempotentReplay: true,
          withdrawalId: existingWithdrawal._id,
          status: existingWithdrawal.status,
          processingMode: existingWithdrawal.processingMode,
          amount: existingWithdrawal.amount,
          clientRequestId: existingWithdrawal.clientRequestId,
        });
      }

      if (normalizedStatus === 'completed') {
        return res.status(200).json({
          success: true,
          message: 'Withdrawal already completed for this request ID.',
          idempotentReplay: true,
          withdrawalId: existingWithdrawal._id,
          status: existingWithdrawal.status,
          processingMode: existingWithdrawal.processingMode,
          amount: existingWithdrawal.amount,
          clientRequestId: existingWithdrawal.clientRequestId,
          paymentReferenceId: existingWithdrawal.paymentReferenceId || null,
        });
      }

      return res.status(409).json({
        success: false,
        message: `Previous request with this clientRequestId ended with status: ${existingWithdrawal.status}. Use a new clientRequestId for retry.`,
        idempotentReplay: true,
        withdrawalId: existingWithdrawal._id,
        status: existingWithdrawal.status,
      });
    }

    // ✅ Record withdrawal request FIRST (so we can get its ID for wallet transaction)
    const withdrawalReq = new WithdrawalRequest({
      driverId,
      amount,
      upiId: finalUpiId,
      clientRequestId,
      status: 'pending',
      processingMode: payoutCapability.manualMode ? 'manual' : (payoutCapability.simulationMode ? 'simulation' : 'auto'),
      idempotencyKey,
      balanceDebited: !payoutCapability.manualMode,
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'],
    });

    try {
      await withdrawalReq.save({ session });
    } catch (saveError) {
      // Handle race where same clientRequestId is submitted concurrently.
      const isDuplicateKey = saveError?.code === 11000;
      if (!isDuplicateKey) {
        throw saveError;
      }

      const existing = await WithdrawalRequest.findOne({
        driverId,
        clientRequestId,
      }).session(session);

      await session.abortTransaction();

      if (!existing) {
        return res.status(409).json({
          success: false,
          message: 'Duplicate withdrawal request detected. Please check withdrawal history.',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Withdrawal already exists for this request ID.',
        idempotentReplay: true,
        withdrawalId: existing._id,
        status: existing.status,
        processingMode: existing.processingMode,
        amount: existing.amount,
        clientRequestId: existing.clientRequestId,
      });
    }

    // ✅ ATOMIC: Record withdrawal as debit in wallet using atomic operators
    // Use $push to add transaction and $inc to update balance atomically
    // This avoids write conflicts on large documents
    const newTransaction = {
      type: 'debit',
      amount,
      description: `Withdrawal request: ₹${amount} to ${finalUpiId}`,
      status: 'pending',
      razorpayOrderId: withdrawalReq._id.toString(),
      paymentMethod: 'upi',
      createdAt: new Date()
    };

    if (payoutCapability.manualMode) {
      await Wallet.findByIdAndUpdate(
        wallet._id,
        {
          $push: { transactions: newTransaction },
          $inc: { pendingWithdrawalAmount: amount }
        },
        { session, new: true }
      );
    } else {
      await Wallet.findByIdAndUpdate(
        wallet._id,
        {
          $push: { transactions: newTransaction },
          $inc: { availableBalance: -amount }
        },
        { session, new: true }
      );
    }

    // ✅ Save UPI to driver profile if new one provided
    if (upiId) {
      await User.findByIdAndUpdate(
        driverId,
        { 
          'driverPaymentDetails.upiId': finalUpiId,
          'driverPaymentDetails.savedAt': new Date(),
        },
        { session }
      );
    }

    await session.commitTransaction();

    console.log(`✅ Withdrawal requested: ₹${amount} | Driver: ${driverId} | UPI: ${finalUpiId}`);

    // Calculate remaining referral balance
    const remainingBalance = Math.max(0, referredBalance - amount);

    // ✅ Emit socket notification
    if (req.io) {
      req.io.to(`driver_${driverId}`).emit('withdrawal:initiated', {
        withdrawalId: withdrawalReq._id,
        amount,
        status: 'pending',
        upiId: finalUpiId,
        remainingBalance,
        timestamp: new Date().toISOString()
      });
    }

    // ✅ Async auto processing only when manual mode is disabled.
    if (!payoutCapability.manualMode) {
      setImmediate(() => {
        simulateRazorpayProcessing(withdrawalReq._id, driverId, amount, finalUpiId, req.io).catch(err => {
          console.error('❌ Processing failed:', err.message);
        });
      });
    }

    return res.json({
      success: true,
      message: payoutCapability.manualMode
        ? 'Withdrawal request submitted. Admin will verify and process manually.'
        : 'Withdrawal initiated successfully',
      withdrawalId: withdrawalReq._id,
      amount,
      status: 'pending',
      processingMode: withdrawalReq.processingMode,
      requiresAdminApproval: !!payoutCapability.manualMode,
      clientRequestId: withdrawalReq.clientRequestId,
      upiId: finalUpiId,
      remainingBalance,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ Withdrawal request error:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

/**
 * ASYNC: Create Razorpay payout contact + fund account + initiate transfer
 * Called in background after withdrawal request is recorded
 */
async function initiateRazorpayPayout(withdrawalId, driverId, amount, upiId, io) {
  try {
    // ✅ Check if Razorpay is initialized
    if (!razorpay) {
      console.error('❌ CRITICAL: Razorpay not initialized at payout time');
      throw new Error('Razorpay not initialized - environment variables not loaded properly');
    }

    console.log('✅ Razorpay ready for payout - Key ID:', process.env.RAZORPAY_KEY_ID?.substring(0, 10) + '...');

    // ✅ Create/fetch contact on Razorpay (using direct API calls)
    let contactId;
    const driver = await User.findById(driverId);
    
    console.log('🔍 Attempting to create Razorpay contact...');
    
    // Check if contact already exists
    const existingWithdrawal = await WithdrawalRequest.findOne({
      driverId,
      razorpayContactId: { $ne: null },
      status: { $in: ['completed', 'processing'] }
    });

    if (existingWithdrawal?.razorpayContactId) {
      contactId = existingWithdrawal.razorpayContactId;
      console.log(`ℹ️ Reusing contact: ${contactId}`);
    } else {
      // Create new contact using helper function
      console.log('📞 Creating new Razorpay Contact via API...');
      try {
        const contact = await razorpayApiCall('post', '/contacts', {
          type: 'customer',
          name: driver.name || 'Driver',
          email: driver.email || `driver${driverId}@app.local`,
          contact: driver.phone,
          reference_id: `driver_${driverId}`
        });
        contactId = contact.id;
        console.log(`✅ Created contact: ${contactId}`);
      } catch (contactError) {
        console.error('❌ Failed to create contact:', contactError.message);
        throw contactError;
      }
    }

    // ✅ Create fund account (UPI)
    let fundAccountId;
    const existingFundAccount = await WithdrawalRequest.findOne({
      driverId,
      razorpayFundAccountId: { $ne: null },
      'upiId': upiId
    });

    if (existingFundAccount?.razorpayFundAccountId) {
      fundAccountId = existingFundAccount.razorpayFundAccountId;
      console.log(`ℹ️ Reusing fund account: ${fundAccountId}`);
    } else {
      // Create fund account using helper function
      console.log('💳 Creating Razorpay Fund Account (UPI)...');
      try {
        let fundAccount;
        try {
          // RazorpayX expects VPA for UPI addresses.
          fundAccount = await razorpayApiCall('post', '/fund_accounts', {
            contact_id: contactId,
            account_type: 'vpa',
            vpa: {
              address: upiId
            }
          });
        } catch (primaryError) {
          // Backward-compatible retry for any account setups that still expect upi.
          if (!String(primaryError?.message || '').toLowerCase().includes('account type')) {
            throw primaryError;
          }
          fundAccount = await razorpayApiCall('post', '/fund_accounts', {
            contact_id: contactId,
            account_type: 'upi',
            upi: {
              address: upiId
            }
          });
        }
        fundAccountId = fundAccount.id;
        console.log(`✅ Created fund account: ${fundAccountId}`);
      } catch (fundError) {
        console.error('❌ Failed to create fund account:', fundError.message);
        throw fundError;
      }
    }

    // ✅ Initiate payout using helper function
    console.log('💰 Initiating Razorpay Payout...');
    try {
      const payoutPayload = {
        account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER || process.env.RAZORPAY_ACCOUNT_NUMBER || '1112220061746830',
        fund_account_id: fundAccountId,
        amount: Math.round(amount * 100),
        currency: 'INR',
        mode: 'UPI',
        purpose: 'payout',
        reference_id: withdrawalId.toString(),
        narration: 'Referral withdrawal',
        queue_if_low_balance: true
      };

      let payout;
      try {
        payout = await razorpayPayoutApiCall('post', '/payouts', payoutPayload);
      } catch (firstPayoutError) {
        const firstMessage = String(firstPayoutError?.message || '').toLowerCase();

        // Some accounts reject uppercase mode; retry once with lowercase.
        if (firstMessage.includes('requested url was not found')) {
          throw new Error('RazorpayX payout API not accessible. Use RazorpayX credentials (RAZORPAYX_KEY_ID/RAZORPAYX_KEY_SECRET) and account number (RAZORPAYX_ACCOUNT_NUMBER), and ensure RazorpayX is enabled on this account.');
        }

        if (firstMessage.includes('mode')) {
          payoutPayload.mode = 'upi';
          payout = await razorpayPayoutApiCall('post', '/payouts', payoutPayload);
        } else {
          throw firstPayoutError;
        }
      }

      console.log(`✅ Payout initiated: ${payout.id} | Amount: ₹${amount}`);

      // ✅ Update withdrawal request with payout ID
      await WithdrawalRequest.findByIdAndUpdate(withdrawalId, {
        razorpayPayoutId: payout.id,
        razorpayContactId: contactId,
        razorpayFundAccountId: fundAccountId,
        status: 'processing'
      });

      // ✅ Emit socket update
      if (io) {
        io.to(`driver_${driverId}`).emit('withdrawal:processing', {
          withdrawalId: withdrawalId.toString(),
          payoutId: payout.id,
          amount,
          status: 'processing',
          message: 'Payment processing...'
        });
      }
    } catch (payoutError) {
      console.error('❌ Failed to initiate payout:', payoutError.message);
      throw payoutError;
    }

  } catch (error) {
    console.error('❌ Razorpay payout error:', error.message);
    const publicFailureReason = getPublicWithdrawalFailureReason(error);

    // ✅ Mark withdrawal as failed and REFUND balance
    const withdrawal = await WithdrawalRequest.findById(withdrawalId);
    if (withdrawal && withdrawal.balanceDebited) {
      // Refund the amount back to wallet using atomic operator
      const refundTransaction = {
        type: 'refund',
        amount: withdrawal.amount,
        description: `Withdrawal refund: ₹${withdrawal.amount} - ${publicFailureReason}`,
        status: 'completed',
        razorpayOrderId: withdrawalId.toString(),
        paymentMethod: 'upi',
        createdAt: new Date()
      };

      // Use findOneAndUpdate since we're querying by driverId, not _id
      await Wallet.findOneAndUpdate(
        { driverId },
        {
          $push: { transactions: refundTransaction },
          $inc: { availableBalance: withdrawal.amount }
        }
      );

      // Mark withdrawal as failed
      await WithdrawalRequest.findByIdAndUpdate(withdrawalId, {
        status: 'failed',
        failureReason: publicFailureReason,
        webhookEvents: [{
          event: 'payout.failed',
          receivedAt: new Date(),
          rawPayload: { error: error.message }
        }]
      });

      console.log(`✅ Refunded ₹${withdrawal.amount} to driver ${driverId}`);

      // ✅ Emit failure notification
      if (io) {
        io.to(`driver_${driverId}`).emit('withdrawal:failed', {
          withdrawalId: withdrawalId.toString(),
          amount: withdrawal.amount,
          reason: error.message,
          refunded: true
        });
      }
    }
  }
}

/**
 * Safe wrapper for async payout processing.
 * Uses real Razorpay flow by default and supports simulation mode via env.
 */
async function simulateRazorpayProcessing(withdrawalId, driverId, amount, upiId, io) {
  const simulationMode = process.env.WITHDRAWAL_SIMULATION_ONLY === 'true';

  try {
    if (simulationMode) {
      await WithdrawalRequest.findByIdAndUpdate(withdrawalId, {
        status: 'completed',
        razorpayPayoutId: `sim_${Date.now()}`,
        processedAt: new Date(),
        webhookEvents: [{
          event: 'payout.processed.simulated',
          receivedAt: new Date(),
          rawPayload: { simulated: true }
        }]
      });

      await Wallet.updateOne(
        { driverId },
        {
          $set: {
            'transactions.$[txn].status': 'completed',
            'transactions.$[txn].description': `Withdrawal completed: ₹${amount} to ${upiId} (simulated)`
          }
        },
        {
          arrayFilters: [{
            'txn.razorpayOrderId': withdrawalId.toString(),
            'txn.status': 'pending'
          }]
        }
      );

      if (io) {
        io.to(`driver_${driverId}`).emit('withdrawal:completed', {
          withdrawalId: withdrawalId.toString(),
          amount,
          status: 'completed',
          simulated: true,
          timestamp: new Date().toISOString()
        });
      }

      console.log(`✅ Simulated payout complete: ₹${amount} | Driver: ${driverId}`);
      return;
    }

    await initiateRazorpayPayout(withdrawalId, driverId, amount, upiId, io);
  } catch (error) {
    console.error('❌ simulateRazorpayProcessing error:', error.message);
    await WithdrawalRequest.findByIdAndUpdate(withdrawalId, {
      status: 'failed',
      failureReason: `Processing error: ${error.message}`
    });
  }
}

/**
 * GET /api/withdrawal/history/:driverId
 * Fetch withdrawal history with statuses
 */
export const getWithdrawalHistory = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!driverId) {
      return res.status(400).json({ success: false, message: 'driverId required' });
    }

    const withdrawals = await WithdrawalRequest.find({ driverId })
      .sort({ initiatedAt: -1 })
      .lean();

    return res.json({
      success: true,
      withdrawals,
      count: withdrawals.length
    });

  } catch (error) {
    console.error('❌ History fetch error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch withdrawal history',
      error: error.message 
    });
  }
};

/**
 * PUT /api/user/:driverId/payment-details
 * Save or update UPI payment details
 */
export const updateDriverPaymentDetails = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { upiId } = req.body;

    if (!driverId || !upiId) {
      return res.status(400).json({ 
        success: false, 
        message: 'driverId and upiId required' 
      });
    }

    // Validate UPI format
    if (!upiId.includes('@')) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid UPI format. Example: yourname@bankname' 
      });
    }

    const driver = await User.findByIdAndUpdate(
      driverId,
      {
        'driverPaymentDetails.upiId': upiId.toLowerCase(),
        'driverPaymentDetails.savedAt': new Date()
      },
      { new: true }
    ).select('driverPaymentDetails');

    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    console.log(`✅ UPI updated for driver ${driverId}`);

    return res.json({
      success: true,
      message: 'Payment details saved successfully',
      upiId: driver.driverPaymentDetails?.upiId,
      savedAt: driver.driverPaymentDetails?.savedAt
    });

  } catch (error) {
    console.error('❌ Payment details update error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to update payment details',
      error: error.message 
    });
  }
};

/**
 * POST /api/withdrawal/save-upi
 * Quick endpoint to save UPI before withdrawal
 */
export const saveUpiForWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { driverId, upiId } = req.body;

    if (!driverId || !upiId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'driverId and upiId required' });
    }

    if (!upiId.includes('@')) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid UPI format' });
    }

    const driver = await User.findByIdAndUpdate(
      driverId,
      {
        'driverPaymentDetails.upiId': upiId.toLowerCase(),
        'driverPaymentDetails.savedAt': new Date()
      },
      { session, new: true }
    );

    await session.commitTransaction();

    return res.json({
      success: true,
      message: 'UPI saved successfully',
      upiId: driver.driverPaymentDetails?.upiId
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Save UPI error:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
};

/**
 * GET /api/withdrawal/status/:withdrawalId
 * Check withdrawal status and details
 */
export const getWithdrawalStatus = async (req, res) => {
  try {
    const { withdrawalId } = req.params;

    const withdrawal = await WithdrawalRequest.findById(withdrawalId).lean();
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    }

    return res.json({
      success: true,
      withdrawal
    });

  } catch (error) {
    console.error('❌ Status check error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/wallet/admin/withdrawal/:withdrawalId/mark-paid
 * Body: { paymentReferenceId, paymentProofImageUrl, notes }
 * Admin marks withdrawal as manually paid (idempotent + race-safe).
 */
export const markWithdrawalPaidByAdmin = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { withdrawalId } = req.params;
    const { paymentReferenceId, paymentProofImageUrl, notes } = req.body || {};

    if (!withdrawalId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'withdrawalId is required' });
    }

    if (!paymentReferenceId || !paymentProofImageUrl) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'paymentReferenceId and paymentProofImageUrl are required'
      });
    }

    // ✅ Prevent payment reference ID reuse across different settled withdrawals
    const refIdDuplicate = await WithdrawalRequest.findOne({
      paymentReferenceId: String(paymentReferenceId).trim().toUpperCase(),
      _id: { $ne: withdrawalId },
      settlementFinalized: true,
    }).select('_id driverId amount').session(session);

    if (refIdDuplicate) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: `Payment Reference ID "${paymentReferenceId}" is already used by another completed withdrawal. Use a unique reference ID.`,
        conflictingWithdrawalId: refIdDuplicate._id,
      });
    }

    const adminActor = req.admin || {};
    const now = new Date();

    const withdrawal = await WithdrawalRequest.findOneAndUpdate(
      {
        _id: withdrawalId,
        status: { $in: ['pending', 'processing'] },
        settlementFinalized: { $ne: true },
      },
      {
        $set: {
          status: 'completed',
          processingMode: 'manual',
          processedAt: now,
          settlementFinalized: true,
          finalizedAt: now,
          failureReason: null,
          paymentReferenceId: String(paymentReferenceId).trim(),
          paymentProofImageUrl: String(paymentProofImageUrl).trim(),
          manualPaymentNotes: notes ? String(notes).trim() : null,
          processedByAdminId: adminActor.id || adminActor._id || null,
          processedByAdminEmail: adminActor.email || null,
        }
      },
      { new: true, session }
    );

    if (!withdrawal) {
      const existing = await WithdrawalRequest.findById(withdrawalId).session(session);
      await session.abortTransaction();

      if (!existing) {
        return res.status(404).json({ success: false, message: 'Withdrawal request not found' });
      }

      if (existing.settlementFinalized) {
        return res.status(409).json({
          success: false,
          message: 'Withdrawal settlement is already finalized and cannot be changed',
          withdrawalId: existing._id,
          status: existing.status,
        });
      }

      if (existing.status === 'completed') {
        return res.status(409).json({
          success: false,
          message: 'Withdrawal is already marked as completed',
          withdrawalId: existing._id,
          status: existing.status,
        });
      }

      return res.status(409).json({
        success: false,
        message: `Withdrawal cannot be marked paid in ${existing.status} state`,
        status: existing.status,
      });
    }

    const walletUpdate = await Wallet.updateOne(
      {
        driverId: withdrawal.driverId,
        transactions: {
          $elemMatch: {
            razorpayOrderId: withdrawal._id.toString(),
            status: 'pending',
          }
        }
      },
      {
        $set: {
          'transactions.$[txn].status': 'completed',
          'transactions.$[txn].description': `Withdrawal completed manually. Ref: ${withdrawal.paymentReferenceId}`,
        },
        $inc: {
          availableBalance: -withdrawal.amount,
          pendingWithdrawalAmount: -withdrawal.amount,
        }
      },
      {
        session,
        arrayFilters: [
          {
            'txn.razorpayOrderId': withdrawal._id.toString(),
            'txn.status': 'pending',
          }
        ]
      }
    );

    if (!walletUpdate.matchedCount) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: 'No pending wallet transaction found for this withdrawal. Settlement blocked to prevent duplicate debit.',
      });
    }

    await session.commitTransaction();

    safeEmit(req.io, `driver_${withdrawal.driverId}`, 'withdrawal:completed', {
      withdrawalId: withdrawal._id,
      amount: withdrawal.amount,
      status: 'completed',
      manual: true,
      paymentReferenceId: withdrawal.paymentReferenceId,
      paymentProofImageUrl: withdrawal.paymentProofImageUrl,
      timestamp: new Date().toISOString(),
    });

    return res.json({
      success: true,
      message: 'Withdrawal marked as paid successfully',
      withdrawal,
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ markWithdrawalPaidByAdmin error:', error);
    return res.status(500).json({ success: false, message: 'Failed to mark withdrawal as paid', error: error.message });
  } finally {
    session.endSession();
  }
};

/**
 * POST /api/wallet/admin/withdrawal/:withdrawalId/reject
 * Body: { reason, notes }
 * Admin rejects a withdrawal and atomically refunds debited balance.
 */
export const rejectWithdrawalByAdmin = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { withdrawalId } = req.params;
    const { reason, notes } = req.body || {};

    if (!withdrawalId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'withdrawalId is required' });
    }

    const adminActor = req.admin || {};
    const rejectionReason = reason ? String(reason).trim() : 'Rejected by admin';

    const withdrawal = await WithdrawalRequest.findOneAndUpdate(
      {
        _id: withdrawalId,
        status: { $in: ['pending', 'processing'] },
        settlementFinalized: { $ne: true },
      },
      {
        $set: {
          status: 'failed',
          processingMode: 'manual',
          processedAt: new Date(),
          settlementFinalized: true,
          finalizedAt: new Date(),
          failureReason: rejectionReason,
          manualPaymentNotes: notes ? String(notes).trim() : null,
          processedByAdminId: adminActor.id || adminActor._id || null,
          processedByAdminEmail: adminActor.email || null,
        }
      },
      { new: true, session }
    );

    if (!withdrawal) {
      const existing = await WithdrawalRequest.findById(withdrawalId).session(session);
      await session.abortTransaction();

      if (!existing) {
        return res.status(404).json({ success: false, message: 'Withdrawal request not found' });
      }

      if (existing.settlementFinalized) {
        return res.status(409).json({
          success: false,
          message: 'Withdrawal settlement is already finalized and cannot be changed',
          withdrawalId: existing._id,
          status: existing.status,
        });
      }

      return res.status(409).json({
        success: false,
        message: `Withdrawal cannot be rejected in ${existing.status} state`,
        status: existing.status,
      });
    }

    if (withdrawal.balanceDebited) {
      const wallet = await Wallet.findOne({ driverId: withdrawal.driverId }).session(session);
      if (!wallet) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: 'Wallet not found for this driver' });
      }

      const alreadyRefunded = (wallet.transactions || []).some(
        t => t.razorpayOrderId === withdrawal._id.toString() && t.type === 'refund'
      );

      if (alreadyRefunded) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          message: 'Withdrawal was already refunded',
          withdrawalId: withdrawal._id,
        });
      }

      const walletUpdate = await Wallet.updateOne(
        {
          driverId: withdrawal.driverId,
          transactions: {
            $elemMatch: {
              razorpayOrderId: withdrawal._id.toString(),
              status: 'pending',
            }
          }
        },
        {
          $set: {
            'transactions.$[txn].status': 'failed',
            'transactions.$[txn].description': `Withdrawal rejected by admin: ${rejectionReason}`,
          },
          $push: {
            transactions: {
              type: 'refund',
              amount: withdrawal.amount,
              description: `Withdrawal refund by admin: ₹${withdrawal.amount}`,
              status: 'completed',
              razorpayOrderId: withdrawal._id.toString(),
              paymentMethod: 'upi',
              createdAt: new Date(),
            }
          },
          $inc: { availableBalance: withdrawal.amount }
        },
        {
          session,
          arrayFilters: [
            {
              'txn.razorpayOrderId': withdrawal._id.toString(),
              'txn.status': 'pending',
            }
          ]
        }
      );

      if (!walletUpdate.matchedCount) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          message: 'No pending wallet transaction found for this withdrawal. Reject blocked to prevent invalid refund.',
        });
      }
    } else {
      const walletUpdate = await Wallet.updateOne(
        {
          driverId: withdrawal.driverId,
          transactions: {
            $elemMatch: {
              razorpayOrderId: withdrawal._id.toString(),
              status: 'pending',
            }
          }
        },
        {
          $set: {
            'transactions.$[txn].status': 'failed',
            'transactions.$[txn].description': `Withdrawal rejected by admin: ${rejectionReason}`,
          },
          $inc: { pendingWithdrawalAmount: -withdrawal.amount }
        },
        {
          session,
          arrayFilters: [
            {
              'txn.razorpayOrderId': withdrawal._id.toString(),
              'txn.status': 'pending',
            }
          ]
        }
      );

      if (!walletUpdate.matchedCount) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          message: 'No pending wallet transaction found for this withdrawal. Reject blocked to prevent invalid reserve release.',
        });
      }
    }

    await session.commitTransaction();

    safeEmit(req.io, `driver_${withdrawal.driverId}`, 'withdrawal:failed', {
      withdrawalId: withdrawal._id,
      amount: withdrawal.amount,
      status: 'failed',
      reason: rejectionReason,
      refunded: !!withdrawal.balanceDebited,
      timestamp: new Date().toISOString(),
    });

    return res.json({
      success: true,
      message: 'Withdrawal rejected and refunded successfully',
      withdrawal,
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ rejectWithdrawalByAdmin error:', error);
    return res.status(500).json({ success: false, message: 'Failed to reject withdrawal', error: error.message });
  } finally {
    session.endSession();
  }
};

export const requestWithdrawal = requestWithdrawalPayout;
export const getWithdrawals = getWithdrawalHistory;
export const updatePaymentDetails = updateDriverPaymentDetails;