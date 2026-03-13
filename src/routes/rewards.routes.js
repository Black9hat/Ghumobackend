// routes/rewards.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Unified Rewards / Coins API
//
// ALL original endpoint signatures are preserved so Flutter never breaks.
// Coin logic now reads from AppSettings (not the legacy RewardSettings model).
// Transaction history now reads from CoinTransaction (not legacy Reward model).
//
// Endpoints:
//   GET  /api/rewards/customer/:customerId      → wallet summary + tx history
//   GET  /api/rewards/discount/:customerId      → booking-screen eligibility
//   POST /api/rewards/award                     → award coins after ride (legacy)
//   POST /api/rewards/redeem                    → redeem coins for discount (legacy)
//   POST /api/rewards/apply-discount            → apply discount to fare (legacy)
//   POST /api/rewards/redeem/:customerId        → new: full coin redemption reset
// ─────────────────────────────────────────────────────────────────────────────
import express from 'express';
import admin from 'firebase-admin';
import User from '../models/User.js';
import AppSettings from '../models/AppSettings.js';
import CoinTransaction from '../models/CoinTransaction.js';
import {
  getCustomerCoinSummary,
  getDiscountEligibility,
  awardRideCoins,
  redeemCoinsForDiscount,
} from '../services/coinService.js';

const router = express.Router();

