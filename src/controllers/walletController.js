// controllers/walletController.js - PRODUCTION PAYMENT SYSTEM

import Wallet from '../models/Wallet.js';
import Trip from '../models/Trip.js';
import PaymentTransaction from '../models/PaymentTransaction.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import mongoose from 'mongoose';

// ═══════════════════════════════════════════════════════════════════
// RAZORPAY INIT
// ═══════════════════════════════════════════════════════════════════
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

    const wallet = await Wallet.findOne({ driverId }).lean();
    if (!wallet) {
      return res.json({
        success: true,
        wallet: { driverId, availableBalance: 0, totalEarnings: 0, totalCommission: 0, pendingAmount: 0, paidCommission: 0, transactions: [] }
      });
    }
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
        .select('driverId availableBalance totalEarnings totalCommission pendingAmount lastUpdated')
        .sort({ [sortField]: sortOrder })
        .skip(skip).limit(Number(limit))
        .populate('driverId', 'name phone vehicleType')
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
          paidCommission: wallet.paidCommission || 0,
          unpaidCommission: (wallet.pendingAmount || 0),   // commission owed but not yet paid
          commissionPayments: wallet.transactions?.filter(t => t.type === 'commission_paid' && t.status === 'completed').length || 0
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

    // ✅ Only allow payout of availableBalance (not pendingAmount — that is commission debt)
    const safeAvailable = Math.max(0, (wallet.availableBalance || 0) - (wallet.pendingAmount || 0));
    if (safeAvailable < amount) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available after pending commission: ₹${safeAvailable.toFixed(2)}`
      });
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
          totalPaidCommission: { $sum: '$paidCommission' },   // ✅ NEW
          avgBalance: { $avg: '$availableBalance' }
        }
      }]),
      Wallet.aggregate([
        { $unwind: '$transactions' },
        { $match: {
          'transactions.createdAt': { $gte: (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })() },
          'transactions.type': { $in: ['credit', 'commission_paid'] },  // ✅ include commission paid today
          'transactions.status': 'completed'
        }},
        { $group: {
          _id: '$transactions.type',
          total: { $sum: '$transactions.amount' },
          count: { $sum: 1 }
        }}
      ])
    ]);

    const summary = stats[0] || { totalDrivers: 0, totalAvailableBalance: 0, totalEarnings: 0, totalCommission: 0, totalPending: 0, totalPaidCommission: 0, avgBalance: 0 };
    // todayStats is now an array with _id = type
    const todayCredit = todayStats.find(r => r._id === 'credit') || { total: 0, count: 0 };
    const todayCommPaid = todayStats.find(r => r._id === 'commission_paid') || { total: 0, count: 0 };

    return res.json({
      success: true,
      stats: {
        ...summary,
        todayTotalEarnings:    Math.round((todayCredit.total || 0) * 100) / 100,
        todayTransactions:     todayCredit.count || 0,
        todayCommissionPaid:   Math.round((todayCommPaid.total || 0) * 100) / 100,
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

    // ✅ Deduct pendingAmount
    const deducted = Math.min(wallet.pendingAmount, paidAmount);
    wallet.pendingAmount = Math.max(0, wallet.pendingAmount - deducted);
    // ✅ Track total lifetime commission paid to platform
    wallet.paidCommission = Math.round(((wallet.paidCommission || 0) + paidAmount) * 100) / 100;

    wallet.transactions.push({
      type: 'commission_paid',        // ✅ distinct type — shows in history as "Commission Paid"
      amount: paidAmount,
      description: `Commission paid to platform via Razorpay`,
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