// src/controllers/tripController.js

import Trip from '../models/Trip.js';
import Wallet from '../models/Wallet.js';
import User from '../models/User.js';
import DriverPlan from '../models/DriverPlan.js';
import mongoose from 'mongoose';
import { startTripRetry, stopTripRetry } from '../utils/tripRetryBroadcaster.js';
import { confirmCashReceipt as processCashCollection } from './paymentController.js';
import { io } from '../socket/socketHandler.js';
import { broadcastToDrivers } from '../utils/tripBroadcaster.js';
import { TRIP_LIMITS } from '../config/tripConfig.js';
import { generateOTP } from '../utils/otpGeneration.js';
import RideHistory from '../models/RideHistory.js';

import RewardSettings from '../models/RewardSettings.js';
import AppSettings from '../models/AppSettings.js';
import Reward from '../models/Reward.js';
import { awardCoins, handleFirstRideReferral } from '../services/rewardService.js';

// ✅ LEGAL STATUS TRANSITIONS
const ALLOWED_TRANSITIONS = {
  requested: ['driver_assigned', 'cancelled', 'timeout'],
  driver_assigned: ['driver_at_pickup', 'cancelled'],
  driver_at_pickup: ['ride_started', 'cancelled'],
  ride_started: ['completed'],
  completed: [],
  cancelled: [],
  timeout: []
};

function assertTransition(current, next) {
  if (!ALLOWED_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`Illegal transition ${current} → ${next}`);
  }
}

const getCustomerModel = async () => {
  try {
    const Customer = mongoose.models.Customer || mongoose.model('Customer');
    return Customer;
  } catch (e) {
    return User;
  }
};

// ✅ HELPER: Save ride to history (session-aware)
async function saveToRideHistory(trip, status = 'Completed', session = null) {
  try {
    let populatedTrip = trip;
    if (!trip.customerId?.phone || !trip.assignedDriver?.name) {
      const query = Trip.findById(trip._id)
        .populate('customerId', 'phone name')
        .populate('assignedDriver', 'name phone vehicleNumber');
      if (session) query.session(session);
      populatedTrip = await query.lean();
    }

    if (!populatedTrip?.customerId?.phone) return;

    const rideHistory = new RideHistory({
      phone: populatedTrip.customerId.phone,
      customerId: populatedTrip.customerId._id || populatedTrip.customerId,
      pickupLocation: populatedTrip.pickup?.address || 'Pickup Location',
      dropLocation: populatedTrip.drop?.address || 'Drop Location',
      vehicleType: populatedTrip.vehicleType || 'bike',
      fare: populatedTrip.finalFare || populatedTrip.fare || 0,
      status: status,
      driver: {
        name: populatedTrip.assignedDriver?.name || 'N/A',
        phone: populatedTrip.assignedDriver?.phone || 'N/A',
        vehicleNumber: populatedTrip.assignedDriver?.vehicleNumber || 'N/A',
      },
      dateTime: populatedTrip.createdAt || new Date(),
      tripId: populatedTrip._id,
    });

    if (session) {
      await rideHistory.save({ session });
    } else {
      await rideHistory.save();
    }

    console.log(`✅ Ride history saved: ${rideHistory._id}`);
  } catch (error) {
    console.error('❌ Error saving ride history:', error);
  }
}

// ✅ Process wallet/commission (session-aware)
async function processWalletTransaction(driverId, tripId, fareAmount, session) {
  try {
    console.log(`💳 Processing wallet: Driver ${driverId}, Fare ₹${fareAmount}`);

    const db = mongoose.connection.db;
    const CommissionSettings = db.collection('commissionSettings');
    const commissionSettings = await CommissionSettings.findOne({ type: 'global' });
    const defaultCommissionPercentage = commissionSettings?.percentage || 15;

    // ── Check for active driver plan (broader query to also catch just-expired plans) ──
    const candidatePlan = await DriverPlan.findOne({
      driver: driverId,
      isActive: true,
      paymentStatus: 'completed',
    });

    let commission;
    let planBonus = 0;
    let finalDriverEarning;
    let planApplied = false;
    let appliedPlanId = null;
    let appliedPlanName = null;
    let commissionRate = defaultCommissionPercentage;

    if (candidatePlan && candidatePlan.isValidNow()) {
      // Plan is active and within valid time window / not expired
      const activePlan = candidatePlan;
      planApplied = true;
      appliedPlanId = activePlan._id;
      appliedPlanName = activePlan.planName;

      if (activePlan.noCommission) {
        commission = 0;
        commissionRate = 0;
        finalDriverEarning = fareAmount;
      } else {
        commissionRate = activePlan.commissionRate;
        commission = (fareAmount * activePlan.commissionRate) / 100;
        finalDriverEarning = fareAmount - commission;
      }

      if (activePlan.bonusMultiplier > 1) {
        planBonus = finalDriverEarning * (activePlan.bonusMultiplier - 1);
        finalDriverEarning = finalDriverEarning * activePlan.bonusMultiplier;
      }

      console.log(`🎯 Plan applied: ${activePlan.planName} | Commission: ${commissionRate}% | Bonus: x${activePlan.bonusMultiplier}`);
    } else {
      // Default commission logic
      commission = (fareAmount * defaultCommissionPercentage) / 100;
      commissionRate = defaultCommissionPercentage;
      finalDriverEarning = fareAmount - commission;

      // Auto-expire plan if it exists but has passed its expiry date
      if (candidatePlan && candidatePlan.expiryDate && candidatePlan.expiryDate < new Date()) {
        candidatePlan.markAsExpired().catch((err) =>
          console.error('❌ Failed to mark plan as expired:', err)
        );
      }
    }

    finalDriverEarning = Math.round(finalDriverEarning * 100) / 100;
    commission = Math.round(commission * 100) / 100;
    planBonus = Math.round(planBonus * 100) / 100;

    const driver = await User.findById(driverId).session(session);
    if (!driver) throw new Error('Driver not found for wallet update');

    const currentEarnings = driver.totalEarnings || 0;
    const currentCommission = driver.totalCommissionPaid || 0;
    const currentPending = driver.pendingAmount || 0;

    await User.findByIdAndUpdate(driverId, {
      $set: {
        totalEarnings: currentEarnings + finalDriverEarning,
        totalCommissionPaid: currentCommission + commission,
        pendingAmount: currentPending + finalDriverEarning,
        lastEarningAt: new Date()
      }
    }, { session });

    // ── Push transaction to Wallet model with plan breakdown ──
    const description = planApplied
      ? `Ride ₹${fareAmount} | Commission: ₹${commission} | Plan Bonus: +₹${planBonus.toFixed(2)}`
      : `Ride ₹${fareAmount} | Commission: ₹${commission}`;

    await Wallet.findOneAndUpdate(
      { driverId },
      {
        $inc: {
          totalEarnings: finalDriverEarning,
          totalCommission: commission,
          availableBalance: finalDriverEarning,
        },
        $push: {
          transactions: {
            type: 'credit',
            amount: finalDriverEarning,
            tripId: tripId || null,
            description,
            originalFare: fareAmount,
            commissionDeducted: commission,
            planBonus,
            finalEarning: finalDriverEarning,
            planApplied,
            planId: (planApplied ? candidatePlan?.plan : null) || null,
            driverPlanId: appliedPlanId,
            planName: appliedPlanName,
            planCommissionRate: commissionRate,
            planBonusMultiplier: (planApplied ? candidatePlan?.bonusMultiplier : null) || 1,
            status: 'completed',
            createdAt: new Date(),
          },
        },
        $set: { lastUpdated: new Date() },
      },
      { upsert: true, session }
    );

    console.log(`✅ Wallet updated: Earning ₹${finalDriverEarning.toFixed(2)}, Commission ₹${commission.toFixed(2)}${planApplied ? `, Plan Bonus ₹${planBonus.toFixed(2)}` : ''}`);

    return {
      success: true,
      fareBreakdown: {
        tripFare: fareAmount,
        commission,
        commissionPercentage: commissionRate,
        driverEarning: finalDriverEarning,
        planBonus,
        planApplied,
        planName: appliedPlanName,
      },
      wallet: {
        totalEarnings: currentEarnings + finalDriverEarning,
        totalCommission: currentCommission + commission,
        pendingAmount: currentPending + finalDriverEarning
      }
    };
  } catch (error) {
    console.error('❌ Wallet error:', error);
    return { success: false, error: error.message };
  }
}

