// src/services/rewardService.js
// ─────────────────────────────────────────────────────────────────────────────
// Central reward service:
//   1. Referral code generation
//   2. Referral signup recording (with fraud checks)
//   3. Welcome coupon assignment
//   4. General coin awarding
//   5. First-ride referral handling (cycle-aware)
//   6. Referral reward claiming
//   7. Coin redemption
// ─────────────────────────────────────────────────────────────────────────────
import mongoose      from 'mongoose';
import User          from '../models/User.js';
import Coupon        from '../models/Coupon.js';
import Referral      from '../models/Referral.js';
import AppSettings   from '../models/AppSettings.js';
import CoinTransaction from '../models/CoinTransaction.js';
import Wallet        from '../models/Wallet.js';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getReferralSettings(settings, role = 'customer') {
  return role === 'driver'
    ? settings.driverReferral || {}
    : settings.referral || {};
}

/**
 * Compute per-cycle reward values from admin settings.
 * cycle is 0-indexed (0 = first cycle).
 */
function getCycleReward(referralSettings, cycle, role = 'customer') {
  const {
    baseReferralsRequired    = 5,
    extraReferralsPerCycle   = 2,
    maxReferralCycles        = 3,
    baseCouponAmount         = 30,
    extraCouponAmount        = 10,
    baseCoinsReward          = 50,
    extraCoinsReward         = 10,
    rewardCouponValidityDays = 90,
    baseRewardAmount         = 100,
    extraRewardAmount        = 25,
    referralsRequired        = 1,
    ridesToComplete          = 1,
    rewardAmount             = 100,
  } = referralSettings;

  if (role === 'driver') {
    const resolvedRequired = Number.isFinite(Number(referralsRequired))
      ? Number(referralsRequired)
      : baseReferralsRequired + cycle * extraReferralsPerCycle;
    const resolvedAmount = Number.isFinite(Number(rewardAmount))
      ? Number(rewardAmount)
      : baseRewardAmount + cycle * extraRewardAmount;

    return {
      referralsRequired: Math.max(1, resolvedRequired),
      ridesToComplete:   Math.max(1, Number(ridesToComplete) || 1),
      rewardAmount:      Math.max(0, resolvedAmount),
      validityDays:      rewardCouponValidityDays,
      maxReferralCycles: 1,
    };
  }

  return {
    referralsRequired: baseReferralsRequired + cycle * extraReferralsPerCycle,
    couponAmount:      baseCouponAmount      + cycle * extraCouponAmount,
    coinsReward:       baseCoinsReward       + cycle * extraCoinsReward,
    validityDays:      rewardCouponValidityDays,
    maxReferralCycles,
  };
}

function getReferralCodeField(role = 'customer') {
  return role === 'driver' ? 'driverReferralCode' : 'referralCode';
}

function getReferralParentField(role = 'customer') {
  return role === 'driver' ? 'driverReferredBy' : 'referredBy';
}

function getReferralProgressField(role = 'customer') {
  return role === 'driver' ? 'driverReferralProgress' : 'referralProgress';
}

function getReferralCycleField(role = 'customer') {
  return role === 'driver' ? 'driverReferralCycleCount' : 'referralCycleCount';
}

function getReferralPendingField(role = 'customer') {
  return role === 'driver' ? 'driverReferralRewardPendingClaim' : 'referralRewardPendingClaim';
}

function getReferralClaimedField(role = 'customer') {
  return role === 'driver' ? 'driverReferralRewardClaimed' : 'referralRewardClaimed';
}

function getReferralBalanceField(role = 'customer') {
  return role === 'driver' ? 'driverReferralAmountBalance' : 'referralCoinsBalance';
}

function getReferralCouponField(role = 'customer') {
  return role === 'driver' ? 'driverReferralCouponCode' : 'referralCouponCode';
}

function getReferralSuccessfulField(role = 'customer') {
  return role === 'driver' ? 'driverSuccessfulReferrals' : 'successfulReferrals';
}

