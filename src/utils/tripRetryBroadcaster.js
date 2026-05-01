// src/utils/tripRetryBroadcaster.js

import Trip from "../models/Trip.js";
import User from "../models/User.js";
import { broadcastToDrivers } from "./tripBroadcaster.js";

const activeRetryLoops = new Map();

const RETRY_INTERVAL_MS = 30000; // 30 seconds

/**
 * ✅ Start retry loop (uses hybrid Socket + FCM)
 */
export const startTripRetry = (tripId) => {
  if (activeRetryLoops.has(tripId)) {
    console.log(`⚠️ Retry already running for ${tripId}`);
    return;
  }

  console.log(`🔄 Scheduling one retry for trip ${tripId} in ${RETRY_INTERVAL_MS}ms`);

  const timeout = setTimeout(async () => {
    try {
      if (!activeRetryLoops.has(tripId)) {
        return;
      }

      const retryCount = 1;

      const trip = await Trip.findById(tripId).lean();
      
      if (!trip) {
        console.log(`🛑 Trip ${tripId} not found`);
        stopTripRetry(tripId);
        return;
      }

      if (trip.status !== "requested") {
        console.log(`🛑 Trip ${tripId} status: ${trip.status}`);
        stopTripRetry(tripId);
        return;
      }

      if (trip.cancelledAt || trip.cancelledBy) {
        console.log(`🛑 Trip ${tripId} cancelled`);
        stopTripRetry(tripId);
        return;
      }

      console.log(`\n🔁 RETRY #${retryCount} for trip ${tripId}`);

      // ✅ Find ALL online drivers (with socket OR fcm token)
      const drivers = await User.find({
        isDriver: true,
        isOnline: true,
        isBusy: { $ne: true },
        vehicleType: trip.vehicleType,
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
              coordinates: trip.pickup.coordinates
            },
            $maxDistance: 5000
          }
        }
      }).select("_id name socketId fcmToken vehicleType location").lean();

      if (!drivers.length) {
        console.log(`⚠️ Retry #${retryCount}: No drivers available`);
        return;
      }

      const payload = {
        tripId: trip._id.toString(),
        type: trip.type || 'short',
        vehicleType: trip.vehicleType,
        customerId: trip.customerId?.toString() || '',
        fare: trip.fare || 0,
        pickup: {
          lat: trip.pickup.coordinates[1],
          lng: trip.pickup.coordinates[0],
          address: trip.pickup.address || 'Pickup',
        },
        drop: {
          lat: trip.drop.coordinates[1],
          lng: trip.drop.coordinates[0],
          address: trip.drop.address || 'Drop',
        },
        isDestinationMatch: false,
        isRetry: true,
        retryCount: retryCount,
      };

      // ✅ Uses hybrid broadcast (Socket + FCM)
      await broadcastToDrivers(drivers, payload);

    } catch (err) {
      console.error("🔥 Retry error:", err.message);
    } finally {
      stopTripRetry(tripId);
    }
  }, RETRY_INTERVAL_MS);

  activeRetryLoops.set(tripId, timeout);
};

export const stopTripRetry = (tripId) => {
  const timeout = activeRetryLoops.get(tripId);
  if (timeout) {
    clearTimeout(timeout);
    activeRetryLoops.delete(tripId);
    console.log(`🛑 Stopped retry for trip ${tripId}`);
  }
};

export const isRetryActive = (tripId) => activeRetryLoops.has(tripId);

export default { startTripRetry, stopTripRetry, isRetryActive };