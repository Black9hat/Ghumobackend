// routes/adminRewardConfigRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Admin endpoints for:
//   • GET/PUT  /api/admin/reward-config   — manage AppSettings
//   • GET      /api/admin/referral-stats  — referral overview
//   • GET      /api/admin/referrals       — full referral list
// ─────────────────────────────────────────────────────────────────────────────
import express from 'express';
import { verifyAdminToken } from '../middlewares/adminAuth.js';
import AppSettings from '../models/AppSettings.js';
import Referral from '../models/Referral.js';
import User from '../models/User.js';

const router = express.Router();

// ── GET /api/admin/reward-config ──────────────────────────────────────────────
router.get('/reward-config', verifyAdminToken, async (req, res) => {
  try {
    const settings = await AppSettings.getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── PUT /api/admin/reward-config ──────────────────────────────────────────────
router.put('/reward-config', verifyAdminToken, async (req, res) => {
  try {
    const { welcomeCoupon, coins, referral } = req.body;

    const settings = await AppSettings.getSettings();

    if (welcomeCoupon) Object.assign(settings.welcomeCoupon, welcomeCoupon);
    if (coins) Object.assign(settings.coins, coins);
    if (referral) Object.assign(settings.referral, referral);

    settings.updatedAt = new Date();
    settings.updatedBy = req.admin?.email || 'admin';
    await settings.save();

    res.json({ success: true, message: 'Reward config updated', settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── GET /api/admin/referral-stats ─────────────────────────────────────────────
router.get('/referral-stats', verifyAdminToken, async (req, res) => {
  try {
    const totalReferrals = await Referral.countDocuments();
    const completedReferrals = await Referral.countDocuments({ firstRideCompleted: true });
    const pendingReferrals = totalReferrals - completedReferrals;
    const usersWithCode = await User.countDocuments({ referralCode: { $exists: true, $ne: null } });
    const rewardsIssued = await User.countDocuments({ referralRewardClaimed: true });

    // Top referrers
    const topReferrers = await User.find({ successfulReferrals: { $gt: 0 } })
      .sort({ successfulReferrals: -1 })
      .limit(10)
      .select('name phone referralCode successfulReferrals referralRewardClaimed');

    res.json({
      success: true,
      stats: {
        totalReferrals,
        completedReferrals,
        pendingReferrals,
        usersWithCode,
        rewardsIssued,
        conversionRate: totalReferrals
          ? ((completedReferrals / totalReferrals) * 100).toFixed(1) + '%'
          : '0%',
      },
      topReferrers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── GET /api/admin/referrals ───────────────────────────────────────────────────
router.get('/referrals', verifyAdminToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const referrals = await Referral.find()
      .populate('referrerId', 'name phone referralCode')
      .populate('referredUserId', 'name phone createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Referral.countDocuments();

    res.json({
      success: true,
      referrals,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;
