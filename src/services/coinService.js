/**
 * coinService.js — Go India Coins Reward System
 * ─────────────────────────────────────────────
 * ALL bonus values are sourced from AppSettings (admin-controlled).
 * No hardcoded values except safe fallbacks when DB is unavailable.
 */

import mongoose        from 'mongoose';
import User            from '../models/User.js';
import AppSettings     from '../models/AppSettings.js';
import CoinTransaction from '../models/CoinTransaction.js';

// ─── Default fallback config (used only if DB record is missing) ──────────────
const DEFAULT_COINS = {
  enabled:                     true,
  coinsPerRide:                5,
  conversionRate:              0.10,
  maxDiscountPerRide:          20,
  coinsRequiredForMaxDiscount: 100,
  distanceBonuses: [
    { label: '0–3 km',  maxKm: 3,    bonus: 1 },
    { label: '3–8 km',  maxKm: 8,    bonus: 2 },
    { label: '8+ km',   maxKm: null, bonus: 4 },
  ],
  vehicleBonuses: {
    bike:    1,
    auto:    2,
    car:     3,
    premium: 3,
    xl:      4,
  },
  randomBonusCoins:   10,
  randomBonusChance:  0.20,
};

/**
 * Resolve the correct customer model.
 * Customers may be in a separate 'Customer' collection or fall back to 'User'.
 */
function getCustomerModel() {
  try {
    return mongoose.models.Customer || mongoose.model('Customer');
  } catch {
    return User;
  }
}

/**
 * Merge DB coins config with defaults — every key falls back safely.
 */
function mergeConfig(dbCoins = {}) {
  const dist = Array.isArray(dbCoins.distanceBonuses) && dbCoins.distanceBonuses.length
    ? dbCoins.distanceBonuses
    : DEFAULT_COINS.distanceBonuses;

  const veh = (dbCoins.vehicleBonuses && Object.keys(dbCoins.vehicleBonuses).length)
    ? { ...DEFAULT_COINS.vehicleBonuses, ...dbCoins.vehicleBonuses }
    : DEFAULT_COINS.vehicleBonuses;

  return {
    enabled:                     dbCoins.enabled                     ?? DEFAULT_COINS.enabled,
    coinsPerRide:                dbCoins.coinsPerRide                ?? DEFAULT_COINS.coinsPerRide,
    conversionRate:              dbCoins.conversionRate              ?? DEFAULT_COINS.conversionRate,
    maxDiscountPerRide:          dbCoins.maxDiscountPerRide          ?? DEFAULT_COINS.maxDiscountPerRide,
    coinsRequiredForMaxDiscount: dbCoins.coinsRequiredForMaxDiscount ?? DEFAULT_COINS.coinsRequiredForMaxDiscount,
    distanceBonuses:             dist,
    vehicleBonuses:              veh,
    randomBonusCoins:            dbCoins.randomBonusCoins            ?? DEFAULT_COINS.randomBonusCoins,
    randomBonusChance:           dbCoins.randomBonusChance           ?? DEFAULT_COINS.randomBonusChance,
  };
}

/**
 * calculateCoinsForRide({ distanceKm, vehicleType, coinConfig, applyRandom })
 * Pure function — no DB access.
 */
export function calculateCoinsForRide({
  distanceKm   = 0,
  vehicleType  = 'bike',
  coinConfig   = DEFAULT_COINS,
  applyRandom  = false,
}) {
  const vType = vehicleType?.toLowerCase?.() ?? 'bike';
  const cfg   = coinConfig;

  const base = cfg.coinsPerRide ?? 5;

  let distanceBonus = 0;
  const tiers = [...(cfg.distanceBonuses ?? DEFAULT_COINS.distanceBonuses)]
    .sort((a, b) => (a.maxKm ?? Infinity) - (b.maxKm ?? Infinity));

  for (const tier of tiers) {
    if (tier.maxKm === null || distanceKm <= tier.maxKm) {
      distanceBonus = tier.bonus ?? 0;
      break;
    }
  }

  const vehicleBonuses = cfg.vehicleBonuses ?? DEFAULT_COINS.vehicleBonuses;
  const vehicleBonus   = vehicleBonuses[vType] ?? 0;

  let randomBonus = 0;
  if (applyRandom) {
    const chance = cfg.randomBonusChance ?? DEFAULT_COINS.randomBonusChance;
    if (Math.random() < chance) {
      randomBonus = cfg.randomBonusCoins ?? DEFAULT_COINS.randomBonusCoins;
    }
  }

  const total = base + distanceBonus + vehicleBonus + randomBonus;

  return {
    base,
    distanceBonus,
    vehicleBonus,
    randomBonus,
    total,
    breakdown: { base, distanceBonus, vehicleBonus, randomBonus, total },
  };
}

