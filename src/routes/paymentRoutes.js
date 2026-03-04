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

// ═══════════════════════════════════════════════════════════════════
// CUSTOMER PAYMENT ROUTES
// ═══════════════════════════════════════════════════════════════════

// Create Razorpay order (QR code payment)
router.post('/direct/create', verifyToken, createDirectPaymentOrder);

// Verify payment after customer pays
router.post('/direct/verify', verifyToken, verifyDirectPayment);

// Customer chooses to pay cash
router.post('/cash/initiate', verifyToken, initiateCashPayment);

// ═══════════════════════════════════════════════════════════════════
// DRIVER PAYMENT ROUTES
// ═══════════════════════════════════════════════════════════════════

// Driver confirms they received cash
router.post('/cash/confirm', verifyToken, confirmCashReceipt);

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK (No auth - verified by Razorpay signature)
// ═══════════════════════════════════════════════════════════════════

router.post(
  '/webhook/razorpay',
  express.raw({ type: 'application/json' }),
  handleRazorpayWebhook
);

export default router;