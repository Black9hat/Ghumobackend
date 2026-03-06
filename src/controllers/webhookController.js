// controllers/webhookController.js
import crypto from 'crypto';
import mongoose from 'mongoose';
import Wallet from '../models/Wallet.js';

// ✅ In-memory dedup for webhook retries (Razorpay retries up to 5 times)
// Stores last 500 event IDs — sufficient for any retry window
const _processedWebhookIds = new Set();
const _MAX_WEBHOOK_CACHE = 500;

const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const webhookSignature = req.headers['x-razorpay-signature'];
    const eventId = req.headers['x-razorpay-event-id'] ?? null;

    // ✅ Dedup at entry — reject duplicate webhook deliveries immediately
    if (eventId) {
      if (_processedWebhookIds.has(eventId)) {
        console.log(`ℹ️ Duplicate webhook event ${eventId} — ignoring`);
        return res.status(200).json({ success: true, duplicate: true });
      }
      // Cap set size to avoid memory growth
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

    // ✅ Must use raw buffer — Razorpay signs exact byte string
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

    const webhookBody = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : req.body;

    const { event, payload } = webhookBody;
    console.log('📥 Webhook event:', event);

    // ✅ Respond 200 IMMEDIATELY — Razorpay times out after 5s
    // Process async so we don't block the response
    res.status(200).json({ success: true, received: true });

    // Process after responding
    switch (event) {
      case 'payment.authorized':
        // UPI payments start as authorized — wait for captured
        console.log(`ℹ️ payment.authorized: ${payload.payment.entity.id} — waiting for capture`);
        break;
      case 'payment.captured':
        await handlePaymentCaptured(payload.payment.entity, req.io);
        break;
      case 'payment.failed':
        await handlePaymentFailed(payload.payment.entity, req.io);
        break;
      case 'order.paid':
        // order.paid fires after payment.captured — just emit socket, don't double-write DB
        await handleOrderPaid(payload.order.entity, payload.payment?.entity, req.io);
        break;
      default:
        console.log('ℹ️ Unhandled webhook event:', event);
    }

  } catch (err) {
    console.error('🔥 Webhook error:', err);
    // Already responded 200 above if we got that far, otherwise:
    if (!res.headersSent) {
      res.status(200).json({ success: false });
    }
  }
};

const handlePaymentCaptured = async (payment, io) => {
  const session = await mongoose.startSession();
  try {
    const driverId = payment.notes?.driverId;
    if (!driverId) {
      console.log('ℹ️ No driverId in payment notes — skipping wallet update');
      return;
    }

    const paidAmount = payment.amount / 100;
    const paymentId = payment.id;

    // ✅ ATOMIC: findOneAndUpdate with condition — prevents race with verifyCommissionPayment
    // Only updates if this paymentId hasn't been recorded yet
    session.startTransaction();

    const wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      await session.abortTransaction();
      console.error(`❌ Wallet not found for driver ${driverId}`);
      return;
    }

    // ✅ Idempotency check inside transaction
    const alreadyDone = wallet.transactions.some(
      t => t.razorpayPaymentId === paymentId && t.status === 'completed'
    );

    if (alreadyDone) {
      await session.abortTransaction();
      console.log(`ℹ️ ${paymentId} already in wallet — webhook skipping DB write`);
      // Still emit socket — Flutter may not have received it
      if (io) {
        io.to(`driver_${driverId}`).emit('commission:paid', {
          paidAmount,
          pendingAmount: wallet.pendingAmount,
          availableBalance: wallet.availableBalance,
          paymentId,
          alreadyProcessed: true,
          timestamp: new Date().toISOString()
        });
      }
      return;
    }

    // ✅ Deduct pending
    const deducted = Math.min(wallet.pendingAmount, paidAmount);
    wallet.pendingAmount = Math.max(0, wallet.pendingAmount - deducted);
    wallet.transactions.push({
      type: 'debit',
      amount: paidAmount,
      description: `Commission paid via Razorpay (${paymentId})`,
      razorpayPaymentId: paymentId,
      razorpayOrderId: payment.order_id,
      paymentMethod: payment.method || 'upi',
      status: 'completed',
      createdAt: new Date()
    });

    await wallet.save({ session });
    await session.commitTransaction();

    console.log(`✅ Webhook updated wallet: ₹${paidAmount} | pending: ₹${wallet.pendingAmount}`);

    // ✅ Emit realtime update to driver
    if (io) {
      io.to(`driver_${driverId}`).emit('commission:paid', {
        paidAmount,
        pendingAmount: wallet.pendingAmount,
        availableBalance: wallet.availableBalance,
        paymentId,
        message: `₹${paidAmount} commission paid`,
        timestamp: new Date().toISOString()
      });
    }

  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ handlePaymentCaptured error:', err);
  } finally {
    session.endSession();
  }
};

const handlePaymentFailed = async (payment, io) => {
  try {
    const driverId = payment.notes?.driverId;
    if (!driverId) return;

    console.log(`❌ Payment failed: ${payment.id} | ${payment.error_description}`);

    await Wallet.updateOne(
      {
        driverId,
        'transactions.razorpayOrderId': payment.order_id,
        'transactions.status': 'pending'           // only update if still pending
      },
      { $set: { 'transactions.$.status': 'failed' } }
    );

    if (io) {
      io.to(`driver_${driverId}`).emit('payment:failed', {
        paymentId: payment.id,
        error: payment.error_description || 'Payment failed',
        message: 'Payment failed. Please try again.',
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('❌ handlePaymentFailed error:', err);
  }
};

const handleOrderPaid = async (order, payment, io) => {
  try {
    // ✅ order.paid fires after payment.captured — wallet already updated there
    // Just emit socket as a final confirmation, don't write DB again
    const driverId = order.notes?.driverId;
    if (!driverId || !io) return;

    const wallet = await Wallet.findOne({ driverId })
      .select('pendingAmount availableBalance')
      .lean();

    if (wallet) {
      io.to(`driver_${driverId}`).emit('commission:paid', {
        orderId: order.id,
        paidAmount: order.amount / 100,
        pendingAmount: wallet.pendingAmount,
        availableBalance: wallet.availableBalance,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('❌ handleOrderPaid error:', err);
  }
};

const testWebhook = async (req, res) => {
  console.log('🧪 Test webhook:', req.body);
  res.status(200).json({ success: true, timestamp: new Date().toISOString() });
};

export { handleRazorpayWebhook, testWebhook };