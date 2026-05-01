// routes/adminRewardConfigRoutes.js — COMPLETE FILE
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

    // ── Welcome Coupon ───────────────────────────────────────────────────────
    if (welcomeCoupon) {
      const allowed = ['enabled', 'discountAmount', 'fareAdjustment', 'code', 'validityDays'];
      for (const key of allowed) {
        if (welcomeCoupon[key] !== undefined) settings.welcomeCoupon[key] = welcomeCoupon[key];
      }
      settings.markModified('welcomeCoupon');
    }

    // ── Coins ────────────────────────────────────────────────────────────────
    if (coins) {
      const scalarFields = [
        'enabled', 'coinsPerRide', 'conversionRate',
        'maxDiscountPerRide', 'coinsRequiredForMaxDiscount',
        'randomBonusCoins', 'randomBonusChance',
      ];
      for (const key of scalarFields) {
        if (coins[key] !== undefined) settings.coins[key] = coins[key];
      }

      if (Array.isArray(coins.distanceBonuses) && coins.distanceBonuses.length) {
        settings.coins.distanceBonuses = coins.distanceBonuses.map((t) => ({
          label: t.label ?? '',
          maxKm: t.maxKm ?? null,
          bonus: Number(t.bonus) || 0,
        }));
        settings.markModified('coins.distanceBonuses');
      }

      if (coins.vehicleBonuses && typeof coins.vehicleBonuses === 'object') {
        const vb = coins.vehicleBonuses;
        if (vb.bike    !== undefined) settings.coins.vehicleBonuses.bike    = Number(vb.bike)    || 0;
        if (vb.auto    !== undefined) settings.coins.vehicleBonuses.auto    = Number(vb.auto)    || 0;
        if (vb.car     !== undefined) settings.coins.vehicleBonuses.car     = Number(vb.car)     || 0;
        if (vb.premium !== undefined) settings.coins.vehicleBonuses.premium = Number(vb.premium) || 0;
        if (vb.xl      !== undefined) settings.coins.vehicleBonuses.xl      = Number(vb.xl)      || 0;
        settings.markModified('coins.vehicleBonuses');
      }

      settings.markModified('coins');
    }

    // ── Referral (cycle-based) ────────────────────────────────────────────────
    if (referral) {
      const allowedReferral = [
        'enabled',
        // Cycle-based fields
        'baseReferralsRequired',
        'extraReferralsPerCycle',
        'baseCouponAmount',
        'extraCouponAmount',
        'baseCoinsReward',
        'extraCoinsReward',
        'maxReferralCycles',
        'rewardCouponValidityDays',
        // Legacy fields kept in sync
        'referralsRequired',
        'rewardCouponAmount',
        'rewardCoins',
      ];
      for (const key of allowedReferral) {
        if (referral[key] !== undefined) settings.referral[key] = referral[key];
      }

      // ✅ Auto-sync legacy fields from base values so old code still works
      if (referral.baseReferralsRequired !== undefined) {
        settings.referral.referralsRequired = referral.baseReferralsRequired;
      }
      if (referral.baseCouponAmount !== undefined) {
        settings.referral.rewardCouponAmount = referral.baseCouponAmount;
      }
      if (referral.baseCoinsReward !== undefined) {
        settings.referral.rewardCoins = referral.baseCoinsReward;
      }

      settings.markModified('referral');
    }

    // ── Driver Referral ───────────────────────────────────────────────────────
    if (req.body.driverReferral) {
      const driverReferral = req.body.driverReferral;
      const allowedDriverReferral = [
        'enabled',
        'referralsRequired',
        'ridesToComplete',
        'rewardAmount',
      ];

      for (const key of allowedDriverReferral) {
        if (driverReferral[key] !== undefined) settings.driverReferral[key] = driverReferral[key];
      }

      // Backward compatibility: map legacy cycle fields if older admin still sends them.
      if (driverReferral.baseReferralsRequired !== undefined && driverReferral.referralsRequired === undefined) {
        settings.driverReferral.referralsRequired = driverReferral.baseReferralsRequired;
      }
      if (driverReferral.baseRewardAmount !== undefined && driverReferral.rewardAmount === undefined) {
        settings.driverReferral.rewardAmount = driverReferral.baseRewardAmount;
      }

      settings.markModified('driverReferral');
    }

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
    const totalReferrals     = await Referral.countDocuments();
    const completedReferrals = await Referral.countDocuments({ firstRideCompleted: true });
    const pendingReferrals   = totalReferrals - completedReferrals;
    const usersWithCode      = await User.countDocuments({ referralCode: { $exists: true, $ne: null } });
    const rewardsIssued      = await User.countDocuments({ referralRewardClaimed: true });
    const exhaustedCount     = await User.countDocuments({
      referralCycleCount: { $gte: 1 },
      referralRewardPendingClaim: false,
      referralRewardClaimed: true,
    });

    // Cycle breakdown — how many users are on each cycle
    const cycleBreakdown = await User.aggregate([
      { $match: { referralCycleCount: { $gte: 1 } } },
      { $group: { _id: '$referralCycleCount', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // Top referrers with cycle-aware fields
    const settings        = await AppSettings.getSettings();
    const ref             = settings.referral;

    const topReferrers = await User.find({ successfulReferrals: { $gt: 0 } })
      .sort({ successfulReferrals: -1 })
      .limit(10)
      .select('name phone referralCode successfulReferrals referralRewardClaimed referralCycleCount referralProgress')
      .lean();

    // Attach per-user required count based on their current cycle
    const topReferrersWithCycle = topReferrers.map((r) => {
      const cycle = r.referralCycleCount ?? 0;
      const baseReq  = ref.baseReferralsRequired ?? ref.referralsRequired ?? 5;
      const extraReq = ref.extraReferralsPerCycle ?? 2;
      return {
        ...r,
        referralCycle:      cycle,
        referralProgress:   r.referralProgress ?? 0,
        requiredReferrals:  baseReq + cycle * extraReq,
      };
    });

    res.json({
      success: true,
      stats: {
        totalReferrals,
        completedReferrals,
        pendingReferrals,
        usersWithCode,
        rewardsIssued,
        exhaustedCount,
        conversionRate: totalReferrals
          ? ((completedReferrals / totalReferrals) * 100).toFixed(1) + '%'
          : '0%',
        cycleBreakdown,
      },
      topReferrers: topReferrersWithCycle,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── GET /api/admin/referrals ───────────────────────────────────────────────────
router.get('/referrals', verifyAdminToken, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const referrals = await Referral.find()
      .populate('referrerId',     'name phone referralCode')
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