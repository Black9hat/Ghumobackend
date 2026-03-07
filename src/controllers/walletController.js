// controllers/walletController.js - PRODUCTION PAYMENT SYSTEM
// ═══════════════════════════════════════════════════════════════════
// FIXES APPLIED:
// 🔴 Bug #1: confirmCashReceipt — added trip.walletUpdated atomic check (prevents double-credit)
// 🔴 Bug #2: confirmCashReceipt — replaced two wallet.save() with single atomic $inc+$push (prevents lost update)
// 🔴 Bug #3: processCashCollection — added trip.walletUpdated atomic check (prevents double-credit)
// 🟠 Bug #4: verifyDirectPayment — replaced wallet.save() with atomic $inc+$push (prevents race with webhook)
// 🟡 Bug #5: createDirectPaymentOrder, initiateCashPayment, processCashCollection, getTodayEarnings
//            — replaced hardcoded 0.20 with dynamic getCommissionRate(vehicleType)
// ═══════════════════════════════════════════════════════════════════

import Wallet from '../models/Wallet.js';
import Trip from '../models/Trip.js';
import PaymentTransaction from '../models/PaymentTransaction.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { getCommissionRate } from '../utils/getCommissionRate.js';

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
// ✅ FIX Bug #5: Dynamic commission from getCommissionRate()
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

    // ✅ FIX Bug #5: Dynamic commission rate from DB instead of hardcoded 0.20
    const commissionRate = await getCommissionRate(trip.vehicleType);
    const commission = Math.round(amount * commissionRate * 100) / 100;
    const driverAmount = Math.round((amount - commission) * 100) / 100;

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

    console.log(`✅ Order created: ${razorpayOrder.id} for trip ${tripId} | commission rate: ${Math.round(commissionRate * 100)}%`);

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
// ✅ FIX Bug #4: Replaced wallet.save() with atomic $inc+$push via
//    findOneAndUpdate — eliminates read-modify-write race with webhook
// ✅ FIX Bug #1 (partial): Added trip.walletUpdated idempotency guard
//    to prevent double-credit if socket + HTTP race occurs
// ═══════════════════════════════════════════════════════════════════
export const verifyDirectPayment = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let result = {};

    await session.withTransaction(async () => {
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature, tripId, driverId, customerId } = req.body;

      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        result = { status: 400, body: { success: false, message: 'Missing payment verification data' } };
        return;
      }

      // Verify signature
      const body = `${razorpayOrderId}|${razorpayPaymentId}`;
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest('hex');

      if (expectedSignature !== razorpaySignature) {
        result = { status: 400, body: { success: false, message: 'Payment verification failed - invalid signature' } };
        return;
      }

      // Check if payment already fully processed
      const existingPayment = await PaymentTransaction.findOne({
        razorpayPaymentId,
        paymentStatus: 'completed'
      }).session(session);

      if (existingPayment) {
        result = { status: 200, body: { success: true, message: 'Payment already processed', paymentId: razorpayPaymentId, alreadyProcessed: true } };
        return;
      }

      // Verify with Razorpay
      const payment = await razorpay.payments.fetch(razorpayPaymentId);
      if (!payment || payment.status !== 'captured') {
        result = { status: 400, body: { success: false, message: `Payment not completed. Status: ${payment?.status}` } };
        return;
      }

      // Update payment transaction atomically
      const paymentTxn = await PaymentTransaction.findOneAndUpdate(
        { razorpayOrderId, paymentStatus: { $ne: 'completed' } },
        {
          $set: {
            razorpayPaymentId,
            paymentStatus: 'completed',
            paymentMethod: payment.method,
            completedAt: new Date()
          },
          $inc: { processedCount: 1 }
        },
        { session, new: true }
      );

      if (!paymentTxn) {
        // Already completed by webhook or another request
        result = { status: 200, body: { success: true, message: 'Payment already processed', paymentId: razorpayPaymentId, alreadyProcessed: true } };
        return;
      }

      // ✅ FIX Bug #1: Claim walletUpdated flag atomically — prevents double-credit
      // if webhook + HTTP verify race each other
      const tripClaim = await Trip.findOneAndUpdate(
        { _id: tripId, walletUpdated: { $ne: true } },
        {
          $set: {
            walletUpdated: true,
            walletUpdatedAt: new Date(),
            paymentStatus: 'completed',
            paymentMethod: 'direct',
            razorpayPaymentId,
            paidAmount: paymentTxn.amount,
            completedAt: new Date()
          }
        },
        { session, new: false }
      ).lean();

      if (!tripClaim) {
        // Wallet already credited (webhook won the race) — still return success
        console.log(`⚠️ verifyDirectPayment: wallet already updated for trip ${tripId}`);
        const existingWallet = await Wallet.findOne({ driverId }).session(session).lean();
        result = {
          status: 200,
          body: {
            success: true,
            message: 'Payment verified (wallet already updated)',
            paymentId: razorpayPaymentId,
            alreadyProcessed: true,
            amount: paymentTxn.driverAmount,
            driverAmount: paymentTxn.driverAmount,
            commission: paymentTxn.commission,
            walletBalance: existingWallet?.availableBalance || 0
          }
        };
        return;
      }

      // ✅ FIX Bug #4: Atomic wallet update using $inc + $push
      // Eliminates read-modify-write race condition
      const updatedWallet = await Wallet.findOneAndUpdate(
        { driverId },
        {
          $inc: {
            availableBalance: paymentTxn.driverAmount,
            totalEarnings: paymentTxn.driverAmount,
            totalCommission: paymentTxn.commission
          },
          $push: {
            transactions: {
              tripId,
              type: 'credit',
              amount: paymentTxn.driverAmount,
              description: `Payment received from trip (₹${paymentTxn.amount})`,
              razorpayPaymentId,
              razorpayOrderId,
              paymentMethod: payment.method,
              status: 'completed',
              createdAt: new Date()
            },
            processedTripIds: tripId
          }
        },
        { session, new: true, upsert: true }
      );

      // Emit socket events (outside transaction is fine — they're fire-and-forget)
      result = {
        status: 200,
        body: {
          success: true,
          message: 'Payment verified successfully',
          paymentId: razorpayPaymentId,
          amount: paymentTxn.driverAmount,
          driverAmount: paymentTxn.driverAmount,
          commission: paymentTxn.commission,
          walletBalance: updatedWallet.availableBalance
        },
        emit: {
          driverId,
          customerId,
          tripId,
          driverAmount: paymentTxn.driverAmount,
          totalAmount: paymentTxn.amount,
          razorpayPaymentId,
          paymentMethod: payment.method
        }
      };
    });

    // Emit socket events AFTER transaction commits successfully
    if (result.emit) {
      const e = result.emit;
      safeEmit(req.io, `driver_${e.driverId}`, 'payment:received', {
        tripId: e.tripId, amount: e.driverAmount, paymentId: e.razorpayPaymentId,
        method: e.paymentMethod, timestamp: new Date().toISOString()
      });
      safeEmit(req.io, `customer_${e.customerId}`, 'payment:confirmed', {
        tripId: e.tripId, amount: e.totalAmount, paymentId: e.razorpayPaymentId,
        timestamp: new Date().toISOString()
      });
      console.log(`✅ Payment verified: ${e.razorpayPaymentId} | Driver: ${e.driverId} | ₹${e.driverAmount}`);
    }

    return res.status(result.status || 200).json(result.body);
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ Payment verification error:', error);
    return res.status(500).json({ success: false, message: 'Payment verification failed', error: error.message });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// INITIATE CASH PAYMENT (Customer side)
