// src/controllers/standbyController.js

import Standby from '../models/standby.js';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';
import { sendToDriver } from '../utils/fcmSender.js';

/**
 * ➕ Add standby drivers for a trip
 */
export const addToStandby = async (tripId, driverIds) => {
  try {
    await Standby.findOneAndUpdate(
      { tripId },
      { $set: { driverQueue: driverIds, currentIndex: 0 } },
      { upsert: true }
    );
    console.log(`📥 Standby queue created for trip ${tripId} with ${driverIds.length} drivers`);
  } catch (err) {
    console.error(`❌ Error in addToStandby:`, err.message);
  }
};

/**
 * 🔁 Promote next standby driver (called via cron or timeout)
 */
export const promoteNextStandby = async (tripId) => {
  try {
    console.log(`🔍 [DEBUG] promoteNextStandby called for trip: ${tripId}`);
    
    const standby = await Standby.findOne({ tripId });
    console.log(`🔍 [DEBUG] Standby record: ${standby ? JSON.stringify(standby) : 'Not found'}`);
    
    const trip = await Trip.findById(tripId);
    console.log(`🔍 [DEBUG] Trip record: ${trip ? 'Found' : 'Not found'}`);
    
    if (trip) {
      console.log(`🔍 [DEBUG] Trip status: ${trip.status}, Assigned driver: ${trip.assignedDriver || 'None'}`);
      console.log(`🔍 [DEBUG] Trip requested status: ${trip.status === 'requested' ? 'MATCHES' : 'DOES NOT MATCH'}`);
    }

    // 🚫 Safety checks with detailed logging
    if (!standby) {
      console.log(`⛔ No standby promotion: No standby record found for trip ${tripId}`);
      return;
    }
    
    if (!trip) {
      console.log(`⛔ No standby promotion: Trip ${tripId} not found`);
      return;
    }
    
    if (trip.status !== 'requested') {
      console.log(`⛔ No standby promotion: Trip status is '${trip.status}' but expected 'requested'`);
      return;
    }

    // 🚫 If already assigned, no need to promote
    if (trip.assignedDriver) {
      console.log(`🚫 Trip ${tripId} already assigned to driver ${trip.assignedDriver}`);
      return;
    }

    const nextDriverId = standby.driverQueue[standby.currentIndex];
    console.log(`🔍 [DEBUG] Next driver in queue: ${nextDriverId} (index: ${standby.currentIndex})`);
    
    if (!nextDriverId) {
      console.log(`⚠️ No more drivers in standby queue for trip ${tripId}`);
      return;
    }

    const driver = await User.findById(nextDriverId);
    console.log(`🔍 [DEBUG] Driver lookup: ${driver ? 'Found' : 'Not found'}`);
    
    if (!driver) {
      console.log(`❌ Driver not found: ${nextDriverId}`);
      return;
    }

    // 🚫 Avoid duplicate pending requests
    const isPending = trip.pendingDrivers?.includes(driver._id.toString());
    console.log(`🔍 [DEBUG] Driver pending status: ${isPending ? 'Already pending' : 'Not pending'}`);
    
    if (isPending) {
      console.log(`⚠️ Driver ${driver._id} already has a pending request for trip ${tripId}`);
      return;
    }

    const payload = {
      tripId: trip._id.toString(),
      pickup: trip.pickup || trip.pickupLocation,
      drop: trip.drop || trip.dropLocation,
      vehicleType: trip.vehicleType,
      type: trip.type,
    };

    console.log(`🔍 [DEBUG] Preparing to send request to driver ${driver._id}`);
    console.log(`🔍 [DEBUG] Driver socket: ${driver.socketId}, FCM token: ${driver.fcmToken ? 'Yes' : 'No'}`);

    // ✅ Send ride request to driver via socket or FCM
    if (driver.socketId) {
      io.to(driver.socketId).emit('trip:request', payload);
      console.log(`📡 Sent ride request to standby driver ${driver._id} via socket`);
    } else if (driver.fcmToken) {
      await sendToDriver(
        driver.fcmToken,
        'New Ride Request',
        'You have been promoted from standby queue.',
        payload
      );
      console.log(`📲 Sent ride request to standby driver ${driver._id} via FCM`);
    } else {
      console.log(`⚠️ Driver ${driver._id} has no socket or FCM token`);
    }

    // 📌 Mark driver as pending for this trip
    if (!trip.pendingDrivers) trip.pendingDrivers = [];
    trip.pendingDrivers.push(driver._id.toString());
    await trip.save();
    console.log(`✅ Added driver ${driver._id} to pending drivers list`);

    // ⏳ Increment index for next promotion
    standby.currentIndex += 1;
    await standby.save();

    console.log(`✅ Updated standby index to ${standby.currentIndex} for trip ${tripId}`);
    return driver._id; // Return the promoted driver ID for tracking
  } catch (err) {
    console.error(`❌ Error in promoteNextStandby:`, err.message);
    console.error(err.stack);
  }
};

/**
 * ♻️ Reassign trip to next standby driver if previous expired
 */
export const reassignStandbyDriver = async (trip) => {
  try {
    console.log(`🔁 Reassigning standby driver for trip: ${trip._id}`);
    const standby = await Standby.findOne({ tripId: trip._id });
    
    if (!standby) {
      console.log(`ℹ️ No standby found for trip ${trip._id}`);
      return;
    }

    await promoteNextStandby(trip._id);
  } catch (err) {
    console.error(`❌ Error in reassignStandbyDriver:`, err.message);
  }
};

/**
 * 🧹 Cleanup standby queue when trip is no longer active
 */
export const cleanupStandbyQueue = async (tripId) => {
  try {
    const result = await Standby.deleteOne({ tripId });
    if (result.deletedCount > 0) {
      console.log(`🧹 Cleaned standby queue for trip ${tripId}`);
    } else {
      console.log(`ℹ️ No standby queue to clean for trip ${tripId}`);
    }
  } catch (err) {
    console.error(`❌ Error cleaning standby queue:`, err.message);
  }
};

/**
 * 🔍 Get standby status for debugging
 */
export const getStandbyStatus = async (tripId) => {
  try {
    const standby = await Standby.findOne({ tripId });
    const trip = await Trip.findById(tripId);
    
    return {
      standby: standby ? {
        tripId: standby.tripId,
        driverQueue: standby.driverQueue,
        currentIndex: standby.currentIndex,
        queueLength: standby.driverQueue.length
      } : null,
      trip: trip ? {
        _id: trip._id,
        status: trip.status,
        assignedDriver: trip.assignedDriver,
        pendingDrivers: trip.pendingDrivers || []
      } : null
    };
  } catch (err) {
    console.error(`❌ Error getting standby status:`, err.message);
    return { error: err.message };
  }
};