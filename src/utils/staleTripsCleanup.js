// utils/staleTripsCleanup.js

import User from '../models/User.js';
import Trip from '../models/Trip.js';

// ✅ Increased to 3 minutes - gives more buffer for background apps
const STALE_DRIVER_THRESHOLD_MS = 180000; // 3 minutes
const CLEANUP_INTERVAL_MS = 60000; // Run every 1 minute

export const startStaleTripCleanup = () => {
  console.log('🧹 Stale trip cleanup job started (threshold: 3 minutes)');

  setInterval(async () => {
    try {
      const now = new Date();
      const staleThreshold = new Date(now.getTime() - STALE_DRIVER_THRESHOLD_MS);

      // ✅ Only mark drivers offline if:
      // 1. No socket connection
      // 2. Last activity is older than 3 minutes
      // 3. NOT currently on an active trip
      const staleDrivers = await User.find({
        isDriver: true,
        isOnline: true,
        socketId: null, // Must have no active socket
        $and: [
          {
            $or: [
              { lastLocationUpdate: { $lt: staleThreshold } },
              { lastLocationUpdate: { $exists: false } }
            ]
          },
          {
            $or: [
              { lastHeartbeat: { $lt: staleThreshold } },
              { lastHeartbeat: { $exists: false } }
            ]
          }
        ]
      }).select('_id name currentTripId lastLocationUpdate lastHeartbeat fcmToken').lean();

      if (staleDrivers.length === 0) {
        // Don't log every time - too noisy
        return;
      }

      console.log(`🔍 Checking ${staleDrivers.length} potentially stale drivers`);

      for (const driver of staleDrivers) {
        // Double-check: Don't touch drivers with active trips
        if (driver.currentTripId) {
          const trip = await Trip.findById(driver.currentTripId)
            .select('status paymentCollected')
            .lean();

          if (trip) {
            const activeStatuses = ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'];
            if (activeStatuses.includes(trip.status)) {
              continue; // Skip - has active trip
            }
            if (trip.status === 'completed' && !trip.paymentCollected) {
              continue; // Skip - awaiting payment
            }
          }
        }

        // Re-fetch to prevent race condition
        const freshDriver = await User.findById(driver._id)
          .select('socketId isOnline lastHeartbeat')
          .lean();
          
        if (freshDriver?.socketId) {
          continue; // Just reconnected
        }

        // Check if there was very recent heartbeat (within last minute)
        if (freshDriver?.lastHeartbeat) {
          const heartbeatAge = Date.now() - new Date(freshDriver.lastHeartbeat).getTime();
          if (heartbeatAge < 60000) {
            continue; // Recent heartbeat, skip
          }
        }

        // Safe to mark offline
        await User.findByIdAndUpdate(driver._id, {
          $set: {
            isOnline: false,
            isBusy: false,
            canReceiveNewRequests: false,
            currentTripId: null
          }
        });

        console.log(`🔴 Driver ${driver.name || driver._id} marked offline (stale > 3 min)`);
      }
    } catch (error) {
      console.error('❌ Stale cleanup error:', error);
    }
  }, CLEANUP_INTERVAL_MS);
};