// ✅ Award incentives to driver (session-aware)
async function awardIncentivesToDriver(driverId, tripId, session = null) {
  try {
    const db = mongoose.connection.db;
    const IncentiveSettings = db.collection('incentiveSettings');
    const settings = await IncentiveSettings.findOne({ type: 'global' });

    if (!settings || (settings.perRideIncentive === 0 && settings.perRideCoins === 0)) {
      return { success: true, awarded: false };
    }

    const driverQuery = User.findById(driverId)
      .select('name phone totalCoinsCollected totalIncentiveEarned totalRidesCompleted wallet');
    const driver = session ? await driverQuery.session(session) : await driverQuery;

    if (!driver) return { success: false, error: 'Driver not found' };

    const newCoins = (driver.totalCoinsCollected || 0) + settings.perRideCoins;
    const newIncentive = (driver.totalIncentiveEarned || 0) + settings.perRideIncentive;
    const newRides = (driver.totalRidesCompleted || 0) + 1;
    const newWallet = (driver.wallet || 0) + settings.perRideIncentive;

    const updateOptions = {
      $set: {
        totalCoinsCollected: newCoins,
        totalIncentiveEarned: newIncentive,
        totalRidesCompleted: newRides,
        wallet: newWallet,
        lastRideId: tripId,
        lastIncentiveAwardedAt: new Date()
      }
    };

    if (session) {
      await User.findByIdAndUpdate(driverId, updateOptions, { session });
    } else {
      await User.findByIdAndUpdate(driverId, updateOptions);
    }

    console.log(`✅ Driver incentives: +${settings.perRideCoins} coins, +₹${settings.perRideIncentive}`);
    return { success: true, awarded: true, coins: settings.perRideCoins, cash: settings.perRideIncentive };
  } catch (error) {
    console.error('❌ Incentive error:', error);
    return { success: false, error: error.message };
  }
}

// ✅ Award coins to customer (session-aware)
async function awardCoinsToCustomer(customerId, tripId, distance, session = null) {
  try {
    const settings = await RewardSettings.findOne();
    if (!settings) return { success: true, awarded: false, reason: 'no_settings' };

    if (!distance || distance <= 0) {
      const tripQuery = Trip.findById(tripId);
      const trip = session ? await tripQuery.session(session).lean() : await tripQuery.lean();

      if (trip?.pickup?.coordinates && trip?.drop?.coordinates) {
        distance = calculateDistanceFromCoords(
          trip.pickup.coordinates[1], trip.pickup.coordinates[0],
          trip.drop.coordinates[1], trip.drop.coordinates[0]
        );
      } else {
        return { success: true, awarded: false, reason: 'no_distance' };
      }
    }

    const tier = settings.getTierByDistance(distance);
    const coinsToAward = tier.coinsPerRide;

    const CustomerModel = await getCustomerModel();
    const updateOptions = { new: true };
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
      coins: coinsToAward,
      type: 'earned',
      description: `Ride completed (${distance.toFixed(1)}km)`,
      createdAt: new Date(),
    });

    if (session) {
      await rewardDoc.save({ session });
    } else {
      await rewardDoc.save();
    }

    console.log(`✅ Customer coins awarded: +${coinsToAward}`);
    return { success: true, awarded: true, coinsAwarded: coinsToAward, totalCoins: customer.coins || 0 };
  } catch (error) {
    console.error('❌ Coin award error:', error);
    return { success: false, error: error.message };
  }
}

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
  if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
    const byId = await User.findById(idOrPhone);
    if (byId) return byId;
  }
  return await User.findOne({ phone: idOrPhone });
};