// POST /api/payment/cash/initiate
// ✅ FIX Bug #5: Dynamic commission from getCommissionRate()
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

    // ✅ FIX Bug #5: Dynamic commission rate from DB
    const commissionRate = await getCommissionRate(trip.vehicleType);
    const commission = Math.round(amount * commissionRate * 100) / 100;
    const driverAmount = amount; // Cash: driver keeps full amount, owes commission later

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

    console.log(`✅ Cash payment pending: ₹${amount} for trip ${tripId} | commission rate: ${Math.round(commissionRate * 100)}%`);

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
// CONFIRM CASH RECEIPT (Driver side) — walletController version
// POST /api/payment/cash/confirm  (via walletRoutes alias)
// ✅ FIX Bug #1: Uses walletUpdated atomic flag — prevents double-credit
//    if socket + HTTP race or if called from both tripController and here
// ✅ FIX Bug #2: Single atomic $inc+$push via findOneAndUpdate — no two
//    wallet.save() calls, no read-modify-write, no lost update
// ✅ FIX Bug #5: Dynamic commission from getCommissionRate(vehicleType)
// ═══════════════════════════════════════════════════════════════════
export const confirmCashReceipt = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let result = {};

    await session.withTransaction(async () => {
      const { paymentId, tripId, driverId, amount } = req.body;

      if (!tripId || !driverId) {
        result = { status: 400, body: { success: false, message: 'Missing tripId or driverId' } };
        return;
      }

      // ✅ FIX Bug #1: Claim the walletUpdated flag atomically — prevents double credit
      const trip = await Trip.findOneAndUpdate(
        { _id: tripId, walletUpdated: { $ne: true } },
        { $set: { walletUpdated: true, walletUpdatedAt: new Date() } },
        { session, new: false }
      ).lean();

      if (!trip) {
        console.log(`⚠️ confirmCashReceipt (walletController): already processed trip ${tripId}`);
        result = { status: 200, body: { success: true, message: 'Cash already confirmed', alreadyProcessed: true } };
        return;
      }

      const fareAmount = parseFloat(amount || trip.finalFare || trip.fare || 0);

      // ✅ FIX Bug #5: Dynamic commission from DB per vehicleType
      const commissionRate = await getCommissionRate(trip.vehicleType);
      const commission = Math.round(fareAmount * commissionRate * 100) / 100;
      const netAmount = Math.round((fareAmount - commission) * 100) / 100;

      // ✅ FIX Bug #2: Single atomic wallet update — no two .save() calls
      const updatedWallet = await Wallet.findOneAndUpdate(
        { driverId },
        {
          $inc: {
            totalEarnings: fareAmount,
            totalCommission: commission,
            pendingAmount: commission
          },
          $push: {
            transactions: {
              $each: [
                {
                  tripId, type: 'credit', amount: fareAmount,
                  description: 'Cash collected from trip',
                  paymentMethod: 'cash', status: 'completed',
                  createdAt: new Date()
                },
                {
                  tripId, type: 'commission', amount: commission,
                  description: `Platform commission (${Math.round(commissionRate * 100)}%)`,
                  paymentMethod: 'cash', status: 'completed',
                  createdAt: new Date()
                },
              ],
            },
            processedTripIds: tripId,
          },
        },
        { session, new: true, upsert: true }
      );

      // Update trip payment fields
      await Trip.findByIdAndUpdate(tripId, {
        $set: {
          paymentStatus: 'completed',
          paymentMethod: 'cash',
          paymentCollected: true,
          paymentCollectedAt: new Date(),
          paidAmount: fareAmount,
          paymentCompletedAt: new Date(),
          status: 'completed',
        },
      }, { session });

      // ✅ Release driver
      await User.findByIdAndUpdate(driverId, {
        $set: {
          isBusy: false,
          currentTripId: null,
          canReceiveNewRequests: true,
          awaitingCashCollection: false
        },
      }, { session });

      // Mark payment transaction complete if present
      if (paymentId) {
        await PaymentTransaction.findByIdAndUpdate(
          paymentId,
          {
            $set: { paymentStatus: 'completed', completedAt: new Date() },
            $inc: { processedCount: 1 }
          },
          { session }
        );
      }

      result = {
        status: 200,
        body: {
          success: true,
          message: 'Cash receipt confirmed',
          amount: fareAmount,
          driverAmount: netAmount,
          commission,
          walletBalance: updatedWallet.availableBalance,
          pendingAmount: updatedWallet.pendingAmount,
        },
        emit: {
          driverId, tripId, fareAmount, netAmount, commission,
          walletBalance: updatedWallet.availableBalance,
          pendingAmount: updatedWallet.pendingAmount
        }
      };
    });

    // Emit AFTER transaction commits — prevents emitting on rollback
    if (result.emit) {
      const e = result.emit;
      safeEmit(req.io, `driver_${e.driverId}`, 'payment:confirmed', {
        tripId: e.tripId, amount: e.fareAmount, driverAmount: e.netAmount,
        commission: e.commission, walletBalance: e.walletBalance,
        pendingAmount: e.pendingAmount, method: 'cash',
        timestamp: new Date().toISOString(),
      });
      console.log(`✅ confirmCashReceipt: ₹${e.fareAmount} | commission: ₹${e.commission} | driver: ${e.driverId}`);
    }

    return res.status(result.status || 200).json(result.body);
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ confirmCashReceipt error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Failed to confirm cash receipt' });
    }
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// PROCESS CASH COLLECTION (Used by walletRoutes POST /collect-cash)
// ✅ FIX Bug #3: Added walletUpdated atomic idempotency guard —
//    prevents double-credit on this second code path for cash
// ✅ FIX Bug #5: Dynamic commission from getCommissionRate(vehicleType)
// ═══════════════════════════════════════════════════════════════════
export const processCashCollection = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { tripId, driverId, amount, paymentMethod = 'cash' } = req.body;

    const missing = [];
    if (!tripId) missing.push('tripId');
    if (!driverId) missing.push('driverId');
    if (!amount && amount !== 0) missing.push('amount');
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `Missing: ${missing.join(', ')}` });
    }

    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number' });
    }

    let result = {};

    await session.withTransaction(async () => {
      // ✅ FIX Bug #3: Claim walletUpdated flag atomically — if already true, return early
      const trip = await Trip.findOneAndUpdate(
        { _id: tripId, walletUpdated: { $ne: true } },
        { $set: { walletUpdated: true, walletUpdatedAt: new Date() } },
        { session, new: false }
      ).lean();

      if (!trip) {
        console.log(`⚠️ processCashCollection: trip ${tripId} already processed`);
        result = { status: 200, body: { success: true, message: 'Cash already collected', alreadyProcessed: true } };
        return;
      }

      // ✅ FIX Bug #5: Commission from Rate model per vehicleType
      const commissionRate = await getCommissionRate(trip.vehicleType);
      const commission = Math.round(numericAmount * commissionRate * 100) / 100;
      const driverNet = Math.round((numericAmount - commission) * 100) / 100;

      // ✅ Atomic wallet update — single findOneAndUpdate, no .save()
      const updatedWallet = await Wallet.findOneAndUpdate(
        { driverId },
        {
          $inc: {
            totalEarnings: numericAmount,
            totalCommission: commission,
            pendingAmount: commission
          },
          $push: {
            transactions: {
              $each: [
                {
                  tripId, type: 'credit', amount: numericAmount,
                  description: 'Cash collected for trip',
                  paymentMethod, status: 'completed',
                  createdAt: new Date()
                },
                {
                  tripId, type: 'commission', amount: commission,
                  description: `Platform commission (${Math.round(commissionRate * 100)}%)`,
                  paymentMethod, status: 'completed',
                  createdAt: new Date()
                },
              ],
            },
            processedTripIds: tripId,
          },
        },
        { session, new: true, upsert: true }
      );

      // Update trip
      await Trip.findByIdAndUpdate(tripId, {
        $set: {
          paymentStatus: 'completed',
          paymentMethod,
          paidAmount: numericAmount,
          paymentCollected: true,
          paymentCollectedAt: new Date(),
          status: 'completed',
        },
      }, { session });

      // ✅ Release driver
      await User.findByIdAndUpdate(driverId, {
        $set: {
          isBusy: false,
          currentTripId: null,
          canReceiveNewRequests: true,
          awaitingCashCollection: false
        },
      }, { session });

      result = {
        status: 200,
        body: {
          success: true,
          message: 'Cash collection recorded',
          amount: numericAmount,
          commission,
          driverNet,
          walletBalance: updatedWallet.availableBalance,
          pendingAmount: updatedWallet.pendingAmount,
        },
        emit: {
          driverId, tripId, driverNet, commission, paymentMethod,
          walletBalance: updatedWallet.availableBalance,
          pendingAmount: updatedWallet.pendingAmount
        }
      };
    });

    // Emit AFTER transaction commits
    if (result.emit) {
      const e = result.emit;
      safeEmit(req.io, `driver_${e.driverId}`, 'payment:confirmed', {
        tripId: e.tripId, amount: e.driverNet, commission: e.commission,
        method: e.paymentMethod, walletBalance: e.walletBalance,
        pendingAmount: e.pendingAmount,
        timestamp: new Date().toISOString(),
      });
      console.log(`✅ processCashCollection: ₹${result.body.amount} | commission: ₹${e.commission} | driver net: ₹${e.driverNet}`);
    }

    return res.status(result.status || 200).json(result.body);
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ processCashCollection error:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
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
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Check if already processed
      const existing = await PaymentTransaction.findOne({
        razorpayPaymentId: payment.id, paymentStatus: 'completed'
      }).session(session);

      if (existing) {
        console.log(`ℹ️ Webhook: payment ${payment.id} already completed`);
        return;
      }

      // Find and update the payment transaction
      const paymentTxn = await PaymentTransaction.findOneAndUpdate(
        { razorpayOrderId: payment.order_id, paymentStatus: { $ne: 'completed' } },
        {
          $set: {
            razorpayPaymentId: payment.id,
            paymentStatus: 'completed',
            paymentMethod: payment.method,
            webhookStatus: 'completed',
            webhookReceivedAt: new Date(),
            completedAt: new Date()
          },
          $inc: { processedCount: 1 }
        },
        { session, new: true }
      );

      if (!paymentTxn) {
        // Either no matching order or already completed
        await PaymentTransaction.findOneAndUpdate(
          { razorpayPaymentId: payment.id },
          { $set: { webhookStatus: 'completed', webhookReceivedAt: new Date() } },
          { session }
        );
        return;
      }

      // ✅ Claim walletUpdated atomically — same guard as verifyDirectPayment
      if (paymentTxn.tripId) {
        const tripClaim = await Trip.findOneAndUpdate(
          { _id: paymentTxn.tripId, walletUpdated: { $ne: true } },
          {
            $set: {
              walletUpdated: true,
              walletUpdatedAt: new Date(),
              paymentStatus: 'completed',
              paymentMethod: 'direct',
              razorpayPaymentId: payment.id,
              paidAmount: paymentTxn.amount,
              completedAt: new Date()
            }
          },
          { session, new: false }
        ).lean();

        if (tripClaim && paymentTxn.driverId) {
          // Wallet not yet credited — do it now
          await Wallet.findOneAndUpdate(
            { driverId: paymentTxn.driverId },
            {
              $inc: {
                availableBalance: paymentTxn.driverAmount,
                totalEarnings: paymentTxn.driverAmount,
                totalCommission: paymentTxn.commission
              },
              $push: {
                transactions: {
                  tripId: paymentTxn.tripId,
                  type: 'credit',
                  amount: paymentTxn.driverAmount,
                  description: `Payment received via webhook (₹${paymentTxn.amount})`,
                  razorpayPaymentId: payment.id,
                  razorpayOrderId: payment.order_id,
                  paymentMethod: payment.method,
                  status: 'completed',
                  createdAt: new Date()
                },
                processedTripIds: paymentTxn.tripId
              }
            },
            { session, upsert: true }
          );
          console.log(`✅ Webhook credited wallet: ${payment.id} | driver: ${paymentTxn.driverId}`);
        } else {
          console.log(`ℹ️ Webhook: wallet already updated for trip ${paymentTxn.tripId}`);
        }
      }
    });

    console.log(`✅ Webhook confirmed: ${payment.id}`);
  } catch (err) {
    console.error('❌ Webhook captured handler error:', err);
  } finally {
    session.endSession();
  }
}

