// routes/referralRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Customer-facing referral endpoints
// ─────────────────────────────────────────────────────────────────────────────
import express from 'express';
import admin from 'firebase-admin';
import User from '../models/User.js';
import Referral from '../models/Referral.js';
import AppSettings from '../models/AppSettings.js';
import { ensureReferralCode } from '../services/rewardService.js';

const router = express.Router();

// ── Firebase token verification ───────────────────────────────────────────────
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ── GET /api/referral/status/:customerId ─────────────────────────────────────
// Returns referral code, progress toward milestone, and reward details
router.get('/status/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const customer = await User.findById(customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Lazy-generate code if missing
    if (!customer.referralCode) {
      await ensureReferralCode(customerId);
      customer.referralCode = (await User.findById(customerId))?.referralCode;
    }

    const settings = await AppSettings.getSettings();
    const { referralsRequired, rewardCouponAmount, rewardCoins, enabled } = settings.referral;

    // Fetch list of successful referrals
    const successfulReferrals = await Referral.find({
      referrerId: customerId,
      firstRideCompleted: true,
    })
      .populate('referredUserId', 'name phone createdAt')
      .sort({ firstRideCompletedAt: -1 })
      .lean();

    const pendingReferrals = await Referral.find({
      referrerId: customerId,
      firstRideCompleted: false,
    })
      .populate('referredUserId', 'name phone createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const progress = customer.successfulReferrals || 0;
    const remaining = Math.max(0, referralsRequired - progress);

    res.json({
      success: true,
      referralCode: customer.referralCode,
      shareLink: `Use code ${customer.referralCode} to get a welcome discount on your first ride!`,
      progress: {
        successful: progress,
        required: referralsRequired,
        remaining,
        milestoneReached: progress >= referralsRequired,
        rewardClaimed: customer.referralRewardClaimed || false,
      },
      reward: {
        couponAmount: rewardCouponAmount,
        coins: rewardCoins,
        description: `Refer ${referralsRequired} friends who complete their first ride to earn ₹${rewardCouponAmount} coupon + ${rewardCoins} coins!`,
      },
      referrals: {
        successful: successfulReferrals.map((r) => ({
          name: r.referredUserId?.name || 'User',
          completedAt: r.firstRideCompletedAt,
        })),
        pending: pendingReferrals.map((r) => ({
          name: r.referredUserId?.name || 'User',
          joinedAt: r.createdAt,
        })),
      },
      systemEnabled: enabled,
    });
  } catch (err) {
    console.error('❌ referral status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/referral/validate/:code ─────────────────────────────────────────
// Validates a referral code before signup (Flutter signup screen)
router.get('/validate/:code', async (req, res) => {
  try {
    const code = req.params.code?.trim().toUpperCase();
    const referrer = await User.findOne({ referralCode: code }).select('name referralCode');
    if (!referrer) {
      return res.status(404).json({ success: false, message: 'Invalid referral code' });
    }
    res.json({
      success: true,
      valid: true,
      referrerName: referrer.name,
      message: `You were referred by ${referrer.name}`,
    });
  } catch (err) {
    console.error('❌ referral validate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