function calculateDistanceFromCoords(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(value) {
  return value * Math.PI / 180;
}

// ========== TRIP CREATION ==========

const createShortTrip = async (req, res) => {
  let coinsDeducted = 0;
  let discountCustomerId = null;

  try {
    const { customerId, pickup, drop, vehicleType, fare, useCoins } = req.body;

    if (!fare || fare <= 0) {
      return res.status(400).json({ success: false, message: 'Valid fare required' });
    }

    if (!vehicleType || typeof vehicleType !== 'string' || vehicleType.trim() === '') {
      return res.status(400).json({ success: false, message: 'Vehicle type required' });
    }

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);
    const sanitizedVehicleType = vehicleType.trim().toLowerCase();

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    let finalFare = fare;
    let discountApplied = 0;
    discountCustomerId = customer._id;

    const distance = calculateDistanceFromCoords(
      pickup.coordinates[1], pickup.coordinates[0],
      drop.coordinates[1], drop.coordinates[0]
    );

    // Coin discount logic — only applies when useCoins === true (user opted in)
    try {
      const appSettings = await AppSettings.getSettings();
      const { coinsRequiredForDiscount, discountAmount, enabled } = appSettings.coins;

      if (enabled && useCoins === true && coinsRequiredForDiscount > 0) {
        const CustomerModel = await getCustomerModel();
        const customerRecord = await CustomerModel.findById(customerId);

        if (customerRecord && (customerRecord.coins || 0) >= coinsRequiredForDiscount) {
          const updatedCustomer = await CustomerModel.findOneAndUpdate(
            { _id: customerId, coins: { $gte: coinsRequiredForDiscount } },
            { $inc: { coins: -coinsRequiredForDiscount, totalCoinsRedeemed: coinsRequiredForDiscount }, $set: { lastDiscountUsedAt: new Date() } },
            { new: true }
          );

          if (updatedCustomer) {
            finalFare = Math.max(0, fare - discountAmount);
            discountApplied = discountAmount;
            coinsDeducted = coinsRequiredForDiscount;

            await Reward.create({
              customerId, coins: -coinsDeducted, type: 'redeemed',
              description: `₹${discountAmount} discount applied (${coinsDeducted} coins)`, createdAt: new Date()
            });

            const customerUser = await User.findById(customerId).select('socketId').lean();
            if (customerUser?.socketId && io) {
              io.to(customerUser.socketId).emit('coins:redeemed', {
                coinsUsed: coinsDeducted, discountAmount,
                remainingCoins: updatedCustomer.coins || 0
              });
            }
          }
        }
      }
    } catch (e) {
      console.log(`⚠️ Discount check failed: ${e.message}`);
    }

    // ✅ STEP 1: NORMAL NEARBY DRIVERS (Socket OR FCM - Production Ready)
    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType: sanitizedVehicleType,
      isOnline: true,
      isBusy: { $ne: true },
      // ✅ PRODUCTION: Has either socket OR fcmToken (can be reached)
      $or: [
        { socketId: { $exists: true, $ne: null } },
        { fcmToken: { $exists: true, $ne: null } }
      ],
      $and: [
        { $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }] }
      ],
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: pickup.coordinates,
          },
          $maxDistance: TRIP_LIMITS.SHORT || 2000,
        },
      },
    }).select('_id name phone socketId fcmToken vehicleType location rating').lean(); // ✅ Added fcmToken

    // ✅ STEP 2: DESTINATION MODE DRIVERS (Socket OR FCM)
    let destinationDrivers = [];
    try {
      destinationDrivers = await User.find({
        isDriver: true,
        vehicleType: sanitizedVehicleType,
        isOnline: true,
        isBusy: { $ne: true },
        // ✅ PRODUCTION: Has either socket OR fcmToken
        $or: [
          { socketId: { $exists: true, $ne: null } },
          { fcmToken: { $exists: true, $ne: null } }
        ],
        $and: [
          { $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }] }
        ],
        "goToDestination.enabled": true,
        "goToDestination.location": {
          $near: {
            $geometry: {
              type: "Point",
              coordinates: drop.coordinates,
            },
            $maxDistance: 2000,
          },
        },
      }).select("_id socketId fcmToken name phone vehicleType").lean(); // ✅ Added fcmToken

      console.log(`🧡 Found ${destinationDrivers.length} destination-mode drivers for short trip`);
    } catch (destErr) {
      console.log(`⚠️ Destination driver query failed: ${destErr.message}`);
    }

    // ✅ STEP 3: DESTINATION DRIVERS GET PRIORITY
    const destinationDriverIds = new Set(
      destinationDrivers.map(d => d._id?.toString())
    );

    const normalOnlyDrivers = nearbyDrivers.filter(
      d => !destinationDriverIds.has(d._id?.toString())
    );

    console.log(`📍 Normal-only drivers: ${normalOnlyDrivers.length}, Destination drivers: ${destinationDrivers.length}`);

    // Create trip
    const trip = await Trip.create({
      customerId: customer._id,
      pickup,
      drop,
      vehicleType: sanitizedVehicleType,
      type: 'short',
      status: 'requested',
      fare: finalFare,
      originalFare: fare,
      discountApplied,
      coinsUsed: coinsDeducted
    });

    // Start retry loop
    startTripRetry(trip._id.toString());

    // ✅ STEP 4: BROADCAST TO NORMAL-ONLY DRIVERS (async - uses Socket + FCM)
    if (normalOnlyDrivers.length > 0) {
      await broadcastToDrivers(normalOnlyDrivers, {
        tripId: trip._id.toString(),
        type: 'short',
        fare: trip.fare,
        vehicleType: sanitizedVehicleType,
        customerId: customer._id.toString(),
        pickup: {
          lat: pickup.coordinates[1],
          lng: pickup.coordinates[0],
          address: pickup.address,
        },
        drop: {
          lat: drop.coordinates[1],
          lng: drop.coordinates[0],
          address: drop.address,
        },
        isDestinationMatch: false,
      });
      console.log(`📍 Sent normal trip request to ${normalOnlyDrivers.length} drivers`);
    }

    // ✅ STEP 5: BROADCAST TO DESTINATION MODE DRIVERS (async - uses Socket + FCM)
    if (destinationDrivers.length > 0) {
      await broadcastToDrivers(destinationDrivers, {
        tripId: trip._id.toString(),
        type: 'short',
        fare: trip.fare,
        vehicleType: sanitizedVehicleType,
        customerId: customer._id.toString(),
        pickup: {
          lat: pickup.coordinates[1],
          lng: pickup.coordinates[0],
          address: pickup.address,
        },
        drop: {
          lat: drop.coordinates[1],
          lng: drop.coordinates[0],
          address: drop.address,
        },
        isDestinationMatch: true,
      });
      console.log(`🧡 Sent destination-match trip to ${destinationDrivers.length} drivers`);
    }

    const totalDriversNotified = normalOnlyDrivers.length + destinationDrivers.length;

    res.status(200).json({
      success: true,
      tripId: trip._id,
      drivers: totalDriversNotified,
      normalDrivers: normalOnlyDrivers.length,
      destinationDrivers: destinationDrivers.length,
      fareDetails: {
        originalFare: fare,
        discountApplied,
        finalFare,
        coinsUsed: coinsDeducted
      }
    });

  } catch (err) {
    console.error('🔥 createShortTrip error:', err);
    if (discountCustomerId && coinsDeducted > 0) {
      try {
        const CustomerModel = await getCustomerModel();
        await CustomerModel.findByIdAndUpdate(discountCustomerId, { $inc: { coins: coinsDeducted } });
      } catch (e) { console.error('Rollback failed:', e); }
    }
    res.status(500).json({ success: false, message: err.message });
  }
};
const createParcelTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, parcelDetails, fare } = req.body;
    if (!fare || fare <= 0) return res.status(400).json({ success: false, message: 'Valid fare required' });

    const sanitizedVehicleType = (vehicleType || 'bike').toString().trim().toLowerCase();
    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    // ✅ STEP 1: NORMAL NEARBY DRIVERS (Socket required)
    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType: sanitizedVehicleType,
      isOnline: true,
      isBusy: { $ne: true },
      socketId: { $exists: true, $ne: null }, // ✅ SOCKET REQUIRED
      $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: TRIP_LIMITS.PARCEL || 10000
        }
      }
    }).select('_id name phone socketId vehicleType location rating').lean();

    // ✅ STEP 2: DESTINATION MODE DRIVERS (Socket required)
    let destinationDrivers = [];
    try {
      destinationDrivers = await User.find({
        isDriver: true,
        vehicleType: sanitizedVehicleType,
        isOnline: true,
        isBusy: { $ne: true },
        socketId: { $exists: true, $ne: null }, // ✅ SOCKET REQUIRED
        $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
        "goToDestination.enabled": true,
        "goToDestination.location": {
          $near: {
            $geometry: {
              type: "Point",
              coordinates: drop.coordinates,
            },
            $maxDistance: 2000,
          },
        },
      }).select("_id socketId name phone vehicleType").lean();

      console.log(`🧡 Found ${destinationDrivers.length} destination-mode drivers for parcel trip`);
    } catch (destErr) {
      console.log(`⚠️ Destination driver query failed: ${destErr.message}`);
    }

    // ✅ STEP 3: PREVENT DUPLICATE NOTIFICATIONS
    const nearbyDriverIds = new Set(
      nearbyDrivers.map(d => d._id?.toString())
    );

    const uniqueDestinationDrivers = destinationDrivers.filter(
      d => !nearbyDriverIds.has(d._id?.toString())
    );

    console.log(`📦 Parcel - Normal drivers: ${nearbyDrivers.length}, Unique destination drivers: ${uniqueDestinationDrivers.length}`);

    // Create trip
    const trip = await Trip.create({
      customerId: customer._id,
      pickup,
      drop,
      vehicleType: sanitizedVehicleType,
      type: 'parcel',
      parcelDetails,
      status: 'requested',
      fare
    });

    // Start retry loop
    startTripRetry(trip._id.toString());

    // ✅ STEP 4: BROADCAST TO NORMAL NEARBY DRIVERS
    if (nearbyDrivers.length) {
      broadcastToDrivers(nearbyDrivers, {
        tripId: trip._id.toString(),
        type: 'parcel',
        fare: trip.fare,
        vehicleType: sanitizedVehicleType,
        customerId: customer._id.toString(),
        pickup: {
          lat: pickup.coordinates[1],
          lng: pickup.coordinates[0],
          address: pickup.address,
        },
        drop: {
          lat: drop.coordinates[1],
          lng: drop.coordinates[0],
          address: drop.address,
        },
        parcelDetails,
        isDestinationMatch: false,
      });
    }

    // ✅ STEP 5: BROADCAST TO DESTINATION MODE DRIVERS
    if (uniqueDestinationDrivers.length) {
      broadcastToDrivers(uniqueDestinationDrivers, {
        tripId: trip._id.toString(),
        type: 'parcel',
        fare: trip.fare,
        vehicleType: sanitizedVehicleType,
        customerId: customer._id.toString(),
        pickup: {
          lat: pickup.coordinates[1],
          lng: pickup.coordinates[0],
          address: pickup.address,
        },
        drop: {
          lat: drop.coordinates[1],
          lng: drop.coordinates[0],
          address: drop.address,
        },
        parcelDetails,
        isDestinationMatch: true,
      });
      console.log(`🧡 Sent destination-match parcel trip to ${uniqueDestinationDrivers.length} drivers`);
    }

    const totalDriversNotified = nearbyDrivers.length + uniqueDestinationDrivers.length;

    res.status(200).json({
      success: true,
      tripId: trip._id,
      drivers: totalDriversNotified,
      normalDrivers: nearbyDrivers.length,
      destinationDrivers: uniqueDestinationDrivers.length
    });
  } catch (err) {
    console.error('🔥 createParcelTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const createLongTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, isSameDay, tripDays, returnTrip, fare } = req.body;
    if (!fare || fare <= 0) return res.status(400).json({ success: false, message: 'Valid fare required' });

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);
    const sanitizedVehicleType = (vehicleType || 'bike').toString().trim().toLowerCase();

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const radius = isSameDay ? TRIP_LIMITS.LONG_SAME_DAY : TRIP_LIMITS.LONG_ADVANCE;

    // ✅ STEP 1: NORMAL NEARBY DRIVERS (Socket required)
    const driverQuery = {
      isDriver: true,
      vehicleType: sanitizedVehicleType,
      isBusy: { $ne: true },
      socketId: { $exists: true, $ne: null }, // ✅ SOCKET REQUIRED
      $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: radius
        }
      }
    };
    if (isSameDay) driverQuery.isOnline = true;

    const nearbyDrivers = await User.find(driverQuery).select('_id name phone socketId vehicleType location rating').lean();

    // ✅ STEP 2: DESTINATION MODE DRIVERS (Socket required)
    let destinationDrivers = [];
    try {
      const destQuery = {
        isDriver: true,
        vehicleType: sanitizedVehicleType,
        isBusy: { $ne: true },
        socketId: { $exists: true, $ne: null }, // ✅ SOCKET REQUIRED
        $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
        "goToDestination.enabled": true,
        "goToDestination.location": {
          $near: {
            $geometry: {
              type: "Point",
              coordinates: drop.coordinates,
            },
            $maxDistance: 5000,
          },
        },
      };
      if (isSameDay) destQuery.isOnline = true;

      destinationDrivers = await User.find(destQuery).select("_id socketId name phone vehicleType").lean();

      console.log(`🧡 Found ${destinationDrivers.length} destination-mode drivers for long trip`);
    } catch (destErr) {
      console.log(`⚠️ Destination driver query failed: ${destErr.message}`);
    }

    // ✅ STEP 3: PREVENT DUPLICATE NOTIFICATIONS
    const nearbyDriverIds = new Set(
      nearbyDrivers.map(d => d._id?.toString())
    );

    const uniqueDestinationDrivers = destinationDrivers.filter(
      d => !nearbyDriverIds.has(d._id?.toString())
    );

    console.log(`🚗 Long trip - Normal drivers: ${nearbyDrivers.length}, Unique destination drivers: ${uniqueDestinationDrivers.length}`);

    // Create trip
    const trip = await Trip.create({
      customerId: customer._id,
      pickup,
      drop,
      vehicleType: sanitizedVehicleType,
      type: 'long',
      status: 'requested',
      isSameDay,
      returnTrip,
      tripDays,
      fare
    });

    // Start retry loop
    startTripRetry(trip._id.toString());

    // ✅ STEP 4: BROADCAST TO NORMAL NEARBY DRIVERS
    if (nearbyDrivers.length) {
      broadcastToDrivers(nearbyDrivers, {
        tripId: trip._id.toString(),
        type: 'long',
        fare: trip.fare,
        vehicleType: sanitizedVehicleType,
        customerId: customer._id.toString(),
        pickup: {
          lat: pickup.coordinates[1],
          lng: pickup.coordinates[0],
          address: pickup.address,
        },
        drop: {
          lat: drop.coordinates[1],
          lng: drop.coordinates[0],
          address: drop.address,
        },
        isSameDay,
        returnTrip,
        tripDays,
        isDestinationMatch: false,
      });
    }

    // ✅ STEP 5: BROADCAST TO DESTINATION MODE DRIVERS
    if (uniqueDestinationDrivers.length) {
      broadcastToDrivers(uniqueDestinationDrivers, {
        tripId: trip._id.toString(),
        type: 'long',
        fare: trip.fare,
        vehicleType: sanitizedVehicleType,
        customerId: customer._id.toString(),
        pickup: {
          lat: pickup.coordinates[1],
          lng: pickup.coordinates[0],
          address: pickup.address,
        },
        drop: {
          lat: drop.coordinates[1],
          lng: drop.coordinates[0],
          address: drop.address,
        },
        isSameDay,
        returnTrip,
        tripDays,
        isDestinationMatch: true,
      });
      console.log(`🧡 Sent destination-match long trip to ${uniqueDestinationDrivers.length} drivers`);
    }

    const totalDriversNotified = nearbyDrivers.length + uniqueDestinationDrivers.length;

    res.status(200).json({
      success: true,
      tripId: trip._id,
      drivers: totalDriversNotified,
      normalDrivers: nearbyDrivers.length,
      destinationDrivers: uniqueDestinationDrivers.length
    });
  } catch (err) {
    console.error('🔥 createLongTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * ✅ Cancel trip search BEFORE driver accepts
 */
const cancelTripByCustomer = async (req, res) => {
  try {
    const { tripId, customerId, reason } = req.body;

    console.log('');
    console.log('🛑 ═══════════════════════════════════════════════════════════════');
    console.log('🛑 CUSTOMER CANCEL SEARCH (HTTP API)');
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Customer ID: ${customerId}`);
    console.log('🛑 ═══════════════════════════════════════════════════════════════');

    if (!tripId || !customerId) {
      return res.status(400).json({
        success: false,
        message: 'tripId and customerId required'
      });
    }

    // ✅ ATOMIC CANCEL WITH VERSION INCREMENT
    const trip = await Trip.findOneAndUpdate(
      {
        _id: tripId,
        customerId: customerId,
        status: 'requested',
        $or: [
          { assignedDriver: { $exists: false } },
          { assignedDriver: null }
        ]
      },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: customerId,
          cancellationReason: reason || 'customer_cancelled_search'
        },
        $inc: { version: 1 }
      },
      { new: true }
    ).lean();

    if (!trip) {
      const existingTrip = await Trip.findById(tripId).lean();

      if (!existingTrip) {
        return res.status(404).json({
          success: false,
          message: 'Trip not found'
        });
      }

      if (existingTrip.status === 'driver_assigned') {
        return res.status(400).json({
          success: false,
          message: 'Driver already accepted. Use cancel ride API instead.',
          status: existingTrip.status,
          driverId: existingTrip.assignedDriver
        });
      }

      if (existingTrip.status === 'cancelled') {
        return res.status(200).json({
          success: true,
          message: 'Already cancelled',
          alreadyCancelled: true
        });
      }

      return res.status(400).json({
        success: false,
        message: 'Cannot cancel at this stage',
        status: existingTrip.status
      });
    }

    console.log(`✅ Trip ${tripId} cancelled successfully (version: ${trip.version})`);

    // 🛑 STOP RETRY LOOP
    stopTripRetry(tripId);
    console.log(`✅ Retry loop stopped for trip ${tripId}`);

    // 📢 NOTIFY ALL ONLINE DRIVERS
    if (io) {
      const onlineDrivers = await User.find({
        isDriver: true,
        isOnline: true,
        socketId: { $exists: true, $ne: null }
      }).select('socketId').lean();

      console.log(`📡 Notifying ${onlineDrivers.length} drivers about cancellation`);

      onlineDrivers.forEach(driver => {
        if (driver.socketId) {
          io.to(driver.socketId).emit('trip:cancelled', {
            tripId,
            reason: 'customer_cancelled_search',
            message: 'Customer cancelled the search'
          });
        }
      });
    }

    // Refund coins if any were used
    let coinsRefunded = 0;
    if (trip.coinsUsed && trip.coinsUsed > 0) {
      try {
        const CustomerModel = await getCustomerModel();
        await CustomerModel.findByIdAndUpdate(customerId, {
          $inc: { coins: trip.coinsUsed }
        });
        coinsRefunded = trip.coinsUsed;
        console.log(`💰 Refunded ${coinsRefunded} coins to customer`);
      } catch (e) {
        console.error('Coin refund failed:', e);
      }
    }

    console.log('🛑 ═══════════════════════════════════════════════════════════════');
    console.log('🛑 CANCEL COMPLETE');
    console.log('🛑 ═══════════════════════════════════════════════════════════════');
    console.log('');

    return res.status(200).json({
      success: true,
      message: 'Search cancelled successfully',
      tripId,
      coinsRefunded
    });

  } catch (err) {
    console.error('🔥 cancelTripByCustomer error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ========== TRIP ACCEPTANCE ==========

const acceptTrip = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { driverId, tripId } = req.body;
    if (!driverId || !tripId) {
      return res.status(400).json({ success: false, message: 'driverId and tripId required' });
    }

    const rideCode = generateOTP();
    let tripData = null;
    let driverData = null;
    let customerData = null;

    await session.withTransaction(async () => {
      const trip = await Trip.findOne({ 
        _id: tripId, 
        status: 'requested', 
        cancelledAt: { $exists: false } 
      }).session(session);
      
      if (!trip) throw new Error('Trip not available');

      // ✅ FIXED: Fetch driver with location
      const driver = await User.findOne({
        _id: driverId, 
        isBusy: { $ne: true },
        $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }]
      })
      .select('name phone photoUrl rating vehicleBrand vehicleNumber location isBusy currentTripId')
      .session(session);
      
      if (!driver) throw new Error('Driver busy');

      assertTransition(trip.status, 'driver_assigned');

      driver.isBusy = true;
      driver.currentTripId = tripId;
      driver.lastTripAcceptedAt = new Date();

      if (driver.goToDestination?.enabled) {
        driver.goToDestination.enabled = false;
        driver.goToDestination.disabledAt = new Date();
        console.log(`🧡 Auto-disabled destination mode for driver ${driverId}`);
      }

      trip.assignedDriver = driverId;
      trip.status = 'driver_assigned';
      stopTripRetry(tripId);

      trip.otp = rideCode;
      trip.acceptedAt = new Date();
      trip.version += 1;

      await driver.save({ session });
      await trip.save({ session });

      tripData = trip.toObject();
      
      // ✅ FIXED: Complete driver data with location
      driverData = {
        _id: driver._id.toString(),   // ✅ always plain string
        id: driver._id.toString(),    // ✅ alias for Flutter fallback
        name: driver.name,
        phone: driver.phone,
        photoUrl: driver.photoUrl || null,
        rating: driver.rating || 4.8,
        vehicleBrand: driver.vehicleBrand || 'Vehicle',
        vehicleNumber: driver.vehicleNumber || 'N/A',
        location: driver.location ? {
          lat: driver.location.coordinates[1],
          lng: driver.location.coordinates[0],
        } : null
      };
    });

    // ✅ FIXED: Fetch customer details
    const customer = await User.findById(tripData.customerId)
      .select('socketId name phone photoUrl rating')
      .lean();
    
    if (customer) {
      customerData = {
        id: customer._id.toString(),
        name: customer.name || 'Customer',
        phone: customer.phone || null,
        photoUrl: customer.photoUrl || null,
        rating: customer.rating || 5.0,
      };
    }

    // ✅ FIXED: Send complete data to customer
    if (customer?.socketId && io) {
      io.to(customer.socketId).emit('trip:accepted', { 
        tripId: tripData._id.toString(), 
        rideCode,
        trip: {
          _id: tripData._id.toString(),
          tripId: tripData._id.toString(),
          customerId: tripData.customerId.toString(),   // ✅ ADDED
          driverId: tripData.assignedDriver.toString(), // ✅ ADDED
          fare: tripData.fare || 0,
          finalFare: tripData.finalFare || tripData.fare || 0,
          pickup: {
            lat: tripData.pickup.coordinates[1],
            lng: tripData.pickup.coordinates[0],
            address: tripData.pickup.address || "Pickup Location",
          },
          drop: {
            lat: tripData.drop.coordinates[1],
            lng: tripData.drop.coordinates[0],
            address: tripData.drop.address || "Drop Location",
          },
        },
        driver: driverData
      });
      
      console.log(`✅ Sent complete trip acceptance to customer with driver location`);
    }

    // ✅ FIXED: Return complete data to driver
    return res.status(200).json({ 
      success: true, 
      data: { 
        tripId: tripData._id, 
        otp: rideCode,
        trip: {
          _id: tripData._id.toString(),
          tripId: tripData._id.toString(),
          customerId: tripData.customerId.toString(),   // ✅ ADDED
          driverId: tripData.assignedDriver.toString(), // ✅ ADDED
          fare: tripData.fare || 0,
          finalFare: tripData.finalFare || tripData.fare || 0,
          type: tripData.type,
          pickup: {
            lat: tripData.pickup.coordinates[1],
            lng: tripData.pickup.coordinates[0],
            address: tripData.pickup.address || "Pickup Location",
          },
          drop: {
            lat: tripData.drop.coordinates[1],
            lng: tripData.drop.coordinates[0],
            address: tripData.drop.address || "Drop Location",
          },
        },
        customer: customerData,
        status: tripData.status,
        rideCode: rideCode
      } 
    });
  } catch (err) {
    console.error('🔥 acceptTrip error:', err);
    return res.status(400).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
};

const rejectTrip = async (req, res) => {
  try {
    const { tripId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip || trip.status !== 'requested') return res.status(400).json({ success: false, message: 'Trip not valid' });
    res.status(200).json({ success: true, message: 'Rejection recorded' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ========== TRIP STATUS UPDATES ==========

const driverGoingToPickup = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== driverId) return res.status(403).json({ success: false, message: 'Not authorized' });

    assertTransition(trip.status, 'driver_going_to_pickup');
    trip.status = 'driver_going_to_pickup';
    trip.version += 1;
    await trip.save();

    const customer = await User.findById(trip.customerId).select('socketId').lean();
    if (customer?.socketId && io) io.to(customer.socketId).emit('trip:driver_enroute', { tripId: trip._id.toString() });

    res.status(200).json({ success: true, message: 'Driver on the way' });
  } catch (err) {
    console.error('🔥 driverGoingToPickup error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const driverArrivedAtPickup = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== driverId) return res.status(403).json({ success: false, message: 'Not authorized' });

    assertTransition(trip.status, 'driver_at_pickup');
    trip.status = 'driver_at_pickup';
    trip.version += 1;
    await trip.save();

    const customer = await User.findById(trip.customerId).select('socketId').lean();
    if (customer?.socketId && io) io.to(customer.socketId).emit('trip:driver_arrived', { tripId: trip._id.toString() });

    res.status(200).json({ success: true, message: 'Driver arrived' });
  } catch (err) {
    console.error('🔥 driverArrivedAtPickup error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const goingToPickup = driverArrivedAtPickup;

const startRide = async (req, res) => {
  try {
    const { tripId, driverId, otp, driverLat, driverLng } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== driverId) return res.status(403).json({ success: false, message: 'Not authorized' });
    if (trip.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });

    const distance = calculateDistanceFromCoords(driverLat, driverLng, trip.pickup.coordinates[1], trip.pickup.coordinates[0]);
    if (distance > 0.1) return res.status(400).json({ success: false, message: `Too far: ${(distance * 1000).toFixed(0)}m` });

    assertTransition(trip.status, 'ride_started');
    trip.status = 'ride_started';
    trip.version += 1;
    trip.rideStartTime = new Date();
    await trip.save();

    const customer = await User.findById(trip.customerId).select('socketId').lean();
    if (customer?.socketId && io) io.to(customer.socketId).emit('trip:ride_started', { tripId: trip._id.toString(), startTime: trip.rideStartTime });

    res.status(200).json({ success: true, message: 'Ride started', startTime: trip.rideStartTime });
  } catch (err) {
    console.error('🔥 startRide error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ========== RIDE COMPLETION ==========

const completeRideWithVerification = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { tripId, driverId, driverLat, driverLng } = req.body;

    console.log('');
    console.log('🔒 ═══════════════════════════════════════════════════════════════');
    console.log('🔒 ATOMIC RIDE COMPLETION');
    console.log('🔒 ═══════════════════════════════════════════════════════════════');
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Driver ID: ${driverId}`);
    console.log('='.repeat(70));

    let tripData = null;
    let walletResult = null;
    let coinReward = null;
    let driverIncentives = null;
    let customerSocketId = null;

    await session.withTransaction(async () => {
      const trip = await Trip.findOne({
        _id: tripId,
        status: 'ride_started',
        'payment.collected': { $ne: true }
      }).session(session);

      if (!trip) {
        const existingTrip = await Trip.findById(tripId).session(session).lean();
        if (existingTrip?.status === 'completed' && existingTrip?.payment?.collected === true) {
          throw new Error('Trip already completed and paid');
        }
        throw new Error('Trip not found or not in ride_started status');
      }

      if (trip.assignedDriver?.toString() !== driverId) {
        throw new Error('Not authorized');
      }

      const dropLat = trip.drop.coordinates[1];
      const dropLng = trip.drop.coordinates[0];
      const distance = calculateDistanceFromCoords(driverLat, driverLng, dropLat, dropLng);

      console.log(`📍 Distance to drop: ${(distance * 1000).toFixed(0)}m`);

      if (distance > 0.5) {
        throw new Error(`Too far from drop: ${(distance * 1000).toFixed(0)}m. Please reach destination.`);
      }

      const fareAmount = trip.fare || 0;
      console.log(`💰 Processing fare: ₹${fareAmount}`);

      assertTransition(trip.status, 'completed');

      trip.status = 'completed';
      trip.completedAt = new Date();
      trip.finalFare = fareAmount;
      trip.payment = {
        collected: true,
        collectedAt: new Date(),
        method: 'Cash'
      };
      trip.version += 1;

      await trip.save({ session });
      console.log('✅ Trip completed + payment marked collected');

      // ──── FIX: Only process wallet for non-cash payments ────
      // For cash rides, wallet will be processed separately in confirmCashCollection()
      // to prevent duplicate transaction recording
      const paymentMethod = trip.payment?.method || trip.paymentMethod || 'unknown';
      
      if (paymentMethod?.toLowerCase() === 'cash') {
        console.log('💰 Cash payment detected - wallet will be processed in confirmCashCollection()');
        walletResult = {
          success: true,
          fareBreakdown: {
            tripFare: fareAmount,
            commission: 0,
            commissionPercentage: 0,
            driverEarning: fareAmount,
            planBonus: 0,
            planApplied: false,
            planName: null,
          },
          wallet: {
            totalEarnings: 0,
            totalCommission: 0,
            pendingAmount: 0,
          }
        };
      } else {
        // Online payment (Razorpay, etc.) - process wallet now
        console.log('💳 Online payment detected - processing wallet transaction');
        walletResult = await processWalletTransaction(driverId, tripId, fareAmount, session);
        if (!walletResult.success) {
          throw new Error('Wallet processing failed: ' + walletResult.error);
        }
      }

      const tripDistance = calculateDistanceFromCoords(
        trip.pickup.coordinates[1], trip.pickup.coordinates[0],
        trip.drop.coordinates[1], trip.drop.coordinates[0]
      );

      coinReward = await awardCoins(trip.customerId, tripId, 'ride_reward', {
        distanceKm: tripDistance,
        vehicleType: trip.vehicleType,
      });

      // Check first ride for referral
      const completedCount = await Trip.countDocuments({
        customerId: trip.customerId,
        status: 'completed',
        paymentStatus: 'completed',
      });
      if (completedCount === 1) {
        handleFirstRideReferral(trip.customerId, tripId).catch((e) =>
          console.warn('⚠️ handleFirstRideReferral failed:', e.message)
        );
      }

      driverIncentives = await awardIncentivesToDriver(driverId, tripId, session);

      await User.findByIdAndUpdate(driverId, {
        $set: {
          isBusy: false,
          currentTripId: null,
          canReceiveNewRequests: true,
          awaitingCashCollection: false,
          lastTripCompletedAt: new Date()
        }
      }, { session });
      console.log('✅ Driver released');

      await saveToRideHistory(trip, 'Completed', session);

      tripData = trip.toObject();

      const customerData = await User.findById(trip.customerId).select('socketId').session(session).lean();
      customerSocketId = customerData?.socketId;
    });

    session.endSession();

    if (customerSocketId && io) {
      io.to(customerSocketId).emit('trip:completed', {
        tripId,
        fare: tripData.finalFare,
        paymentCollected: true,
        coinsAwarded: coinReward?.coinsAwarded || 0
      });

      if (coinReward?.awarded) {
        io.to(customerSocketId).emit('coins:awarded', {
          coins: coinReward.coinsAwarded,
          totalCoins: coinReward.totalCoins,
          message: `You earned ${coinReward.coinsAwarded} coins! 🎉`
        });
      }
    }

    console.log('');
    console.log('✅ ═══════════════════════════════════════════════════════════════');
    console.log('✅ RIDE COMPLETION SUCCESS');
    console.log(`   Fare: ₹${tripData.finalFare}`);
    console.log(`   Driver Earning: ₹${walletResult.fareBreakdown.driverEarning.toFixed(2)}`);
    console.log(`   Customer Coins: +${coinReward?.coinsAwarded || 0}`);
    console.log('✅ ═══════════════════════════════════════════════════════════════');
    console.log('');

    res.status(200).json({
      success: true,
      message: 'Ride completed successfully',
      fare: tripData.finalFare,
      paymentCollected: true,
      fareBreakdown: walletResult.fareBreakdown,
      wallet: walletResult.wallet,
      coinReward: coinReward?.awarded ? {
        coinsAwarded: coinReward.coinsAwarded,
        totalCoins: coinReward.totalCoins
      } : null,
      driverIncentives: driverIncentives?.awarded ? {
        coins: driverIncentives.coins,
        cash: driverIncentives.cash
      } : null
    });

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('🔥 completeRideWithVerification error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// ✅ confirmCashCollection - Direct wallet update (no mock chain)
// ============================================================
const confirmCashCollection = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tripId, driverId, fare } = req.body;

    console.log('');
    console.log('💰 ═══════════════════════════════════════════════════════════════');
    console.log('💰 CONFIRM CASH COLLECTION');
    console.log(`   Trip: ${tripId} | Driver: ${driverId} | Fare: ₹${fare}`);
    console.log('💰 ═══════════════════════════════════════════════════════════════');

    if (!tripId || !driverId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'tripId and driverId are required' });
    }

    // ── 1. Load & validate trip ──────────────────────────────────────
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

    if (trip.paymentCollected === true) {
      await session.abortTransaction();
      return res.json({ success: true, message: 'Cash already collected', alreadyProcessed: true });
    }

    // ── 2. Calculate fare & commission (check for active plan) ────────
    const COMMISSION_RATE = 0.20;
    const fareAmount = Number(fare) || trip.finalFare || trip.fare || 0;
    if (fareAmount <= 0) {
      await session.abortTransaction();
           return res.status(400).json({ success: false, message: 'Invalid fare amount' });
    }

    // ──── FIX: Check for active plan to apply benefits ────
    const now = new Date();
    const activePlan = await DriverPlan.findOne({
      driver: driverId,
      isActive: true,
      expiryDate: { $gt: now },
      $or: [
        { paymentStatus: 'completed' },
        { purchaseMethod: 'admin_assigned' },
      ]
    }).session(session);

    let planApplied = false;
    let finalCommissionRate = COMMISSION_RATE;
    let planBonus = 0;
    let appliedPlanDetails = null;

    if (activePlan) {
      const isInTimeWindow = activePlan.isValidNow ? activePlan.isValidNow() : true;
      if (isInTimeWindow) {
        planApplied = true;
        finalCommissionRate = activePlan.noCommission ? 0 : activePlan.commissionRate;
        appliedPlanDetails = {
          planId: activePlan.plan,
          planName: activePlan.planName,
          commissionRate: finalCommissionRate,
          bonusMultiplier: activePlan.bonusMultiplier || 1.0
        };

        const commission = Math.round(fareAmount * finalCommissionRate * 100) / 100;
        const baseEarning = Math.round((fareAmount - commission) * 100) / 100;
        const bonus = Math.round(baseEarning * (activePlan.bonusMultiplier - 1) * 100) / 100;
        planBonus = bonus;

        console.log(`📋 Plan applied: "${activePlan.planName}" | Commission: ${finalCommissionRate * 100}% | Bonus: x${activePlan.bonusMultiplier}`);
      }
    }

    // Use calculated commission rate with plan (not hardcoded 20%)
    const commission = Math.round(fareAmount * finalCommissionRate * 100) / 100;
    const baseEarning = Math.round((fareAmount - commission) * 100) / 100;
    const driverEarning = Math.round((baseEarning + planBonus) * 100) / 100;

    console.log(`   Fare: ₹${fareAmount} | Commission: ₹${commission} | Plan Bonus: ₹${planBonus} | Driver: ₹${driverEarning}`);

    // ── 3. Update wallet directly ────────────────────────────────────
    let wallet = await Wallet.findOne({ driverId }).session(session);
    if (!wallet) {
      wallet = new Wallet({
        driverId,
        availableBalance: 0,
        totalEarnings: 0,
        totalCommission: 0,
        pendingAmount: 0,
        transactions: []
      });
    }

    // Record ride earning with plan details (single comprehensive transaction)
    wallet.transactions.push({
      tripId,
      type: 'credit',
      amount: driverEarning,
      originalFare: fareAmount,
      commissionDeducted: commission,
      planBonus: planBonus,
      finalEarning: driverEarning,
      description: planApplied
        ? `Ride earnings: ₹${fareAmount} (Plan: ${appliedPlanDetails.planName})`
        : `Ride earnings: ₹${fareAmount}`,
      planApplied,
      planId: appliedPlanDetails?.planId,
      planName: appliedPlanDetails?.planName,
      planCommissionRate: finalCommissionRate,
      planBonusMultiplier: appliedPlanDetails?.bonusMultiplier || 1.0,
      paymentMethod: 'cash',
      status: 'completed',
      createdAt: new Date()
    });

    // Update totals
    wallet.totalEarnings    += driverEarning;
    wallet.totalCommission  += commission;
    if (planApplied && planBonus > 0) {
      wallet.totalPlanBonusEarned = (wallet.totalPlanBonusEarned || 0) + planBonus;
    }

    // Cash flow: driver physically has the cash, owes commission to platform
    // Commission is DEBT — add to pendingAmount directly
    wallet.pendingAmount = Math.round((wallet.pendingAmount + commission) * 100) / 100;

    // availableBalance tracks online earnings minus withdrawals (not cash)
    // Keep it unchanged for cash trips — pendingAmount is the debt tracker

    await wallet.save({ session });

    console.log(`   Wallet saved: earning=₹${driverEarning}, commission=₹${commission}, pending=₹${wallet.pendingAmount}`);

    // ── 4. Mark trip as payment collected ───────────────────────────
    trip.paymentCollected  = true;
    trip.paymentStatus     = 'completed';
    trip.paymentMethod     = 'cash';
    trip.paidAmount        = fareAmount;
    trip.paymentCompletedAt = new Date();
    await trip.save({ session });

    await session.commitTransaction();

    // ── 5. Emit socket to customer ───────────────────────────────────
    if (req.io) {
      const customerId = trip.customerId?.toString();
      if (customerId) {
        req.io.to(`customer_${customerId}`).emit('trip:cash_collected', {
          tripId,
          message: 'Driver confirmed cash received. Thank you!',
          timestamp: new Date().toISOString()
        });
      }
      req.io.to(`driver_${driverId}`).emit('payment:confirmed', {
        tripId,
        amount: fareAmount,
        driverAmount: driverEarning,
        commission,
        pendingAmount: wallet.pendingAmount,
        method: 'cash',
        timestamp: new Date().toISOString()
      });
    }

    console.log('✅ Cash collection complete');

    // ── 6. Award coins to customer + handle first-ride referral (non-critical) ─
    let coinReward = null;
    try {
      if (trip.customerId) {
        // Use the new rewardService for consistent coin logic
        const cashTripDistance = calculateDistanceFromCoords(
          trip.pickup.coordinates[1], trip.pickup.coordinates[0],
          trip.drop.coordinates[1], trip.drop.coordinates[0]
        );
        coinReward = await awardCoins(trip.customerId, tripId, 'ride_reward', {
          distanceKm: cashTripDistance,
          vehicleType: trip.vehicleType,
        });

        // Check if this is their first completed ride → trigger referral chain
        const completedCount = await Trip.countDocuments({
          customerId: trip.customerId,
          status: 'completed',
          paymentCollected: true,
        });
        if (completedCount === 1) {
          handleFirstRideReferral(trip.customerId, tripId).catch((e) =>
            console.warn('⚠️ handleFirstRideReferral failed:', e.message)
          );
        }
      }
    } catch (coinErr) {
      console.warn('⚠️ Coin award failed (non-critical):', coinErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Cash collected successfully',
      amount: fareAmount,
      fareBreakdown: {
        tripFare: fareAmount,
        commission,
        commissionPercentage: COMMISSION_RATE * 100,
        driverEarning
      },
      wallet: {
        totalEarnings:    wallet.totalEarnings,
        totalCommission:  wallet.totalCommission,
        pendingAmount:    wallet.pendingAmount,
        availableBalance: wallet.availableBalance
      },
      coinReward: coinReward?.awarded ? {
        coinsAwarded: coinReward.coinsAwarded,
        totalCoins: coinReward.totalCoins
      } : null
    });

  } catch (err) {
    await session.abortTransaction();
    console.error('🔥 confirmCashCollection error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to confirm cash collection' });
    }
  } finally {
    session.endSession();
  }
};