// ─── DB-backed helpers ────────────────────────────────────────────────────────

/**
 * getCoinsConfig() — Load and merge AppSettings coins config from DB.
 */
export async function getCoinsConfig() {
  try {
    const settings   = await AppSettings.getSettings();
    const coinsPlain = settings?.coins?.toObject
      ? settings.coins.toObject()
      : (settings?.coins ?? {});
    return mergeConfig(coinsPlain);
  } catch {
    return mergeConfig({});
  }
}

/**
 * awardRideCoins(customerId, tripId, { distanceKm, vehicleType })
 * ──────────────────────────────────────────────────────────────
 * Awards coins to a customer after a completed ride.
 *
 * Accepts BOTH call signatures for backwards compatibility:
 *   • awardRideCoins(customerId, tripId, { distanceKm, vehicleType })   ← tripController style
 *   • awardRideCoins({ userId, tripId, distanceKm, vehicleType })        ← named-arg style
 */
export async function awardRideCoins(customerIdOrOpts, tripIdArg, optsArg) {
  // ── Normalise arguments ────────────────────────────────────────────────────
  let customerId, tripId, distanceKm, vehicleType;

  if (customerIdOrOpts && typeof customerIdOrOpts === 'object' && !customerIdOrOpts.toHexString) {
    // Named-arg style: awardRideCoins({ userId, tripId, distanceKm, vehicleType })
    ({ userId: customerId, tripId, distanceKm = 0, vehicleType = 'bike' } = customerIdOrOpts);
  } else {
    // Positional style: awardRideCoins(customerId, tripId, { distanceKm, vehicleType })
    customerId  = customerIdOrOpts;
    tripId      = tripIdArg;
    distanceKm  = optsArg?.distanceKm  ?? 0;
    vehicleType = optsArg?.vehicleType ?? 'bike';
  }

  const cfg = await getCoinsConfig();
  if (!cfg.enabled) return null;

  const result = calculateCoinsForRide({
    distanceKm,
    vehicleType,
    coinConfig:  cfg,
    applyRandom: true,
  });

  // ── Resolve customer model (Customer collection or User fallback) ──────────
  const CustomerModel = getCustomerModel();
  const user = await CustomerModel.findById(customerId);
  if (!user) {
    console.warn(`⚠️ awardRideCoins: customer ${customerId} not found in ${CustomerModel.modelName}`);
    throw new Error('User not found');
  }

  user.coins            = (user.coins ?? 0) + result.total;
  user.totalCoinsEarned = (user.totalCoinsEarned ?? 0) + result.total;

  const coinsRequired  = cfg.coinsRequiredForMaxDiscount;
  const couponUnlocked = user.coins >= coinsRequired;

  await user.save();

  // Log the transaction
  await CoinTransaction.create({
    userId:      customerId,
    tripId,
    coinsEarned: result.total,
    type:        'earn',
    description: `Ride completed (+${result.distanceBonus} dist, +${result.vehicleBonus} vehicle${result.randomBonus ? `, +${result.randomBonus} lucky!` : ''})`,
    balanceAfter: user.coins,
    breakdown:   result.breakdown,
  });

  return {
    awarded:        true,         // ✅ tripController checks coinReward?.awarded
    coinsAwarded:   result.total,
    totalCoins:     user.coins,   // ✅ tripController reads coinReward.totalCoins
    newBalance:     user.coins,
    coinsRequired,
    couponUnlocked,
    breakdown:      result.breakdown,
  };
}

/**
 * getCustomerCoinSummary(customerId)
 * Returns wallet data for the Flutter coins_wallet_page.
 */
