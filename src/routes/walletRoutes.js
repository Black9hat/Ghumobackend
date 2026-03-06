// routes/walletRoutes.js
import express from 'express';
import { authenticateUser } from '../middlewares/auth.js';
import { verifyAdminToken } from '../middlewares/adminAuth.js';
import {
  getWalletByDriverId,
  processCashCollection,
  getTodayEarnings,
  createRazorpayOrder,
  verifyRazorpayPayment,
  createCommissionOrder,
  verifyCommissionPayment,
  getPaymentProofs,
  getAllWallets,
  getWalletDetails,
  getWalletTransactions,
  processManualPayout,
  getWalletStats
} from '../controllers/walletController.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// ADMIN MIDDLEWARE - checks x-admin-token header or admin role
// ═══════════════════════════════════════════════════════════════════
// ✅ Admin routes use verifyAdminToken (JWT) — same as adminRoutes.js

// ═══════════════════════════════════════════════════════════════════
// ⚠️ CRITICAL: ADMIN ROUTES MUST COME BEFORE /:driverId ROUTES
// Otherwise Express treats "admin" as a driverId parameter!
// ═══════════════════════════════════════════════════════════════════

// ── DEBUG / TEST ROUTE ────────────────────────────────────────────
router.get('/admin/test', (req, res) => {
  res.json({
    success: true,
    message: 'Wallet admin route is reachable',
    timestamp: new Date().toISOString(),
    auth: {
      authorization: req.headers.authorization ? 'Present' : 'Missing',
      adminToken: req.headers['x-admin-token'] ? 'Present' : 'Missing'
    }
  });
});

// ── ADMIN ROUTES (DEFINED FIRST!) ─────────────────────────────────
router.get('/admin/wallets/stats/summary', verifyAdminToken, getWalletStats);
router.get('/admin/wallets/:driverId/transactions', verifyAdminToken, getWalletTransactions);
router.post('/admin/wallets/:driverId/payout', verifyAdminToken, processManualPayout);
router.get('/admin/wallets/:driverId', verifyAdminToken, getWalletDetails);
router.get('/admin/wallets', verifyAdminToken, getAllWallets);

// ── DRIVER ROUTES (DEFINED AFTER admin routes) ───────────────────
router.get('/today/:driverId', authenticateUser, getTodayEarnings);
router.get('/payment-proof/:driverId', authenticateUser, getPaymentProofs);
router.post('/collect-cash', authenticateUser, processCashCollection);
router.post('/create-order', authenticateUser, createRazorpayOrder);
router.post('/verify-payment', authenticateUser, verifyRazorpayPayment);
router.post('/create-commission-order', authenticateUser, createCommissionOrder);
router.post('/verify-commission', authenticateUser, verifyCommissionPayment);

// ⚠️ THIS MUST BE LAST - catches everything as /:driverId
router.get('/:driverId', authenticateUser, getWalletByDriverId);

export default router;