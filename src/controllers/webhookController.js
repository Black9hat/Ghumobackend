// controllers/webhookController_ENHANCED.js - Plan Payment Webhook Handler

import crypto from 'crypto';
import mongoose from 'mongoose';
import Wallet from '../models/Wallet.js';
import PaymentPlan from '../models/PaymentPlan.js';
import DriverPlan from '../models/DriverPlan.js';
import Plan from '../models/Plan.js';

// ════════════════════════════════════════════════════════════════════
// IN-MEMORY DEDUPLICATION
// ════════════════════════════════════════════════════════════════════
const _processedWebhookIds = new Set();
const _MAX_WEBHOOK_CACHE = 500;

const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const webhookSignature = req.headers['x-razorpay-signature'];
    const eventId = req.headers['x-razorpay-event-id'] ?? null;

    // ✅ DEDUP: Reject duplicate webhook deliveries immediately
    if (eventId) {
      if (_processedWebhookIds.has(eventId)) {
        console.log(`ℹ️ Duplicate webhook event ${eventId} — ignoring`);
        return res.status(200).json({ success: true, duplicate: true });
      }
      if (_processedWebhookIds.size >= _MAX_WEBHOOK_CACHE) {
        const first = _processedWebhookIds.values().next().value;
        _processedWebhookIds.delete(first);
      }
      _processedWebhookIds.add(eventId);
    }

    if (!webhookSecret) {
      console.error('⚠️ RAZORPAY_WEBHOOK_SECRET not set');
      return res.status(500).json({ success: false });
    }
    if (!webhookSignature) {
      console.error('❌ Missing x-razorpay-signature');
      return res.status(400).json({ success: false });
    }

    // ✅ Verify signature using raw body
    const rawBody = req.rawBody || req.body;
    const bodyString = Buffer.isBuffer(rawBody)
      ? rawBody.toString()
      : typeof rawBody === 'string'
        ? rawBody
        : JSON.stringify(rawBody);

    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(bodyString)
      .digest('hex');

    if (expectedSig !== webhookSignature) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const webhookBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { event, payload } = webhookBody;

    console.log('📥 Webhook event:', event);

    // ✅ Respond 200 IMMEDIATELY
    res.status(200).json({ success: true, received: true });

    // Process async
    switch (event) {
      case 'payment.authorized':
        console.log(`ℹ️ payment.authorized: ${payload.payment.entity.id} — waiting for capture`);
        break;

      case 'payment.captured':
        // Could be wallet commission OR plan purchase
        if (payload.payment.entity.notes?.type === 'plan_purchase') {
          await handlePlanPaymentCaptured(payload.payment.entity, req.io);
        } else {
          // Original wallet commission logic
          await handleWalletPaymentCaptured(payload.payment.entity, req.io);
        }
        break;

      case 'payment.failed':
        if (payload.payment.entity.notes?.type === 'plan_purchase') {
          await handlePlanPaymentFailed(payload.payment.entity, req.io);
        } else {
          await handleWalletPaymentFailed(payload.payment.entity, req.io);
        }
        break;

      case 'order.paid':
        // Check type in notes
        if (payload.payment?.entity.notes?.type === 'plan_purchase') {
          await handlePlanOrderPaid(payload.order.entity, payload.payment?.entity, req.io);
        } else {
          await handleWalletOrderPaid(payload.order.entity, payload.payment?.entity, req.io);
        }
        break;

      default:
        console.log('ℹ️ Unhandled webhook event:', event);
    }
  } catch (err) {
    console.error('🔥 Webhook error:', err);
    if (!res.headersSent) {
      res.status(200).json({ success: false });
    }
  }
};

// ════════════════════════════════════════════════════════════════════
// PLAN PAYMENT HANDLERS
// ════════════════════════════════════════════════════════════════════

