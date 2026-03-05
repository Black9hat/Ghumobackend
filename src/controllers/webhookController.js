// controllers/webhookController.js
import crypto from 'crypto';
import Wallet from '../models/Wallet.js';
import User from '../models/User.js';

const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const webhookSignature = req.headers['x-razorpay-signature'];

    if (!webhookSecret) {
      console.error('⚠️ RAZORPAY_WEBHOOK_SECRET not set in .env');
      return res.status(500).json({ success: false, message: 'Webhook not configured' });
    }

    if (!webhookSignature) {
      console.error('❌ Missing x-razorpay-signature header');
      return res.status(400).json({ success: false, message: 'Missing signature' });
    }

    // ✅ CRITICAL: Razorpay signs the RAW body string — must use rawBody not re-stringified JSON
    const rawBody = req.rawBody || req.body;
    const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString() : JSON.stringify(rawBody);

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(bodyString)
      .digest('hex');

    if (expectedSignature !== webhookSignature) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    console.log('✅ Webhook signature verified');

    const webhookBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { event, payload } = webhookBody;

    console.log('📥 Webhook event:', event);

    switch (event) {
      case 'payment.captured':
        await handlePaymentCaptured(payload.payment.entity, req.io);
        break;
      case 'payment.failed':
        await handlePaymentFailed(payload.payment.entity, req.io);
        break;
      case 'order.paid':
        await handleOrderPaid(payload.order.entity, payload.payment?.entity, req.io);
        break;
      default:
        console.log('ℹ️ Unhandled webhook event:', event);
    }

    // Always return 200 — Razorpay will retry if you return anything else
    return res.status(200).json({ success: true, received: true });

  } catch (err) {
    console.error('🔥 Webhook error:', err);
    return res.status(200).json({ success: false, error: err.message });
  }
};

const handlePaymentCaptured = async (payment, io) => {
  try {
    console.log(`💳 Payment captured: ${payment.id} | ₹${payment.amount / 100}`);

    const driverId = payment.notes?.driverId;
    if (!driverId) {
      console.log('ℹ️ No driverId in payment notes — skipping');
      return;
    }

    // Check if already processed
    const wallet = await Wallet.findOne({
      driverId,
      'transactions.razorpayPaymentId': payment.id,
      'transactions.status': 'completed'
    });

    if (wallet) {
      console.log('ℹ️ Payment already processed — no action needed');
    } else {
      console.log(`ℹ️ Webhook for driver ${driverId} — payment verify API should handle this`);
    }

    // ✅ Notify driver via socket
    if (io) {
      io.to(`driver_${driverId}`).emit('payment:confirmed', {
        paymentId: payment.id,
        amount: payment.amount / 100,
        message: 'Payment confirmed by Razorpay',
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('❌ handlePaymentCaptured error:', err);
  }
};

const handlePaymentFailed = async (payment, io) => {
  try {
    console.log(`❌ Payment failed: ${payment.id} | ${payment.error_description}`);

    const driverId = payment.notes?.driverId;
    if (!driverId) return;

    // Mark any pending transaction as failed
    await Wallet.findOneAndUpdate(
      { driverId, 'transactions.razorpayOrderId': payment.order_id },
      { $set: { 'transactions.$.status': 'failed' } }
    );

    // Notify driver
    if (io) {
      io.to(`driver_${driverId}`).emit('payment:failed', {
        paymentId: payment.id,
        error: payment.error_description,
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
    console.log(`✅ Order paid: ${order.id} | ₹${order.amount / 100}`);
    const driverId = order.notes?.driverId;
    if (driverId && io) {
      io.to(`driver_${driverId}`).emit('commission:paid', {
        orderId: order.id,
        amount: order.amount / 100,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('❌ handleOrderPaid error:', err);
  }
};

const testWebhook = async (req, res) => {
  console.log('🧪 Test webhook:', req.body);
  res.status(200).json({ success: true, message: 'Test webhook received', timestamp: new Date().toISOString() });
};

export { handleRazorpayWebhook, testWebhook };