// ── Auth middleware ──────────────────────────────────────────────────────────
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/rewards/customer/:customerId
// Full wallet summary — used by coins_wallet_page.dart
// Response shape compatible with old AND new Flutter parsing:
//   • NEW fields: coins, coinsRequired, maxDiscountPerRide, coinDiscountActive,
//                 coinsLeft, progress, transactions[]
//   • LEGACY fields kept: totalCoins, isDiscountEnabled, distanceTiers[], history[]
// ─────────────────────────────────────────────────────────────────────────────
router.get('/customer/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    const result = await getCustomerCoinSummary(customerId);
    if (!result.success) return res.status(404).json({ error: result.error || 'Customer not found' });

    const settings = await AppSettings.getSettings();
    const coinConfig = settings.coins;

    // Build distanceTiers array in legacy shape so old Flutter parsing still works
    // Flutter reads: tiers[0].coinsRequiredForDiscount and tiers[0].discountAmount
    const distanceTiers = [
      {
        minDistance: 0,
        maxDistance: Infinity,
        coinsPerRide: coinConfig.coinsPerRide ?? 5,
        coinsRequiredForDiscount: coinConfig.coinsRequiredForMaxDiscount ?? 200,
        discountAmount: coinConfig.maxDiscountPerRide ?? 20,
        platformFee: 0,
      },
    ];

    // Format history for Flutter: { description, coins, type, date }
    const history = result.transactions.map((tx) => ({
      _id: tx._id,
      description: tx.description,
      coins: tx.coins,          // positive = earn, negative = spend
      type: tx.isEarned ? 'earned' : 'redeemed',
      isEarned: tx.isEarned,
      date: new Date(tx.createdAt).toLocaleDateString('en-IN'),
      createdAt: tx.createdAt,
      balanceAfter: tx.balanceAfter,
    }));

    res.json({
      success: true,
      // ── NEW fields (coinService shape) ──────────────────────────────
      coins: result.coins,
      coinsRequired: result.coinsRequired,
      coinsLeft: result.coinsLeft,
      progress: result.progress,
      coinDiscountActive: result.coinDiscountActive,
      maxDiscountPerRide: result.maxDiscountPerRide,
      conversionRate: result.conversionRate,
      totalCoinsEarned: result.totalCoinsEarned,
      totalCoinsRedeemed: result.totalCoinsRedeemed,
      transactions: result.transactions,  // rich format
      // ── LEGACY fields (old Flutter coins_wallet_page.dart reads these) ──
      totalCoins: result.coins,           // alias for legacy
      isDiscountEnabled: coinConfig.enabled ?? true,
      distanceTiers,                      // legacy shape with coinsRequiredForDiscount
      referralBonus: settings.referral?.rewardCoins ?? 50,
      history,                            // legacy shape with date string
      // ── Bonus config — Flutter wallet page reads these from admin ────
      distanceBonuses:  result.distanceBonuses,
      vehicleBonuses:   result.vehicleBonuses,
      randomBonusCoins: result.randomBonusCoins,
      randomBonusChance: result.randomBonusChance,
    });
  } catch (err) {
    console.error('❌ GET /rewards/customer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/rewards/discount/:customerId
// Booking-screen eligibility — used by short_trip_page.dart
// Response shape compatible with OLD Flutter parsing:
//   data['hasDiscount'], data['isDiscountEnabled'], data['coins'],
//   data['coinsRequired'], data['discountAmount']
// PLUS new fields: coinDiscountActive, coinsLeft
// ─────────────────────────────────────────────────────────────────────────────
router.get('/discount/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    const result = await getDiscountEligibility(customerId);
    if (!result.success) return res.status(404).json({ error: result.error || 'Customer not found' });

    const settings = await AppSettings.getSettings();
    const coinConfig = settings.coins;

    if (!coinConfig.enabled) {
      return res.json({
        hasDiscount: false,
        discountAmount: 0,
        coins: result.coins ?? 0,
        coinsRequired: result.coinsRequired ?? 0,
        hasRedeemableDiscount: false,
        autoEligible: false,
        isDiscountEnabled: false,
        coinDiscountActive: false,
        coinsLeft: result.coinsRequired ?? 0,
        message: 'Coin discount system is currently disabled',
      });
    }

    const coinDiscountActive = result.coinDiscountActive;

    res.json({
      // ── OLD Flutter fields (keep exact names) ───────────────────────
      hasDiscount: coinDiscountActive,
      discountAmount: result.discountAmount,   // always admin-set value so Flutter shows correct target (e.g. ₹15) even before threshold
      coins: result.coins,
      coinsRequired: result.coinsRequired,
      hasRedeemableDiscount: coinDiscountActive,
      autoEligible: coinDiscountActive,
      isDiscountEnabled: true,
      // ── NEW additional fields ────────────────────────────────────────
      coinDiscountActive,
      coinsLeft: result.coinsLeft,
      success: true,
    });
  } catch (err) {
    console.error('❌ GET /rewards/discount error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/rewards/award  (legacy endpoint — still works)
// Award coins after ride completion when called externally.
// Now uses coinService.awardRideCoins for consistent bonus logic.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/award', verifyToken, async (req, res) => {
  try {
    const { customerId, tripId, distance, vehicleType } = req.body;

    if (!customerId) return res.status(400).json({ error: 'customerId required' });

    const result = await awardRideCoins(customerId, tripId, {
      distanceKm: parseFloat(distance) || 0,
      vehicleType: vehicleType || '',
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to award coins' });
    }

    const settings = await AppSettings.getSettings();
    const coinsRequired = settings.coins.coinsRequiredForMaxDiscount ?? 200;

    res.json({
      success: true,
      coinsAwarded: result.coinsAwarded,
      totalCoins: result.totalCoins,
      coinsRequired,
      couponUnlocked: result.couponUnlocked ?? false,
      breakdown: result.breakdown,
      // Legacy shape
      distanceTier: {
        range: `0-${Math.ceil(distance || 0)}km`,
        platformFee: 0,
      },
    });
  } catch (err) {
    console.error('❌ POST /rewards/award error:', err);
    res.status(500).json({ error: 'Failed to award coins' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/rewards/redeem  (legacy endpoint — still works)
// Redeem coins for a discount. Resets balance to 0.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/redeem', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });

    const result = await redeemCoinsForDiscount(customerId);

    if (!result.success) {
      return res.status(400).json({ error: result.error, success: false });
    }

    res.json({
      success: true,
      remainingCoins: result.remainingCoins,
      discountAvailable: true,
      discountAmount: result.discountAmount,
      coinsRedeemed: result.coinsRedeemed,
    });
  } catch (err) {
    console.error('❌ POST /rewards/redeem error:', err);
    res.status(500).json({ error: 'Failed to redeem coins' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/rewards/redeem/:customerId  (new clean endpoint)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/redeem/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const result = await redeemCoinsForDiscount(customerId);

    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('❌ POST /rewards/redeem/:customerId error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/rewards/apply-discount  (legacy endpoint — still works)
// Checks eligibility and returns the discount amount.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/apply-discount', verifyToken, async (req, res) => {
  try {
    const { customerId, originalFare } = req.body;
    if (!customerId || !originalFare) {
      return res.status(400).json({ error: 'customerId and originalFare required' });
    }

    const settings = await AppSettings.getSettings();
    const coinConfig = settings.coins;

    if (!coinConfig.enabled) {
      return res.json({
        discountApplied: false,
        finalFare: originalFare,
        discount: 0,
        message: 'Coin discount system is currently disabled',
      });
    }

    const user = await User.findById(customerId).select('coins').lean();
    if (!user) return res.status(404).json({ error: 'Customer not found' });

    const coinsRequired  = coinConfig.coinsRequiredForMaxDiscount ?? 200;
    const discountAmount = coinConfig.maxDiscountPerRide ?? 20;
    const currentCoins   = user.coins ?? 0;

    if (currentCoins < coinsRequired) {
      return res.json({
        discountApplied: false,
        finalFare: originalFare,
        discount: 0,
        message: `Need ${coinsRequired - currentCoins} more coins for ₹${discountAmount} off`,
      });
    }

    // Redeem and reset coins
    const redeemResult = await redeemCoinsForDiscount(customerId);
    if (!redeemResult.success) {
      return res.status(400).json({ discountApplied: false, finalFare: originalFare, discount: 0, error: redeemResult.error });
    }

    const finalFare = Math.max(0, originalFare - discountAmount);

    res.json({
      discountApplied: true,
      originalFare,
      discount: discountAmount,
      finalFare,
      coinsDeducted: redeemResult.coinsRedeemed,
      remainingCoins: 0,
    });
  } catch (err) {
    console.error('❌ POST /rewards/apply-discount error:', err);
    res.status(500).json({ error: 'Failed to apply discount' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/rewards/stats  (new — admin dashboard uses this for coin stats)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [
      totalUsersWithCoins,
      totalCoinsInCirculation,
      totalCoinsEverEarned,
      totalCoinsEverRedeemed,
      recentTransactions,
      settings,
    ] = await Promise.all([
      User.countDocuments({ coins: { $gt: 0 } }),
      User.aggregate([{ $group: { _id: null, total: { $sum: '$coins' } } }]),
      CoinTransaction.aggregate([
        { $match: { coinsEarned: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$coinsEarned' } } },
      ]),
      CoinTransaction.aggregate([
        { $match: { coinsEarned: { $lt: 0 } } },
        { $group: { _id: null, total: { $sum: '$coinsEarned' } } },
      ]),
      CoinTransaction.countDocuments(),
      AppSettings.getSettings(),
    ]);

    const coinsRequired = settings.coins.coinsRequiredForMaxDiscount ?? 200;
    const discountAmount = settings.coins.maxDiscountPerRide ?? 20;
    const usersEligibleForDiscount = await User.countDocuments({ coins: { $gte: coinsRequired } });

    res.json({
      success: true,
      stats: {
        totalUsersWithCoins,
        totalCoinsInCirculation: totalCoinsInCirculation[0]?.total ?? 0,
        totalCoinsEverEarned: totalCoinsEverEarned[0]?.total ?? 0,
        totalCoinsEverRedeemed: Math.abs(totalCoinsEverRedeemed[0]?.total ?? 0),
        totalTransactions: recentTransactions,
        usersEligibleForDiscount,
        coinsRequired,
        discountAmount,
        coinsEnabled: settings.coins.enabled,
      },
    });
  } catch (err) {
    console.error('❌ GET /rewards/stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({
    message: '🪙 Rewards / Coins API is active',
    endpoints: [
      'GET  /api/rewards/customer/:customerId   — wallet summary + history',
      'GET  /api/rewards/discount/:customerId   — booking screen eligibility',
      'POST /api/rewards/award                  — award coins (legacy)',
      'POST /api/rewards/redeem                 — redeem coins (legacy)',
      'POST /api/rewards/redeem/:customerId     — redeem coins (new)',
      'POST /api/rewards/apply-discount         — apply discount to fare (legacy)',
      'GET  /api/rewards/stats                  — admin coin stats',
    ],
  });
});

export default router;
