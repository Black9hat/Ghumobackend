// routes/adminRewardConfigRoutes.js
import express from 'express';
import { verifyAdminToken } from '../middlewares/adminAuth.js';
import AppSettings from '../models/AppSettings.js';
import Coupon      from '../models/Coupon.js';
import Referral    from '../models/Referral.js';
import User        from '../models/User.js';
import {
  getWelcomeApplicableVehicles,
  getWelcomeDisplayAmount,
  getWelcomeReferenceVehicleType,
  normalizeWelcomeFixedAmounts,
  normalizeWelcomeVehicleType,
} from '../utils/welcomeCouponConfig.js';

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

// ─── Coupon sync ──────────────────────────────────────────────────────────────

/**
 * Keeps the canonical WELCOME coupon document in the Coupon collection
 * in sync with the AppSettings welcome coupon config.
 *
 * Called automatically after every reward-config save.
 */
const syncWelcomeCouponRecord = async (wc) => {
  const code = String(wc?.code || '').trim().toUpperCase();
  if (!code) {
    console.warn('⚠️  syncWelcomeCouponRecord: no coupon code — skipping sync');
    return;
  }

  const displayAmount = getWelcomeDisplayAmount(wc, wc?.vehicleType || 'all');
  const referenceVehicleType = getWelcomeReferenceVehicleType(wc);
  const applicableVehicles = getWelcomeApplicableVehicles(wc);

  // Coupon expires 10 years from now (effectively permanent)
  const validUntil = new Date();
  validUntil.setFullYear(validUntil.getFullYear() + 10);

  const modeNote = wc?.useFixedWelcomeAmount
    ? 'Fixed fare mode — vehicle-specific first-ride fares configured'
    : `Legacy mode — ₹${displayAmount} discount applied`;

  await Coupon.findOneAndUpdate(
    { code },
    {
      $set: {
        code,
        description:        `Welcome offer! Get ₹${displayAmount} off on your first ride. (${modeNote})`,
        discountType:       'FIXED',
        discountValue:      displayAmount,
        applicableVehicles,
        applicableFor:      'FIRST_RIDE',
        maxUsagePerUser:    1,
        totalUsageLimit:    null,
        validUntil,
        isActive:           wc?.enabled !== false,
        eligibleUserTypes:  ['NEW'],
        minRidesCompleted:  0,
        maxRidesCompleted:  0,
      },
      $setOnInsert: {
        validFrom:           new Date(),
        currentUsageCount:   0,
        createdBy:           'system',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(
    `🎁 Welcome coupon "${code}" synced — ` +
    `amount ₹${displayAmount}, ` +
    `mode: ${wc?.useFixedWelcomeAmount ? 'fixed' : 'legacy'}, ` +
    `vehicles: ${applicableVehicles.join(', ')}, ` +
    `reference vehicle: ${referenceVehicleType}, ` +
    `active: ${wc?.enabled !== false}`
  );
};

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/reward-config
 * Returns the full AppSettings document.
 */
router.get('/reward-config', verifyAdminToken, async (req, res) => {
  try {
    const settings = await AppSettings.getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    console.error('GET /reward-config error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

/**
 * PUT /api/admin/reward-config
 * Partial update — only the sections present in the body are updated.
 * Automatically syncs the Coupon collection after saving.
 */
router.put('/reward-config', verifyAdminToken, async (req, res) => {
  try {
    const { welcomeCoupon, coins, referral, driverReferral } = req.body;

    const settings = await AppSettings.getSettings();

    // ── 1. Welcome Coupon ────────────────────────────────────────────────────
    if (welcomeCoupon) {
      const ALLOWED_WC_KEYS = [
        'enabled',
        'useFixedWelcomeAmount',
        'discountAmount',
        'fareAdjustment',
        'vehicleType',
        'exactAmount',
        'fixedAmounts',
        'code',
        'validityDays',
      ];

      for (const key of ALLOWED_WC_KEYS) {
        if (welcomeCoupon[key] !== undefined) {
          settings.welcomeCoupon[key] = welcomeCoupon[key];
        }
      }

      // Sanitise & coerce
      settings.welcomeCoupon.vehicleType =
        normalizeWelcomeVehicleType(settings.welcomeCoupon.vehicleType);

      settings.welcomeCoupon.useFixedWelcomeAmount =
        Boolean(settings.welcomeCoupon.useFixedWelcomeAmount);

      settings.welcomeCoupon.fixedAmounts = normalizeWelcomeFixedAmounts(
        settings.welcomeCoupon.fixedAmounts
      );

      if (
        settings.welcomeCoupon.exactAmount !== null &&
        settings.welcomeCoupon.exactAmount !== undefined
      ) {
        settings.welcomeCoupon.exactAmount =
          Number(settings.welcomeCoupon.exactAmount) || null;
      }

      // In fixed mode the legacy fields are irrelevant but we keep them tidy
      if (settings.welcomeCoupon.useFixedWelcomeAmount) {
        // fareAdjustment has no meaning in fixed mode — reset to 0
        settings.welcomeCoupon.fareAdjustment = 0;

        const hasAnyFixedAmount = Object.values(settings.welcomeCoupon.fixedAmounts || {}).some(
          (amount) => Number(amount) > 0
        );

        if (!hasAnyFixedAmount && settings.welcomeCoupon.exactAmount > 0) {
          settings.welcomeCoupon.fixedAmounts.all = Number(settings.welcomeCoupon.exactAmount);
          settings.welcomeCoupon.vehicleType = 'all';
        }

        const displayAmount = getWelcomeDisplayAmount(
          settings.welcomeCoupon,
          settings.welcomeCoupon.vehicleType || 'all'
        );
        settings.welcomeCoupon.exactAmount = displayAmount;
        settings.welcomeCoupon.vehicleType = getWelcomeReferenceVehicleType(settings.welcomeCoupon);
      }

      settings.markModified('welcomeCoupon');
    }

    // ── 2. Coins ─────────────────────────────────────────────────────────────
    if (coins) {
      const SCALAR_COIN_KEYS = [
        'enabled',
        'coinsPerRide',
        'conversionRate',
        'maxDiscountPerRide',
        'coinsRequiredForMaxDiscount',
        'randomBonusCoins',
        'randomBonusChance',
      ];

      for (const key of SCALAR_COIN_KEYS) {
        if (coins[key] !== undefined) settings.coins[key] = coins[key];
      }

      if (Array.isArray(coins.distanceBonuses) && coins.distanceBonuses.length > 0) {
        settings.coins.distanceBonuses = coins.distanceBonuses.map((t) => ({
          label: t.label ?? '',
          maxKm: t.maxKm ?? null,
          bonus: Number(t.bonus) || 0,
        }));
        settings.markModified('coins.distanceBonuses');
      }

      if (coins.vehicleBonuses && typeof coins.vehicleBonuses === 'object') {
        const vb = coins.vehicleBonuses;
        const keys = ['bike', 'auto', 'car', 'premium', 'xl'];
        for (const k of keys) {
          if (vb[k] !== undefined) {
            settings.coins.vehicleBonuses[k] = Number(vb[k]) || 0;
          }
        }
        settings.markModified('coins.vehicleBonuses');
      }

      settings.markModified('coins');
    }

    // ── 3. Customer Referral (cycle-based) ───────────────────────────────────
    if (referral) {
      const ALLOWED_REFERRAL_KEYS = [
        'enabled',
        'baseReferralsRequired',
        'extraReferralsPerCycle',
        'baseCouponAmount',
        'extraCouponAmount',
        'baseCoinsReward',
        'extraCoinsReward',
        'maxReferralCycles',
        'rewardCouponValidityDays',
        // legacy aliases — kept for safety
        'referralsRequired',
        'rewardCouponAmount',
        'rewardCoins',
      ];

      for (const key of ALLOWED_REFERRAL_KEYS) {
        if (referral[key] !== undefined) settings.referral[key] = referral[key];
      }

      // Keep legacy aliases in sync with their canonical counterparts
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

    // ── 4. Driver Referral ───────────────────────────────────────────────────
    if (driverReferral) {
      const ALLOWED_DR_KEYS = [
        'enabled',
        'referralsRequired',
        'ridesToComplete',
        'rewardAmount',
      ];

      for (const key of ALLOWED_DR_KEYS) {
        if (driverReferral[key] !== undefined) {
          settings.driverReferral[key] = driverReferral[key];
        }
      }

      // Accept alternative key names from the UI just in case
      if (
        driverReferral.baseReferralsRequired !== undefined &&
        driverReferral.referralsRequired === undefined
      ) {
        settings.driverReferral.referralsRequired =
          driverReferral.baseReferralsRequired;
      }
      if (
        driverReferral.baseRewardAmount !== undefined &&
        driverReferral.rewardAmount === undefined
      ) {
        settings.driverReferral.rewardAmount = driverReferral.baseRewardAmount;
      }

      settings.markModified('driverReferral');
    }

    // ── Persist ──────────────────────────────────────────────────────────────
    settings.updatedAt = new Date();
    settings.updatedBy = req.admin?.email || 'admin';

    await settings.save();

    // Keep the Coupon collection in sync (non-fatal if it fails)
    try {
      await syncWelcomeCouponRecord(settings.welcomeCoupon);
    } catch (syncErr) {
      console.error('⚠️  Welcome coupon sync failed (non-fatal):', syncErr.message);
    }

    res.json({ success: true, message: 'Reward config updated', settings });
  } catch (err) {
    console.error('PUT /reward-config error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── GET /api/admin/referral-stats ─────────────────────────────────────────────
router.get('/referral-stats', verifyAdminToken, async (req, res) => {
  try {
    const [
      totalReferrals,
      completedReferrals,
      usersWithCode,
      rewardsIssued,
      exhaustedCount,
      cycleBreakdown,
      settings,
      topReferrers,
    ] = await Promise.all([
      Referral.countDocuments(),
      Referral.countDocuments({ firstRideCompleted: true }),
      User.countDocuments({ referralCode: { $exists: true, $ne: null } }),
      User.countDocuments({ referralRewardClaimed: true }),
      User.countDocuments({
        referralCycleCount:        { $gte: 1 },
        referralRewardPendingClaim: false,
        referralRewardClaimed:     true,
      }),
      User.aggregate([
        { $match: { referralCycleCount: { $gte: 1 } } },
        { $group: { _id: '$referralCycleCount', count: { $sum: 1 } } },
        { $sort:  { _id: 1 } },
      ]),
      AppSettings.getSettings(),
      User.find({ successfulReferrals: { $gt: 0 } })
        .sort({ successfulReferrals: -1 })
        .limit(10)
        .select(
          'name phone referralCode successfulReferrals ' +
          'referralRewardClaimed referralCycleCount referralProgress'
        )
        .lean(),
    ]);

    const pendingReferrals = totalReferrals - completedReferrals;
    const ref              = settings.referral;
    const baseReq          = ref.baseReferralsRequired ?? ref.referralsRequired ?? 5;
    const extraReq         = ref.extraReferralsPerCycle ?? 2;

    const topReferrersWithCycle = topReferrers.map((r) => {
      const cycle = r.referralCycleCount ?? 0;
      return {
        ...r,
        referralCycle:     cycle,
        referralProgress:  r.referralProgress ?? 0,
        requiredReferrals: baseReq + cycle * extraReq,
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
    console.error('GET /referral-stats error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── GET /api/admin/referrals ──────────────────────────────────────────────────
router.get('/referrals', verifyAdminToken, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20); // cap at 100
    const skip  = (page - 1) * limit;

    const [referrals, total] = await Promise.all([
      Referral.find()
        .populate('referrerId',     'name phone referralCode')
        .populate('referredUserId', 'name phone createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Referral.countDocuments(),
    ]);

    res.json({
      success: true,
      referrals,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('GET /referrals error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;