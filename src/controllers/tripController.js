// src/controllers/tripController.js
// ════════════════════════════════════════════════════════════════════════════
// COMPLETE TRIP CONTROLLER
// ════════════════════════════════════════════════════════════════════════════
import Trip            from '../models/Trip.js';
import Wallet          from '../models/Wallet.js';
import User            from '../models/User.js';
import DriverPlan      from '../models/DriverPlan.js';
import CoinTransaction from '../models/CoinTransaction.js';
import mongoose        from 'mongoose';
import CommissionSetting from '../models/CommissionSetting.js'; // ✅ ADDED
import { startProgressiveBroadcast, stopProgressiveBroadcast } from '../utils/progressiveTripBroadcaster.js';
import { io }          from '../socket/socketHandler.js';
import { TRIP_LIMITS } from '../config/tripConfig.js';
import { generateOTP } from '../utils/otpGeneration.js';
import RideHistory     from '../models/RideHistory.js';
import RewardSettings  from '../models/RewardSettings.js';
import AppSettings     from '../models/AppSettings.js';
import Reward          from '../models/Reward.js';
import {
  awardCoins,
  handleFirstRideReferral,
} from '../services/rewardService.js';
import { awardRideCoins } from '../services/coinService.js';

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS & HELPERS
// ════════════════════════════════════════════════════════════════════════════

const MINIMUM_FARE = 5;

const ALLOWED_TRANSITIONS = {
  requested:      ['driver_assigned', 'cancelled', 'timeout'],
  driver_assigned:['driver_at_pickup', 'cancelled'],
  driver_at_pickup:['ride_started', 'cancelled'],
  ride_started:   ['completed', 'awaiting_payment'],
  awaiting_payment:['completed'],
  completed:      [],
  cancelled:      [],
  timeout:        [],
};

function assertTransition(current, next) {
  if (!ALLOWED_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`Illegal transition ${current} → ${next}`);
  }
}

const getCustomerModel = async () => {
  try {
    return mongoose.models.Customer || mongoose.model('Customer');
  } catch (e) {
    return User;
  }
};

function normalizeCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length !== 2) {
    throw new Error('Coordinates must be [lat, lng] or [lng, lat]');
  }
  const [a, b] = coords.map(Number);
  if (Math.abs(a) <= 90 && Math.abs(b) > 90) return [b, a];
  return [a, b];
}

const findUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;
  if (
    typeof idOrPhone === 'string' &&
    /^[0-9a-fA-F]{24}$/.test(idOrPhone)
  ) {
    const byId = await User.findById(idOrPhone);
    if (byId) return byId;
  }
  return await User.findOne({ phone: idOrPhone });
};

