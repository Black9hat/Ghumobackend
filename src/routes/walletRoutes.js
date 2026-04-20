// routes/walletRoutes.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { authenticateUser } from '../middlewares/auth.js';
import { verifyAdminToken } from '../middlewares/adminAuth.js';
import WithdrawalRequest from '../models/WithdrawalRequest.js';
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
  getWalletStats,
  processDriverWithdrawal,
  requestWithdrawalPayout,
  getWithdrawalHistory,
  saveUpiForWithdrawal,
  getWithdrawalStatus,
  updateDriverPaymentDetails,
  markWithdrawalPaidByAdmin,
  rejectWithdrawalByAdmin,
} from '../controllers/walletController.js';

const router = express.Router();

const withdrawalProofDir = path.join(process.cwd(), 'uploads', 'withdrawal-proofs');
if (!fs.existsSync(withdrawalProofDir)) {
  fs.mkdirSync(withdrawalProofDir, { recursive: true });
}

const withdrawalProofUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, withdrawalProofDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `proof_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, and WEBP images are allowed'));
    }
    return cb(null, true);
  }
});

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

// ═══════════════════════════════════════════════════════════════════
// 💳 ADMIN WITHDRAWAL ROUTES
// ═══════════════════════════════════════════════════════════════════
const getAllWithdrawalsForAdmin = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const skip = (safePage - 1) * safeLimit;

    const filter = {};
    if (status && ['pending', 'processing', 'completed', 'failed', 'reversed'].includes(String(status))) {
      filter.status = String(status);
    }

    const [withdrawals, total] = await Promise.all([
      WithdrawalRequest.find(filter)
      .populate('driverId', 'name phone email')
      .sort({ initiatedAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
      WithdrawalRequest.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      withdrawals: withdrawals || [],
      count: withdrawals?.length ?? 0,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit)
      }
    });
  } catch (error) {
    console.error('❌ Admin fetch withdrawals error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch withdrawals',
      error: error.message
    });
  }
};

// Primary endpoint used by wallet namespace.
router.get('/admin/withdrawal/all', verifyAdminToken, getAllWithdrawalsForAdmin);
router.post('/admin/withdrawal/upload-proof', verifyAdminToken, withdrawalProofUpload.single('proof'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Proof image file is required (field: proof)' });
  }

  const proofPath = `/uploads/withdrawal-proofs/${req.file.filename}`;
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  return res.json({
    success: true,
    message: 'Proof uploaded successfully',
    paymentProofImageUrl: proofPath,
    absoluteUrl: `${baseUrl}${proofPath}`,
    fileName: req.file.filename,
  });
});
router.post('/admin/withdrawal/:withdrawalId/mark-paid', verifyAdminToken, markWithdrawalPaidByAdmin);
router.post('/admin/withdrawal/:withdrawalId/reject', verifyAdminToken, rejectWithdrawalByAdmin);

// Backward-compatible aliases used by some admin clients.
router.get('/admin/all', verifyAdminToken, getAllWithdrawalsForAdmin);
router.post('/admin/upload-proof', verifyAdminToken, withdrawalProofUpload.single('proof'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Proof image file is required (field: proof)' });
  }

  const proofPath = `/uploads/withdrawal-proofs/${req.file.filename}`;
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  return res.json({
    success: true,
    message: 'Proof uploaded successfully',
    paymentProofImageUrl: proofPath,
    absoluteUrl: `${baseUrl}${proofPath}`,
    fileName: req.file.filename,
  });
});
router.post('/admin/:withdrawalId/mark-paid', verifyAdminToken, markWithdrawalPaidByAdmin);
router.post('/admin/:withdrawalId/reject', verifyAdminToken, rejectWithdrawalByAdmin);

// ── DRIVER ROUTES (DEFINED AFTER admin routes) ───────────────────
router.get('/today/:driverId', authenticateUser, getTodayEarnings);
router.get('/payment-proof/:driverId', authenticateUser, getPaymentProofs);
router.post('/collect-cash', authenticateUser, processCashCollection);
router.post('/create-order', authenticateUser, createRazorpayOrder);
router.post('/verify-payment', authenticateUser, verifyRazorpayPayment);
router.post('/create-commission-order', authenticateUser, createCommissionOrder);
router.post('/verify-commission', authenticateUser, verifyCommissionPayment);
router.post('/withdraw', authenticateUser, processDriverWithdrawal);

// ═══════════════════════════════════════════════════════════════════
// 💳 WITHDRAWAL SYSTEM - REFERRED AMOUNT PAYOUT (NEW)
// ═══════════════════════════════════════════════════════════════════
router.post('/request-payout', authenticateUser, requestWithdrawalPayout);
router.get('/history/:driverId', authenticateUser, getWithdrawalHistory);
router.post('/save-upi', authenticateUser, saveUpiForWithdrawal);
router.get('/status/:withdrawalId', authenticateUser, getWithdrawalStatus);

// ⚠️ THIS MUST BE LAST - catches everything as /:driverId
router.get('/:driverId', authenticateUser, getWalletByDriverId);

export default router;