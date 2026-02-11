// src/utils/tripBroadcaster.js

import { io } from '../socket/socketHandler.js';
import { sendToDriver } from './fcmSender.js';

/**
 * ✅ PRODUCTION: Hybrid Socket + FCM Broadcasting
 * - Socket: For real-time when app is open (instant delivery)
 * - FCM: For background/killed app (data-only, high priority)
 * 
 * 🔥 CRITICAL: FCM payload must be FLAT (no nested objects)
 *    All FCM data values must be STRINGS
 */

/**
 * Broadcast trip request to multiple drivers
 * @param {Array} drivers - Array of driver objects with socketId and/or fcmToken
 * @param {Object} tripPayload - Trip data to send
 * @returns {Object} - Result summary
 */
const broadcastToDrivers = async (drivers, tripPayload) => {
  console.log('');
  console.log('═'.repeat(70));
  console.log('📡 BROADCASTING TRIP TO DRIVERS (PRODUCTION MODE)');
  console.log('═'.repeat(70));
  console.log(`📦 Trip ID: ${tripPayload.tripId}`);
  console.log(`   Type: ${tripPayload.type || 'short'}`);
  console.log(`   Vehicle: ${tripPayload.vehicleType}`);
  console.log(`   Fare: ₹${tripPayload.fare}`);
  console.log(`   Payment: ${tripPayload.paymentMethod || 'cash'}`);
  console.log(`   Pickup: ${tripPayload.pickup?.address || 'N/A'}`);
  console.log(`   Drop: ${tripPayload.drop?.address || 'N/A'}`);
  console.log(`   Drivers: ${drivers?.length || 0}`);
  console.log('═'.repeat(70));

  // Validate drivers array
  if (!drivers || !Array.isArray(drivers) || drivers.length === 0) {
    console.warn(`⚠️ No drivers to broadcast`);
    return { 
      success: false, 
      count: 0, 
      socket: 0, 
      fcm: 0, 
      failed: 0,
      message: 'No drivers available'
    };
  }

  let socketSent = 0;
  let fcmSent = 0;
  let failed = 0;
  const deliveryResults = [];

  // ═══════════════════════════════════════════════════════════════
  // ✅ SOCKET PAYLOAD: Can use nested objects, numbers, booleans
  // ═══════════════════════════════════════════════════════════════
  const socketPayload = {
    tripId: String(tripPayload.tripId || ''),
    type: String(tripPayload.type || 'short'),
    vehicleType: String(tripPayload.vehicleType || 'bike'),
    customerId: String(tripPayload.customerId || ''),
    customerName: String(tripPayload.customerName || 'Customer'),
    customerPhone: String(tripPayload.customerPhone || ''),
    fare: Number(tripPayload.fare ?? 0),
    distance: Number(tripPayload.distance ?? 0),
    duration: Number(tripPayload.duration ?? 0),
    paymentMethod: String(tripPayload.paymentMethod ?? 'cash'),
    isRetry: Boolean(tripPayload.isRetry || false),
    isDestinationMatch: Boolean(tripPayload.isDestinationMatch || false),
    isScheduled: Boolean(tripPayload.isScheduled || false),
    scheduledTime: tripPayload.scheduledTime || null,
    
    // ✅ Nested objects OK for Socket.IO
    pickup: {
      lat: Number(tripPayload.pickup?.lat || 0),
      lng: Number(tripPayload.pickup?.lng || 0),
      address: String(tripPayload.pickup?.address || 'Pickup Location'),
    },
    drop: {
      lat: Number(tripPayload.drop?.lat || 0),
      lng: Number(tripPayload.drop?.lng || 0),
      address: String(tripPayload.drop?.address || 'Drop Location'),
    },
    
    timestamp: new Date().toISOString(),
  };

  // ═══════════════════════════════════════════════════════════════
  // 🔥 FCM PAYLOAD: MUST be FLAT, ALL values MUST be STRINGS
  // ═══════════════════════════════════════════════════════════════
  const fcmPayload = {
    // Core trip data
    tripId: String(tripPayload.tripId || ''),
    type: String(tripPayload.type || 'short'),
    notificationType: 'TRIP_REQUEST',
    vehicleType: String(tripPayload.vehicleType || 'bike'),
    customerId: String(tripPayload.customerId || ''),
    customerName: String(tripPayload.customerName || 'Customer'),
    customerPhone: String(tripPayload.customerPhone || ''),
    
    // All numbers converted to strings for FCM
    fare: String(tripPayload.fare ?? 0),
    distance: String(tripPayload.distance ?? 0),
    duration: String(tripPayload.duration ?? 0),
    
    // All booleans converted to strings for FCM
    paymentMethod: String(tripPayload.paymentMethod ?? 'cash'),
    isRetry: String(tripPayload.isRetry ?? false),
    isDestinationMatch: String(tripPayload.isDestinationMatch ?? false),
    isScheduled: String(tripPayload.isScheduled ?? false),
    scheduledTime: String(tripPayload.scheduledTime || ''),
    
    // 🔥 CRITICAL: FLAT pickup structure (no nesting!)
    pickupLat: String(tripPayload.pickup?.lat || 0),
    pickupLng: String(tripPayload.pickup?.lng || 0),
    pickupAddress: String(tripPayload.pickup?.address || 'Pickup Location'),
    
    // 🔥 CRITICAL: FLAT drop structure (no nesting!)
    dropLat: String(tripPayload.drop?.lat || 0),
    dropLng: String(tripPayload.drop?.lng || 0),
    dropAddress: String(tripPayload.drop?.address || 'Drop Location'),
    
    timestamp: new Date().toISOString(),
  };

  // Add optional parcel details (stringified for FCM)
  if (tripPayload.parcelDetails) {
    socketPayload.parcelDetails = tripPayload.parcelDetails;
    fcmPayload.parcelDetails = JSON.stringify(tripPayload.parcelDetails);
  }

  // Add stops if any
  if (tripPayload.stops && Array.isArray(tripPayload.stops)) {
    socketPayload.stops = tripPayload.stops;
    fcmPayload.stops = JSON.stringify(tripPayload.stops);
    fcmPayload.hasStops = 'true';
    fcmPayload.stopsCount = String(tripPayload.stops.length);
  }

  // ═══════════════════════════════════════════════════════════════
  // 📡 BROADCAST TO EACH DRIVER
  // ═══════════════════════════════════════════════════════════════
  for (const driver of drivers) {
    const driverName = driver.name || 'Unknown Driver';
    const driverId = driver._id?.toString() || driver.id?.toString() || 'unknown';
    const shortId = driverId.substring(0, 8);
    const socketId = driver.socketId;
    const fcmToken = driver.fcmToken;

    console.log(`\n👤 Driver: ${driverName} (${shortId}...)`);
    console.log(`   Socket ID: ${socketId || 'Not connected'}`);
    console.log(`   FCM Token: ${fcmToken ? fcmToken.substring(0, 20) + '...' : 'Not available'}`);

    let delivered = false;
    let deliveryMethod = null;

    // ═══════════════════════════════════════════════════════════════
    // ✅ PRIORITY 1: Socket.IO (if driver is connected - instant)
    // ═══════════════════════════════════════════════════════════════
    if (socketId && io) {
      try {
        // Send to specific socket
        io.to(socketId).emit('trip:request', socketPayload);
        
        // Also emit legacy event for backward compatibility
        io.to(socketId).emit('tripRequest', socketPayload);
        io.to(socketId).emit('new-trip-request', socketPayload);
        
        console.log(`   ✅ SOCKET: Delivered instantly via ${socketId}`);
        socketSent++;
        delivered = true;
        deliveryMethod = 'socket';
      } catch (socketError) {
        console.log(`   ❌ SOCKET ERROR: ${socketError.message}`);
      }
    } else {
      console.log(`   ⚪ SOCKET: Driver not connected`);
    }

    // ═══════════════════════════════════════════════════════════════
    // ✅ PRIORITY 2: FCM (for background/killed app)
    // Send FCM even if socket succeeded (as backup)
    // ═══════════════════════════════════════════════════════════════
    if (fcmToken) {
      try {
        const fcmResult = await sendToDriver(fcmToken, fcmPayload);
        
        if (fcmResult.success) {
          console.log(`   ✅ FCM: Sent successfully (${fcmResult.messageId})`);
          if (!delivered) {
            fcmSent++;
            delivered = true;
            deliveryMethod = 'fcm';
          } else {
            // FCM sent as backup
            console.log(`   📲 FCM: Also sent as backup`);
          }
        } else {
          console.log(`   ❌ FCM FAILED: ${fcmResult.error || 'Unknown error'}`);
          if (fcmResult.tokenRemoved) {
            console.log(`   🗑️ FCM: Invalid token removed from database`);
          }
        }
      } catch (fcmError) {
        console.log(`   ❌ FCM ERROR: ${fcmError.message}`);
      }
    } else {
      console.log(`   ⚪ FCM: No token available`);
    }

    // ═══════════════════════════════════════════════════════════════
    // Track unreachable drivers
    // ═══════════════════════════════════════════════════════════════
    if (!delivered) {
      console.log(`   ⚠️ UNREACHABLE: No socket connection or FCM token`);
      failed++;
    }

    deliveryResults.push({
      driverId,
      driverName,
      delivered,
      method: deliveryMethod,
      hasSocket: !!socketId,
      hasFcm: !!fcmToken,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 📊 SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log('');
  console.log('═'.repeat(70));
  console.log('📊 BROADCAST SUMMARY');
  console.log('═'.repeat(70));
  console.log(`   📦 Trip ID: ${tripPayload.tripId}`);
  console.log(`   👥 Total Drivers: ${drivers.length}`);
  console.log(`   ✅ Socket Delivered: ${socketSent}`);
  console.log(`   ✅ FCM Delivered: ${fcmSent}`);
  console.log(`   ❌ Unreachable: ${failed}`);
  console.log(`   📈 Success Rate: ${((socketSent + fcmSent) / drivers.length * 100).toFixed(1)}%`);
  console.log('═'.repeat(70));
  console.log('');

  return {
    success: socketSent > 0 || fcmSent > 0,
    count: socketSent + fcmSent,
    total: drivers.length,
    socket: socketSent,
    fcm: fcmSent,
    failed: failed,
    results: deliveryResults,
  };
};

/**
 * Broadcast trip update to specific driver
 * @param {Object} driver - Driver object with socketId and/or fcmToken
 * @param {String} eventType - Event type (e.g., 'trip:accepted', 'trip:started')
 * @param {Object} payload - Data to send
 */
const broadcastToDriver = async (driver, eventType, payload) => {
  if (!driver) {
    console.warn('⚠️ No driver provided for broadcast');
    return { success: false, error: 'No driver' };
  }

  const driverId = driver._id?.toString() || driver.id?.toString();
  console.log(`\n📡 Broadcasting ${eventType} to driver ${driverId}`);

  let delivered = false;

  // Socket delivery
  if (driver.socketId && io) {
    try {
      io.to(driver.socketId).emit(eventType, payload);
      console.log(`   ✅ Socket delivered`);
      delivered = true;
    } catch (err) {
      console.log(`   ❌ Socket error: ${err.message}`);
    }
  }

  // FCM delivery (flatten payload for FCM)
  if (driver.fcmToken) {
    try {
      const flatPayload = flattenForFCM(payload, eventType);
      const result = await sendToDriver(driver.fcmToken, flatPayload);
      if (result.success) {
        console.log(`   ✅ FCM delivered`);
        delivered = true;
      }
    } catch (err) {
      console.log(`   ❌ FCM error: ${err.message}`);
    }
  }

  return { success: delivered };
};

/**
 * Broadcast trip cancellation to driver
 */
const broadcastTripCancellation = async (driver, tripId, reason, cancelledBy) => {
  const payload = {
    tripId: String(tripId),
    notificationType: 'TRIP_CANCELLED',
    reason: String(reason || 'Trip was cancelled'),
    cancelledBy: String(cancelledBy || 'customer'),
    timestamp: new Date().toISOString(),
  };

  return broadcastToDriver(driver, 'trip:cancelled', payload);
};

/**
 * Flatten nested object for FCM (all values must be strings)
 */
const flattenForFCM = (obj, notificationType = 'UPDATE') => {
  const flat = {
    notificationType: String(notificationType),
    timestamp: new Date().toISOString(),
  };

  const flatten = (data, prefix = '') => {
    for (const key in data) {
      if (data.hasOwnProperty(key)) {
        const value = data[key];
        const newKey = prefix ? `${prefix}${key.charAt(0).toUpperCase() + key.slice(1)}` : key;

        if (value === null || value === undefined) {
          flat[newKey] = '';
        } else if (typeof value === 'object' && !Array.isArray(value)) {
          flatten(value, newKey);
        } else if (Array.isArray(value)) {
          flat[newKey] = JSON.stringify(value);
        } else {
          flat[newKey] = String(value);
        }
      }
    }
  };

  flatten(obj);
  return flat;
};

export { 
  broadcastToDrivers, 
  broadcastToDriver, 
  broadcastTripCancellation,
  flattenForFCM 
};

export default broadcastToDrivers;