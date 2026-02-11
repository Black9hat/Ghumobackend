// webhookController.js - RAZORPAY WEBHOOK HANDLER (OPTIONAL BUT RECOMMENDED)
import crypto from 'crypto';
import Wallet from '../models/Wallet.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';

/**
 * 🔐 WEBHOOK SIGNATURE VERIFICATION
 * This adds an extra layer of security by handling server-to-server notifications
 */
const verifyWebhookSignature = (webhookBody, webhookSignature, webhookSecret) => {
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(JSON.stringify(webhookBody))
    .digest('hex');
  
  return expectedSignature === webhookSignature;
};

/**
 * 🎯 RAZORPAY WEBHOOK HANDLER
 * POST /api/webhook/razorpay
 * 
 * This endpoint receives server-to-server notifications from Razorpay
 * for additional payment verification and reconciliation
 */
const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const webhookSignature = req.headers['x-razorpay-signature'];
    const webhookBody = req.body;

    // Step 1: Verify webhook signature
    if (!webhookSecret) {
      console.error('⚠️  Razorpay webhook secret not configured');
      return res.status(500).json({ 
        success: false, 
        message: 'Webhook not configured' 
      });
    }

    if (!webhookSignature) {
      console.error('❌ Missing webhook signature');
      return res.status(400).json({ 
        success: false, 
        message: 'Missing signature' 
      });
    }

    const isValid = verifyWebhookSignature(
      webhookBody, 
      webhookSignature, 
      webhookSecret
    );

    if (!isValid) {
      console.error('❌ Invalid webhook signature - possible fraud attempt');
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid signature' 
      });
    }

    console.log('✅ Webhook signature verified');

    // Step 2: Process webhook event
    const event = webhookBody.event;
    const payload = webhookBody.payload;

    console.log('📥 Webhook event received:', event);

    switch (event) {
      case 'payment.captured':
        await handlePaymentCaptured(payload.payment.entity);
        break;

      case 'payment.failed':
        await handlePaymentFailed(payload.payment.entity);
        break;

      case 'order.paid':
        await handleOrderPaid(payload.order.entity, payload.payment.entity);
        break;

      default:
        console.log('ℹ️  Unhandled webhook event:', event);
    }

    // Always return 200 OK to acknowledge receipt
    res.status(200).json({ success: true, received: true });

  } catch (err) {
    console.error('🔥 Webhook handler error:', err);
    // Still return 200 to prevent Razorpay from retrying
    res.status(200).json({ success: false, error: err.message });
  }
};

/**
 * Handle payment.captured event
 */
const handlePaymentCaptured = async (payment) => {
  try {
    console.log('💳 Payment captured:', payment.id);
    console.log('   Amount:', payment.amount / 100, 'INR');
    console.log('   Status:', payment.status);
    console.log('   Method:', payment.method);

    // Extract driver ID from order notes
    const driverId = payment.notes?.driverId;
    
    if (!driverId) {
      console.log('⚠️  No driver ID in payment notes');
      return;
    }

    // Check if payment already processed
    const wallet = await Wallet.findOne({
      driverId,
      'transactions.razorpayPaymentId': payment.id
    });

    if (wallet) {
      const existingTxn = wallet.transactions.find(
        t => t.razorpayPaymentId === payment.id && t.status === 'completed'
      );
      
      if (existingTxn) {
        console.log('ℹ️  Payment already processed via API');
        return;
      }
    }

    console.log('ℹ️  Webhook confirms payment, already processed via verify API');
    
    // Optionally: Send notification to driver
    const driver = await User.findById(driverId).select('socketId').lean();
    if (driver?.socketId) {
      io.to(driver.socketId).emit('payment:confirmed', {
        paymentId: payment.id,
        amount: payment.amount / 100,
        message: 'Payment confirmed by payment gateway'
      });
    }

  } catch (err) {
    console.error('Error handling payment captured:', err);
  }
};

/**
 * Handle payment.failed event
 */
const handlePaymentFailed = async (payment) => {
  try {
    console.log('❌ Payment failed:', payment.id);
    console.log('   Error:', payment.error_description);

    const driverId = payment.notes?.driverId;
    
    if (!driverId) return;

    // Update transaction status to failed
    await Wallet.findOneAndUpdate(
      { 
        driverId,
        'transactions.razorpayOrderId': payment.order_id 
      },
      {
        $set: {
          'transactions.$.status': 'failed',
          'transactions.$.description': `Payment failed: ${payment.error_description}`
        }
      }
    );

    // Notify driver
    const driver = await User.findById(driverId).select('socketId').lean();
    if (driver?.socketId) {
      io.to(driver.socketId).emit('payment:failed', {
        paymentId: payment.id,
        orderId: payment.order_id,
        error: payment.error_description,
        message: 'Payment failed. Please try again.'
      });
    }

    console.log('📢 Driver notified of failed payment');

  } catch (err) {
    console.error('Error handling payment failed:', err);
  }
};

/**
 * Handle order.paid event
 */
const handleOrderPaid = async (order, payment) => {
  try {
    console.log('✅ Order paid:', order.id);
    console.log('   Amount:', order.amount / 100, 'INR');
    console.log('   Payment:', payment.id);

    // This is a confirmation that order is fully paid
    // Usually already handled by payment.captured, but good for reconciliation
    
    const driverId = order.notes?.driverId;
    if (driverId) {
      console.log('📊 Order payment confirmed for driver:', driverId);
    }

  } catch (err) {
    console.error('Error handling order paid:', err);
  }
};

/**
 * Test webhook endpoint (for development)
 * POST /api/webhook/test
 */
const testWebhook = async (req, res) => {
  try {
    console.log('🧪 Test webhook called');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);

    res.status(200).json({
      success: true,
      message: 'Test webhook received',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Test webhook error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

export {
  handleRazorpayWebhook,
  testWebhook
};