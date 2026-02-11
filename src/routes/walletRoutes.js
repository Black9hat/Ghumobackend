// routes/walletRoutes.js - SECURE WALLET API ROUTES
import express from 'express';
import {
  getWalletByDriverId,
  processCashCollection,
  getTodayEarnings,
  createRazorpayOrder,
  verifyRazorpayPayment,
  getPaymentProofs
} from '../controllers/walletController.js';

const router = express.Router();

// ✅ GET wallet details
router.get('/:driverId', getWalletByDriverId);

// ✅ GET today's earnings
router.get('/today/:driverId', getTodayEarnings);

// ✅ GET payment proofs (pending payments)
router.get('/payment-proof/:driverId', getPaymentProofs);

// ✅ POST collect cash after trip
router.post('/collect-cash', processCashCollection);

// ✅ POST create Razorpay order (for UPI payment)
router.post('/create-order', createRazorpayOrder);

// ✅ POST verify Razorpay payment
router.post('/verify-payment', verifyRazorpayPayment);

export default router;