async function handlePaymentFailedWebhook(payment) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await PaymentTransaction.findOneAndUpdate(
        { razorpayOrderId: payment.order_id },
        {
          $set: {
            paymentStatus: 'failed',
            webhookStatus: 'completed',
            webhookReceivedAt: new Date()
          }
        },
        { session }
      );

      // Also update trip status
      const txn = await PaymentTransaction.findOne({ razorpayOrderId: payment.order_id }).session(session).lean();
      if (txn?.tripId) {
        await Trip.findByIdAndUpdate(txn.tripId, {
          $set: { paymentStatus: 'failed' }
        }, { session });
      }
    });
    console.log(`❌ Webhook failed: ${payment.order_id}`);
  } catch (err) {
    console.error('❌ Webhook failed handler error:', err);
  } finally {
    session.endSession();
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
        wallet: {
          driverId, availableBalance: 0, totalEarnings: 0,
          totalCommission: 0, pendingAmount: 0, transactions: []
        }
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
// ✅ FIX Bug #5: Compute today's commission from actual commission
//    transactions instead of hardcoded 0.20
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

    const todayCommissionTxns = (wallet.transactions || []).filter(
      t => t.type === 'commission' && new Date(t.createdAt) >= startOfDay
    );

    const todayEarnings = todayTxns.reduce((sum, t) => sum + (t.amount || 0), 0);

    // ✅ FIX Bug #5: Sum actual commission transactions instead of hardcoded 0.20
    const todayCommission = todayCommissionTxns.reduce((sum, t) => sum + (t.amount || 0), 0);

    return res.json({
      success: true,
      todayEarnings: Math.round(todayEarnings * 100) / 100,
      todayTrips: todayTxns.length,
      todayCommission: Math.round(todayCommission * 100) / 100,
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
        .select('driverId availableBalance totalEarnings totalCommission pendingAmount transactions lastUpdated')
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
          netEarnings: (wallet.totalEarnings || 0) - (wallet.totalCommission || 0)
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
    if (type) transactions = transactions.filter(t => t.type === type);
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
// ✅ Uses atomic $inc + $push instead of read-modify-write
// ═══════════════════════════════════════════════════════════════════
export const processManualPayout = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { driverId } = req.params;
    const { amount, description, adminId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }

    let result = {};

    await session.withTransaction(async () => {
      // Atomic: only deduct if sufficient balance
      const updatedWallet = await Wallet.findOneAndUpdate(
        { driverId, availableBalance: { $gte: amount } },
        {
          $inc: { availableBalance: -amount },
          $push: {
            transactions: {
              type: 'debit',
              amount,
              description: description || 'Manual payout by admin',
              paymentMethod: 'bank_transfer',
              status: 'completed',
              createdAt: new Date()
            }
          }
        },
        { session, new: true }
      );

      if (!updatedWallet) {
        // Check if wallet exists vs insufficient balance
        const wallet = await Wallet.findOne({ driverId }).session(session).lean();
        if (!wallet) {
          result = { status: 404, body: { success: false, message: 'Wallet not found' } };
        } else {
          result = {
            status: 400,
            body: { success: false, message: `Insufficient balance. Available: ₹${wallet.availableBalance}` }
          };
        }
        return;
      }

      result = {
        status: 200,
        body: {
          success: true,
          message: `₹${amount} payout processed`,
          newBalance: updatedWallet.availableBalance
        }
      };
    });

    console.log(`✅ Manual payout: ₹${amount} from driver ${driverId} by admin ${adminId}`);
    return res.status(result.status || 200).json(result.body);
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
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
          avgBalance: { $avg: '$availableBalance' }
        }
      }]),
      Wallet.aggregate([
        { $unwind: '$transactions' },
        {
          $match: {
            'transactions.createdAt': {
              $gte: (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })()
            },
            'transactions.type': 'credit',
            'transactions.status': 'completed'
          }
        },
        {
          $group: {
            _id: null,
            todayTotalEarnings: { $sum: '$transactions.amount' },
            todayTransactions: { $sum: 1 }
          }
        }
      ])
    ]);

    const summary = stats[0] || {
      totalDrivers: 0, totalAvailableBalance: 0, totalEarnings: 0,
      totalCommission: 0, totalPending: 0, avgBalance: 0
    };
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
// CREATE COMMISSION PAYMENT ORDER (Driver pays pending commission)
// POST /api/wallet/create-commission-order
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
      amount: Math.round(numericAmount * 100),
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
      razorpayKeyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    console.error('❌ createCommissionOrder error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create commission order', error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// VERIFY COMMISSION PAYMENT
// POST /api/wallet/verify-commission
// ✅ Uses atomic $inc + $push with double-checked locking
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

    // ✅ Step 3: Fetch from Razorpay with timeout
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

    // ✅ Step 4: Atomic transaction — uses $inc + conditional update
    let result = {};

    session.startTransaction();

    // Atomic: only deduct if this paymentId hasn't been recorded yet
    // Use a unique marker to prevent double processing
    const updateResult = await Wallet.findOneAndUpdate(
      {
        driverId,
        'transactions.razorpayPaymentId': { $ne: paymentId }
      },
      {
        $inc: { pendingAmount: -paidAmount },
        $push: {
          transactions: {
            type: 'commission',
            amount: paidAmount,
            description: `Commission paid via Razorpay`,
            razorpayPaymentId: paymentId,
            razorpayOrderId: orderId,
            paymentMethod,
            status: 'completed',
            createdAt: new Date()
          }
        }
      },
      { session, new: true }
    );

    if (!updateResult) {
      // Either wallet not found or paymentId already exists
      const walletExists = await Wallet.findOne({ driverId }).session(session).lean();
      await session.abortTransaction();

      if (!walletExists) {
        return res.status(404).json({ success: false, message: 'Wallet not found' });
      }

      // Already processed
      return res.json({
        success: true,
        message: 'Commission already processed',
        alreadyProcessed: true,
        paidAmount: 0,
        pendingAmount: walletExists.pendingAmount,
        availableBalance: walletExists.availableBalance
      });
    }

    // Ensure pendingAmount doesn't go negative
    if (updateResult.pendingAmount < 0) {
      await Wallet.findOneAndUpdate(
        { driverId },
        { $set: { pendingAmount: 0 } },
        { session }
      );
      updateResult.pendingAmount = 0;
    }

    await session.commitTransaction();

    console.log(`✅ Commission verified: ₹${paidAmount} | driver: ${driverId} | pending: ₹${Math.max(0, updateResult.pendingAmount)}`);

    // ✅ Emit socket after commit
    safeEmit(req.io, `driver_${driverId}`, 'commission:paid', {
      paidAmount,
      pendingAmount: Math.max(0, updateResult.pendingAmount),
      availableBalance: updateResult.availableBalance,
      paymentId,
      timestamp: new Date().toISOString()
    });

    return res.json({
      success: true,
      message: 'Commission payment verified',
      paidAmount,
      pendingAmount: Math.max(0, updateResult.pendingAmount),
      availableBalance: updateResult.availableBalance
    });

  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ verifyCommissionPayment error:', error);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// NAMED ALIASES (for backward compatibility)
// ═══════════════════════════════════════════════════════════════════
export const createRazorpayOrder = createDirectPaymentOrder;
export const verifyRazorpayPayment = verifyDirectPayment;
export const processCashPaymentHandler = initiateCashPayment;
export const confirmCashPayment = confirmCashReceipt;
export const razorpayWebhook = handleRazorpayWebhook;