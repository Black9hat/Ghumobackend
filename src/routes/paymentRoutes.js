// routes/paymentRoutes.js

import express from 'express';
import {
  createDirectPaymentOrder,
  verifyDirectPayment,
  initiateCashPayment,
  confirmCashReceipt,
  handleRazorpayWebhook
} from '../controllers/paymentController.js';
import { verifyToken } from '../middleware/auth.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER PAYMENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Create payment order (QR code)
router.post('/direct/create', verifyToken, createDirectPaymentOrder);

// Verify payment after completion
router.post('/direct/verify', verifyToken, verifyDirectPayment);

// Initiate cash payment
router.post('/cash/initiate', verifyToken, initiateCashPayment);

// ═══════════════════════════════════════════════════════════════════════════
// DRIVER PAYMENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Confirm cash receipt
router.post('/cash/confirm', verifyToken, confirmCashReceipt);

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK (No auth - verified by signature)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/webhook/razorpay', express.raw({ type: 'application/json' }), handleRazorpayWebhook);

export default router;