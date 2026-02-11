// src/jobs/driverCleanup.js

import User from '../models/User.js';
import Trip from '../models/Trip.js';

export const cleanupStuckDrivers = async () => {
  try {
    console.log('🔍 Running driver availability cleanup...');
    
    const stuckDrivers = await User.find({
      isDriver: true,
      isBusy: true,
      $or: [
        { currentTripId: null },
        { currentTripId: { $exists: false } }
      ]
    });
    
    if (stuckDrivers.length > 0) {
      console.log(`⚠️ Found ${stuckDrivers.length} drivers stuck in busy state`);
      
      for (const driver of stuckDrivers) {
        const activeTrip = await Trip.findOne({
          assignedDriver: driver._id,
          status: { $in: ['driver_assigned', 'ride_started'] }
        });
        
        if (!activeTrip) {
          await User.findByIdAndUpdate(driver._id, {
            $set: {
              isBusy: false,
              currentTripId: null,
              canReceiveNewRequests: false
            }
          });
          console.log(`✅ Reset stuck driver: ${driver.name} (${driver._id})`);
        } else {
          console.log(`⏭️ Skipping ${driver.name} - has active trip ${activeTrip._id}`);
        }
      }
    } else {
      console.log('✅ All drivers have correct availability status');
    }
    
  } catch (error) {
    console.error('❌ Cleanup job error:', error);
  }
};