function calculateDistanceFromCoords(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(v) { return (v * Math.PI) / 180; }

// ════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

async function saveToRideHistory(trip, status = 'Completed', session = null) {
  try {
    let populatedTrip = trip;
    if (!trip.customerId?.phone || !trip.assignedDriver?.name) {
      const q = Trip.findById(trip._id)
        .populate('customerId', 'phone name')
        .populate('assignedDriver', 'name phone vehicleNumber');
      if (session) q.session(session);
      populatedTrip = await q.lean();
    }
    if (!populatedTrip?.customerId?.phone) return;

    const rh = new RideHistory({
      phone:           populatedTrip.customerId.phone,
      customerId:      populatedTrip.customerId._id || populatedTrip.customerId,
      pickupLocation:  populatedTrip.pickup?.address  || 'Pickup Location',
      dropLocation:    populatedTrip.drop?.address    || 'Drop Location',
      vehicleType:     populatedTrip.vehicleType      || 'bike',
      fare:            populatedTrip.finalFare         || populatedTrip.fare || 0,
      originalFare:    populatedTrip.originalFare      || populatedTrip.fare || 0,
      discountApplied: populatedTrip.discountApplied   || 0,
      coinsUsed:       populatedTrip.coinsUsed         || 0,
      status,
      driver: {
        name:          populatedTrip.assignedDriver?.name          || 'N/A',
        phone:         populatedTrip.assignedDriver?.phone         || 'N/A',
        vehicleNumber: populatedTrip.assignedDriver?.vehicleNumber || 'N/A',
      },
      dateTime: populatedTrip.createdAt || new Date(),
      tripId:   populatedTrip._id,
    });

    if (session) await rh.save({ session });
    else         await rh.save();

    console.log(`✅ Ride history saved: ${rh._id}`);
  } catch (err) {
    console.error('❌ saveToRideHistory:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// UNIFIED EARNINGS RESOLVER
// Priority: active DriverPlan → CommissionSetting → hard default
// Returns all fields needed by both processWalletTransaction and
// confirmCashCollection so there is one single source of truth.
// ════════════════════════════════════════════════════════════════════════════
async function resolveDriverEarnings(driverId, fareAmount) {
  const driverDoc   = await User.findById(driverId).select('vehicleType city').lean();
  const vehicleType = driverDoc?.vehicleType || 'bike';
  const city        = driverDoc?.city        || 'all';

  // ── Step 1: check for an active, valid plan ──────────────────────────────
  const activePlan = await DriverPlan.findOne({
    driver:   driverId,
    isActive: true,
    expiryDate: { $gt: new Date() },
    $or: [
      { paymentStatus: 'completed' },
      { purchaseMethod: 'admin_assigned' },
    ],
  }).lean();

  const planIsValid = activePlan && (
    activePlan.isValidNow
      ? activePlan.isValidNow()
      : true
  );

  let commissionRate, perRideIncentive, platformFeeFlat, platformFeePercent;
  let planBonusMultiplier = 1;
  let planApplied = false, appliedPlanId = null, appliedPlanName = null;

  if (planIsValid) {
    // Use plan values for EVERYTHING
    commissionRate     = activePlan.noCommission ? 0 : (activePlan.commissionRate ?? 20);
    perRideIncentive   = activePlan.perRideIncentive   ?? 0;
    platformFeeFlat    = activePlan.platformFeeFlat    ?? 0;
    platformFeePercent = activePlan.platformFeePercent ?? 0;
    planBonusMultiplier = activePlan.bonusMultiplier ?? 1;
    planApplied        = true;
    appliedPlanId      = activePlan._id;
    appliedPlanName    = activePlan.planName;
    console.log(`📋 Plan active for driver ${driverId}: "${activePlan.planName}" | commission=${commissionRate}% incentive=₹${perRideIncentive}`);
  } else {
    // Use CommissionSetting values for EVERYTHING
    const settings = await CommissionSetting.getForVehicle(vehicleType, city);
    commissionRate     = settings.commissionPercent    ?? 20;
    perRideIncentive   = settings.perRideIncentive     ?? 0;
    platformFeeFlat    = settings.platformFeeFlat      ?? 0;
    platformFeePercent = settings.platformFeePercent   ?? 0;
    console.log(`📋 No active plan for driver ${driverId} — using CommissionSetting | commission=${commissionRate}% incentive=₹${perRideIncentive}`);
  }

  // ── Step 2: compute earnings using all configured fee components ─────────
  // platform fee = commission% of fare + fixed fee + extra % fee
  const commissionPart = fareAmount * (commissionRate / 100);
  const flatPart = platformFeeFlat;
  const percentPart = fareAmount * (platformFeePercent / 100);

  // Deducted platform fee cannot exceed fare amount.
  const totalPlatformFeeRaw = commissionPart + flatPart + percentPart;
  const totalPlatformFee = Math.min(fareAmount, totalPlatformFeeRaw);

  const commission = Math.round(totalPlatformFee * 100) / 100;
  const driverEarning = Math.round((fareAmount - commission) * 100) / 100;
  const effectivePlatformFeeRate =
    fareAmount > 0 ? Math.round((commission / fareAmount) * 10000) / 100 : 0;

  return {
    commissionRate,
    effectivePlatformFeeRate,
    commissionPart: Math.round(commissionPart * 100) / 100,
    platformFeeFlatApplied: Math.round(flatPart * 100) / 100,
    platformFeePercent,
    platformFeePercentAmount: Math.round(percentPart * 100) / 100,
    commission,
    driverEarning,
    perRideIncentive,
    platformFeeFlat,
    platformFeePercent,
    planBonusMultiplier,
    planApplied,
    appliedPlanId,
    appliedPlanName,
    vehicleType,
    city,
  };
}

async function processWalletTransaction(driverId, tripId, fareAmount, session) {
  try {
    console.log(`💳 Wallet: Driver ${driverId}, Fare ₹${fareAmount}`);

    const {
      commissionRate,
      commission,
      driverEarning,
      planApplied,
      appliedPlanId,
      appliedPlanName,
    } = await resolveDriverEarnings(driverId, fareAmount);

    const driver = await User.findById(driverId).session(session);
    if (!driver) throw new Error('Driver not found for wallet update');

    await User.findByIdAndUpdate(driverId, {
      $set: {
        totalEarnings:       (driver.totalEarnings       || 0) + driverEarning,
        totalCommissionPaid: (driver.totalCommissionPaid || 0) + commission,
        pendingAmount:       (driver.pendingAmount        || 0) + driverEarning,
        lastEarningAt:       new Date(),
      },
    }, { session });

    const description = planApplied
      ? `Ride ₹${fareAmount} | Commission: ₹${commission} (Plan: ${appliedPlanName})`
      : `Ride ₹${fareAmount} | Commission: ₹${commission}`;

    await Wallet.findOneAndUpdate(
      { driverId },
      {
        $inc: {
          totalEarnings:    driverEarning,
          totalCommission:  commission,
          availableBalance: driverEarning,
        },
        $push: {
          transactions: {
            type:               'credit',
            amount:             driverEarning,
            tripId:             tripId || null,
            description,
            originalFare:       fareAmount,
            commissionDeducted: commission,
            planBonus:          0,
            finalEarning:       driverEarning,
            planApplied,
            planId:             appliedPlanId ? null : null, // plan template ref
            driverPlanId:       appliedPlanId,
            planName:           appliedPlanName,
            planCommissionRate: commissionRate,
            status:             'completed',
            createdAt:          new Date(),
          },
        },
        $set: { lastUpdated: new Date() },
      },
      { upsert: true, session }
    );

    return {
      success: true,
      fareBreakdown: {
        tripFare:             fareAmount,
        commission,
        commissionPercentage: commissionRate,
        driverEarning,
        planApplied,
        planName:             appliedPlanName,
      },
    };
  } catch (err) {
    console.error('❌ processWalletTransaction:', err.message);
    return { success: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ✅ FIXED: awardIncentivesToDriver — reads from CommissionSetting (same
//    source as GET /api/trips/incentives/:driverId), so trip request card
//    and earnings bottom sheet always show the identical number.
// ════════════════════════════════════════════════════════════════════════════
async function awardIncentivesToDriver(driverId, tripId, session = null) {
  try {
    // resolveDriverEarnings already applies plan-vs-CommissionSetting priority.
    // Pass fare=0 — we only need the perRideIncentive from it.
    const resolved = await resolveDriverEarnings(driverId, 0);
    const { perRideIncentive, vehicleType, city } = resolved;

    if (!perRideIncentive || perRideIncentive === 0) {
      console.log(`ℹ️ No incentive configured for ${vehicleType}/${city} — skipping award`);
      return { success: true, awarded: false };
    }

    const q      = User.findById(driverId).select('totalIncentiveEarned totalRidesCompleted wallet lastRideId');
    const driver = session ? await q.session(session) : await q;
    if (!driver) return { success: false, error: 'Driver not found' };

    // Idempotency guard — never double-award for the same trip
    if (driver.lastRideId?.toString() === tripId?.toString()) {
      console.warn(`⚠️ Incentive already awarded for trip ${tripId} to driver ${driverId}`);
      return { success: true, awarded: false, reason: 'already_awarded' };
    }

    const update = {
      $set: {
        totalIncentiveEarned:   (driver.totalIncentiveEarned || 0) + perRideIncentive,
        totalRidesCompleted:    (driver.totalRidesCompleted  || 0) + 1,
        wallet:                 (driver.wallet               || 0) + perRideIncentive,
        lastRideId:             tripId,
        lastIncentiveAwardedAt: new Date(),
      },
    };

    if (session) await User.findByIdAndUpdate(driverId, update, { session });
    else         await User.findByIdAndUpdate(driverId, update);

    console.log(`✅ Awarded incentive to driver ${driverId}: ₹${perRideIncentive.toFixed(2)} [${vehicleType}/${city}] (${resolved.planApplied ? `Plan: ${resolved.appliedPlanName}` : 'CommissionSetting'})`);

    return { success: true, awarded: true, incentive: perRideIncentive };
  } catch (err) {
    console.error('❌ awardIncentivesToDriver:', err.message);
    return { success: false, error: err.message };
  }
}

async function awardCoinsToCustomer(customerId, tripId, distance, session = null) {
  try {
    const settings = await RewardSettings.findOne();
    if (!settings) return { success: true, awarded: false, reason: 'no_settings' };

    if (!distance || distance <= 0) {
      const q    = Trip.findById(tripId);
      const trip = session ? await q.session(session).lean() : await q.lean();
      if (trip?.pickup?.coordinates && trip?.drop?.coordinates) {
        distance = calculateDistanceFromCoords(
          trip.pickup.coordinates[1], trip.pickup.coordinates[0],
          trip.drop.coordinates[1],   trip.drop.coordinates[0]
        );
      } else {
        return { success: true, awarded: false, reason: 'no_distance' };
      }
    }

    const tier        = settings.getTierByDistance(distance);
    const coinsToAward = tier.coinsPerRide;
    const CustomerModel = await getCustomerModel();
    const opts        = { new: true };
    if (session) opts.session = session;

    const customer = await CustomerModel.findByIdAndUpdate(
      customerId,
      { $inc: { coins: coinsToAward } },
      opts
    );
    if (!customer) return { success: false, error: 'Customer not found' };

    const rewardDoc = new Reward({
      customerId,
      tripId,
      coins:       coinsToAward,
      type:        'earned',
      description: `Ride completed (${distance.toFixed(1)}km)`,
      createdAt:   new Date(),
    });
    if (session) await rewardDoc.save({ session });
    else         await rewardDoc.save();

    return { success: true, awarded: true, coinsAwarded: coinsToAward };
  } catch (err) {
    console.error('❌ awardCoinsToCustomer:', err.message);
    return { success: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TRIP CREATION
// ════════════════════════════════════════════════════════════════════════════

const createShortTrip = async (req, res) => {
  let coinsDeducted = 0;
  let enabled       = false;
  let coinsRequiredForDiscount = 0;
  let discountAmount = 0;

  try {
    const { customerId, pickup, drop, vehicleType, fare, useCoins } = req.body;

    console.log(`📌 CREATE SHORT TRIP:`, { customerId, vehicleType, fare, useCoins });

    if (!fare || fare <= 0) {
      return res.status(400).json({ success: false, message: 'Valid fare required' });
    }
    if (!vehicleType || typeof vehicleType !== 'string' || vehicleType.trim() === '') {
      return res.status(400).json({ success: false, message: 'Vehicle type required' });
    }

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates   = normalizeCoordinates(drop.coordinates);
    const sanitizedVehicleType = vehicleType.trim().toLowerCase();

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    let finalFare     = fare;
    let discountApplied = 0;

    try {
      const appSettings = await AppSettings.getSettings();

      enabled                  = appSettings.coins?.enabled ?? false;
      coinsRequiredForDiscount = appSettings.coins?.coinsRequiredForMaxDiscount ?? 0;
      discountAmount           = appSettings.coins?.maxDiscountPerRide ?? 0;

      if (enabled && useCoins === true && coinsRequiredForDiscount > 0) {
        const CustomerModel  = await getCustomerModel();
        const customerRecord = await CustomerModel.findById(customer._id);

        if (customerRecord && (customerRecord.coins ?? 0) >= coinsRequiredForDiscount) {
          const discountedFare = fare - discountAmount;

          if (discountedFare < MINIMUM_FARE) {
            const actualDiscount = Math.max(0, fare - MINIMUM_FARE);
            finalFare       = MINIMUM_FARE;
            discountApplied = actualDiscount;
            coinsDeducted   = coinsRequiredForDiscount;
          } else {
            finalFare       = discountedFare;
            discountApplied = discountAmount;
            coinsDeducted   = coinsRequiredForDiscount;
          }
        }
      }
    } catch (e) {
      console.error(`❌ Coin discount error: ${e.message}`);
    }

    const nearbyDrivers = await User.find({
      isDriver:  true,
      vehicleType: sanitizedVehicleType,
      isOnline:  true,
      isBusy:    { $ne: true },
      $or: [
        { socketId: { $exists: true, $ne: null } },
        { fcmToken: { $exists: true, $ne: null } },
      ],
      $and: [
        { $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }] },
      ],
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: TRIP_LIMITS.SHORT || 2000,
        },
      },
    }).select('_id name phone socketId fcmToken vehicleType location rating').lean();

    let destinationDrivers = [];
    try {
      destinationDrivers = await User.find({
        isDriver:  true,
        vehicleType: sanitizedVehicleType,
        isOnline:  true,
        isBusy:    { $ne: true },
        $or: [
          { socketId: { $exists: true, $ne: null } },
          { fcmToken: { $exists: true, $ne: null } },
        ],
        $and: [
          { $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }] },
        ],
        'goToDestination.enabled': true,
        'goToDestination.location': {
          $near: {
            $geometry: { type: 'Point', coordinates: drop.coordinates },
            $maxDistance: 2000,
          },
        },
      }).select('_id socketId fcmToken name phone vehicleType').lean();
    } catch (destErr) {
      console.log(`⚠️ Destination driver query failed: ${destErr.message}`);
    }

    const destinationDriverIds = new Set(destinationDrivers.map(d => d._id?.toString()));
    const normalOnlyDrivers    = nearbyDrivers.filter(d => !destinationDriverIds.has(d._id?.toString()));

    const trip = await Trip.create({
      customerId:      customer._id,
      pickup,
      drop,
      vehicleType:     sanitizedVehicleType,
      type:            'short',
      status:          'requested',
      fare:            finalFare,
      originalFare:    fare,
      discountApplied: discountApplied || 0,
      coinsUsed:       coinsDeducted   || 0,
    });

    await startProgressiveBroadcast(trip);

    return res.status(200).json({
      success:    true,
      tripId:     trip._id,
      drivers:    normalOnlyDrivers.length + destinationDrivers.length,
      normalDrivers:      normalOnlyDrivers.length,
      destinationDrivers: destinationDrivers.length,
      fareDetails: {
        originalFare: fare,
        discountApplied,
        finalFare,
        coinsUsed: coinsDeducted,
      },
    });
  } catch (err) {
    console.error('🔥 createShortTrip:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

const createParcelTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, parcelDetails, fare } = req.body;
    if (!fare || fare <= 0) {
      return res.status(400).json({ success: false, message: 'Valid fare required' });
    }

    const sanitizedVehicleType = (vehicleType || 'bike').toString().trim().toLowerCase();
    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates   = normalizeCoordinates(drop.coordinates);

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const nearbyDrivers = await User.find({
      isDriver:  true,
      vehicleType: sanitizedVehicleType,
      isOnline:  true,
      isBusy:    { $ne: true },
      socketId:  { $exists: true, $ne: null },
      $or:       [{ currentTripId: null }, { currentTripId: { $exists: false } }],
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: TRIP_LIMITS.PARCEL || 10000,
        },
      },
    }).select('_id name phone socketId vehicleType location rating').lean();

    let destinationDrivers = [];
    try {
      destinationDrivers = await User.find({
        isDriver:  true,
        vehicleType: sanitizedVehicleType,
        isOnline:  true,
        isBusy:    { $ne: true },
        socketId:  { $exists: true, $ne: null },
        $or:       [{ currentTripId: null }, { currentTripId: { $exists: false } }],
        'goToDestination.enabled': true,
        'goToDestination.location': {
          $near: {
            $geometry: { type: 'Point', coordinates: drop.coordinates },
            $maxDistance: 2000,
          },
        },
      }).select('_id socketId name phone vehicleType').lean();
    } catch (destErr) {
      console.log(`⚠️ Destination driver query failed: ${destErr.message}`);
    }

    const nearbyIds = new Set(nearbyDrivers.map(d => d._id?.toString()));
    const uniqueDest = destinationDrivers.filter(d => !nearbyIds.has(d._id?.toString()));

    const trip = await Trip.create({
      customerId:  customer._id,
      pickup,
      drop,
      vehicleType: sanitizedVehicleType,
      type:        'parcel',
      parcelDetails,
      status:      'requested',
      fare,
      originalFare: fare,
    });

    await startProgressiveBroadcast(trip);

    return res.status(200).json({
      success: true, tripId: trip._id,
      drivers: nearbyDrivers.length + uniqueDest.length,
      normalDrivers: nearbyDrivers.length, destinationDrivers: uniqueDest.length,
    });
  } catch (err) {
    console.error('🔥 createParcelTrip:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

const createLongTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, isSameDay, tripDays, returnTrip, fare } = req.body;
    if (!fare || fare <= 0) {
      return res.status(400).json({ success: false, message: 'Valid fare required' });
    }

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates   = normalizeCoordinates(drop.coordinates);
    const sanitizedVehicleType = (vehicleType || 'bike').toString().trim().toLowerCase();

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const radius      = isSameDay ? TRIP_LIMITS.LONG_SAME_DAY : TRIP_LIMITS.LONG_ADVANCE;
    const driverQuery = {
      isDriver:  true,
      vehicleType: sanitizedVehicleType,
      isBusy:    { $ne: true },
      socketId:  { $exists: true, $ne: null },
      $or:       [{ currentTripId: null }, { currentTripId: { $exists: false } }],
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: radius,
        },
      },
    };
    if (isSameDay) driverQuery.isOnline = true;

    const nearbyDrivers = await User.find(driverQuery)
      .select('_id name phone socketId vehicleType location rating').lean();

    let destinationDrivers = [];
    try {
      const destQuery = {
        isDriver:  true,
        vehicleType: sanitizedVehicleType,
        isBusy:    { $ne: true },
        socketId:  { $exists: true, $ne: null },
        $or:       [{ currentTripId: null }, { currentTripId: { $exists: false } }],
        'goToDestination.enabled': true,
        'goToDestination.location': {
          $near: {
            $geometry: { type: 'Point', coordinates: drop.coordinates },
            $maxDistance: 5000,
          },
        },
      };
      if (isSameDay) destQuery.isOnline = true;
      destinationDrivers = await User.find(destQuery)
        .select('_id socketId name phone vehicleType').lean();
    } catch (destErr) {
      console.log(`⚠️ Destination driver query failed: ${destErr.message}`);
    }

    const nearbyIds  = new Set(nearbyDrivers.map(d => d._id?.toString()));
    const uniqueDest = destinationDrivers.filter(d => !nearbyIds.has(d._id?.toString()));

    const trip = await Trip.create({
      customerId: customer._id,
      pickup, drop,
      vehicleType: sanitizedVehicleType,
      type:        'long',
      status:      'requested',
      isSameDay, returnTrip, tripDays,
      fare,
      originalFare: fare,
    });

    await startProgressiveBroadcast(trip);

    return res.status(200).json({
      success: true, tripId: trip._id,
      drivers: nearbyDrivers.length + uniqueDest.length,
      normalDrivers: nearbyDrivers.length, destinationDrivers: uniqueDest.length,
    });
  } catch (err) {
    console.error('🔥 createLongTrip:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// CANCELLATION
// ════════════════════════════════════════════════════════════════════════════

const cancelTripByCustomer = async (req, res) => {
  try {
    const { tripId, customerId, reason } = req.body;
    if (!tripId || !customerId) {
      return res.status(400).json({ success: false, message: 'tripId and customerId required' });
    }

    const trip = await Trip.findOneAndUpdate(
      {
        _id:        tripId,
        customerId: customerId,
        status:     'requested',
        $or:        [{ assignedDriver: { $exists: false } }, { assignedDriver: null }],
      },
      {
        $set: {
          status:             'cancelled',
          cancelledAt:        new Date(),
          cancelledBy:        customerId,
          cancellationReason: reason || 'customer_cancelled_search',
        },
        $inc: { version: 1 },
      },
      { new: true }
    ).lean();

    if (!trip) {
      const existing = await Trip.findById(tripId).lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Trip not found' });
      if (existing.status === 'driver_assigned') {
        return res.status(400).json({
          success: false,
          message: 'Driver already accepted. Use cancel ride API.',
          status:  existing.status,
          driverId: existing.assignedDriver,
        });
      }
      if (existing.status === 'cancelled') {
        return res.status(200).json({ success: true, message: 'Already cancelled', alreadyCancelled: true });
      }
      return res.status(400).json({ success: false, message: 'Cannot cancel at this stage', status: existing.status });
    }

    stopProgressiveBroadcast(tripId);

    if (io) {
      const onlineDrivers = await User.find({
        isDriver: true, isOnline: true, socketId: { $exists: true, $ne: null },
      }).select('socketId').lean();
      onlineDrivers.forEach(d => {
        io.to(d.socketId).emit('trip:cancelled', { tripId, reason: 'customer_cancelled_search' });
      });
    }

    return res.status(200).json({ success: true, message: 'Search cancelled', tripId, coinsRefunded: 0 });
  } catch (err) {
    console.error('🔥 cancelTripByCustomer:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

const cancelTrip = async (req, res) => {
  try {
    const { tripId, cancelledBy, reason } = req.body;
    if (!tripId || !cancelledBy) {
      return res.status(400).json({ success: false, message: 'tripId and cancelledBy required' });
    }

    const trip = await Trip.findById(tripId)
      .populate('customerId',    'phone name socketId')
      .populate('assignedDriver','name phone socketId');

    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.status === 'cancelled') return res.status(400).json({ success: false, message: 'Already cancelled' });
    if (trip.status === 'completed') return res.status(400).json({ success: false, message: 'Cannot cancel completed trip' });

    const isCustomer = trip.customerId?._id?.toString() === cancelledBy;
    const isDriver   = trip.assignedDriver?._id?.toString() === cancelledBy;
    if (!isCustomer && !isDriver) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    let coinsRefunded = 0;

    if (trip.coinsUsed && trip.coinsUsed > 0 && trip.status !== 'requested') {
      try {
        const CustomerModel  = await getCustomerModel();
        const updatedCustomer = await CustomerModel.findByIdAndUpdate(
          trip.customerId._id,
          { $inc: { coins: trip.coinsUsed, totalCoinsRedeemed: -trip.coinsUsed } },
          { new: true }
        );

        await CoinTransaction.create({
          userId:      trip.customerId._id,
          tripId:      trip._id,
          coinsEarned: trip.coinsUsed,
          type:        'earn',
          description: `Refund: ${trip.coinsUsed} coins returned (trip cancelled)`,
          balanceAfter: updatedCustomer?.coins ?? 0,
          breakdown: { baseCoins: 0, distanceBonus: 0, vehicleBonus: 0, randomBonus: 0 },
        });

        coinsRefunded = trip.coinsUsed;
        console.log(`💰 Refunded ${coinsRefunded} coins to customer`);
      } catch (e) {
        console.error('Coin refund failed:', e.message);
      }
    }

    assertTransition(trip.status, 'cancelled');
    trip.status             = 'cancelled';
    trip.version            += 1;
    trip.cancelledBy        = cancelledBy;
    trip.cancelledAt        = new Date();
    trip.cancellationReason = reason;
    await trip.save();

    await saveToRideHistory(trip, 'Cancelled');

    if (trip.assignedDriver) {
      await User.findByIdAndUpdate(
        trip.assignedDriver._id,
        { $set: { currentTripId: null, isBusy: false } }
      );
    }

    if (trip.assignedDriver?.socketId && io) {
      io.to(trip.assignedDriver.socketId).emit('trip:cancelled', {
        tripId, cancelledBy: isCustomer ? 'customer' : 'driver',
      });
    }
    if (trip.customerId?.socketId && io) {
      io.to(trip.customerId.socketId).emit('trip:cancelled', { tripId, coinsRefunded });
    }

    return res.status(200).json({ success: true, message: 'Trip cancelled', coinsRefunded });
  } catch (err) {
    console.error('🔥 cancelTrip:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// TRIP ACCEPTANCE
// ════════════════════════════════════════════════════════════════════════════

const acceptTrip = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { driverId, tripId } = req.body;
    if (!driverId || !tripId) {
      return res.status(400).json({ success: false, message: 'driverId and tripId required' });
    }

    const rideCode    = generateOTP();
    let   tripData    = null;
    let   driverData  = null;
    let   customerData = null;

    await session.withTransaction(async () => {
      const trip = await Trip.findOne({
        _id:         tripId,
        status:      'requested',
        cancelledAt: { $exists: false },
      }).session(session);
      if (!trip) throw new Error('Trip not available');

      const driver = await User.findOne({
        _id:    driverId,
        isBusy: { $ne: true },
        $or:    [{ currentTripId: null }, { currentTripId: { $exists: false } }],
      })
        .select('name phone photoUrl rating vehicleBrand vehicleNumber location isBusy currentTripId')
        .session(session);
      if (!driver) throw new Error('Driver busy');

      assertTransition(trip.status, 'driver_assigned');

      driver.isBusy          = true;
      driver.currentTripId   = tripId;
      driver.lastTripAcceptedAt = new Date();

      if (driver.goToDestination?.enabled) {
        driver.goToDestination.enabled   = false;
        driver.goToDestination.disabledAt = new Date();
      }

      trip.assignedDriver = driverId;
      trip.status         = 'driver_assigned';

      if (trip.coinsUsed && trip.coinsUsed > 0) {
        try {
          const CustomerModel = await getCustomerModel();
          const customer      = await CustomerModel.findById(trip.customerId).session(session);

          if (!customer) throw new Error('Customer not found for coin deduction');

          if ((customer.coins ?? 0) < trip.coinsUsed) {
            trip.fare           = trip.originalFare || trip.fare;
            trip.discountApplied = 0;
            trip.coinsUsed       = 0;
          } else {
            const oldBalance = customer.coins;
            customer.coins          -= trip.coinsUsed;
            customer.totalCoinsRedeemed =
              (customer.totalCoinsRedeemed ?? 0) + trip.coinsUsed;
            await customer.save({ session });

            let txnResult;
            try {
              txnResult = await CoinTransaction.create([{
                userId:      trip.customerId,
                tripId:      trip._id,
                coinsEarned: -trip.coinsUsed,
                type:        'spend',
                description: `Redeemed ${trip.coinsUsed} coins for ₹${trip.discountApplied || 0} ride discount`,
                balanceAfter: customer.coins,
                breakdown: { baseCoins: 0, distanceBonus: 0, vehicleBonus: 0, randomBonus: 0 },
              }], { session });
            } catch (sessionErr) {
              txnResult = await CoinTransaction.create({
                userId:      trip.customerId,
                tripId:      trip._id,
                coinsEarned: -trip.coinsUsed,
                type:        'spend',
                description: `Redeemed ${trip.coinsUsed} coins for ₹${trip.discountApplied || 0} ride discount`,
                balanceAfter: customer.coins,
                breakdown: { baseCoins: 0, distanceBonus: 0, vehicleBonus: 0, randomBonus: 0 },
              });
            }
          }
        } catch (coinErr) {
          console.error(`❌ COIN DEDUCTION FAILED (non-fatal): ${coinErr.message}`);
        }
      }

      stopProgressiveBroadcast(tripId);

      trip.otp        = rideCode;
      trip.acceptedAt = new Date();
      trip.version    += 1;

      await driver.save({ session });
      await trip.save({ session });

      tripData = trip.toObject();
      driverData = {
        _id:          driver._id.toString(),
        id:           driver._id.toString(),
        name:         driver.name,
        phone:        driver.phone,
        photoUrl:     driver.photoUrl || null,
        rating:       driver.rating   || 4.8,
        vehicleBrand: driver.vehicleBrand  || 'Vehicle',
        vehicleNumber: driver.vehicleNumber || 'N/A',
        location: driver.location ? {
          lat: driver.location.coordinates[1],
          lng: driver.location.coordinates[0],
        } : null,
      };
    });

    const customer = await User.findById(tripData.customerId)
      .select('socketId name phone photoUrl rating').lean();

    if (customer) {
      customerData = {
        id:       customer._id.toString(),
        name:     customer.name     || 'Customer',
        phone:    customer.phone    || null,
        photoUrl: customer.photoUrl || null,
        rating:   customer.rating   || 5.0,
      };
    }

    if (customer?.socketId && io) {
      io.to(customer.socketId).emit('trip:accepted', {
        tripId:   tripData._id.toString(),
        rideCode,
        trip: {
          _id:        tripData._id.toString(),
          tripId:     tripData._id.toString(),
          customerId: tripData.customerId.toString(),
          driverId:   tripData.assignedDriver.toString(),
          fare:       tripData.fare   || 0,
          finalFare:  tripData.finalFare || tripData.fare || 0,
          pickup: {
            lat:     tripData.pickup.coordinates[1],
            lng:     tripData.pickup.coordinates[0],
            address: tripData.pickup.address || 'Pickup Location',
          },
          drop: {
            lat:     tripData.drop.coordinates[1],
            lng:     tripData.drop.coordinates[0],
            address: tripData.drop.address || 'Drop Location',
          },
        },
        driver: driverData,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        tripId:   tripData._id,
        otp:      rideCode,
        trip: {
          _id:        tripData._id.toString(),
          tripId:     tripData._id.toString(),
          customerId: tripData.customerId.toString(),
          driverId:   tripData.assignedDriver.toString(),
          fare:       tripData.fare   || 0,
          finalFare:  tripData.finalFare || tripData.fare || 0,
          type:       tripData.type,
          pickup: {
            lat:     tripData.pickup.coordinates[1],
            lng:     tripData.pickup.coordinates[0],
            address: tripData.pickup.address || 'Pickup Location',
          },
          drop: {
            lat:     tripData.drop.coordinates[1],
            lng:     tripData.drop.coordinates[0],
            address: tripData.drop.address || 'Drop Location',
          },
        },
        customer: customerData,
        status:   tripData.status,
        rideCode,
      },
    });
  } catch (err) {
    console.error('🔥 acceptTrip:', err);
    return res.status(400).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
};

const rejectTrip = async (req, res) => {
  try {
    const { tripId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip || trip.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Trip not valid' });
    }
    return res.status(200).json({ success: true, message: 'Rejection recorded' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const driverGoingToPickup = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== driverId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    assertTransition(trip.status, 'driver_going_to_pickup');
    trip.status   = 'driver_going_to_pickup';
    trip.version  += 1;
    await trip.save();

    const customer = await User.findById(trip.customerId).select('socketId').lean();
    if (customer?.socketId && io) {
      io.to(customer.socketId).emit('trip:driver_enroute', { tripId: trip._id.toString() });
    }
    return res.status(200).json({ success: true, message: 'Driver on the way' });
  } catch (err) {
    console.error('🔥 driverGoingToPickup:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

const driverArrivedAtPickup = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== driverId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    assertTransition(trip.status, 'driver_at_pickup');
    trip.status  = 'driver_at_pickup';
    trip.version += 1;
    await trip.save();

    const customer = await User.findById(trip.customerId).select('socketId').lean();
    if (customer?.socketId && io) {
      io.to(customer.socketId).emit('trip:driver_arrived', { tripId: trip._id.toString() });
    }
    return res.status(200).json({ success: true, message: 'Driver arrived' });
  } catch (err) {
    console.error('🔥 driverArrivedAtPickup:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

const goingToPickup = driverArrivedAtPickup;

const startRide = async (req, res) => {
  try {
    const { tripId, driverId, otp, driverLat, driverLng } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== driverId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (trip.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });

    const dist = calculateDistanceFromCoords(
      driverLat, driverLng,
      trip.pickup.coordinates[1], trip.pickup.coordinates[0]
    );
    if (dist > 0.1) {
      return res.status(400).json({ success: false, message: `Too far: ${(dist * 1000).toFixed(0)}m` });
    }

    assertTransition(trip.status, 'ride_started');
    trip.status        = 'ride_started';
    trip.version       += 1;
    trip.rideStartTime = new Date();
    await trip.save();

    const customer = await User.findById(trip.customerId).select('socketId').lean();
    if (customer?.socketId && io) {
      io.to(customer.socketId).emit('trip:ride_started', {
        tripId: trip._id.toString(), startTime: trip.rideStartTime,
      });
    }
    return res.status(200).json({ success: true, message: 'Ride started', startTime: trip.rideStartTime });
  } catch (err) {
    console.error('🔥 startRide:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// RIDE COMPLETION & PAYMENT
// ════════════════════════════════════════════════════════════════════════════

const completeRideWithVerification = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { tripId, driverId, driverLat, driverLng } = req.body;

    console.log('🔒 ATOMIC RIDE COMPLETION', { tripId, driverId });

    let tripData    = null;
    let walletResult = null;

    await session.withTransaction(async () => {
      const trip = await Trip.findOne({
        _id:                tripId,
        status:             'ride_started',
        'payment.collected': { $ne: true },
      }).session(session);

      if (!trip) {
        const existing = await Trip.findById(tripId).session(session).lean();
        if (existing?.status === 'completed' && existing?.payment?.collected) {
          throw new Error('Trip already completed and paid');
        }
        throw new Error('Trip not found or not in ride_started status');
      }

      if (trip.assignedDriver?.toString() !== driverId) {
        throw new Error('Not authorized');
      }

      const distToDropKm = calculateDistanceFromCoords(
        driverLat, driverLng,
        trip.drop.coordinates[1], trip.drop.coordinates[0]
      );

      if (distToDropKm > 0.5) {
        throw new Error(`Too far from drop: ${(distToDropKm * 1000).toFixed(0)}m`);
      }

      let fareAmount = 0;
      if (trip.fare > 0) {
        fareAmount = trip.fare;
      } else if (trip.originalFare > 0) {
        fareAmount = Math.max(
          MINIMUM_FARE,
          trip.originalFare - (trip.discountApplied || 0)
        );
      }

      if (fareAmount <= 0) {
        throw new Error('Cannot complete ride — fare resolved to ₹0');
      }

      assertTransition(trip.status, 'awaiting_payment');
      trip.status      = 'awaiting_payment';
      trip.finalFare   = fareAmount;
      trip.fare        = fareAmount;
      trip.rideEndTime = new Date();
      trip.version     += 1;

      await trip.save({ session });

      walletResult = {
        success: true,
        fareBreakdown: {
          tripFare: fareAmount, commission: 0,
          commissionPercentage: 0, driverEarning: fareAmount,
          planBonus: 0, planApplied: false, planName: null,
        },
      };

      await User.findByIdAndUpdate(driverId, {
        $set: {
          currentTripId:         tripId,
          isBusy:                true,
          canReceiveNewRequests: false,
          awaitingCashCollection: true,
          lastTripCompletedAt:   new Date(),
        },
      }, { session });

      tripData = trip.toObject();
    });

    session.endSession();

    return res.status(200).json({
      success:                true,
      message:                'Ride completed. Please collect cash.',
      fare:                   tripData.finalFare,
      paymentCollected:       false,
      awaitingCashCollection: true,
      fareBreakdown:          walletResult.fareBreakdown,
    });
  } catch (err) {
    try { session.endSession(); } catch (_) {}
    console.error('🔥 completeRideWithVerification:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// CONFIRM CASH COLLECTION — with incentive written to Wallet
// ════════════════════════════════════════════════════════════════════════════

const confirmCashCollection = async (req, res) => {
  const { tripId, driverId, fare } = req.body;

  console.log('💰 CONFIRM CASH COLLECTION', { tripId, driverId, fare });

  if (!tripId || !driverId) {
    return res.status(400).json({
      success: false,
      message: 'tripId and driverId are required',
    });
  }

  const MAX_RETRIES  = 3;
  const RETRY_DELAY  = 200;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();

    try {
      let result = null;

      await session.withTransaction(async () => {
        const trip = await Trip.findById(tripId).session(session);

        if (!trip) {
          throw Object.assign(new Error('Trip not found'), { statusCode: 404 });
        }

        if (trip.assignedDriver?.toString() !== driverId) {
          throw Object.assign(new Error('Not authorized'), { statusCode: 403 });
        }

        if (
          trip.status !== 'awaiting_payment' &&
          trip.status !== 'completed'
        ) {
          throw Object.assign(
            new Error(`Trip status is '${trip.status}' — must be awaiting_payment`),
            { statusCode: 400 }
          );
        }

        if (trip.paymentCollected === true) {
          result = { alreadyProcessed: true, success: true, message: 'Cash already collected' };
          return;
        }

        const requestFare = Number(fare) || 0;
        let   fareAmount  = 0;

        if (requestFare > 0) {
          fareAmount = requestFare;
        } else if ((trip.finalFare ?? 0) > 0) {
          fareAmount = trip.finalFare;
        } else if ((trip.fare ?? 0) > 0) {
          fareAmount = trip.fare;
        } else if ((trip.originalFare ?? 0) > 0) {
          fareAmount = Math.max(
            MINIMUM_FARE,
            trip.originalFare - (trip.discountApplied || 0)
          );
        }

        if (fareAmount <= 0) {
          throw Object.assign(new Error('Cannot process ₹0 fare'), { statusCode: 400 });
        }

        // ── Resolve commission + incentive from plan or CommissionSetting ──
        const resolved = await resolveDriverEarnings(driverId, fareAmount);
        const {
          commissionRate,
          effectivePlatformFeeRate,
          commissionPart,
          platformFeeFlatApplied,
          platformFeePercent,
          platformFeePercentAmount,
          commission,
          driverEarning,
          perRideIncentive,
          planBonusMultiplier,
          planApplied,
          appliedPlanId: resolvedPlanId,
          appliedPlanName,
        } = resolved;
        const finalCommissionRate = effectivePlatformFeeRate ?? commissionRate;

        console.log(`   Commission: ₹${commission} (${finalCommissionRate}%) | Driver: ₹${driverEarning} | Incentive: ₹${perRideIncentive}`);

        // Total credited to driver = ride earning + per-ride incentive (merged, single transaction)
        const totalCredit = Math.round((driverEarning + perRideIncentive) * 100) / 100;

        const updatedWallet = await Wallet.findOneAndUpdate(
          { driverId },
          {
            $inc: {
              totalEarnings:    totalCredit,
              totalCommission:  commission,
              availableBalance: totalCredit,
              pendingAmount:    commission,
            },
            $push: {
              transactions: [
                // 1️⃣ Trip earnings transaction
                {
                  tripId,
                  type:               'credit',
                  amount:             totalCredit,
                  originalFare:       fareAmount,
                  commissionDeducted: commission,
                  planBonus:          0,
                  finalEarning:       totalCredit,
                  description: planApplied
                    ? `Ride ₹${fareAmount} (Plan: ${appliedPlanName})${perRideIncentive > 0 ? ` + ₹${perRideIncentive} incentive` : ''}`
                    : `Ride ₹${fareAmount}${perRideIncentive > 0 ? ` + ₹${perRideIncentive} incentive` : ''}`,
                  planApplied,
                  driverPlanId:       resolvedPlanId || null,
                  planName:           appliedPlanName || null,
                  planCommissionRate: finalCommissionRate,
                  paymentMethod:      'cash',
                  status:             'completed',
                  createdAt:          new Date(),
                },
                // 2️⃣ Commission pending transaction (shows in history)
                commission > 0 && {
                  tripId,
                  type:        'commission',
                  amount:      commission,
                  description: `Commission pending for ride ₹${fareAmount}`,
                  status:      'pending',
                  createdAt:   new Date(),
                }
              ].filter(Boolean),
            },
            $set: { lastUpdated: new Date() },
          },
          {
            upsert: true,
            session,
            new: true,
            sort: { updatedAt: -1, lastUpdated: -1, createdAt: -1 },
          }
        );

        const updatedTrip = await Trip.findOneAndUpdate(
          { _id: tripId, paymentCollected: { $ne: true } },
          {
            $set: {
              status:             'completed',
              paymentCollected:   true,
              paymentStatus:      'completed',
              paymentMethod:      'cash',
              paidAmount:         fareAmount,
              finalFare:          fareAmount,
              fare:               fareAmount,
              completedAt:        new Date(),
              paymentCompletedAt: new Date(),
            },
          },
          { session, new: true }
        );

        if (!updatedTrip) {
          result = { alreadyProcessed: true, success: true, message: 'Cash already collected' };
          return;
        }

        await User.findByIdAndUpdate(
          driverId,
          {
            $set: {
              isBusy:                false,
              currentTripId:         null,
              canReceiveNewRequests: true,
              awaitingCashCollection: false,
              lastCashCollectedAt:   new Date(),
            },
          },
          { session }
        );

        result = {
          success:           true,
          fareAmount,
          commissionRate,
          commissionPart,
          platformFeeFlatApplied,
          platformFeePercent,
          platformFeePercentAmount,
          commission,
          driverEarning,
          totalCredit,
          perRideIncentive,
          planBonusMultiplier,
          planApplied,
          appliedPlanName,
          finalCommissionRate,
          customerId:        trip.customerId,
          vehicleType:       trip.vehicleType,
          pickup:            trip.pickup,
          drop:              trip.drop,
          pendingAmount:     Number(updatedWallet?.pendingAmount || 0),
          availableBalance:  Number(updatedWallet?.availableBalance || 0),
        };
      });

      session.endSession();

      if (result?.alreadyProcessed) {
        return res.json({ success: true, message: 'Cash already collected', alreadyProcessed: true });
      }

      const {
        fareAmount,
        commissionRate,
        commissionPart,
        platformFeeFlatApplied,
        platformFeePercent,
        platformFeePercentAmount,
        commission,
        driverEarning,
        totalCredit,
        perRideIncentive,
        planBonusMultiplier,
        planApplied,
        appliedPlanName,
        finalCommissionRate,
        customerId,
        vehicleType,
        pickup,
        drop,
        pendingAmount,
        availableBalance,
      } = result;

      // ── Update driver User doc incentive counters (non-critical) ─────────
      try {
        const driver = await User.findById(driverId).select('totalIncentiveEarned totalRidesCompleted wallet lastRideId').lean();
        if (driver && driver.lastRideId?.toString() !== tripId?.toString()) {
          await User.findByIdAndUpdate(driverId, {
            $set: {
              totalIncentiveEarned:   (driver.totalIncentiveEarned || 0) + perRideIncentive,
              totalRidesCompleted:    (driver.totalRidesCompleted  || 0) + 1,
              wallet:                 (driver.wallet               || 0) + perRideIncentive,
              lastRideId:             tripId,
              lastIncentiveAwardedAt: new Date(),
            },
          });
          console.log(`✅ Incentive ₹${perRideIncentive} applied to User doc for driver ${driverId}`);
        }
      } catch (incErr) {
        console.warn('⚠️ Incentive User doc update failed (non-critical):', incErr.message);
      }

      // ── Save ride history (non-critical) ─────────────────────────────────
      try {
        const trip = await Trip.findById(tripId).lean();
        if (trip) await saveToRideHistory(trip, 'Completed');
      } catch (histErr) {
        console.warn('⚠️ saveToRideHistory failed:', histErr.message);
      }

      // ── Award coins + handle referral (non-critical) ─────────────────────
      let coinReward = null;
      try {
        if (customerId) {
          const rideDist = calculateDistanceFromCoords(
            pickup.coordinates[1], pickup.coordinates[0],
            drop.coordinates[1],   drop.coordinates[0]
          );

          coinReward = await awardRideCoins({
            userId:      customerId,
            tripId,
            distanceKm:  rideDist,
            vehicleType: vehicleType,
          });

          const [customerCompletedCount, driverCompletedCount] = await Promise.all([
            Trip.countDocuments({
              customerId,
              status:           'completed',
              paymentCollected: true,
            }),
            Trip.countDocuments({
              assignedDriver:   driverId,
              status:           'completed',
              paymentCollected: true,
            }),
          ]);

          if (customerCompletedCount === 1) {
            handleFirstRideReferral(customerId, tripId)
              .then((r) => {
                if (r.hadReferral) {
                  console.log(`✅ Referral: referrerId=${r.referrerId}, milestone=${r.milestoneReached}`);
                }
              })
              .catch((e) => console.warn('⚠️ handleFirstRideReferral:', e.message));

            User.findByIdAndUpdate(customerId, {
              $set: { welcomeCouponUsed: true },
            }).catch(() => {});
          }

          if (driverCompletedCount === 1) {
            handleFirstRideReferral(driverId, tripId, 'driver')
              .then((r) => {
                if (r.hadReferral) {
                  console.log(`✅ Driver referral: referrerId=${r.referrerId}, milestone=${r.milestoneReached}`);
                }
              })
              .catch((e) => console.warn('⚠️ handleFirstRideReferral(driver):', e.message));
          }
        }
      } catch (coinErr) {
        console.warn('⚠️ Coin/referral failed (non-critical):', coinErr.message);
      }

      // ── Emit socket events ────────────────────────────────────────────────
      if (req.io) {
        const cid = customerId.toString();

        req.io.to(`customer_${cid}`).emit('trip:cash_collected', {
          tripId:           tripId.toString(),
          customerId:       cid,
          driverId:         driverId.toString(),
          amount:           fareAmount,
          message:          'Driver confirmed cash payment',
          timestamp:        new Date().toISOString(),
          paymentCollected: true,
          success:          true,
        });

        req.io.to(`driver_${driverId}`).emit('payment:confirmed', {
          tripId:    tripId.toString(),
          amount:    fareAmount,
          customerId: cid,
          pendingAmount,
          walletBalance: availableBalance,
          message:   'Payment collected successfully',
          timestamp: new Date().toISOString(),
        });
      }

      console.log(
        `✅ CASH COLLECTION SUCCESS | Fare: ₹${fareAmount} | Driver: ₹${driverEarning} | Incentive: ₹${perRideIncentive} | Total credited: ₹${totalCredit} | Pending: ₹${pendingAmount} | Wallet: ₹${availableBalance}`,
      );

      return res.status(200).json({
        success: true,
        message: 'Cash collected successfully',
        amount:  fareAmount,
        wallet: {
          pendingAmount,
          availableBalance,
        },
        fareBreakdown: {
          tripFare:             fareAmount,
          commission,
          commissionPercentage: finalCommissionRate,
          baseCommissionRate:   commissionRate,
          commissionPart,
          platformFeeFlat:      platformFeeFlatApplied,
          platformFeePercent,
          platformFeePercentAmount,
          driverEarning,
          incentiveAwarded:     perRideIncentive,
          totalEarnings:        totalCredit,   // hero amount shown in Flutter earnings sheet
          planApplied,
          planName:             appliedPlanName || null,
          planBonusMultiplier,
        },
        socketEmitted: !!req.io,
      });

    } catch (err) {
      try { session.endSession(); } catch (_) {}

      const isTransient =
        err.errorLabels?.has?.('TransientTransactionError') ||
        err.errorLabels?.includes?.('TransientTransactionError') ||
        err.code === 112 ||
        err.code === 251 ||
        err.codeName === 'WriteConflict' ||
        err.message?.includes('WriteConflict') ||
        err.message?.includes('TransientTransactionError');

      const statusCode = err.statusCode;
      if (statusCode === 400 || statusCode === 403 || statusCode === 404) {
        if (!res.headersSent) {
          return res.status(statusCode).json({ success: false, message: err.message });
        }
        return;
      }

      if (isTransient && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY * attempt;
        console.warn(`⚠️ WriteConflict on attempt ${attempt}/${MAX_RETRIES}. Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      console.error(`🔥 confirmCashCollection failed after ${attempt} attempt(s):`, err.message);

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: 'Failed to confirm cash collection',
          error:   err.message,
        });
      }
    }
  }
};

const completeTrip = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { tripId, userId } = req.body;

    await session.withTransaction(async () => {
      const trip = await Trip.findById(tripId).session(session);
      if (!trip) throw new Error('Trip not found');

      if (
        trip.assignedDriver?.toString() !== userId &&
        trip.customerId?.toString() !== userId
      ) {
        throw new Error('Not authorized');
      }

      assertTransition(trip.status, 'completed');
      trip.status      = 'completed';
      trip.completedAt = new Date();
      trip.version     += 1;
      await trip.save({ session });

      await User.findByIdAndUpdate(
        trip.assignedDriver,
        { $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: true } },
        { session }
      );

      await saveToRideHistory(trip, 'Completed', session);
    });

    session.endSession();
    return res.status(200).json({ success: true, message: 'Trip completed' });
  } catch (err) {
    try { session.endSession(); } catch (_) {}
    console.error('🔥 completeTrip:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// QUERY FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

const getTripById = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).populate('assignedDriver customerId');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    return res.status(200).json({ success: true, trip });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const getTripByIdWithPayment = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.tripId)
      .populate('assignedDriver', 'name phone')
      .populate('customerId',    'name phone')
      .lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    return res.status(200).json({ success: true, trip });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const getDriverActiveTrip = async (req, res) => {
  try {
    const { driverId } = req.params;

    const trip = await Trip.findOne({
      assignedDriver: driverId,
      status: {
        $in: [
          'driver_assigned', 'driver_going_to_pickup',
          'driver_at_pickup', 'ride_started', 'awaiting_payment',
        ],
      },
    }).populate('customerId', 'name phone photoUrl rating').lean();

    if (!trip) {
      await User.findByIdAndUpdate(driverId, { $set: { isBusy: false, currentTripId: null } });
      return res.status(200).json({ success: true, hasActiveTrip: false, driverFreed: true });
    }

    const cashCollected =
      trip.paymentCollected === true || trip.payment?.collected === true;

    if (trip.status === 'awaiting_payment' && cashCollected) {
      await User.findByIdAndUpdate(driverId, { $set: { isBusy: false, currentTripId: null } });
      return res.status(200).json({
        success: true, hasActiveTrip: false, driverFreed: true,
        reason: 'payment_already_collected',
      });
    }

    const pickupCoords = trip.pickup?.location?.coordinates;
    const dropCoords   = trip.drop?.location?.coordinates;

    const pickup = {
      address: trip.pickup?.address  ?? trip.pickup?.name ?? 'Pickup Location',
      lat: pickupCoords ? pickupCoords[1] : (trip.pickup?.lat ?? 0),
      lng: pickupCoords ? pickupCoords[0] : (trip.pickup?.lng ?? 0),
    };

    const drop = {
      address: trip.drop?.address ?? trip.drop?.name ?? 'Drop Location',
      lat: dropCoords ? dropCoords[1] : (trip.drop?.lat ?? 0),
      lng: dropCoords ? dropCoords[0] : (trip.drop?.lng ?? 0),
    };

    const customer = trip.customerId
      ? {
          _id:      trip.customerId._id?.toString(),
          name:     trip.customerId.name     ?? 'Customer',
          phone:    trip.customerId.phone    ?? '',
          photoUrl: trip.customerId.photoUrl ?? '',
          rating:   trip.customerId.rating   ?? 5.0,
        }
      : null;

    if (trip.status === 'awaiting_payment' && !cashCollected) {
      return res.status(200).json({
        success: true, hasActiveTrip: true, isAwaitingPayment: true,
        trip: {
          tripId:                trip._id.toString(),
          status:                'awaiting_payment',
          ridePhase:             'completed',
          fare:                  trip.finalFare || trip.fare,
          finalFare:             trip.finalFare || trip.fare,
          rideCode:              trip.rideCode  ?? trip.otp ?? '',
          otp:                   trip.rideCode  ?? trip.otp ?? '',
          pickup,
          drop,
          paymentCollected:      false,
          awaitingCashCollection: true,
        },
        customer,
      });
    }

    let ridePhase = 'going_to_pickup';
    if      (trip.status === 'ride_started')      ridePhase = 'going_to_drop';
    else if (trip.status === 'driver_at_pickup')  ridePhase = 'at_pickup';

    return res.status(200).json({
      success: true, hasActiveTrip: true,
      trip: {
        tripId:           trip._id.toString(),
        status:           trip.status,
        ridePhase,
        fare:             trip.fare,
        finalFare:        trip.finalFare ?? trip.fare,
        rideCode:         trip.rideCode  ?? trip.otp ?? '',
        otp:              trip.rideCode  ?? trip.otp ?? '',
        pickup,
        drop,
        paymentCollected: cashCollected,
      },
      customer,
    });
  } catch (err) {
    console.error('🔥 getDriverActiveTrip:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

const getActiveRide = async (req, res) => {
  try {
    const { customerId } = req.params;
    const trip = await Trip.findOne({
      customerId,
      status: {
        $in: ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'],
      },
    })
      .populate('assignedDriver', 'name phone photoUrl rating vehicleBrand vehicleNumber location')
      .lean();

    if (!trip) return res.status(200).json({ success: true, hasActiveRide: false });

    return res.status(200).json({
      success:      true,
      hasActiveRide: true,
      trip:    { tripId: trip._id.toString(), status: trip.status, fare: trip.fare },
      driver:  trip.assignedDriver,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const getDriverLocationByTripId = async (req, res) => {
  try {
    const { tripId } = req.params;

    const trip = await Trip.findById(tripId)
      .select('assignedDriver customerId status').lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (!trip.assignedDriver) return res.status(200).json({ success: false, message: 'No driver assigned' });

    const driver = await User.findById(trip.assignedDriver)
      .select('location lastBearing locationSequence lastLocationUpdate').lean();

    if (!driver?.location?.coordinates) {
      return res.status(200).json({ success: false, message: 'Driver location unavailable' });
    }

    const [lng, lat] = driver.location.coordinates;

    return res.status(200).json({
      success:  true,
      location: { lat, lng, latitude: lat, longitude: lng },
      driverLocation: {
        lat, lng, latitude: lat, longitude: lng,
        bearing:    driver.lastBearing       ?? null,
        heading:    driver.lastBearing       ?? null,
        sequence:   driver.locationSequence  ?? null,
        lastUpdate: driver.lastLocationUpdate ?? null,
      },
      driverId: driver._id.toString(),
      tripId:   tripId.toString(),
    });
  } catch (err) {
    console.error('❌ getDriverLocationByTripId:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// SUPPORT
// ════════════════════════════════════════════════════════════════════════════

const requestTripSupport = async (req, res) => {
  try {
    const { tripId, reason } = req.body;
    if (!tripId) return res.status(400).json({ success: false, message: 'tripId required' });

    const trip = await Trip.findByIdAndUpdate(
      tripId,
      {
        supportRequested:    true,
        supportReason:       reason || 'Help requested',
        supportRequestedAt:  new Date(),
      },
      { new: true }
    )
      .populate('customerId',    'name phone')
      .populate('assignedDriver','name phone vehicleNumber');

    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });

    if (io) {
      io.to('admin-room').emit('admin:support_request', {
        tripId: trip._id.toString(), reason: trip.supportReason, trip,
      });
    }

    return res.json({ success: true, message: 'Support request sent' });
  } catch (err) {
    console.error('🔥 requestTripSupport:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════════════════

export {
  createShortTrip,
  createParcelTrip,
  createLongTrip,
  acceptTrip,
  rejectTrip,
  completeTrip,
  cancelTrip,
  getTripById,
  goingToPickup,
  driverGoingToPickup,
  driverArrivedAtPickup,
  startRide,
  cancelTripByCustomer,
  completeRideWithVerification,
  confirmCashCollection,
  getDriverActiveTrip,
  getTripByIdWithPayment,
  getActiveRide,
  awardCoinsToCustomer,
  getDriverLocationByTripId,
  requestTripSupport,
}