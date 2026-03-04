// routes/walletRoutes.js
import express from 'express';
import { authenticateUser } from '../middlewares/auth.js';
import {
  getWalletByDriverId,
  processCashCollection,
  getTodayEarnings,
  createRazorpayOrder,
  verifyRazorpayPayment,
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
const verifyAdmin = (req, res, next) => {
  // Method 1: x-admin-token header (admin panel)
  const adminToken = req.headers['x-admin-token'];
  if (adminToken && process.env.ADMIN_TOKEN && adminToken === process.env.ADMIN_TOKEN) {
    console.log('✅ Admin access via x-admin-token');
    return next();
  }

  // Method 2: Firebase user with admin role in DB
  if (req.user && req.user.role === 'admin') {
    console.log('✅ Admin access via role');
    return next();
  }

  console.log('❌ Admin access denied');
  return res.status(403).json({ success: false, message: 'Admin access required' });
};

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
router.get('/admin/wallets/stats/summary', authenticateUser, verifyAdmin, getWalletStats);
router.get('/admin/wallets/:driverId/transactions', authenticateUser, verifyAdmin, getWalletTransactions);
router.post('/admin/wallets/:driverId/payout', authenticateUser, verifyAdmin, processManualPayout);
router.get('/admin/wallets/:driverId', authenticateUser, verifyAdmin, getWalletDetails);
router.get('/admin/wallets', authenticateUser, verifyAdmin, getAllWallets);

// ── DRIVER ROUTES (DEFINED AFTER admin routes) ───────────────────
router.get('/today/:driverId', authenticateUser, getTodayEarnings);
router.get('/payment-proof/:driverId', authenticateUser, getPaymentProofs);
router.post('/collect-cash', authenticateUser, processCashCollection);
router.post('/create-order', authenticateUser, createRazorpayOrder);
router.post('/verify-payment', authenticateUser, verifyRazorpayPayment);

// ⚠️ THIS MUST BE LAST - catches everything as /:driverId
router.get('/:driverId', authenticateUser, getWalletByDriverId);

export default router;