function getReferralCodePrefix(role = 'customer') {
  return role === 'driver' ? 'DRV' : 'REF';
}

function buildDriverReferralTransaction(amount) {
  return {
    type: 'referral_bonus',
    amount,
    description: `Driver referral reward — +₹${amount}`,
    paymentMethod: 'wallet',
    status: 'completed',
    createdAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. REFERRAL CODE GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ensureReferralCode(userId)
 * Generates a unique referral code for a customer.
 * Idempotent — safe to call multiple times.
 */
export async function ensureReferralCode(userId, role = 'customer') {
  try {
    const field = getReferralCodeField(role);
    const user = await User.findById(userId).select(`${field} role`);
    if (!user) return null;
    if (user.role !== role) return null;
    if (user[field]) return user[field];

    let code     = null;
    let attempts = 0;
    while (!code && attempts < 10) {
      const candidate = _generateCode(userId.toString(), role);
      const existing  = await User.findOne({ [field]: candidate })
        .select('_id').lean();
      if (!existing) code = candidate;
      attempts++;
    }

    // Fallback if all attempts collide (extremely rare)
    if (!code) {
      code = `${getReferralCodePrefix(role)}${Date.now().toString(36).toUpperCase()}`;
    }

    await User.findByIdAndUpdate(userId, { [field]: code });
    console.log(`✅ ${role} referral code generated: ${code} for user ${userId}`);
    return code;
  } catch (err) {
    console.error('❌ ensureReferralCode:', err.message);
    return null;
  }
}

function _generateCode(seed, role = 'customer') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const prefix = getReferralCodePrefix(role);
  let suffix  = '';
  for (let i = 0; i < 5; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}${suffix}`.slice(0, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RECORD REFERRAL AT SIGNUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * recordReferralSignup(newUserId, referralCode)
 * Called during firebase-sync when a new user signs up with a referral code.
 *
 * Fraud checks:
 *   ✅ Code must exist and belong to a real customer
 *   ✅ No self-referral (same userId OR same phone)
 *   ✅ User cannot be referred twice (unique index on referredUserId)
 *   ✅ referredBy field not already set on user
 */
export async function recordReferralSignup(newUserId, referralCode, role = 'customer') {
  try {
    if (!referralCode || !newUserId) {
      return { success: false, message: 'Missing parameters' };
    }

    const code = referralCode.trim().toUpperCase();

    // ── 1. Find referrer ────────────────────────────────────────────────────
    const referrerField = getReferralCodeField(role);
    const referrer = await User.findOne({ [referrerField]: code })
      .select('_id phone role name')
      .lean();

    if (!referrer) {
      console.warn(`⚠️ recordReferralSignup: Invalid code "${code}"`);
      return { success: false, message: 'Invalid referral code' };
    }

    if (referrer.role !== role) {
      return { success: false, message: 'Invalid referral code' };
    }

    // ── 2. Find new user ────────────────────────────────────────────────────
    const newUser = await User.findById(newUserId)
      .select('_id phone referredBy driverReferredBy')
      .lean();

    if (!newUser) {
      return { success: false, message: 'User not found' };
    }

    // ── 3. Self-referral by userId ──────────────────────────────────────────
    if (referrer._id.toString() === newUserId.toString()) {
      console.warn(`⚠️ Self-referral attempt: ${newUserId}`);
      return { success: false, message: 'Cannot refer yourself' };
    }

    // ── 4. Self-referral by phone ───────────────────────────────────────────
    if (referrer.phone === newUser.phone) {
      console.warn(`⚠️ Same-phone referral: ${newUser.phone}`);
      return { success: false, message: 'Cannot refer yourself' };
    }

    // ── 5. Already referred check (referredBy on User) ──────────────────────
    const referredByField = getReferralParentField(role);
    if (newUser[referredByField]) {
      console.warn(`⚠️ User ${newUserId} already has referredBy set`);
      return { success: false, message: 'User already referred' };
    }

    // ── 6. Already referred check (Referral collection) ─────────────────────
    const alreadyReferred = await Referral.findOne({
      referredUserId: newUserId,
    }).lean();

    if (alreadyReferred) {
      console.warn(`⚠️ Referral record already exists for ${newUserId}`);
      return { success: false, message: 'User already referred' };
    }

    // ── 7. Create Referral record ───────────────────────────────────────────
    await Referral.create({
      referrerId:     referrer._id,
      referredUserId: newUserId,
      referralCode:   code,
    });

    // ── 8. Mark referredBy on new user ──────────────────────────────────────
    await User.findByIdAndUpdate(newUserId, { [referredByField]: referrer._id });

    console.log(`✅ Referral recorded: ${referrer._id} → ${newUserId} (code: ${code})`);
    return { 
      success: true, 
      referrerId: referrer._id,
      referrerName: referrer.name || 'Driver',
      referrerPhone: referrer.phone 
    };
  } catch (err) {
    // Duplicate key = race condition, already referred
    if (err.code === 11000) {
      console.warn(`⚠️ Duplicate referral (race condition) for ${newUserId}`);
      return { success: false, message: 'User already referred' };
    }
    console.error('❌ recordReferralSignup:', err.message);
    return { success: false, message: 'Internal error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. WELCOME COUPON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * assignWelcomeCoupon(userId)
 * Auto-assigns a welcome coupon to a new customer on registration.
 * Idempotent — safe to call multiple times.
 */
export async function assignWelcomeCoupon(userId) {
  try {
    const user = await User.findById(userId)
      .select('role welcomeCouponAssigned');
    if (!user || user.role !== 'customer') {
      return { success: false, message: 'Not a customer' };
    }
    if (user.welcomeCouponAssigned) {
      return { success: true, message: 'Already assigned' };
    }

    const settings = await AppSettings.getSettings();
    const { discountAmount, fareAdjustment, code, validityDays, enabled } =
      settings.welcomeCoupon;

    if (!enabled) {
      return { success: false, message: 'Welcome coupon disabled' };
    }

    // Ensure master coupon exists (create once, reuse for all users)
    let coupon = await Coupon.findOne({ code: code.toUpperCase() });
    if (!coupon) {
      const validUntil = new Date();
      validUntil.setFullYear(validUntil.getFullYear() + 10);

      coupon = await Coupon.create({
        code:               code.toUpperCase(),
        description:        `Welcome offer! Get ₹${discountAmount} off on your first ride.`,
        discountType:       'FIXED',
        discountValue:      discountAmount,
        applicableVehicles: ['all'],
        applicableFor:      'FIRST_RIDE',
        maxUsagePerUser:    1,
        totalUsageLimit:    null,
        validFrom:          new Date(),
        validUntil,
        isActive:           true,
        eligibleUserTypes:  ['NEW'],
        minRidesCompleted:  0,
        maxRidesCompleted:  0,
        createdBy:          'system',
      });
      console.log(`🎟️ Welcome coupon created: ${coupon.code}`);
    }

    await User.findByIdAndUpdate(userId, { welcomeCouponAssigned: true });
    console.log(`✅ Welcome coupon assigned to ${userId}`);

    return {
      success:        true,
      couponCode:     coupon.code,
      discountAmount,
      fareAdjustment,
      message: `Welcome! Use ${coupon.code} for ₹${discountAmount} off your first ride.`,
    };
  } catch (err) {
    console.error('❌ assignWelcomeCoupon:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. AWARD COINS (general purpose)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * awardCoins(customerId, tripId, transactionType, opts)
 * Awards coins to a customer and records a CoinTransaction.
 * transactionType: 'ride_reward' | 'referral_reward' | 'admin_grant'
 */
export async function awardCoins(
  customerId,
  tripId,
  transactionType = 'ride_reward',
  opts = {}
) {
  try {
    const settings = await AppSettings.getSettings();
    if (!settings.coins.enabled) {
      return { success: true, awarded: false, reason: 'coins_disabled' };
    }

    const baseCoins    = settings.coins.coinsPerRide ?? 5;
    const coinsToAward = opts.coins ?? baseCoins;

    const customer = await User.findByIdAndUpdate(
      customerId,
      { $inc: { coins: coinsToAward, totalCoinsEarned: coinsToAward } },
      { new: true }
    );
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }

    const descMap = {
      ride_reward:     `Ride completed — +${coinsToAward} coins`,
      referral_reward: `Referral milestone reward — +${coinsToAward} coins`,
      admin_grant:     `Admin granted — +${coinsToAward} coins`,
    };

    // Map to CoinTransaction type enum
    const txTypeMap = {
      ride_reward:     'earn',
      referral_reward: 'referral_reward',
      admin_grant:     'admin_grant',
    };

    await CoinTransaction.create({
      userId:       customerId,
      tripId:       tripId || null,
      coinsEarned:  coinsToAward,
      type:         txTypeMap[transactionType] || 'earn',
      description:  descMap[transactionType] || `+${coinsToAward} coins`,
      balanceAfter: customer.coins ?? 0,
    });

    console.log(`✅ +${coinsToAward} coins → user ${customerId} (${transactionType})`);
    return {
      success:      true,
      awarded:      true,
      coinsAwarded: coinsToAward,
      totalCoins:   customer.coins,
    };
  } catch (err) {
    console.error('❌ awardCoins:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. REFERRAL FIRST-RIDE COMPLETION (cycle-aware)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * handleFirstRideReferral(customerId, tripId)
 * Called from tripController.js → confirmCashCollection()
 * when a customer's FIRST ride is confirmed paid.
 *
 * Flow:
 *   1. Find referral record for this customer
 *   2. Mark first ride complete
 *   3. Increment referrer's progress + successfulReferrals
 *   4. Check if milestone reached for current cycle
 *   5. If yes → pre-generate coupon (inactive) + set pendingClaim flag
 *
 * IMPORTANT: Coins are NOT awarded here.
 *   They are queued in referralCoinsBalance.
 *   Actual coin award happens in claimReferralReward().
 */
export async function handleFirstRideReferral(userId, tripId, role = 'customer') {
  try {
    // ── 1. Find referral record ─────────────────────────────────────────────
    const referral = await Referral.findOne({
      referredUserId:     userId,
      firstRideCompleted: false,
    });

    if (!referral) {
      console.log(`ℹ️ No pending referral for ${role} ${userId}`);
      return { success: true, hadReferral: false };
    }

    // ── 2. Load admin config ────────────────────────────────────────────────
    const settings        = await AppSettings.getSettings();
    const ref             = getReferralSettings(settings, role);

    // Driver referral can require multiple completed rides by referred user.
    if (role === 'driver') {
      const ridesToComplete = Math.max(1, Number(ref.ridesToComplete) || 1);
      const completedRideCount = (referral.completedRideCount || 0) + 1;

      referral.completedRideCount = completedRideCount;

      if (completedRideCount < ridesToComplete) {
        await referral.save();
        console.log(
          `ℹ️ Driver referral progress for ${userId}: ${completedRideCount}/${ridesToComplete} rides completed`
        );
        return {
          success: true,
          hadReferral: true,
          milestoneReached: false,
          referredUserRides: completedRideCount,
          ridesRequired: ridesToComplete,
        };
      }
    }

    // ── 3. Mark referral completion milestone ───────────────────────────────
    referral.firstRideCompleted   = true;
    referral.firstRideTripId      = tripId;
    referral.firstRideCompletedAt = new Date();
    await referral.save();

    console.log(`✅ Referral completion marked for referred ${role} user ${userId}`);

    if (!ref.enabled) {
      console.log('ℹ️ Referral system disabled by admin');
      return { success: true, hadReferral: true };
    }

    // ── 4. Load referrer ────────────────────────────────────────────────────
    const referrer = await User.findById(referral.referrerId);
    if (!referrer) {
      console.warn(`⚠️ Referrer ${referral.referrerId} not found`);
      return { success: false, error: 'Referrer not found' };
    }

    // ── 5. Determine active cycle/config context ────────────────────────────
    const cycleField = getReferralCycleField(role);
    const currentCycle = role === 'driver' ? 0 : (referrer[cycleField] ?? 0);
    const maxAllowedCycles = role === 'driver' ? 1 : (ref.maxReferralCycles ?? 3);

    const progressField = getReferralProgressField(role);
    const successfulField = getReferralSuccessfulField(role);
    const pendingField = getReferralPendingField(role);
    const balanceField = getReferralBalanceField(role);
    const claimedField = getReferralClaimedField(role);
    const couponField = getReferralCouponField(role);

    // ── 6. Increment progress ───────────────────────────────────────────────
    const newProgress = (referrer[progressField] ?? 0) + 1;

    await User.findByIdAndUpdate(referral.referrerId, {
      $inc: {
        [successfulField]: 1,
        [progressField]:    1,
      },
    });

    // Get cycle reward config
    const cycleReward = getCycleReward(ref, currentCycle, role);

    console.log(
      `🎯 Referrer ${referrer._id}: progress ${newProgress}/${cycleReward.referralsRequired}` +
      ` (${role === 'driver' ? 'simple driver referral' : `cycle ${currentCycle + 1}/${maxAllowedCycles}`})`
    );

    // ── 7. Check milestone ──────────────────────────────────────────────────
    const milestoneReached =
      newProgress >= cycleReward.referralsRequired &&
      !referrer[pendingField]; // don't queue twice

    if (milestoneReached) {
      console.log(`🎉 Milestone reached for referrer ${referrer._id}!`);

      if (role === 'driver') {
        await User.findByIdAndUpdate(referrer._id, {
          $set: {
            [pendingField]: true,
            [balanceField]: (referrer[balanceField] || 0) + cycleReward.rewardAmount,
          },
        });

        console.log(
          `📦 Queued for ${referrer._id}: ₹${cycleReward.rewardAmount} driver referral reward`
        );
      } else {
        // Pre-create coupon (isActive=false until user claims)
        const couponCode = await _prepareMilestoneCoupon(
          referrer._id,
          cycleReward.couponAmount,
          cycleReward.validityDays,
          currentCycle + 1
        );

        // Queue reward — user must tap "Claim" to receive
        await User.findByIdAndUpdate(referrer._id, {
          $set: {
            [pendingField]: true,
            [couponField]:  couponCode,
            referralCoinsBalance:
              (referrer.referralCoinsBalance || 0) + cycleReward.coinsReward,
          },
        });

        console.log(
          `📦 Queued for ${referrer._id}: ` +
          `₹${cycleReward.couponAmount} coupon (${couponCode}) + ` +
          `${cycleReward.coinsReward} coins`
        );
      }
    }

    return {
      success:         true,
      hadReferral:     true,
      referrerId:      referral.referrerId,
      milestoneReached,
      progress:        newProgress,
      required:        cycleReward.referralsRequired,
    };
  } catch (err) {
    console.error('❌ handleFirstRideReferral:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. CLAIM REFERRAL REWARD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * claimReferralReward(userId)
 * Called when user taps "Claim Now" on ReferralPage.
 *
 * Flow:
 *   1. Verify pendingClaim is true
 *   2. Award queued coins (CoinTransaction created here)
 *   3. Activate pre-created coupon
 *   4. Advance cycle, reset progress
 *   5. Return result to frontend
 */
export async function claimReferralReward(userId, role = 'customer') {
  // Use DB session for atomicity
  const session = await mongoose.startSession();
  try {
    let claimResult = null;

    await session.withTransaction(async () => {
      // ── 1. Load user ──────────────────────────────────────────────────────
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('User not found');

      // ── 2. Verify pending claim ───────────────────────────────────────────
      const pendingField = getReferralPendingField(role);
      const claimedField = getReferralClaimedField(role);
      const cycleField = getReferralCycleField(role);
      const balanceField = getReferralBalanceField(role);
      const couponField = getReferralCouponField(role);
      const progressField = getReferralProgressField(role);

      if (!user[pendingField]) {
        throw new Error('No pending referral reward to claim');
      }

      // ── 3. Load admin config ──────────────────────────────────────────────
      const settings        = await AppSettings.getSettings();
      const ref             = getReferralSettings(settings, role);
      const maxAllowedCycles = role === 'driver' ? 1 : (ref.maxReferralCycles ?? 3);
      const currentCycle    = role === 'driver' ? 0 : (user[cycleField] ?? 0);
      const cycleReward = getCycleReward(ref, currentCycle, role);

      let newCycle = role === 'driver' ? 1 : currentCycle + 1;
      let cyclesExhausted = role === 'driver' ? false : newCycle >= maxAllowedCycles;

      if (role === 'driver') {
        const amountToAward = user[balanceField] > 0
          ? user[balanceField]
          : cycleReward.rewardAmount;

        const wallet = await Wallet.findOneAndUpdate(
          { driverId: userId },
          {
            $inc: {
              availableBalance: amountToAward,
              balance: amountToAward,
              totalEarnings: amountToAward,
            },
            $push: {
              transactions: buildDriverReferralTransaction(amountToAward),
            },
            $set: { lastUpdated: new Date() },
          },
          { upsert: true, new: true, session }
        );

        await User.findByIdAndUpdate(userId, {
          $inc: { wallet: amountToAward },
          $set: {
            [pendingField]: false,
            [claimedField]: true,
            [balanceField]: 0,
            [progressField]: 0,
            [couponField]: null,
          },
        }, { session });

        claimResult = {
          success:         true,
          amountAwarded:   amountToAward,
          cycleCompleted:  1,
          cyclesExhausted,
          maxCycles:       1,
          walletBalance:   wallet?.availableBalance ?? amountToAward,
          message: `🎉 Reward claimed! Refer more drivers to unlock the next payout.`,
        };
      } else {
        // ── 4. Award queued coins ─────────────────────────────────────────────
        const coinsToAward = user.referralCoinsBalance > 0
          ? user.referralCoinsBalance
          : cycleReward.coinsReward;

        const newCoinBalance = (user.coins || 0) + coinsToAward;

        await User.findByIdAndUpdate(userId, {
          $inc: { coins: coinsToAward, totalCoinsEarned: coinsToAward },
          $set: { referralCoinsBalance: 0 },
        }, { session });

        // ✅ Record CoinTransaction (shows in coins wallet history)
        await CoinTransaction.create([{ 
          userId,
          tripId:      null,
          coinsEarned: coinsToAward,
          type:        'referral_reward',
          description: `Referral Cycle ${currentCycle + 1} reward — +${coinsToAward} coins`,
          balanceAfter: newCoinBalance,
          breakdown: {
            baseCoins:     coinsToAward,
            distanceBonus: 0,
            vehicleBonus:  0,
            randomBonus:   0,
          },
        }], { session });

        console.log(`🪙 Referral coins awarded: +${coinsToAward} → user ${userId}`);

        // ── 5. Activate pre-created coupon ────────────────────────────────────
        const couponCode = user.referralCouponCode;
        if (couponCode) {
          await Coupon.findOneAndUpdate(
            { code: couponCode },
            { $set: { isActive: true } },
            { session }
          );
          console.log(`✅ Coupon activated: ${couponCode}`);
        }

        // ── 6. Advance cycle, reset progress ──────────────────────────────────
        await User.findByIdAndUpdate(userId, {
          $set: {
            referralRewardPendingClaim: false,
            referralRewardClaimed:      true,
            referralCycleCount:         newCycle,
            referralCouponCode:         null,
            referralProgress:           0,  // reset for next cycle
          },
        }, { session });

        console.log(
          `🎉 Referral claimed: user ${userId} | ` +
          `cycle ${newCycle} | coins +${coinsToAward} | coupon ${couponCode}`
        );

        claimResult = {
          success:         true,
          coinsAwarded:    coinsToAward,
          couponCode:      couponCode || null,
          couponAmount:    cycleReward.couponAmount,
          cycleCompleted:  newCycle,
          cyclesExhausted,
          maxCycles:       maxAllowedCycles,
          message: cyclesExhausted
            ? `🏆 All ${maxAllowedCycles} cycles completed! Final reward claimed.`
            : `🎉 Reward claimed! Cycle ${newCycle} begins — refer more friends!`,
        };
      }
    });

    session.endSession();
    return claimResult;
  } catch (err) {
    try { session.endSession(); } catch (_) {}
    console.error('❌ claimReferralReward:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Pre-create milestone coupon (inactive until claimed)
// ─────────────────────────────────────────────────────────────────────────────
async function _prepareMilestoneCoupon(
  referrerId,
  couponAmount,
  validityDays,
  cycleNumber
) {
  try {
    const code = `REF-${referrerId.toString().slice(-6).toUpperCase()}-C${cycleNumber}`;
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);

    const existing = await Coupon.findOne({ code });
    if (!existing) {
      await Coupon.create({
        code,
        description:        `🎉 Referral Cycle ${cycleNumber} — ₹${couponAmount} off your next ride`,
        discountType:       'FIXED',
        discountValue:      couponAmount,
        applicableVehicles: ['all'],
        applicableFor:      'ALL_RIDES',
        maxUsagePerUser:    1,
        totalUsageLimit:    1,
        currentUsageCount:  0,
        validFrom:          new Date(),
        validUntil,
        isActive:           false,  // ✅ Inactive until user claims
        eligibleUserTypes:  ['ALL'],
        minRidesCompleted:  0,
        maxRidesCompleted:  null,
        createdBy:          'system-referral',
      });
      console.log(`🎟️ Milestone coupon pre-created: ${code} (₹${couponAmount})`);
    }

    return code;
  } catch (err) {
    console.error('❌ _prepareMilestoneCoupon:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. COIN REDEMPTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * redeemCoins(customerId, coinsToRedeem)
 * Deducts coins and returns the discount amount.
 */
export async function redeemCoins(customerId, coinsToRedeem) {
  try {
    const settings = await AppSettings.getSettings();
    const { conversionRate, maxDiscountPerRide } = settings.coins;

    if (!settings.coins.enabled) {
      return { success: false, error: 'Coin system disabled' };
    }

    const customer = await User.findById(customerId);
    if (!customer) return { success: false, error: 'Customer not found' };

    if ((customer.coins || 0) < coinsToRedeem) {
      return { success: false, error: 'Insufficient coins' };
    }

    // Cap discount at maxDiscountPerRide
    let discountAmount = Math.round(coinsToRedeem * conversionRate * 100) / 100;
    if (discountAmount > maxDiscountPerRide) {
      discountAmount = maxDiscountPerRide;
      coinsToRedeem  = Math.ceil(maxDiscountPerRide / conversionRate);
    }

    const updated = await User.findByIdAndUpdate(
      customerId,
      { $inc: { coins: -coinsToRedeem, totalCoinsRedeemed: coinsToRedeem } },
      { new: true }
    );

    await CoinTransaction.create({
      userId:       customerId,
      coinsEarned:  -coinsToRedeem,
      type:         'spend',
      description:  `₹${discountAmount} ride discount (${coinsToRedeem} coins redeemed)`,
      balanceAfter: updated.coins ?? 0,
    });

    return {
      success:        true,
      coinsRedeemed:  coinsToRedeem,
      discountAmount,
      remainingCoins: updated.coins,
    };
  } catch (err) {
    console.error('❌ redeemCoins:', err.message);
    return { success: false, error: err.message };
  }
}