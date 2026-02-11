// src/utils/notificationRetry.js
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';

/**
 * Retry failed notifications - runs every 30 seconds
 */
export const startNotificationRetryJob = () => {
  setInterval(async () => {
    try {
      // Find trips where customer wasn't notified
      const unnotifiedTrips = await Trip.find({
        status: 'driver_assigned',
        customerNotified: false,
        notificationRetries: { $lt: 3 }, // Max 3 retries
        lastNotificationAttempt: {
          $lt: new Date(Date.now() - 30000) // Last attempt was >30s ago
        }
      }).limit(10);

      if (unnotifiedTrips.length === 0) return;

      console.log(`🔄 Retrying notifications for ${unnotifiedTrips.length} trip(s)...`);

      for (const trip of unnotifiedTrips) {
        const customer = await User.findById(trip.customerId).select('socketId').lean();
        
        if (!customer?.socketId) {
          console.warn(`⚠️ Customer ${trip.customerId} has no socketId, skipping...`);
          continue;
        }

        const driver = await User.findById(trip.assignedDriver)
          .select('name phone photoUrl rating vehicleBrand vehicleNumber location')
          .lean();

        if (!driver) continue;

        const payload = {
          tripId: trip._id.toString(),
          rideCode: trip.otp,
          trip: {
            pickup: {
              lat: trip.pickup.coordinates[1],
              lng: trip.pickup.coordinates[0],
              address: trip.pickup.address || "Pickup Location",
            },
            drop: {
              lat: trip.drop.coordinates[1],
              lng: trip.drop.coordinates[0],
              address: trip.drop.address || "Drop Location",
            },
          },
          driver: {
            id: driver._id.toString(),
            name: driver.name || 'Driver',
            phone: driver.phone || null,
            photoUrl: driver.photoUrl || null,
            rating: driver.rating || 4.8,
            vehicleBrand: driver.vehicleBrand || 'Vehicle',
            vehicleNumber: driver.vehicleNumber || 'N/A',
            location: {
              lat: driver.location.coordinates[1],
              lng: driver.location.coordinates[0],
            },
          },
        };

        io.to(customer.socketId).emit('trip:accepted', payload);
        
        await Trip.findByIdAndUpdate(trip._id, {
          $inc: { notificationRetries: 1 },
          $set: { 
            lastNotificationAttempt: new Date(),
            customerNotified: true
          }
        });

        console.log(`🔄 Retry notification sent to customer ${trip.customerId} for trip ${trip._id}`);
      }
    } catch (e) {
      console.error('❌ Notification retry job error:', e);
    }
  }, 30000); // Every 30 seconds

  console.log('🔄 Notification retry job started (runs every 30 seconds)');
};