const completeTrip = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { tripId, userId } = req.body;

    await session.withTransaction(async () => {
      const trip = await Trip.findById(tripId).session(session);
      if (!trip) throw new Error('Trip not found');

      if (trip.assignedDriver?.toString() !== userId && trip.customerId?.toString() !== userId) {
        throw new Error('Not authorized');
      }

      assertTransition(trip.status, 'completed');

      trip.status = 'completed';
      trip.completedAt = new Date();
      trip.version += 1;
      await trip.save({ session });

      await User.findByIdAndUpdate(trip.assignedDriver, {
        $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: true }
      }, { session });

      await saveToRideHistory(trip, 'Completed', session);
    });

    session.endSession();
    res.status(200).json({ success: true, message: 'Trip completed' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('🔥 completeTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ========== CANCEL TRIP ==========

const cancelTrip = async (req, res) => {
  try {
    const { tripId, cancelledBy, reason } = req.body;
    if (!tripId || !cancelledBy) return res.status(400).json({ success: false, message: 'tripId and cancelledBy required' });

    const trip = await Trip.findById(tripId)
      .populate('customerId', 'phone name socketId')
      .populate('assignedDriver', 'name phone socketId');

    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.status === 'cancelled') return res.status(400).json({ success: false, message: 'Already cancelled' });
    if (trip.status === 'completed') return res.status(400).json({ success: false, message: 'Cannot cancel completed trip' });

    const isCustomer = trip.customerId?._id?.toString() === cancelledBy;
    const isDriver = trip.assignedDriver?._id?.toString() === cancelledBy;
    if (!isCustomer && !isDriver) return res.status(403).json({ success: false, message: 'Not authorized' });

    // Refund coins
    let coinsRefunded = 0;
    if (trip.coinsUsed && trip.coinsUsed > 0) {
      try {
        const CustomerModel = await getCustomerModel();
        await CustomerModel.findByIdAndUpdate(trip.customerId._id, { $inc: { coins: trip.coinsUsed } });
        coinsRefunded = trip.coinsUsed;
      } catch (e) { console.error('Coin refund failed:', e); }
    }

    assertTransition(trip.status, 'cancelled');
    trip.status = 'cancelled';
    trip.version += 1;
    trip.cancelledBy = cancelledBy;
    trip.cancelledAt = new Date();
    trip.cancellationReason = reason;
    await trip.save();

    await saveToRideHistory(trip, 'Cancelled');

    if (trip.assignedDriver) {
      await User.findByIdAndUpdate(trip.assignedDriver._id, { $set: { currentTripId: null, isBusy: false } });
    }

    if (trip.assignedDriver?.socketId && io) {
      io.to(trip.assignedDriver.socketId).emit('trip:cancelled', { tripId, cancelledBy: isCustomer ? 'customer' : 'driver' });
    }
    if (trip.customerId?.socketId && io) {
      io.to(trip.customerId.socketId).emit('trip:cancelled', { tripId, coinsRefunded });
    }

    // Notify all online drivers if no driver assigned
    if (!trip.assignedDriver && io) {
      const onlineDrivers = await User.find({
        isDriver: true,
        isOnline: true,
        socketId: { $exists: true, $ne: null }
      }).select('socketId').lean();

      console.log(`📡 [cancelTrip] Notifying ${onlineDrivers.length} drivers about cancellation`);

      onlineDrivers.forEach(driver => {
        io.to(driver.socketId).emit('trip:cancelled', {
          tripId: trip._id.toString(),
          cancelledBy: 'customer',
          reason: 'customer_cancelled_search'
        });
      });
    }

    res.status(200).json({ success: true, message: 'Trip cancelled', coinsRefunded });
  } catch (err) {
    console.error('🔥 cancelTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ========== QUERY FUNCTIONS ==========

const getTripById = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).populate('assignedDriver customerId');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    res.status(200).json({ success: true, trip });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getTripByIdWithPayment = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.tripId)
      .populate('assignedDriver', 'name phone')
      .populate('customerId', 'name phone')
      .lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    res.status(200).json({ success: true, trip });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getDriverActiveTrip = async (req, res) => {
  try {
    const { driverId } = req.params;

    const trip = await Trip.findOne({
      assignedDriver: driverId,
      $or: [
        { status: { $in: ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'] } },
        { status: 'completed', 'payment.collected': { $ne: true } }
      ]
    }).populate('customerId', 'name phone photoUrl rating').lean();

    if (!trip) {
      await User.findByIdAndUpdate(driverId, { $set: { isBusy: false, currentTripId: null } });
      return res.status(200).json({ success: true, hasActiveTrip: false, driverFreed: true });
    }

    let ridePhase = 'going_to_pickup';
    if (trip.status === 'ride_started') ridePhase = 'going_to_drop';
    else if (trip.status === 'driver_at_pickup') ridePhase = 'at_pickup';
    else if (trip.status === 'completed') ridePhase = 'completed';

    res.status(200).json({
      success: true, hasActiveTrip: true,
      trip: { tripId: trip._id.toString(), status: trip.status, ridePhase, fare: trip.fare, paymentCollected: trip.payment?.collected || false },
      customer: trip.customerId
    });
  } catch (err) {
    console.error('🔥 getDriverActiveTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const getActiveRide = async (req, res) => {
  try {
    const { customerId } = req.params;
    const trip = await Trip.findOne({
      customerId,
      status: { $in: ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'] }
    }).populate('assignedDriver', 'name phone photoUrl rating vehicleBrand vehicleNumber location').lean();

    if (!trip) return res.status(200).json({ success: true, hasActiveRide: false });

    res.status(200).json({
      success: true, hasActiveRide: true,
      trip: { tripId: trip._id.toString(), status: trip.status, fare: trip.fare },
      driver: trip.assignedDriver
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ========== DRIVER LOCATION BY TRIP ID ==========
// Flutter polls GET /api/trip/:tripId/driver-location as socket fallback

const getDriverLocationByTripId = async (req, res) => {
  try {
    const { tripId } = req.params;

    const trip = await Trip.findById(tripId)
      .select('assignedDriver customerId status')
      .lean();

    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (!trip.assignedDriver) {
      return res.status(200).json({ success: false, message: 'No driver assigned' });
    }

    const driver = await User.findById(trip.assignedDriver)
      .select('location lastBearing locationSequence lastLocationUpdate')
      .lean();

    if (!driver?.location?.coordinates) {
      return res.status(200).json({ success: false, message: 'Driver location unavailable' });
    }

    const [lng, lat] = driver.location.coordinates;

    return res.status(200).json({
      success: true,
      location: { lat, lng, latitude: lat, longitude: lng },
      driverLocation: {
        lat, lng, latitude: lat, longitude: lng,
        bearing: driver.lastBearing ?? null,
        heading: driver.lastBearing ?? null,
        sequence: driver.locationSequence ?? null,
        lastUpdate: driver.lastLocationUpdate ?? null
      },
      driverId: driver._id.toString(),
      tripId: tripId.toString()
    });
  } catch (err) {
    console.error('❌ getDriverLocationByTripId error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ========== SUPPORT ==========

export const requestTripSupport = async (req, res) => {
  try {
    const { tripId, reason } = req.body;
    if (!tripId) return res.status(400).json({ success: false, message: 'tripId required' });

    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { supportRequested: true, supportReason: reason || 'Help requested', supportRequestedAt: new Date() },
      { new: true }
    ).populate('customerId', 'name phone').populate('assignedDriver', 'name phone vehicleNumber');

    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });

    if (io) io.to('admin-room').emit('admin:support_request', { tripId: trip._id.toString(), reason: trip.supportReason, trip });

    res.json({ success: true, message: 'Support request sent' });
  } catch (err) {
    console.error('🔥 requestTripSupport error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ========== EXPORTS ==========

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
  getDriverLocationByTripId,   // ✅ NEW: Flutter polls /api/trip/:tripId/driver-location
};