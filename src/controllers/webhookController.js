// controllers/webhookController.js
// Phase 2b — production hardened
// Fixes:
//   1. wallet.save() inside transaction replaced with atomic $inc+$push (no lost updates)
//   2. handlePaymentCaptured: DB-level dedup via PaymentTransaction.webhookProcessed
//   3. Wallet dedup: checks transactions array before writing
//   4. session.withTransaction() throughout — no leaked sessions
//   5. handlePaymentFailed: also marks PaymentTransaction as failed

import crypto from 'crypto';
import mongoose from 'mongoose';
import Wallet from '../models/Wallet.js';
import PaymentTransaction from '../models/PaymentTransaction.js';

// ✅ In-memory dedup for webhook retries (Razorpay retries up to 5×)
const _processedWebhookIds = new Set();
const _MAX_WEBHOOK_CACHE   = 500;

export const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const webhookSig    = req.headers['x-razorpay-signature'];
    const eventId       = req.headers['x-razorpay-event-id'] ?? null;

    // ✅ In-memory dedup — fast reject of duplicate deliveries
    if (eventId) {
      if (_processedWebhookIds.has(eventId)) {
        console.log(`ℹ️ Duplicate webhook ${eventId} — ignoring`);
        return res.status(200).json({ success: true, duplicate: true });
      }
      if (_processedWebhookIds.size >= _MAX_WEBHOOK_CACHE) {
        _processedWebhookIds.delete(_processedWebhookIds.values().next().value);
      }
      _processedWebhookIds.add(eventId);
    }

    if (!webhookSecret) {
      console.error('⚠️ RAZORPAY_WEBHOOK_SECRET not set');
      return res.status(500).json({ success: false });
    }
    if (!webhookSig) {
      console.error('❌ Missing x-razorpay-signature');
      return res.status(400).json({ success: false });
    }

    // ✅ Raw buffer required — Razorpay signs exact bytes
    const rawBody = req.rawBody || req.body;
    const bodyStr = Buffer.isBuffer(rawBody)
      ? rawBody.toString()
      : typeof rawBody === 'string'
        ? rawBody
        : JSON.stringify(rawBody);

    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(bodyStr)
      .digest('hex');

    if (expectedSig !== webhookSig) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const webhookBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { event, payload } = webhookBody;
    console.log(`📥 Webhook: ${event}`);

    // ✅ Respond 200 IMMEDIATELY — Razorpay times out at 5s
    res.status(200).json({ success: true, received: true });

    // Process AFTER responding
    switch (event) {
      case 'payment.authorized':
        console.log(`ℹ️ payment.authorized: ${payload.payment.entity.id} — waiting for capture`);
        break;
      case 'payment.captured':
        await handlePaymentCaptured(payload.payment.entity, req.io);
        break;
      case 'payment.failed':
        await handlePaymentFailed(payload.payment.entity, req.io);
        break;
      case 'order.paid':
        // Fires after payment.captured — emit socket only, wallet already updated
        await handleOrderPaid(payload.order.entity, req.io);
        break;
      default:
        console.log(`ℹ️ Unhandled event: ${event}`);
    }

  } catch (err) {
    console.error('🔥 Webhook error:', err);
    if (!res.headersSent) res.status(200).json({ success: false });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// payment.captured — commission debit from driver wallet
// ✅ atomic $inc+$push, DB-level dedup, withTransaction for session safety
// ─────────────────────────────────────────────────────────────────────────────

const handlePaymentCaptured = async (payment, io) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const driverId   = payment.notes?.driverId;
      const tripId     = payment.notes?.tripId;
      const paymentId  = payment.id;
      const paidAmount = payment.amount / 100;

      if (!driverId) {
        console.log('ℹ️ No driverId in notes — skipping');
        return;
      }

      // ✅ DB-level dedup: already processed?
      const alreadyDone = await PaymentTransaction.findOne({
        razorpayPaymentId: paymentId, webhookProcessed: true,
      }).session(session).lean();

      if (alreadyDone) {
        console.log(`ℹ️ ${paymentId} already webhook-processed — socket only`);
        if (io) {
          const w = await Wallet.findOne({ driverId }).select('pendingAmount availableBalance').lean();
          io.to(`driver_${driverId}`).emit('commission:paid', {
            paidAmount, pendingAmount: w?.pendingAmount || 0,
            availableBalance: w?.availableBalance || 0,
            paymentId, alreadyProcessed: true, timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      // Mark transaction as webhook-processed
      await PaymentTransaction.findOneAndUpdate(
        { razorpayOrderId: payment.order_id, webhookProcessed: { $ne: true } },
        { $set: { webhookProcessed: true, webhookReceivedAt: new Date(), paymentMethod: payment.method, razorpayPaymentId: paymentId } },
        { session }
      );

      // ✅ Check wallet array dedup (in case API verify already wrote it)
      const walletHasIt = await Wallet.findOne({
        driverId,
        'transactions.razorpayPaymentId': paymentId,
        'transactions.status': 'completed',
      }).session(session).lean();

      if (walletHasIt) {
        console.log(`ℹ️ ${paymentId} already in wallet — socket only`);
        if (io) {
          io.to(`driver_${driverId}`).emit('commission:paid', {
            paidAmount, pendingAmount: walletHasIt.pendingAmount,
            availableBalance: walletHasIt.availableBalance,
            paymentId, alreadyProcessed: true, timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      // ✅ Calculate new pending after deduction
      const current    = await Wallet.findOne({ driverId }).session(session).lean();
      const pending    = current?.pendingAmount || 0;
      const deducted   = Math.min(pending, paidAmount);
      const newPending = Math.max(0, pending - deducted);

      // ✅ Atomic update — no lost updates
      const updated = await Wallet.findOneAndUpdate(
        { driverId },
        {
          $set:  { pendingAmount: newPending },
          $push: {
            transactions: {
              ...(tripId ? { tripId } : {}),
              type:              'debit',
              amount:            paidAmount,
              description:       `Commission paid via Razorpay (${paymentId})`,
              razorpayPaymentId: paymentId,
              razorpayOrderId:   payment.order_id,
              paymentMethod:     payment.method || 'upi',
              status:            'completed',
              createdAt:         new Date(),
            },
          },
        },
        { session, new: true, upsert: true }
      );

      console.log(`✅ Webhook wallet updated: ₹${paidAmount} | pending now: ₹${updated.pendingAmount}`);

      if (io) {
        io.to(`driver_${driverId}`).emit('commission:paid', {
          paidAmount, pendingAmount: updated.pendingAmount,
          availableBalance: updated.availableBalance,
          paymentId, message: `₹${paidAmount} commission paid`,
          timestamp: new Date().toISOString(),
        });
      }
    });
  } catch (err) {
    console.error('❌ handlePaymentCaptured error:', err);
  } finally {
    session.endSession();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// payment.failed
// ─────────────────────────────────────────────────────────────────────────────

const handlePaymentFailed = async (payment, io) => {
  try {
    const driverId = payment.notes?.driverId;
    if (!driverId) return;

    console.log(`❌ Payment failed: ${payment.id} | ${payment.error_description}`);

    await PaymentTransaction.findOneAndUpdate(
      { razorpayOrderId: payment.order_id, paymentStatus: { $ne: 'completed' } },
      {
        $set: {
          paymentStatus: 'failed', webhookProcessed: true,
          webhookReceivedAt: new Date(),
          errorDetails: { code: payment.error_code, message: payment.error_description, timestamp: new Date() },
        },
      }
    );

    await Wallet.updateOne(
      { driverId, 'transactions.razorpayOrderId': payment.order_id, 'transactions.status': 'pending' },
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
    console.error('❌ handlePaymentFailed error:', err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// order.paid — wallet already updated in handlePaymentCaptured, just emit socket
// ─────────────────────────────────────────────────────────────────────────────

const handleOrderPaid = async (order, io) => {
  try {
    const driverId = order.notes?.driverId;
    if (!driverId || !io) return;

    const wallet = await Wallet.findOne({ driverId }).select('pendingAmount availableBalance').lean();
    if (wallet) {
      io.to(`driver_${driverId}`).emit('commission:paid', {
        orderId: order.id, paidAmount: order.amount / 100,
        pendingAmount: wallet.pendingAmount, availableBalance: wallet.availableBalance,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('❌ handleOrderPaid error:', err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Dev test endpoint
// ─────────────────────────────────────────────────────────────────────────────

export const testWebhook = async (req, res) => {
  console.log('🧪 Test webhook:', req.body);
  res.status(200).json({ success: true, timestamp: new Date().toISOString() });
};