const handlePlanPaymentCaptured = async (payment, io) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const driverId = payment.notes?.driverId;
    const planId = payment.notes?.planId;

    if (!driverId || !planId) {
      console.log('ℹ️ Incomplete plan payment notes — skipping');
      await session.abortTransaction();
      return;
    }

    const paymentId = payment.id;
    const orderId = payment.order_id;

    // ── Find payment record ──
    const paymentRecord = await PaymentPlan.findOne({
      razorpayOrderId: orderId,
      driverId,
    }).session(session);

    if (!paymentRecord) {
      console.log('ℹ️ PaymentPlan record not found for order:', orderId);
      await session.abortTransaction();
      return;
    }

    // ── Check if already processed ──
    if (paymentRecord.webhookProcessed) {
      await session.abortTransaction();
      console.log(`ℹ️ PaymentPlan ${orderId} already processed — webhook skipping`);

      if (io && paymentRecord.driverPlanId) {
        io.to(`driver_${driverId}`).emit('plan:activated', {
          planName: paymentRecord.planName,
          validTill: new Date(
            paymentRecord.completedAt.getTime() + paymentRecord.planDurationDays * 24 * 60 * 60 * 1000
          ).toISOString(),
          alreadyProcessed: true,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    // ── Fetch plan ──
    const plan = await Plan.findById(planId).session(session);
    if (!plan) {
      console.error('❌ Plan not found:', planId);
      await session.abortTransaction();
      return;
    }

    // ── Create DriverPlan ──
    const now = new Date();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + plan.durationDays);

    const driverPlan = new DriverPlan({
      driver: driverId,
      plan: planId,
      planName: plan.planName,
      planType: plan.planType,
      description: plan.description,
      commissionRate: plan.commissionRate,
      bonusMultiplier: plan.bonusMultiplier,
      noCommission: plan.noCommission,
      monthlyFee: plan.monthlyFee,
      benefits: plan.benefits,
      planPrice: plan.planPrice,
      durationDays: plan.durationDays,
      isTimeBasedPlan: plan.isTimeBasedPlan,
      planStartTime: plan.planStartTime,
      planEndTime: plan.planEndTime,
      isActive: true,
      activatedDate: now,
      expiryDate,
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId,
      amountPaid: paymentRecord.amount,
      planPurchaseDate: now,
      paymentStatus: 'completed',
      purchaseMethod: 'driver_purchase',
    });

    await driverPlan.save({ session });

    // ── Update payment record ──
    paymentRecord.razorpayPaymentId = paymentId;
    paymentRecord.paymentStatus = 'captured';
    paymentRecord.capturedAt = now;
    paymentRecord.driverPlanId = driverPlan._id;
    paymentRecord.webhookProcessed = true;
    paymentRecord.webhookProcessedAt = now;

    await paymentRecord.save({ session });

    // ── Update Plan stats ──
    plan.totalPurchases += 1;
    plan.totalRevenueGenerated += paymentRecord.amount;
    plan.lastPurchaseDate = now;
    await plan.save({ session });

    // ── Add wallet transaction ──
    const wallet = await Wallet.findOne({ driverId }).session(session);
    if (wallet) {
      wallet.transactions.push({
        type: 'plan_purchase',
        amount: paymentRecord.amount,
        description: `Plan purchase: ${plan.planName}`,
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        paymentMethod: 'razorpay',
        status: 'completed',
        createdAt: now,
      });
      await wallet.save({ session });
    }

    await session.commitTransaction();

    console.log(`✅ Plan payment captured: ${paymentId} | Driver: ${driverId} | Plan: ${plan.planName}`);

    // ── Emit socket notification ──
    if (io) {
      io.to(`driver_${driverId}`).emit('plan:activated', {
        planName: plan.planName,
        validTill: expiryDate.toISOString(),
        benefits: plan.benefits,
        message: `✅ Plan "${plan.planName}" activated successfully!`,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ handlePlanPaymentCaptured error:', err);
  } finally {
    session.endSession();
  }
};

const handlePlanPaymentFailed = async (payment, io) => {
  try {
    const driverId = payment.notes?.driverId;
    const planId = payment.notes?.planId;

    if (!driverId || !planId) return;

    const orderId = payment.order_id;

    console.log(`❌ Plan payment failed: ${payment.id} | ${payment.error_description}`);

    await PaymentPlan.updateOne(
      { razorpayOrderId: orderId },
      {
        $set: {
          paymentStatus: 'failed',
          errorDetails: {
            code: payment.error_code,
            message: payment.error_description,
            timestamp: new Date(),
          },
        },
      }
    );

    if (io) {
      io.to(`driver_${driverId}`).emit('plan:paymentFailed', {
        paymentId: payment.id,
        error: payment.error_description || 'Payment failed',
        message: 'Failed to activate plan. Please try again.',
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('❌ handlePlanPaymentFailed error:', err);
  }
};

const handlePlanOrderPaid = async (order, payment, io) => {
  try {
    // order.paid fires after payment.captured
    // Plan already activated in handlePlanPaymentCaptured
    // Just emit confirmation

    const driverId = order.notes?.driverId;
    if (!driverId || !io) return;

    const driverPlan = await DriverPlan.findOne({
      driver: driverId,
      isActive: true,
      expiryDate: { $gte: new Date() },
    }).select('planName expiryDate benefits');

    if (driverPlan) {
      io.to(`driver_${driverId}`).emit('plan:confirmed', {
        orderId: order.id,
        planName: driverPlan.planName,
        validTill: driverPlan.expiryDate.toISOString(),
        benefits: driverPlan.benefits,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('❌ handlePlanOrderPaid error:', err);
  }
};

// ════════════════════════════════════════════════════════════════════
// WALLET PAYMENT HANDLERS (Original logic - unchanged)
// ════════════════════════════════════════════════════════════════════

const handleWalletPaymentCaptured = async (payment, io) => {
  // Original wallet commission logic
  const session = await mongoose.startSession();
  try {
    const driverId = payment.notes?.driverId;
    if (!driverId) {
      console.log('ℹ️ No driverId in payment notes — skipping wallet update');
      return;
    }

    const paidAmount = payment.amount / 100;
    const paymentId = payment.id;

    session.startTransaction();

    const wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      await session.abortTransaction();
      console.error(`❌ Wallet not found for driver ${driverId}`);
      return;
    }

    const alreadyDone = wallet.transactions.some(
      (t) => t.razorpayPaymentId === paymentId && t.status === 'completed'
    );

    if (alreadyDone) {
      await session.abortTransaction();
      console.log(`ℹ️ ${paymentId} already in wallet — webhook skipping DB write`);

      if (io) {
        io.to(`driver_${driverId}`).emit('commission:paid', {
          paidAmount,
          pendingAmount: wallet.pendingAmount,
          availableBalance: wallet.availableBalance,
          paymentId,
          alreadyProcessed: true,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    const deducted = Math.min(wallet.pendingAmount, paidAmount);
    wallet.pendingAmount = Math.max(0, wallet.pendingAmount - deducted);
    wallet.totalCommission = (wallet.totalCommission || 0) + paidAmount;
    wallet.transactions.push({
      type: 'commission',
      amount: paidAmount,
      description: `Commission paid via Razorpay`,
      razorpayPaymentId: paymentId,
      razorpayOrderId: payment.order_id,
      paymentMethod: payment.method || 'upi',
      status: 'completed',
      createdAt: new Date(),
    });

    await wallet.save({ session });
    await session.commitTransaction();

    console.log(`✅ Webhook updated wallet: ₹${paidAmount} | pending: ₹${wallet.pendingAmount}`);

    if (io) {
      io.to(`driver_${driverId}`).emit('commission:paid', {
        paidAmount,
        pendingAmount: wallet.pendingAmount,
        availableBalance: wallet.availableBalance,
        paymentId,
        message: `₹${paidAmount} commission paid`,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ handleWalletPaymentCaptured error:', err);
  } finally {
    session.endSession();
  }
};

const handleWalletPaymentFailed = async (payment, io) => {
  try {
    const driverId = payment.notes?.driverId;
    if (!driverId) return;

    console.log(`❌ Payment failed: ${payment.id} | ${payment.error_description}`);

    await Wallet.updateOne(
      {
        driverId,
        'transactions.razorpayOrderId': payment.order_id,
        'transactions.status': 'pending',
      },
      { $set: { 'transactions.$.status': 'failed' } }
    );

    if (io) {
      io.to(`driver_${driverId}`).emit('payment:failed', {
        paymentId: payment.id,
        error: payment.error_description || 'Payment failed',
        message: 'Payment failed. Please try again.',
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('❌ handleWalletPaymentFailed error:', err);
  }
};

const handleWalletOrderPaid = async (order, payment, io) => {
  try {
    const driverId = order.notes?.driverId;
    if (!driverId || !io) return;

    const wallet = await Wallet.findOne({ driverId }).select('pendingAmount availableBalance').lean();

    if (wallet) {
      io.to(`driver_${driverId}`).emit('commission:paid', {
        orderId: order.id,
        paidAmount: order.amount / 100,
        pendingAmount: wallet.pendingAmount,
        availableBalance: wallet.availableBalance,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('❌ handleWalletOrderPaid error:', err);
  }
};

const testWebhook = async (req, res) => {
  console.log('🧪 Test webhook:', req.body);
  res.status(200).json({ success: true, timestamp: new Date().toISOString() });
};

export {
  handleRazorpayWebhook,
  testWebhook,
};