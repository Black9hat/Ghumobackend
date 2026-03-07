// src/routes/paymentRoutes.js
// ⚠️  Razorpay webhook is NOT here.
//     It is at: /api/webhook/razorpay  (webhookRoutes.js → webhookController.js)
//     That route is mounted BEFORE express.json() in server.js to get the raw body.

import express from 'express';
import {
  createDirectPaymentOrder,
  verifyDirectPayment,
  initiateCashPayment,
  confirmCashReceipt,
} from '../controllers/paymentController.js';
import { authenticateUser } from '../middlewares/auth.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// CUSTOMER ROUTES
// ═══════════════════════════════════════════════════════════════════

// Create Razorpay order (QR / direct payment)
router.post('/direct/create', authenticateUser, createDirectPaymentOrder);

// Verify payment after customer completes it in the app
router.post('/direct/verify', authenticateUser, verifyDirectPayment);

// Customer signals they will pay cash
router.post('/cash/initiate', authenticateUser, initiateCashPayment);

// ═══════════════════════════════════════════════════════════════════
// DRIVER ROUTES
// ═══════════════════════════════════════════════════════════════════

// Driver confirms they received the cash
router.post('/cash/confirm', authenticateUser, confirmCashReceipt);

export default router;