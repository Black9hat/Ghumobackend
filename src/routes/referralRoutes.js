// src/routes/referralRoutes.js
import express     from 'express';
import admin       from 'firebase-admin';
import User        from '../models/User.js';
import Referral    from '../models/Referral.js';
import AppSettings from '../models/AppSettings.js';
import {
  ensureReferralCode,
  claimReferralReward,
  recordReferralSignup,
} from '../services/rewardService.js';

const router = express.Router();

// ── Auth middleware ──────────────────────────────────────────────────────────
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

// ── Helper: compute per-cycle reward values ──────────────────────────────────
function getCycleReward(ref, cycle) {
  return {
    referralsRequired:
      (ref.baseReferralsRequired  ?? 5) +
      cycle * (ref.extraReferralsPerCycle ?? 2),
    couponAmount:
      (ref.baseCouponAmount  ?? 30) +
      cycle * (ref.extraCouponAmount ?? 10),
    coinsReward:
      (ref.baseCoinsReward  ?? 50) +
      cycle * (ref.extraCoinsReward ?? 10),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/referral/status/:customerId
// Full referral status — used by referral_page.dart
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    let customer = await User.findById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Lazy-generate code if missing
    if (!customer.referralCode) {
      await ensureReferralCode(customerId);
      customer = await User.findById(customerId);
    }

    const settings         = await AppSettings.getSettings();
    const ref              = settings.referral;
    const maxAllowedCycles = ref.maxReferralCycles ?? 3;
    const currentCycle     = customer.referralCycleCount ?? 0;
    const cyclesExhausted  = currentCycle >= maxAllowedCycles;

    // Per-cycle reward amounts
    const cycleReward = getCycleReward(ref, currentCycle);

    // Progress within current cycle
    const progress         = customer.referralProgress ?? 0;
    const remaining        = Math.max(0, cycleReward.referralsRequired - progress);
    const milestoneReached = progress >= cycleReward.referralsRequired;

    // Total across all cycles
    const successfulTotal = customer.successfulReferrals ?? 0;

    // Fetch referral records for friend list
    const [successfulReferrals, pendingReferrals] = await Promise.all([
      Referral.find({
        referrerId:         customerId,
        firstRideCompleted: true,
        isFlagged:          { $ne: true },
      })
        .populate('referredUserId', 'name phone')
        .sort({ firstRideCompletedAt: -1 })
        .lean(),

      Referral.find({
        referrerId:         customerId,
        firstRideCompleted: false,
        isFlagged:          { $ne: true },
      })
        .populate('referredUserId', 'name phone')
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    // Build share text + deep link
    const PLAY_STORE_BASE = 'https://play.google.com/store/apps/details?id=com.startech.goindia';
const referrer  = encodeURIComponent(`referralCode=${customer.referralCode}`);
const deepLink  = `${PLAY_STORE_BASE}&referrer=${referrer}`;
const shareText =
  `🎉 Join me on GoIndia!\n\n` +
  `Use my referral code *${customer.referralCode}* when you sign up.\n\n` +
  `🎁 Get a discount on your first ride!\n\n` +
  `📲 Download here:\n${deepLink}`;
    return res.json({
      success:      true,
      referralCode: customer.referralCode,
      shareLink:    shareText,
      deepLink,
      systemEnabled: ref.enabled,

      progress: {
        successful:    progress,
        required:      cycleReward.referralsRequired,
        remaining,
        milestoneReached,
        rewardClaimed: customer.referralRewardClaimed || false,
        // ✅ Flutter shows "Claim Now" button when this is true
        pendingClaim:  customer.referralRewardPendingClaim || false,
        couponCode:    customer.referralCouponCode || null,
        pendingCoins:  customer.referralCoinsBalance || 0,
      },

      reward: {
        couponAmount: cycleReward.couponAmount,
        coins:        cycleReward.coinsReward,
        description: `Refer ${cycleReward.referralsRequired} friends who complete their ` +
          `first ride to earn ₹${cycleReward.couponAmount} coupon + ${cycleReward.coinsReward} coins!`,
      },

      cycle: {
        current:        currentCycle,
        max:            maxAllowedCycles,
        exhausted:      cyclesExhausted,
        successfulTotal,
      },

      referrals: {
        successful: successfulReferrals.map((r) => ({
          name:        r.referredUserId?.name || 'User',
          completedAt: r.firstRideCompletedAt,
        })),
        pending: pendingReferrals.map((r) => ({
          name:     r.referredUserId?.name || 'User',
          joinedAt: r.createdAt,
        })),
      },
    });
  } catch (err) {
    console.error('❌ GET /referral/status:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/referral/claim/:customerId
// User taps "Claim Reward" on ReferralPage
// ─────────────────────────────────────────────────────────────────────────────
router.post('/claim/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    // ✅ Security: verify token matches the user
    const user = await User.findById(customerId).select('firebaseUid').lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.firebaseUid !== req.user?.uid) {
      return res.status(403).json({
        success: false,
        error:   'Unauthorized — token does not match user',
      });
    }

    const result = await claimReferralReward(customerId);

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.json(result);
  } catch (err) {
    console.error('❌ POST /referral/claim:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/referral/validate/:code
// Validate referral code before signup (NO auth needed)
// Used by login_page.dart to show referrer name in banner
// ─────────────────────────────────────────────────────────────────────────────
router.get('/validate/:code', async (req, res) => {
  try {
    const code     = req.params.code?.trim().toUpperCase();
    if (!code || code.length < 4) {
      return res.status(400).json({ success: false, message: 'Invalid code' });
    }

    const referrer = await User.findOne({ referralCode: code })
      .select('name referralCode role')
      .lean();

    if (!referrer || referrer.role !== 'customer') {
      return res.status(404).json({
        success: false,
        message: 'Invalid referral code',
      });
    }

    return res.json({
      success:      true,
      valid:        true,
      referrerName: referrer.name || 'A friend',
      message:      `You were invited by ${referrer.name || 'a friend'}`,
    });
  } catch (err) {
    console.error('❌ GET /referral/validate:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/referral/code/:customerId
// Just the referral code — fast endpoint
// ─────────────────────────────────────────────────────────────────────────────
router.get('/code/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    let   user           = await User.findById(customerId).select('referralCode').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.referralCode) {
      await ensureReferralCode(customerId);
      user = await User.findById(customerId).select('referralCode').lean();
    }

    return res.json({ success: true, referralCode: user?.referralCode || null });
  } catch (err) {
    console.error('❌ GET /referral/code:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Health ───────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({
    message: '🔗 Referral API active',
    endpoints: [
      'GET  /api/referral/status/:customerId  — full referral status',
      'GET  /api/referral/code/:customerId    — just the referral code',
      'GET  /api/referral/validate/:code      — validate code (no auth)',
      'POST /api/referral/claim/:customerId   — claim pending reward',
    ],
  });
});

export default router;