export async function getCustomerCoinSummary(customerId) {
  const CustomerModel = getCustomerModel();
  const [user, cfg] = await Promise.all([
    CustomerModel.findById(customerId).lean(),
    getCoinsConfig(),
  ]);

  if (!user) throw new Error('User not found');

  const transactions = await CoinTransaction
    .find({ userId: customerId })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  const coins         = user.coins ?? 0;
  const coinsRequired = cfg.coinsRequiredForMaxDiscount;
  const progress      = coinsRequired > 0 ? Math.min(coins / coinsRequired, 1) : 0;

  return {
    success: true,
    coins,
    coinsRequired,
    maxDiscountPerRide:          cfg.maxDiscountPerRide,
    conversionRate:              cfg.conversionRate,
    isDiscountEnabled:           cfg.enabled,
    coinDiscountActive:          coins >= coinsRequired && cfg.enabled,
    progress,
    distanceBonuses:             cfg.distanceBonuses,
    vehicleBonuses:              cfg.vehicleBonuses,
    randomBonusCoins:            cfg.randomBonusCoins,
    randomBonusChance:           cfg.randomBonusChance,
    totalCoinsEarned:            user.totalCoinsEarned ?? 0,
    totalCoinsRedeemed:          user.totalCoinsRedeemed ?? 0,
    transactions: transactions.map(tx => ({
      type:        tx.coinsEarned > 0 ? 'earn' : 'spend',
      isEarned:    tx.coinsEarned > 0,
      coins:       Math.abs(tx.coinsEarned),
      description: tx.description,
      createdAt:   tx.createdAt,
      breakdown:   tx.breakdown,
    })),
    // Legacy fields
    totalCoins:    coins,
    distanceTiers: cfg.distanceBonuses.map(d => ({
      label:                    d.label,
      coinsRequiredForDiscount: coinsRequired,
      discountAmount:           cfg.maxDiscountPerRide,
      bonus:                    d.bonus,
    })),
  };
}

/**
 * getDiscountEligibility(customerId)
 * Used by short_trip_page to check if coin discount is available.
 */
export async function getDiscountEligibility(customerId) {
  const CustomerModel = getCustomerModel();
  const [user, cfg] = await Promise.all([
    CustomerModel.findById(customerId).select('coins').lean(),
    getCoinsConfig(),
  ]);
  if (!user) throw new Error('User not found');

  const coins              = user.coins ?? 0;
  const coinsRequired      = cfg.coinsRequiredForMaxDiscount;
  const coinDiscountActive = coins >= coinsRequired && cfg.enabled;

  return {
    success: true,
    coinDiscountActive,
    coins,
    coinsRequired,
    discountAmount:    cfg.maxDiscountPerRide,
    coinsLeft:         Math.max(0, coinsRequired - coins),
    hasDiscount:       coinDiscountActive,
    isDiscountEnabled: cfg.enabled,
  };
}

/**
 * redeemCoinsForDiscount(customerId)
 * Deducts coins and returns discount amount.
 */
export async function redeemCoinsForDiscount(customerId) {
  const cfg          = await getCoinsConfig();
  const CustomerModel = getCustomerModel();
  const user         = await CustomerModel.findById(customerId);
  if (!user) throw new Error('User not found');

  const coins         = user.coins ?? 0;
  const coinsRequired = cfg.coinsRequiredForMaxDiscount;

  if (coins < coinsRequired) {
    throw new Error(`Need ${coinsRequired} coins, have ${coins}`);
  }

  user.coins              = coins - coinsRequired;
  user.totalCoinsRedeemed = (user.totalCoinsRedeemed ?? 0) + coinsRequired;
  await user.save();

  await CoinTransaction.create({
    userId:      customerId,
    coinsEarned: -coinsRequired,
    type:        'spend',
    description: `Redeemed ${coinsRequired} coins for ₹${cfg.maxDiscountPerRide} discount`,
    balanceAfter: user.coins,
  });

  return {
    success:        true,
    discountAmount: cfg.maxDiscountPerRide,
    coinsUsed:      coinsRequired,
    newBalance:     user.coins,
  };
}
