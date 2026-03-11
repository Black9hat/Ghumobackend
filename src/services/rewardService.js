// services/rewardService.js
// ─────────────────────────────────────────────────────────────────────────────
// Central service for:
//   • Generating unique referral codes
//   • Assigning welcome coupons to new customers
//   • Awarding coins on ride completion  (replaces the duplicate in rewards.routes.js)
//   • Processing referral first-ride completion & milestone rewards
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import User from '../models/User.js';
import Coupon from '../models/Coupon.js';
import CouponUsage from '../models/CouponUsage.js';
import Reward from '../models/Reward.js';
import Referral from '../models/Referral.js';
import AppSettings from '../models/AppSettings.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. REFERRAL CODE GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a unique 8-char alphanumeric referral code and assigns it to user.
 * Safe to call multiple times – skips if code already exists.
 */
export async function ensureReferralCode(userId) {
  const user = await User.findById(userId);
  if (!user) return null;
  if (user.referralCode) return user.referralCode;

  let code;
  let attempts = 0;

  while (!code && attempts < 10) {
    const candidate = generateCode(userId.toString());
    const existing = await User.findOne({ referralCode: candidate });
    if (!existing) code = candidate;
    attempts++;
  }

  if (!code) {
    code = `REF${Date.now().toString(36).toUpperCase()}`;
  }

  await User.findByIdAndUpdate(userId, { referralCode: code });
  console.log(`✅ Referral code generated: ${code} for user ${userId}`);
  return code;
}

