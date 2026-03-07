// src/controllers/tripController.js

import Trip from '../models/Trip.js';
import Wallet from '../models/Wallet.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { startTripRetry, stopTripRetry } from '../utils/tripRetryBroadcaster.js';
import { io } from '../socket/socketHandler.js';
import { broadcastToDrivers } from '../utils/tripBroadcaster.js';
import { TRIP_LIMITS } from '../config/tripConfig.js';
import { generateOTP } from '../utils/otpGeneration.js';
import RideHistory from '../models/RideHistory.js';
import RewardSettings from '../models/RewardSettings.js';
import Reward from '../models/Reward.js';

// ═══════════════════════════════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════════════════════════════

const ALLOWED_TRANSITIONS = {
  requested:              ['driver_assigned', 'cancelled', 'timeout'],
  driver_assigned:        ['driver_going_to_pickup', 'driver_at_pickup', 'cancelled'],
  driver_going_to_pickup: ['driver_at_pickup', 'cancelled'],
  driver_at_pickup:       ['ride_started', 'cancelled'],
  ride_started:           ['completed'],
  completed:              [],
  cancelled:              [],
  timeout:                [],
};

function assertTransition(current, next) {
  if (!ALLOWED_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`Illegal transition: ${current} → ${next}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

const getCustomerModel = async () => {
  try {
    return mongoose.models.Customer || mongoose.model('Customer');
  } catch (e) {
    return User;
  }
};

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

    const rideHistory = new RideHistory({
      phone:           populatedTrip.customerId.phone,
      customerId:      populatedTrip.customerId._id || populatedTrip.customerId,
      pickupLocation:  populatedTrip.pickup?.address || 'Pickup Location',
      dropLocation:    populatedTrip.drop?.address   || 'Drop Location',
      vehicleType:     populatedTrip.vehicleType || 'bike',
      fare:            populatedTrip.finalFare   || populatedTrip.fare || 0,
      status,
      driver: {
        name:          populatedTrip.assignedDriver?.name          || 'N/A',
        phone:         populatedTrip.assignedDriver?.phone         || 'N/A',
        vehicleNumber: populatedTrip.assignedDriver?.vehicleNumber || 'N/A',
      },
      dateTime: populatedTrip.createdAt || new Date(),
      tripId:   populatedTrip._id,
    });

    if (session) await rideHistory.save({ session });
    else         await rideHistory.save();

    console.log(`✅ Ride history saved: ${rideHistory._id}`);
  } catch (error) {
    console.error('❌ Error saving ride history:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PROCESS WALLET TRANSACTION  ★ FIXED: writes to Wallet model ★
// ═══════════════════════════════════════════════════════════════════

async function processWalletTransaction(driverId, tripId, fareAmount, session) {
  try {
    console.log(`💳 processWalletTransaction: Driver ${driverId}, Fare ₹${fareAmount}`);

    // Commission from DB — never hardcoded
    const db = mongoose.connection.db;
    const settings = await db.collection('commissionSettings').findOne({ type: 'global' });
    const commissionPct = settings?.percentage ?? 20;

    const commission    = Math.round((fareAmount * commissionPct) / 100 * 100) / 100;
    const driverEarning = Math.round((fareAmount - commission) * 100) / 100;

    // ✅ Write to Wallet model (not User model)
    let wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      wallet = new Wallet({
        driverId,
        availableBalance: 0,
        balance:          0,
        totalEarnings:    0,
        totalCommission:  0,
        pendingAmount:    0,
        transactions:     [],
        processedTripIds: [],
      });
    }

    wallet.transactions.push({
      tripId,
      type:          'credit',
      amount:        driverEarning,
      description:   `Trip completed — net earnings (fare ₹${fareAmount}, commission ${commissionPct}%)`,
      paymentMethod: 'cash',
      status:        'completed',
      createdAt:     new Date(),
    });

    wallet.availableBalance  = Math.round((wallet.availableBalance + driverEarning) * 100) / 100;
    wallet.balance           = wallet.availableBalance;
    wallet.totalEarnings     = Math.round((wallet.totalEarnings    + driverEarning) * 100) / 100;
    wallet.totalCommission   = Math.round((wallet.totalCommission  + commission)    * 100) / 100;

    await wallet.save({ session });

    console.log(`✅ Wallet updated: +₹${driverEarning} (commission ₹${commission})`);

    return {
      success: true,
      fareBreakdown: {
        tripFare:           fareAmount,
        commission,
        commissionPercentage: commissionPct,
        driverEarning,
      },
      wallet: {
        totalEarnings:   wallet.totalEarnings,
        totalCommission: wallet.totalCommission,
        availableBalance: wallet.availableBalance,
        pendingAmount:   wallet.pendingAmount,
      },
    };
  } catch (error) {
    console.error('❌ processWalletTransaction error:', error);
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// AWARD INCENTIVES TO DRIVER
// ═══════════════════════════════════════════════════════════════════

async function awardIncentivesToDriver(driverId, tripId, session = null) {
  try {
    const db       = mongoose.connection.db;
    const settings = await db.collection('incentiveSettings').findOne({ type: 'global' });

    if (!settings || (settings.perRideIncentive === 0 && settings.perRideCoins === 0)) {
      return { success: true, awarded: false };
    }

    const q      = User.findById(driverId).select('totalCoinsCollected totalIncentiveEarned totalRidesCompleted wallet');
    const driver = session ? await q.session(session) : await q;
    if (!driver) return { success: false, error: 'Driver not found' };

    const update = {
      $set: {
        totalCoinsCollected:    (driver.totalCoinsCollected    || 0) + settings.perRideCoins,
        totalIncentiveEarned:   (driver.totalIncentiveEarned   || 0) + settings.perRideIncentive,
        totalRidesCompleted:    (driver.totalRidesCompleted    || 0) + 1,
        wallet:                 (driver.wallet                 || 0) + settings.perRideIncentive,
        lastRideId:             tripId,
        lastIncentiveAwardedAt: new Date(),
      },
    };

    if (session) await User.findByIdAndUpdate(driverId, update, { session });
    else         await User.findByIdAndUpdate(driverId, update);

    console.log(`✅ Driver incentives: +${settings.perRideCoins} coins, +₹${settings.perRideIncentive}`);
    return { success: true, awarded: true, coins: settings.perRideCoins, cash: settings.perRideIncentive };
  } catch (error) {
    console.error('❌ Incentive error:', error);
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// AWARD COINS TO CUSTOMER
// ═══════════════════════════════════════════════════════════════════

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

    const tier         = settings.getTierByDistance(distance);
    const coinsToAward = tier.coinsPerRide;

    const CustomerModel  = await getCustomerModel();
    const updateOptions  = { new: true };
    if (session) updateOptions.session = session;

    const customer = await CustomerModel.findByIdAndUpdate(
      customerId,
      { $inc: { coins: coinsToAward } },
      updateOptions
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

    console.log(`✅ Customer coins: +${coinsToAward}`);
    return { success: true, awarded: true, coinsAwarded: coinsToAward, totalCoins: customer.coins || 0 };
  } catch (error) {
    console.error('❌ Coin award error:', error);
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// COORDINATE UTILS
// ═══════════════════════════════════════════════════════════════════

function normalizeCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length !== 2) {
    throw new Error('Coordinates must be [lat, lng] or [lng, lat]');
  }
  const [a, b] = coords.map(Number);
  if (Math.abs(a) <= 90 && Math.abs(b) > 90) return [b, a];
  return [a, b];
}

function calculateDistanceFromCoords(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(v) { return v * Math.PI / 180; }

const findUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;
  if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
    const byId = await User.findById(idOrPhone);
    if (byId) return byId;
  }
  return User.findOne({ phone: idOrPhone });
};

// ═══════════════════════════════════════════════════════════════════
// TRIP CREATION
// ═══════════════════════════════════════════════════════════════════

const createShortTrip = async (req, res) => {
  let coinsDeducted      = 0;
  let discountCustomerId = null;

  try {
    const { customerId, pickup, drop, vehicleType, fare, idempotencyKey } = req.body;

    if (!fare || fare <= 0)
      return res.status(400).json({ success: false, message: 'Valid fare required' });
    if (!vehicleType || typeof vehicleType !== 'string' || vehicleType.trim() === '')
      return res.status(400).json({ success: false, message: 'Vehicle type required' });

    // ── Idempotency check ────────────────────────────────────────
    if (idempotencyKey) {
      const existing = await Trip.findOne({ idempotencyKey }).lean();
      if (existing) {
        console.log(`ℹ️ Duplicate trip creation attempt: ${idempotencyKey}`);
        return res.status(200).json({
          success:   true,
          duplicate: true,
          tripId:    existing._id,
          message:   'Trip already created with this key',
        });
      }
    }

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates   = normalizeCoordinates(drop.coordinates);
    const sanitizedVehicleType = vehicleType.trim().toLowerCase();

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer)
      return res.status(404).json({ success: false, message: 'Customer not found' });

    let finalFare     = fare;
    let discountApplied = 0;
    discountCustomerId  = customer._id;

    const distance = calculateDistanceFromCoords(
      pickup.coordinates[1], pickup.coordinates[0],
      drop.coordinates[1],   drop.coordinates[0]
    );

    // Discount logic
    try {
      const settings = await RewardSettings.findOne();
      if (settings?.getTierByDistance) {
        const tier          = settings.getTierByDistance(distance);
        const CustomerModel = await getCustomerModel();
        const customerRecord = await CustomerModel.findById(customerId);

        if (customerRecord && (customerRecord.coins || 0) >= tier.coinsRequiredForDiscount) {
          const updatedCustomer = await CustomerModel.findOneAndUpdate(
            { _id: customerId, coins: { $gte: tier.coinsRequiredForDiscount } },
            { $inc: { coins: -tier.coinsRequiredForDiscount }, $set: { lastDiscountUsedAt: new Date() } },
            { new: true }
          );
          if (updatedCustomer) {
            finalFare       = Math.max(0, fare - tier.discountAmount);
            discountApplied = tier.discountAmount;
            coinsDeducted   = tier.coinsRequiredForDiscount;
            await Reward.create({
              customerId, coins: -coinsDeducted, type: 'redeemed',
              description: `₹${tier.discountAmount} discount applied`, createdAt: new Date(),
            });
            const cu = await User.findById(customerId).select('socketId').lean();
            if (cu?.socketId && io) {
              io.to(cu.socketId).emit('coins:redeemed', {
                coinsUsed: coinsDeducted, discountAmount: tier.discountAmount,
                remainingCoins: updatedCustomer.coins || 0,
              });
            }
          }
        }
      }
    } catch (e) {
      console.log(`⚠️ Discount check failed: ${e.message}`);
    }

    const nearbyDrivers = await User.find({
      isDriver:   true,
      vehicleType: sanitizedVehicleType,
      isOnline:   true,
      isBusy:     { $ne: true },
      $or:  [{ socketId: { $exists: true, $ne: null } }, { fcmToken: { $exists: true, $ne: null } }],
      $and: [{ $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }] }],
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
        isDriver:   true,
        vehicleType: sanitizedVehicleType,
        isOnline:   true,
        isBusy:     { $ne: true },
        $or:  [{ socketId: { $exists: true, $ne: null } }, { fcmToken: { $exists: true, $ne: null } }],
        $and: [{ $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }] }],
        'goToDestination.enabled': true,
        'goToDestination.location': {
          $near: {
            $geometry: { type: 'Point', coordinates: drop.coordinates },
            $maxDistance: 2000,
          },
        },
      }).select('_id socketId fcmToken name phone vehicleType').lean();
    } catch (e) {
      console.log(`⚠️ Destination driver query: ${e.message}`);
    }

    const destIds          = new Set(destinationDrivers.map(d => d._id?.toString()));
    const normalOnlyDrivers = nearbyDrivers.filter(d => !destIds.has(d._id?.toString()));

    const tripData = {
      customerId: customer._id,
      pickup, drop,
      vehicleType: sanitizedVehicleType,
      type:   'short',
      status: 'requested',
      fare:   finalFare,
      originalFare: fare,
      discountApplied,
      coinsUsed: coinsDeducted,
    };
    if (idempotencyKey) tripData.idempotencyKey = idempotencyKey;

    const trip = await Trip.create(tripData);
    startTripRetry(trip._id.toString());

    if (normalOnlyDrivers.length > 0) {
      await broadcastToDrivers(normalOnlyDrivers, {
        tripId: trip._id.toString(), type: 'short', fare: trip.fare,
        vehicleType: sanitizedVehicleType, customerId: customer._id.toString(),
        pickup: { lat: pickup.coordinates[1], lng: pickup.coordinates[0], address: pickup.address },
        drop:   { lat: drop.coordinates[1],   lng: drop.coordinates[0],   address: drop.address },
        isDestinationMatch: false,
      });
    }

    if (destinationDrivers.length > 0) {
      await broadcastToDrivers(destinationDrivers, {
        tripId: trip._id.toString(), type: 'short', fare: trip.fare,
        vehicleType: sanitizedVehicleType, customerId: customer._id.toString(),
        pickup: { lat: pickup.coordinates[1], lng: pickup.coordinates[0], address: pickup.address },
        drop:   { lat: drop.coordinates[1],   lng: drop.coordinates[0],   address: drop.address },
        isDestinationMatch: true,
      });
    }

    res.status(200).json({
      success: true,
      tripId:  trip._id,
      drivers: normalOnlyDrivers.length + destinationDrivers.length,
      normalDrivers:      normalOnlyDrivers.length,
      destinationDrivers: destinationDrivers.length,
      fareDetails: { originalFare: fare, discountApplied, finalFare, coinsUsed: coinsDeducted },
    });

  } catch (err) {
    // Handle duplicate idempotencyKey (unique index violation)
    if (err.code === 11000 && err.keyPattern?.idempotencyKey) {
      const existing = await Trip.findOne({ idempotencyKey: req.body.idempotencyKey }).lean();
      return res.status(200).json({
        success: true, duplicate: true,
        tripId:  existing?._id,
        message: 'Trip already created with this key',
      });
    }
    console.error('🔥 createShortTrip error:', err);
    if (discountCustomerId && coinsDeducted > 0) {
      try {
        const M = await getCustomerModel();
        await M.findByIdAndUpdate(discountCustomerId, { $inc: { coins: coinsDeducted } });
      } catch (e) { console.error('Rollback failed:', e); }
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

const createParcelTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, parcelDetails, fare, idempotencyKey } = req.body;
    if (!fare || fare <= 0)
      return res.status(400).json({ success: false, message: 'Valid fare required' });

    if (idempotencyKey) {
      const existing = await Trip.findOne({ idempotencyKey }).lean();
      if (existing) return res.status(200).json({ success: true, duplicate: true, tripId: existing._id });
    }

    const sanitizedVehicleType = (vehicleType || 'bike').toString().trim().toLowerCase();
    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates   = normalizeCoordinates(drop.coordinates);

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const nearbyDrivers = await User.find({
      isDriver: true, vehicleType: sanitizedVehicleType, isOnline: true,
      isBusy: { $ne: true }, socketId: { $exists: true, $ne: null },
      $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
      location: { $near: { $geometry: { type: 'Point', coordinates: pickup.coordinates }, $maxDistance: TRIP_LIMITS.PARCEL || 10000 } },
    }).select('_id name phone socketId vehicleType location rating').lean();

    let destinationDrivers = [];
    try {
      destinationDrivers = await User.find({
        isDriver: true, vehicleType: sanitizedVehicleType, isOnline: true,
        isBusy: { $ne: true }, socketId: { $exists: true, $ne: null },
        $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
        'goToDestination.enabled': true,
        'goToDestination.location': { $near: { $geometry: { type: 'Point', coordinates: drop.coordinates }, $maxDistance: 2000 } },
      }).select('_id socketId name phone vehicleType').lean();
    } catch (e) { console.log(`⚠️ Dest query: ${e.message}`); }

    const nearbyIds  = new Set(nearbyDrivers.map(d => d._id?.toString()));
    const uniqueDest = destinationDrivers.filter(d => !nearbyIds.has(d._id?.toString()));

    const tripData = { customerId: customer._id, pickup, drop, vehicleType: sanitizedVehicleType, type: 'parcel', parcelDetails, status: 'requested', fare };
    if (idempotencyKey) tripData.idempotencyKey = idempotencyKey;

    const trip = await Trip.create(tripData);
    startTripRetry(trip._id.toString());

    const payload = {
      tripId: trip._id.toString(), type: 'parcel', fare: trip.fare,
      vehicleType: sanitizedVehicleType, customerId: customer._id.toString(),
      pickup: { lat: pickup.coordinates[1], lng: pickup.coordinates[0], address: pickup.address },
      drop:   { lat: drop.coordinates[1],   lng: drop.coordinates[0],   address: drop.address },
      parcelDetails,
    };

    if (nearbyDrivers.length) broadcastToDrivers(nearbyDrivers, { ...payload, isDestinationMatch: false });
    if (uniqueDest.length)    broadcastToDrivers(uniqueDest,    { ...payload, isDestinationMatch: true });

    res.status(200).json({
      success: true, tripId: trip._id,
      drivers: nearbyDrivers.length + uniqueDest.length,
      normalDrivers: nearbyDrivers.length, destinationDrivers: uniqueDest.length,
    });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.idempotencyKey) {
      const ex = await Trip.findOne({ idempotencyKey: req.body.idempotencyKey }).lean();
      return res.status(200).json({ success: true, duplicate: true, tripId: ex?._id });
    }
    console.error('🔥 createParcelTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const createLongTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, isSameDay, tripDays, returnTrip, fare, idempotencyKey } = req.body;
    if (!fare || fare <= 0) return res.status(400).json({ success: false, message: 'Valid fare required' });

    if (idempotencyKey) {
      const existing = await Trip.findOne({ idempotencyKey }).lean();
      if (existing) return res.status(200).json({ success: true, duplicate: true, tripId: existing._id });
    }

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates   = normalizeCoordinates(drop.coordinates);
    const sanitizedVehicleType = (vehicleType || 'bike').toString().trim().toLowerCase();

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const radius      = isSameDay ? TRIP_LIMITS.LONG_SAME_DAY : TRIP_LIMITS.LONG_ADVANCE;
    const driverQuery = {
      isDriver: true, vehicleType: sanitizedVehicleType, isBusy: { $ne: true },
      socketId: { $exists: true, $ne: null },
      $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
      location: { $near: { $geometry: { type: 'Point', coordinates: pickup.coordinates }, $maxDistance: radius } },
    };
    if (isSameDay) driverQuery.isOnline = true;

    const nearbyDrivers = await User.find(driverQuery).select('_id name phone socketId vehicleType location rating').lean();

    let destinationDrivers = [];
    try {
      const destQ = {
        isDriver: true, vehicleType: sanitizedVehicleType, isBusy: { $ne: true },
        socketId: { $exists: true, $ne: null },
        $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
        'goToDestination.enabled': true,
        'goToDestination.location': { $near: { $geometry: { type: 'Point', coordinates: drop.coordinates }, $maxDistance: 5000 } },
      };
      if (isSameDay) destQ.isOnline = true;
      destinationDrivers = await User.find(destQ).select('_id socketId name phone vehicleType').lean();
    } catch (e) { console.log(`⚠️ Dest query: ${e.message}`); }

    const nearbyIds  = new Set(nearbyDrivers.map(d => d._id?.toString()));
    const uniqueDest = destinationDrivers.filter(d => !nearbyIds.has(d._id?.toString()));

    const tripData = { customerId: customer._id, pickup, drop, vehicleType: sanitizedVehicleType, type: 'long', status: 'requested', isSameDay, returnTrip, tripDays, fare };
    if (idempotencyKey) tripData.idempotencyKey = idempotencyKey;

    const trip = await Trip.create(tripData);
    startTripRetry(trip._id.toString());

    const payload = {
      tripId: trip._id.toString(), type: 'long', fare: trip.fare,
      vehicleType: sanitizedVehicleType, customerId: customer._id.toString(),
      pickup: { lat: pickup.coordinates[1], lng: pickup.coordinates[0], address: pickup.address },
      drop:   { lat: drop.coordinates[1],   lng: drop.coordinates[0],   address: drop.address },
      isSameDay, returnTrip, tripDays,
    };
    if (nearbyDrivers.length) broadcastToDrivers(nearbyDrivers, { ...payload, isDestinationMatch: false });
    if (uniqueDest.length)    broadcastToDrivers(uniqueDest,    { ...payload, isDestinationMatch: true });

    res.status(200).json({
      success: true, tripId: trip._id,
      drivers: nearbyDrivers.length + uniqueDest.length,
      normalDrivers: nearbyDrivers.length, destinationDrivers: uniqueDest.length,
    });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.idempotencyKey) {
      const ex = await Trip.findOne({ idempotencyKey: req.body.idempotencyKey }).lean();
      return res.status(200).json({ success: true, duplicate: true, tripId: ex?._id });
    }
    console.error('🔥 createLongTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// CANCEL SEARCH (before driver accepts)
// ═══════════════════════════════════════════════════════════════════

const cancelTripByCustomer = async (req, res) => {
  try {
    const { tripId, customerId, reason } = req.body;
    if (!tripId || !customerId)
      return res.status(400).json({ success: false, message: 'tripId and customerId required' });

    const trip = await Trip.findOneAndUpdate(
      {
        _id: tripId, customerId,
        status: 'requested',
        $or: [{ assignedDriver: { $exists: false } }, { assignedDriver: null }],
      },
      {
        $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: customerId, cancellationReason: reason || 'customer_cancelled_search' },
        $inc: { version: 1 },
      },
      { new: true }
    ).lean();

    if (!trip) {
      const existing = await Trip.findById(tripId).lean();
      if (!existing)           return res.status(404).json({ success: false, message: 'Trip not found' });
      if (existing.status === 'driver_assigned') return res.status(400).json({ success: false, message: 'Driver already accepted. Use cancel ride API.', status: existing.status });
      if (existing.status === 'cancelled')       return res.status(200).json({ success: true, message: 'Already cancelled', alreadyCancelled: true });
      return res.status(400).json({ success: false, message: 'Cannot cancel at this stage', status: existing.status });
    }

    stopTripRetry(tripId);

    if (io) {
      const onlineDrivers = await User.find({ isDriver: true, isOnline: true, socketId: { $exists: true, $ne: null } }).select('socketId').lean();
      onlineDrivers.forEach(d => {
        if (d.socketId) io.to(d.socketId).emit('trip:cancelled', { tripId, reason: 'customer_cancelled_search' });
      });
    }

    let coinsRefunded = 0;
    if (trip.coinsUsed > 0) {
      try {
        const M = await getCustomerModel();
        await M.findByIdAndUpdate(customerId, { $inc: { coins: trip.coinsUsed } });
        coinsRefunded = trip.coinsUsed;
      } catch (e) { console.error('Coin refund failed:', e); }
    }

    return res.status(200).json({ success: true, message: 'Search cancelled successfully', tripId, coinsRefunded });
  } catch (err) {
    console.error('🔥 cancelTripByCustomer error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// ACCEPT TRIP
// ═══════════════════════════════════════════════════════════════════

const acceptTrip = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { driverId, tripId } = req.body;
    if (!driverId || !tripId)
      return res.status(400).json({ success: false, message: 'driverId and tripId required' });

    const rideCode   = generateOTP();
    let tripData     = null;
    let driverData   = null;
    let customerData = null;

    await session.withTransaction(async () => {
      const trip = await Trip.findOne({
        _id: tripId, status: 'requested', cancelledAt: { $exists: false },
      }).session(session);
      if (!trip) throw new Error('Trip not available');

      const driver = await User.findOne({
        _id: driverId,
        isBusy: { $ne: true },
        $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
      }).select('name phone photoUrl rating vehicleBrand vehicleNumber location isBusy currentTripId goToDestination').session(session);
      if (!driver) throw new Error('driver_busy');

      assertTransition(trip.status, 'driver_assigned');

      driver.isBusy        = true;
      driver.currentTripId = tripId;
      driver.lastTripAcceptedAt = new Date();

      if (driver.goToDestination?.enabled) {
        driver.goToDestination.enabled    = false;
        driver.goToDestination.disabledAt = new Date();
      }

      trip.assignedDriver = driverId;
      trip.status         = 'driver_assigned';
      trip.otp            = rideCode;
      trip.acceptedAt     = new Date();
      trip.version        += 1;

      stopTripRetry(tripId);

      await driver.save({ session });
      await trip.save({ session });

      tripData = trip.toObject();

      driverData = {
        _id:           driver._id.toString(),
        id:            driver._id.toString(),
        name:          driver.name,
        phone:         driver.phone,
        photoUrl:      driver.photoUrl  || null,
        rating:        driver.rating    || 4.8,
        vehicleBrand:  driver.vehicleBrand  || 'Vehicle',
        vehicleNumber: driver.vehicleNumber || 'N/A',
        location: driver.location?.coordinates ? {
          lat: driver.location.coordinates[1],
          lng: driver.location.coordinates[0],
        } : null,
      };
    });

    const customer = await User.findById(tripData.customerId).select('socketId name phone photoUrl rating').lean();
    if (customer) {
      customerData = {
        id:       customer._id.toString(),
        name:     customer.name     || 'Customer',
        phone:    customer.phone    || null,
        photoUrl: customer.photoUrl || null,
        rating:   customer.rating   || 5.0,
      };
    }

    const tripPayload = {
      _id:        tripData._id.toString(),
      tripId:     tripData._id.toString(),
      customerId: tripData.customerId.toString(),
      driverId:   tripData.assignedDriver.toString(),
      fare:       tripData.fare       || 0,
      finalFare:  tripData.finalFare  || tripData.fare || 0,
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
    };

    if (customer?.socketId && io) {
      io.to(customer.socketId).emit('trip:accepted', {
        tripId: tripData._id.toString(), rideCode, trip: tripPayload, driver: driverData,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        tripId: tripData._id, otp: rideCode,
        trip:   tripPayload,
        customer: customerData,
        status:   tripData.status,
        rideCode,
      },
    });
  } catch (err) {
    console.error('🔥 acceptTrip error:', err);
    const msg = err.message;
    if (msg === 'driver_busy') {
      const driver = await User.findById(req.body.driverId).select('currentTripId').lean();
      return res.status(400).json({ success: false, message: 'Driver is busy', error: 'driver_busy', currentTripId: driver?.currentTripId || null });
    }
    return res.status(400).json({ success: false, message: msg });
  } finally {
    session.endSession();
  }
};

const rejectTrip = async (req, res) => {
  try {
    const { tripId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip || trip.status !== 'requested')
      return res.status(400).json({ success: false, message: 'Trip not valid' });
    res.status(200).json({ success: true, message: 'Rejection recorded' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// TRIP STATUS UPDATES
// ═══════════════════════════════════════════════════════════════════

const driverGoingToPickup = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip)                                            return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== driverId)     return res.status(403).json({ success: false, message: 'Not authorized' });

    assertTransition(trip.status, 'driver_going_to_pickup');
    trip.status   = 'driver_going_to_pickup';
    trip.version  += 1;
    await trip.save();

    const customer = await User.findById(trip.customerId).select('socketId').lean();
    if (customer?.socketId && io) io.to(customer.socketId).emit('trip:driver_enroute', { tripId: trip._id.toString() });

    res.status(200).json({ success: true, message: 'Driver on the way' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const driverArrivedAtPickup = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip)                                        return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== driverId) return res.status(403).json({ success: false, message: 'Not authorized' });

    assertTransition(trip.status, 'driver_at_pickup');
    trip.status  = 'driver_at_pickup';
    trip.version += 1;
    await trip.save();

    const customer = await User.findById(trip.customerId).select('socketId').lean();
    if (customer?.socketId && io) io.to(customer.socketId).emit('trip:driver_arrived', { tripId: trip._id.toString() });

    res.status(200).json({ success: true, message: 'Driver arrived' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const goingToPickup = driverArrivedAtPickup;

const startRide = async (req, res) => {
  try {
    const { tripId, driverId, otp, driverLat, driverLng } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip)                                        return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== driverId) return res.status(403).json({ success: false, message: 'Not authorized' });
    if (trip.otp !== otp)                             return res.status(400).json({ success: false, message: 'Invalid OTP' });

    const dist = calculateDistanceFromCoords(driverLat, driverLng, trip.pickup.coordinates[1], trip.pickup.coordinates[0]);
    if (dist > 0.1) return res.status(400).json({ success: false, message: `Too far: ${(dist * 1000).toFixed(0)}m` });

    assertTransition(trip.status, 'ride_started');
    trip.status       = 'ride_started';
    trip.version      += 1;
    trip.rideStartTime = new Date();
    await trip.save();

    const customer = await User.findById(trip.customerId).select('socketId').lean();
    if (customer?.socketId && io) io.to(customer.socketId).emit('trip:ride_started', { tripId: trip._id.toString(), startTime: trip.rideStartTime });

    res.status(200).json({ success: true, message: 'Ride started', startTime: trip.rideStartTime });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// COMPLETE RIDE
// ═══════════════════════════════════════════════════════════════════

const completeRideWithVerification = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { tripId, driverId, driverLat, driverLng } = req.body;

    let tripData       = null;
    let walletResult   = null;
    let coinReward     = null;
    let driverIncentives = null;
    let customerSocketId = null;

    await session.withTransaction(async () => {
      // ── Atomic complete: only succeeds once ─────────────────────
      const trip = await Trip.findOneAndUpdate(
        { _id: tripId, status: 'ride_started', assignedDriver: driverId },
        {
          $set: {
            status:           'completed',
            completedAt:      new Date(),
            'payment.collected':   true,
            'payment.collectedAt': new Date(),
          },
          $inc: { version: 1 },
        },
        { new: true, session }
      );

      if (!trip) {
        // Check if already completed (idempotent)
        const existing = await Trip.findById(tripId).session(session).lean();
        if (existing?.status === 'completed') throw new Error('ALREADY_COMPLETED');
        throw new Error('Trip not found or not in ride_started status');
      }

      const dist = calculateDistanceFromCoords(driverLat, driverLng, trip.drop.coordinates[1], trip.drop.coordinates[0]);
      if (dist > 0.5) throw new Error(`Too far from drop: ${(dist * 1000).toFixed(0)}m`);

      const fareAmount = parseFloat(trip.fare) || 0;

      // Update finalFare atomically
      await Trip.findByIdAndUpdate(tripId, { $set: { finalFare: fareAmount } }, { session });

      walletResult = await processWalletTransaction(driverId, tripId, fareAmount, session);
      if (!walletResult.success) throw new Error('Wallet processing failed: ' + walletResult.error);

      const tripDist = calculateDistanceFromCoords(
        trip.pickup.coordinates[1], trip.pickup.coordinates[0],
        trip.drop.coordinates[1],   trip.drop.coordinates[0]
      );

      coinReward       = await awardCoinsToCustomer(trip.customerId, tripId, tripDist, session);
      driverIncentives = await awardIncentivesToDriver(driverId, tripId, session);

      await User.findByIdAndUpdate(driverId, {
        $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: true, awaitingCashCollection: false, lastTripCompletedAt: new Date() },
      }, { session });

      await saveToRideHistory(trip, 'Completed', session);

      tripData = trip.toObject();
      tripData.finalFare = fareAmount;

      const cu = await User.findById(trip.customerId).select('socketId').session(session).lean();
      customerSocketId = cu?.socketId;
    });

    session.endSession();

    if (customerSocketId && io) {
      io.to(customerSocketId).emit('trip:completed', {
        tripId, fare: tripData.finalFare, paymentCollected: true,
        coinsAwarded: coinReward?.coinsAwarded || 0,
      });
      if (coinReward?.awarded) {
        io.to(customerSocketId).emit('coins:awarded', {
          coins: coinReward.coinsAwarded, totalCoins: coinReward.totalCoins,
          message: `You earned ${coinReward.coinsAwarded} coins! 🎉`,
        });
      }
    }

    res.status(200).json({
      success: true, message: 'Ride completed successfully',
      fare:             tripData.finalFare,
      paymentCollected: true,
      fareBreakdown:    walletResult.fareBreakdown,
      wallet:           walletResult.wallet,
      coinReward:       coinReward?.awarded ? { coinsAwarded: coinReward.coinsAwarded, totalCoins: coinReward.totalCoins } : null,
      driverIncentives: driverIncentives?.awarded ? { coins: driverIncentives.coins, cash: driverIncentives.cash } : null,
    });

  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    session.endSession();

    if (err.message === 'ALREADY_COMPLETED') {
      return res.status(200).json({ success: true, message: 'Ride already completed', alreadyCompleted: true });
    }
    console.error('🔥 completeRideWithVerification error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// CONFIRM CASH COLLECTION  ★ FIXED: checks walletUpdated first ★
// ═══════════════════════════════════════════════════════════════════

const confirmCashCollection = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tripId, driverId, fare } = req.body;

    console.log(`\n💰 confirmCashCollection: Trip ${tripId} | Driver ${driverId} | Fare ₹${fare}`);

    if (!tripId || !driverId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'tripId and driverId are required' });
    }

    // ── 1. Load trip ──────────────────────────────────────────────
    const trip = await Trip.findById(tripId).session(session);
    if (!trip) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.assignedDriver?.toString() !== driverId) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (trip.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Trip must be completed before collecting cash' });
    }

    // ── 2. IDEMPOTENCY CHECK — walletUpdated is the master flag ───
    if (trip.walletUpdated === true) {
      await session.abortTransaction();
      console.log(`ℹ️ walletUpdated already true for trip ${tripId} — returning early`);
      return res.json({ success: true, message: 'Cash already collected', alreadyProcessed: true });
    }

    // ── 3. Calculate amounts ──────────────────────────────────────
    const fareAmount = parseFloat(fare) || parseFloat(trip.finalFare) || parseFloat(trip.fare) || 0;
    if (fareAmount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid fare amount' });
    }

    // Commission from DB
    const db       = mongoose.connection.db;
    const settings = await db.collection('commissionSettings').findOne({ type: 'global' });
    const commissionPct = settings?.percentage ?? 20;

    const commission    = Math.round(fareAmount * commissionPct / 100 * 100) / 100;
    const driverEarning = Math.round((fareAmount - commission) * 100) / 100;

    console.log(`   Fare ₹${fareAmount} | Commission ${commissionPct}% = ₹${commission} | Driver ₹${driverEarning}`);

    // ── 4. Update wallet ──────────────────────────────────────────
    let wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      wallet = new Wallet({ driverId, availableBalance: 0, balance: 0, totalEarnings: 0, totalCommission: 0, pendingAmount: 0, transactions: [], processedTripIds: [] });
    }

    // Secondary dedup: processedTripIds
    if (wallet.processedTripIds?.some(id => id.toString() === tripId.toString())) {
      await session.abortTransaction();
      return res.json({ success: true, message: 'Cash already collected', alreadyProcessed: true });
    }

    wallet.transactions.push({
      tripId, type: 'credit', amount: fareAmount,
      description: 'Cash collected from customer',
      paymentMethod: 'cash', status: 'completed', createdAt: new Date(),
    });

    wallet.transactions.push({
      tripId, type: 'commission', amount: commission,
      description: `Platform commission (${commissionPct}%)`,
      paymentMethod: 'cash', status: 'completed', createdAt: new Date(),
    });

    wallet.totalEarnings   = Math.round((wallet.totalEarnings   + fareAmount)  * 100) / 100;
    wallet.totalCommission = Math.round((wallet.totalCommission + commission)   * 100) / 100;

    // Cash flow: driver physically holds the cash, owes commission to platform
    // pendingAmount tracks the commission debt
    wallet.pendingAmount = Math.round((wallet.pendingAmount + commission) * 100) / 100;

    // Track this tripId to prevent double-processing
    wallet.processedTripIds.push(tripId);

    await wallet.save({ session });

    // ── 5. Mark trip as payment collected + walletUpdated ────────
    // Both flags set in same transaction — atomically
    trip.paymentCollected   = true;
    trip.paymentStatus      = 'completed';
    trip.paymentMethod      = 'cash';
    trip.paidAmount         = fareAmount;
    trip.paymentCompletedAt = new Date();
    trip.walletUpdated      = true;        // ★ MASTER FLAG ★
    trip.walletUpdatedAt    = new Date();
    trip.finalFare          = fareAmount;
    await trip.save({ session });

    await session.commitTransaction();

    // ── 6. Emit sockets ───────────────────────────────────────────
    const ioInstance = req.io || io;
    if (ioInstance) {
      const customerId = trip.customerId?.toString();
      if (customerId) {
        ioInstance.to(`customer_${customerId}`).emit('trip:cash_collected', {
          tripId, message: 'Driver confirmed cash received. Thank you!', timestamp: new Date().toISOString(),
        });
      }
      ioInstance.to(`driver_${driverId}`).emit('payment:confirmed', {
        tripId, amount: fareAmount, driverAmount: driverEarning, commission,
        pendingAmount: wallet.pendingAmount, method: 'cash', timestamp: new Date().toISOString(),
      });
    }

    console.log('✅ Cash collection confirmed');

    // ── 7. Award customer coins (non-critical) ────────────────────
    let coinReward = null;
    try {
      if (trip.customerId) coinReward = await awardCoinsToCustomer(trip.customerId, tripId, null);
    } catch (e) { console.warn('⚠️ Coin award failed:', e.message); }

    return res.status(200).json({
      success: true, message: 'Cash collected successfully',
      amount: fareAmount,
      fareBreakdown: { tripFare: fareAmount, commission, commissionPercentage: commissionPct, driverEarning },
      wallet: {
        totalEarnings:    wallet.totalEarnings,
        totalCommission:  wallet.totalCommission,
        pendingAmount:    wallet.pendingAmount,
        availableBalance: wallet.availableBalance,
      },
      coinReward: coinReward?.awarded ? { coinsAwarded: coinReward.coinsAwarded, totalCoins: coinReward.totalCoins } : null,
    });

  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('🔥 confirmCashCollection error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed to confirm cash collection' });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════
// CANCEL TRIP (after driver accepted)
// ═══════════════════════════════════════════════════════════════════

const cancelTrip = async (req, res) => {
  try {
    const { tripId, cancelledBy, reason } = req.body;
    if (!tripId || !cancelledBy)
      return res.status(400).json({ success: false, message: 'tripId and cancelledBy required' });

    const trip = await Trip.findById(tripId)
      .populate('customerId',    'phone name socketId')
      .populate('assignedDriver', 'name phone socketId');

    if (!trip)                        return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.status === 'cancelled')  return res.status(400).json({ success: false, message: 'Already cancelled' });
    if (trip.status === 'completed')  return res.status(400).json({ success: false, message: 'Cannot cancel completed trip' });

    const isCustomer = trip.customerId?._id?.toString()  === cancelledBy;
    const isDriver   = trip.assignedDriver?._id?.toString() === cancelledBy;
    if (!isCustomer && !isDriver)
      return res.status(403).json({ success: false, message: 'Not authorized' });

    let coinsRefunded = 0;
    if (trip.coinsUsed > 0) {
      try {
        const M = await getCustomerModel();
        await M.findByIdAndUpdate(trip.customerId._id, { $inc: { coins: trip.coinsUsed } });
        coinsRefunded = trip.coinsUsed;
      } catch (e) { console.error('Coin refund failed:', e); }
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
      await User.findByIdAndUpdate(trip.assignedDriver._id, { $set: { currentTripId: null, isBusy: false } });
    }

    if (trip.assignedDriver?.socketId && io) io.to(trip.assignedDriver.socketId).emit('trip:cancelled', { tripId, cancelledBy: isCustomer ? 'customer' : 'driver' });
    if (trip.customerId?.socketId     && io) io.to(trip.customerId.socketId).emit('trip:cancelled',     { tripId, coinsRefunded });

    if (!trip.assignedDriver && io) {
      const onlineDrivers = await User.find({ isDriver: true, isOnline: true, socketId: { $exists: true, $ne: null } }).select('socketId').lean();
      onlineDrivers.forEach(d => io.to(d.socketId).emit('trip:cancelled', { tripId: trip._id.toString(), cancelledBy: 'customer' }));
    }

    res.status(200).json({ success: true, message: 'Trip cancelled', coinsRefunded });
  } catch (err) {
    console.error('🔥 cancelTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const completeTrip = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { tripId, userId } = req.body;

    await session.withTransaction(async () => {
      const trip = await Trip.findById(tripId).session(session);
      if (!trip) throw new Error('Trip not found');
      if (trip.assignedDriver?.toString() !== userId && trip.customerId?.toString() !== userId) throw new Error('Not authorized');

      assertTransition(trip.status, 'completed');
      trip.status      = 'completed';
      trip.completedAt = new Date();
      trip.version     += 1;
      await trip.save({ session });

      await User.findByIdAndUpdate(trip.assignedDriver, { $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: true } }, { session });
      await saveToRideHistory(trip, 'Completed', session);
    });

    session.endSession();
    res.status(200).json({ success: true, message: 'Trip completed' });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    session.endSession();
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// QUERY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

const getTripById = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).populate('assignedDriver customerId');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    res.status(200).json({ success: true, trip });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getTripByIdWithPayment = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.tripId)
      .populate('assignedDriver', 'name phone')
      .populate('customerId',     'name phone')
      .lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    res.status(200).json({ success: true, trip });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getDriverActiveTrip = async (req, res) => {
  try {
    const { driverId } = req.params;
    const trip = await Trip.findOne({
      assignedDriver: driverId,
      $or: [
        { status: { $in: ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'] } },
        { status: 'completed', 'payment.collected': { $ne: true } },
      ],
    }).populate('customerId', 'name phone photoUrl rating').lean();

    if (!trip) {
      await User.findByIdAndUpdate(driverId, { $set: { isBusy: false, currentTripId: null } });
      return res.status(200).json({ success: true, hasActiveTrip: false, driverFreed: true });
    }

    let ridePhase = 'going_to_pickup';
    if      (trip.status === 'ride_started')    ridePhase = 'going_to_drop';
    else if (trip.status === 'driver_at_pickup') ridePhase = 'at_pickup';
    else if (trip.status === 'completed')        ridePhase = 'completed';

    res.status(200).json({
      success: true, hasActiveTrip: true,
      trip: { tripId: trip._id.toString(), status: trip.status, ridePhase, fare: trip.fare, paymentCollected: trip.payment?.collected || false },
      customer: trip.customerId,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getActiveRide = async (req, res) => {
  try {
    const { customerId } = req.params;
    const trip = await Trip.findOne({
      customerId,
      status: { $in: ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'] },
    }).populate('assignedDriver', 'name phone photoUrl rating vehicleBrand vehicleNumber location').lean();

    if (!trip) return res.status(200).json({ success: true, hasActiveRide: false });
    res.status(200).json({
      success: true, hasActiveRide: true,
      trip:   { tripId: trip._id.toString(), status: trip.status, fare: trip.fare },
      driver: trip.assignedDriver,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getDriverLocationByTripId = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findById(tripId).select('assignedDriver customerId status').lean();
    if (!trip)               return res.status(404).json({ success: false, message: 'Trip not found' });
    if (!trip.assignedDriver) return res.status(200).json({ success: false, message: 'No driver assigned' });

    const driver = await User.findById(trip.assignedDriver).select('location lastBearing locationSequence lastLocationUpdate').lean();
    if (!driver?.location?.coordinates) return res.status(200).json({ success: false, message: 'Driver location unavailable' });

    const [lng, lat] = driver.location.coordinates;
    return res.status(200).json({
      success: true,
      location:       { lat, lng, latitude: lat, longitude: lng },
      driverLocation: { lat, lng, latitude: lat, longitude: lng, bearing: driver.lastBearing ?? null, sequence: driver.locationSequence ?? null, lastUpdate: driver.lastLocationUpdate ?? null },
      driverId:  driver._id.toString(),
      tripId:    tripId.toString(),
    });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

export const requestTripSupport = async (req, res) => {
  try {
    const { tripId, reason } = req.body;
    if (!tripId) return res.status(400).json({ success: false, message: 'tripId required' });

    const trip = await Trip.findByIdAndUpdate(tripId,
      { supportRequested: true, supportReason: reason || 'Help requested', supportRequestedAt: new Date() },
      { new: true }
    ).populate('customerId', 'name phone').populate('assignedDriver', 'name phone vehicleNumber');

    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (io) io.to('admin-room').emit('admin:support_request', { tripId: trip._id.toString(), reason: trip.supportReason, trip });
    res.json({ success: true, message: 'Support request sent' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

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
};