// src/cron/standbyReassignCron.js

import Trip from '../models/Trip.js';
import { promoteNextStandby } from '../controllers/standbyController.js';
import ReassignmentLog from '../models/ReassignmentLog.js';

/**
 * Cron Job: Auto-promotes standby drivers for long trips
 * Runs every 2 minutes (called from server.js)
 */
const standbyReassignCron = async () => {
  try {
    const now = new Date();

    const trips = await Trip.find({
      trip: 'long',
      scheduledTime: { $lte: new Date(now.getTime() + 15 * 60 * 1000) },
      status: 'pending',
      mainDriverStatus: { $ne: 'confirmed' },
    });

    if (trips.length === 0) return; // 🔇 Skip logs if nothing to do

    console.log('🔄 Running Standby Reassignment Cron');

    for (const trip of trips) {
      try {
        console.log(`🟡 Checking standby for Trip ID: ${trip._id}`);
        const previousDriver = trip.driver;

        const newDriver = await promoteNextStandby(trip._id);

        if (newDriver && newDriver !== previousDriver) {
          await ReassignmentLog.create({
            tripId: trip._id,
            previousDriver,
            newDriver,
            reason: 'timeout',
          });

          console.log(`✅ Driver reassigned for Trip ${trip._id}`);
        } else {
          console.log(`🔕 No reassignment needed for Trip ${trip._id}`);
        }
      } catch (innerErr) {
        console.error(`❌ Error handling trip ${trip._id}:`, innerErr.message);
      }
    }

    console.log('✅ Standby reassignment check complete');
  } catch (err) {
    console.error('❌ Error in standbyReassignCron:', err.message);
  }
};
export default standbyReassignCron;