function generateCode(seed) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const base = seed.slice(-4).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return (base + suffix).slice(0, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RECORD REFERRAL AT SIGNUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when a new customer signs up with a referral code.
 * Creates the Referral document and links referredBy on the user.
 * Validates: code exists, not self-referral, user not already referred.
 *
 * @returns { success, message, referrerId? }
 */
export async function recordReferralSignup(newUserId, referralCode) {
  if (!referralCode) return { success: false, message: 'No referral code provided' };

  const code = referralCode.trim().toUpperCase();

  // Find referrer
  const referrer = await User.findOne({ referralCode: code });
  if (!referrer) return { success: false, message: 'Invalid referral code' };

  // Prevent self-referral
  if (referrer._id.toString() === newUserId.toString()) {
    return { success: false, message: 'Cannot refer yourself' };
  }

  // Check if already referred
  const existing = await Referral.findOne({ referredUserId: newUserId });
  if (existing) return { success: false, message: 'User already has a referral' };

  await Referral.create({
    referrerId: referrer._id,
    referredUserId: newUserId,
    referralCode: code,
  });

  await User.findByIdAndUpdate(newUserId, { referredBy: referrer._id });

  console.log(`✅ Referral recorded: ${referrer._id} → ${newUserId}`);
  return { success: true, referrerId: referrer._id };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. WELCOME COUPON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-assigns a welcome coupon to a new customer on registration.
 * Creates the system-level WELCOME coupon if it doesn't exist yet.
 * Idempotent — safe to call multiple times.
 */
export async function assignWelcomeCoupon(userId) {
  try {
    const user = await User.findById(userId);
    if (!user || user.role !== 'customer') return { success: false, message: 'Not a customer' };
    if (user.welcomeCouponAssigned) return { success: true, message: 'Already assigned' };

    const settings = await AppSettings.getSettings();
    const { discountAmount, fareAdjustment, code, validityDays, enabled } = settings.welcomeCoupon;
    if (!enabled) return { success: false, message: 'Welcome coupon disabled' };

    // Ensure the coupon exists in the DB (create once, reuse for all new users)
    let coupon = await Coupon.findOne({ code: code.toUpperCase() });
    if (!coupon) {
      const validUntil = new Date();
      validUntil.setFullYear(validUntil.getFullYear() + 10); // long-lived master coupon

      coupon = await Coupon.create({
        code: code.toUpperCase(),
        description: `Welcome offer! Get ₹${discountAmount} off on your first ride.`,
        discountType: 'FIXED',
        discountValue: discountAmount,
        applicableVehicles: ['all'],
        applicableFor: 'FIRST_RIDE',
        maxUsagePerUser: 1,
        totalUsageLimit: null,            // unlimited (each user gets 1 use)
        validFrom: new Date(),
        validUntil,
        isActive: true,
        eligibleUserTypes: ['NEW'],
        minRidesCompleted: 0,
        maxRidesCompleted: 0,
        createdBy: 'system',
      });
      console.log(`🎟️ System welcome coupon created: ${coupon.code}`);
    }

    // Mark on user so we don't double-assign
    await User.findByIdAndUpdate(userId, { welcomeCouponAssigned: true });
    console.log(`✅ Welcome coupon assigned to user ${userId}`);

    return {
      success: true,
      couponCode: coupon.code,
      discountAmount,
      fareAdjustment,
      message: `Welcome! Use code ${coupon.code} on your first ride for ₹${discountAmount} off.`,
    };
  } catch (err) {
    console.error('❌ assignWelcomeCoupon error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. AWARD COINS ON RIDE COMPLETION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Awards coins to a customer after a completed ride.
 * Uses AppSettings for coin count (falls back to RewardSettings distance tiers
 * if present to stay backwards-compatible).
 *
 * @param {string|ObjectId} customerId
 * @param {string|ObjectId} tripId
 * @param {string} transactionType  - 'ride_reward' | 'referral_reward'
 * @param {object} [opts]
 * @returns { success, awarded, coinsAwarded, totalCoins }
 */
export async function awardCoins(customerId, tripId, transactionType = 'ride_reward', opts = {}) {
  try {
    const settings = await AppSettings.getSettings();
    if (!settings.coins.enabled) return { success: true, awarded: false, reason: 'coins_disabled' };

    const coinsToAward = opts.coins ?? settings.coins.coinsPerRide;

    const customer = await User.findByIdAndUpdate(
      customerId,
      {
        $inc: {
          coins: coinsToAward,
          totalCoinsEarned: coinsToAward,
        },
      },
      { new: true }
    );
    if (!customer) return { success: false, error: 'Customer not found' };

    const descMap = {
      ride_reward: `Ride completed – earned ${coinsToAward} coins`,
      referral_reward: `Referral milestone reward – ${coinsToAward} coins`,
      coin_redeem: `Coins redeemed for ride discount`,
    };

    await Reward.create({
      customerId,
      tripId: tripId || null,
      coins: coinsToAward,
      type: 'earned',
      description: descMap[transactionType] || `Coins awarded (${transactionType})`,
    });

    console.log(`✅ +${coinsToAward} coins → customer ${customerId} (${transactionType})`);
    return {
      success: true,
      awarded: true,
      coinsAwarded: coinsToAward,
      totalCoins: customer.coins,
    };
  } catch (err) {
    console.error('❌ awardCoins error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. REFERRAL FIRST-RIDE COMPLETION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when a customer completes their FIRST ride.
 * Marks their Referral record, increments referrer's successfulReferrals,
 * and triggers the 5-referral milestone reward if threshold is reached.
 *
 * @param {string|ObjectId} customerId  – the user who just completed ride 1
 * @param {string|ObjectId} tripId
 */
export async function handleFirstRideReferral(customerId, tripId) {
  try {
    // Find their referral entry (they were referred by someone)
    const referral = await Referral.findOne({
      referredUserId: customerId,
      firstRideCompleted: false,
    });
    if (!referral) return { success: true, hadReferral: false };

    // Mark first ride complete
    referral.firstRideCompleted = true;
    referral.firstRideTripId = tripId;
    referral.firstRideCompletedAt = new Date();
    await referral.save();

    // Increment referrer's count
    const referrer = await User.findByIdAndUpdate(
      referral.referrerId,
      { $inc: { successfulReferrals: 1 } },
      { new: true }
    );
    if (!referrer) return { success: false, error: 'Referrer not found' };

    console.log(
      `✅ Referral confirmed: ${referral.referrerId} now has ${referrer.successfulReferrals} successful referrals`
    );

    // Check milestone
    const settings = await AppSettings.getSettings();
    const { referralsRequired, rewardCouponAmount, rewardCoins, rewardCouponValidityDays, enabled } =
      settings.referral;

    if (!enabled) return { success: true, hadReferral: true, milestoneReached: false };

    if (
      referrer.successfulReferrals >= referralsRequired &&
      !referrer.referralRewardClaimed
    ) {
      await issueMilestoneReward(referrer, rewardCouponAmount, rewardCoins, rewardCouponValidityDays, tripId);
    }

    return { success: true, hadReferral: true, referrerId: referral.referrerId };
  } catch (err) {
    console.error('❌ handleFirstRideReferral error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Internal: issue the 5-referral milestone reward ──────────────────────────
async function issueMilestoneReward(referrer, couponAmount, coins, validityDays, tripId) {
  try {
    // Create a personal coupon for the referrer
    const code = `REF5-${referrer._id.toString().slice(-6).toUpperCase()}`;
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);

    const existing = await Coupon.findOne({ code });
    if (!existing) {
      await Coupon.create({
        code,
        description: `🎉 Referral reward! ₹${couponAmount} off on your next ride.`,
        discountType: 'FIXED',
        discountValue: couponAmount,
        applicableVehicles: ['all'],
        applicableFor: 'ALL_RIDES',
        maxUsagePerUser: 1,
        totalUsageLimit: 1,
        validFrom: new Date(),
        validUntil,
        isActive: true,
        eligibleUserTypes: ['ALL'],
        createdBy: 'system-referral',
      });
    }

    // Award coins
    await awardCoins(referrer._id, tripId, 'referral_reward', { coins });

    // Mark reward as claimed
    await User.findByIdAndUpdate(referrer._id, { referralRewardClaimed: true });

    console.log(
      `🎉 Referral milestone reward issued to ${referrer._id}: ₹${couponAmount} coupon (${code}) + ${coins} coins`
    );
  } catch (err) {
    console.error('❌ issueMilestoneReward error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. COIN REDEMPTION (for ride discount)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates & applies coin redemption for a ride.
 * Returns the discount amount in ₹.
 *
 * @param {string|ObjectId} customerId
 * @param {number} coinsToRedeem
 * @returns { success, discountAmount, remainingCoins }
 */
export async function redeemCoins(customerId, coinsToRedeem) {
  try {
    const settings = await AppSettings.getSettings();
    const { conversionRate, maxDiscountPerRide, coinsRequiredForMaxDiscount } = settings.coins;

    if (!settings.coins.enabled) {
      return { success: false, error: 'Coin system is disabled' };
    }

    const customer = await User.findById(customerId);
    if (!customer) return { success: false, error: 'Customer not found' };

    if ((customer.coins || 0) < coinsToRedeem) {
      return { success: false, error: 'Insufficient coins' };
    }

    // Calculate discount
    let discountAmount = Math.round(coinsToRedeem * conversionRate * 100) / 100;
    if (discountAmount > maxDiscountPerRide) {
      discountAmount = maxDiscountPerRide;
      // recalculate actual coins consumed
      coinsToRedeem = Math.ceil(maxDiscountPerRide / conversionRate);
    }

    // Deduct coins
    const updated = await User.findByIdAndUpdate(
      customerId,
      {
        $inc: {
          coins: -coinsToRedeem,
          totalCoinsRedeemed: coinsToRedeem,
        },
      },
      { new: true }
    );

    // Record transaction
    await Reward.create({
      customerId,
      coins: -coinsToRedeem,
      type: 'redeemed',
      description: `₹${discountAmount} ride discount (${coinsToRedeem} coins redeemed)`,
    });

    console.log(`✅ Coins redeemed: -${coinsToRedeem} coins → ₹${discountAmount} discount`);
    return {
      success: true,
      coinsRedeemed: coinsToRedeem,
      discountAmount,
      remainingCoins: updated.coins,
    };
  } catch (err) {
    console.error('❌ redeemCoins error:', err.message);
    return { success: false, error: err.message };
  }
}
