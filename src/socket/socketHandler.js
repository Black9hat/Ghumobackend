// sockets/socketHandler.js

import User from '../models/User.js';
import Trip from '../models/Trip.js';
import mongoose from 'mongoose';
import ChatMessageModel from '../models/ChatMessage.js';
import { startNotificationRetryJob } from '../utils/notificationRetry.js';
import { startStaleTripCleanup } from '../utils/staleTripsCleanup.js';
import { sendToDriver } from '../utils/fcmSender.js';
import { promoteNextStandby, reassignStandbyDriver } from '../controllers/standbyController.js';
import { broadcastToDrivers } from '../utils/tripBroadcaster.js';
import { initSupportSockets } from './supportSocketHandler.js';
import { stopTripRetry } from '../utils/tripRetryBroadcaster.js';

import {
  createShortTrip,
  createParcelTrip,
  createLongTrip,
} from '../controllers/tripController.js';
import { emitTripError } from '../utils/errorEmitter.js';

const TRIP_TIMEOUT_MS = 60000;

const ChatMessage = mongoose.models.ChatMessage || ChatMessageModel;

let io;

const connectedDrivers = new Map();
const connectedCustomers = new Map();

const DISTANCE_LIMITS = {
  short: 5000,
  parcel: 5000,
  long_same_day: 20000,
  long_multi_day: 50000,
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

async function awardIncentivesToDriver(driverId, tripId) {
  try {
    const db = mongoose.connection.db;
    const IncentiveSettings = db.collection('incentiveSettings');
    const settings = await IncentiveSettings.findOne({ type: 'global' });

    if (!settings || (settings.perRideIncentive === 0 && settings.perRideCoins === 0)) {
      return { success: true, awarded: false };
    }

    const driver = await User.findById(driverId)
      .select('totalCoinsCollected totalIncentiveEarned totalRidesCompleted wallet');

    if (!driver) {
      return { success: false, error: 'Driver not found' };
    }

    const newCoins = (driver.totalCoinsCollected || 0) + settings.perRideCoins;
    const newIncentive = (driver.totalIncentiveEarned || 0) + settings.perRideIncentive;
    const newRides = (driver.totalRidesCompleted || 0) + 1;
    const newWallet = (driver.wallet || 0) + settings.perRideIncentive;

    await User.findByIdAndUpdate(driverId, {
      $set: {
        totalCoinsCollected: newCoins,
        totalIncentiveEarned: newIncentive,
        totalRidesCompleted: newRides,
        wallet: newWallet,
        lastRideId: tripId,
        lastIncentiveAwardedAt: new Date()
      }
    });

    return { success: true, awarded: true };
  } catch (error) {
    console.error('❌ Error awarding incentives:', error);
    return { success: false, error: error.message };
  }
}

const normalizePhone = (phone) => {
  if (!phone) return null;
  return String(phone).replace(/[^0-9]/g, "");
};

const validateTripPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const { type, customerId, pickup, drop } = payload;
  if (!type || !customerId || !pickup || !drop) return false;
  if (!pickup.coordinates || !Array.isArray(pickup.coordinates) || pickup.coordinates.length !== 2) return false;
  if (!drop.coordinates || !Array.isArray(drop.coordinates) || drop.coordinates.length !== 2) return false;
  return true;
};

const resolveUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;

  try {
    if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
      const byId = await User.findById(idOrPhone);
      if (byId) return byId;
    }

    const byFirebaseUid = await User.findOne({ firebaseUid: idOrPhone });
    if (byFirebaseUid) return byFirebaseUid;

    const normalizedPhone = normalizePhone(idOrPhone);
    const byPhone = await User.findOne({ phone: normalizedPhone });
    if (byPhone) return byPhone;

    return null;
  } catch (err) {
    console.error('❌ resolveUserByIdOrPhone error:', err);
    return null;
  }
};

function toRad(value) {
  return value * Math.PI / 180;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getActiveTrip(driverId) {
  try {
    const driver = await User.findById(driverId)
      .select('currentTripId')
      .lean();

    if (!driver?.currentTripId) return null;

    const trip = await Trip.findById(driver.currentTripId).lean();
    if (!trip) return null;

    const activeStatuses = ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'];
    
    const isActive = activeStatuses.includes(trip.status) || 
      (trip.status === 'completed' && !trip.paymentCollected);

    if (!isActive) return null;

    const customer = await User.findById(trip.customerId)
      .select('name phone photoUrl rating')
      .lean();

    return {
      trip,
      customer
    };
  } catch (e) {
    console.error('❌ getActiveTrip error:', e);
    return null;
  }
}

async function sendActiveTripToDriver(socket, driverId) {
  try {
    const activeData = await getActiveTrip(driverId);
    
    if (!activeData) return false;

    const { trip, customer } = activeData;

    const payload = {
      tripId: trip._id.toString(),
      status: trip.status,
      rideStatus: trip.rideStatus,
      otp: trip.otp,
      trip: {
        pickup: {
          lat: trip.pickup.coordinates[1],
          lng: trip.pickup.coordinates[0],
          address: trip.pickup.address
        },
        drop: {
          lat: trip.drop.coordinates[1],
          lng: trip.drop.coordinates[0],
          address: trip.drop.address
        },
        fare: trip.fare,
        type: trip.type
      },
      customer: customer ? {
        id: customer._id.toString(),
        name: customer.name,
        phone: customer.phone,
        photoUrl: customer.photoUrl,
        rating: customer.rating
      } : null,
      paymentInfo: trip.status === 'completed' ? {
        fare: trip.finalFare || trip.fare,
        paymentCollected: trip.paymentCollected,
        awaitingCashCollection: !trip.paymentCollected
      } : null
    };

    socket.emit('active_trip:restore', payload);
    console.log(`📦 Sent active trip ${trip._id} to driver ${driverId} immediately`);
    
    return true;
  } catch (e) {
    console.error('❌ sendActiveTripToDriver error:', e);
    return false;
  }
}

// ============================================================================
// 📡 SESSION MANAGEMENT HELPER FUNCTIONS
// ============================================================================

/**
 * 📡 FORCE LOGOUT USER VIA SOCKET.IO
 * (Called by SessionManager when multi-device login detected)
 */
export const emitForceLogout = (io, phone, data) => {
  try {
    const roomName = `user:${phone}`;

    console.log(`📡 Emitting force_logout to room ${roomName}`);

    io.to(roomName).emit('force_logout', {
      reason: data.reason || 'multi_device_login',
      message: data.message || 'Your account has been logged in on another device',
      newDeviceId: data.newDeviceId,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  } catch (error) {
    console.error('❌ emitForceLogout error:', error);
    return { success: false, error: error.message };
  }
};

/**
 * 📡 EMIT TO SPECIFIC USER
 */
export const emitToUser = (io, phone, event, data) => {
  try {
    const roomName = `user:${phone}`;
    io.to(roomName).emit(event, data);
    return { success: true };
  } catch (error) {
    console.error(`❌ emitToUser error for ${phone}:`, error);
    return { success: false, error: error.message };
  }
};

// ============================================================================
// MAIN SOCKET INITIALIZATION
// ============================================================================

export const initSocket = (ioInstance) => {
  io = ioInstance;

  io.on('connection', async (socket) => {
    console.log(`🟢 New connection: ${socket.id}`);

    // Check for admin connection
    const isAdmin = socket.handshake.query?.role === 'admin' ||
      socket.handshake.auth?.role === 'admin';

    if (isAdmin) {
      console.log('👨‍💼 ADMIN CONNECTED:', socket.id);
      socket.join('admin-room');
      socket.emit('admin:connected', {
        success: true,
        message: 'Connected to admin room',
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });
    }

    // Check if this is a driver reconnecting with driverId in query
    const queryDriverId = socket.handshake.query?.driverId || socket.handshake.auth?.driverId;
    
    if (queryDriverId) {
      console.log(`🔄 Driver ${queryDriverId} connecting with ID in handshake`);
      
      const driver = await User.findById(queryDriverId).select('phone').lean();
      
      // Update driver's socket immediately
      await User.findByIdAndUpdate(queryDriverId, {
        $set: {
          socketId: socket.id,
          isOnline: true,
          lastConnectedAt: new Date(),
          lastHeartbeat: new Date()
        },
        $unset: { lastDisconnectedAt: "" }
      });
      
      connectedDrivers.set(socket.id, queryDriverId);
      
      // Join user room for session management
      if (driver?.phone) {
        socket.join(`user:${driver.phone}`);
        socket.data.phone = driver.phone;
      }
      
      // Send active trip IMMEDIATELY on connection
      const hasSentTrip = await sendActiveTripToDriver(socket, queryDriverId);
      
      if (hasSentTrip) {
        console.log(`✅ Driver ${queryDriverId} reconnected with active trip restored immediately`);
      }
    }

    // =========================================================================
    // 🔐 USER JOIN ROOM (for force_logout events) - NEW!
    // =========================================================================
    socket.on('user:join', async (data) => {
      try {
        const { phone } = data;
        
        if (!phone) {
          console.log('⚠️ user:join - no phone provided');
          return;
        }

        const roomName = `user:${phone}`;
        socket.join(roomName);
        socket.data.phone = phone;

        // Log room members for debugging
        const roomMembers = await io.in(roomName).allSockets();
        console.log(`✅ User joined room ${roomName} (socket: ${socket.id})`);
        console.log(`   Room ${roomName} now has ${roomMembers.size} member(s)`);

        // Acknowledge join
        socket.emit('user:joined', {
          success: true,
          room: roomName,
          socketId: socket.id,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error('❌ user:join error:', error);
      }
    });

    // =========================================================================
    // 🔐 USER LEAVE ROOM (for cleanup) - NEW!
    // =========================================================================
    socket.on('user:leave', async (data) => {
      try {
        const { phone } = data;
        
        if (!phone) return;

        const roomName = `user:${phone}`;
        socket.leave(roomName);
        
        console.log(`👋 User left room ${roomName} (socket: ${socket.id})`);
      } catch (error) {
        console.error('❌ user:leave error:', error);
      }
    });

    // =========================================================================
    // 📱 USER CONNECTION HANDLER (SESSION MANAGEMENT)
    // =========================================================================
    socket.on('user:connect', async (data) => {
      try {
        const { phone, customerId, role } = data;
        
        if (!phone) {
          console.log('⚠️ user:connect - no phone provided');
          socket.emit('error', { message: 'Phone number required' });
          return;
        }

        // Join room based on phone number (for multi-device detection)
        const roomName = `user:${phone}`;
        socket.join(roomName);

        // Also join by customer ID (for existing functionality)
        if (customerId) {
          socket.join(`customer:${customerId}`);
        }

        // Join role-specific room
        if (role === 'driver') {
          socket.join(`driver:${customerId}`);
        }

        console.log(`✅ User ${phone} joined room ${roomName}`);

        // Store phone in socket data for cleanup
        socket.data.phone = phone;
        socket.data.customerId = customerId;
        socket.data.role = role;

        // Emit connection success
        socket.emit('connection:success', {
          message: 'Connected to server',
          timestamp: new Date().toISOString(),
          socketId: socket.id,
        });
      } catch (error) {
        console.error('❌ user:connect error:', error);
        socket.emit('error', { message: 'Connection failed' });
      }
    });

    // =========================================================================
    // 📤 CLIENT LOGOUT REQUEST (SESSION MANAGEMENT)
    // =========================================================================
    socket.on('user:logout', async (data) => {
      try {
        const { phone, reason } = data;
        
        if (!phone) {
          console.log('⚠️ user:logout - no phone provided');
          return;
        }

        console.log(`👋 User ${phone} requesting logout, reason: ${reason || 'user_initiated'}`);

        // Import SessionManager dynamically
        const SessionManager = (await import('../services/SessionManager.js')).default;

        // Handle logout through SessionManager
        const result = await SessionManager.handleLogout(phone, reason || 'user_logout');

        if (result.success) {
          // Confirm logout to client
          socket.emit('logout:success', {
            message: 'Logged out successfully',
            timestamp: new Date().toISOString(),
          });

          // Leave all rooms
          const rooms = Array.from(socket.rooms);
          rooms.forEach((room) => {
            if (room !== socket.id) {
              socket.leave(room);
            }
          });
        } else {
          socket.emit('error', { message: result.error || 'Logout failed' });
        }
      } catch (error) {
        console.error('❌ user:logout error:', error);
        socket.emit('error', { message: 'Logout failed' });
      }
    });

    // =========================================================================
    // SAVE FCM TOKEN VIA SOCKET
    // =========================================================================
    socket.on('driver:save_fcm_token', async ({ driverId, fcmToken }) => {
      try {
        if (!driverId || !fcmToken) {
          console.log('⚠️ Missing driverId or fcmToken');
          socket.emit('fcm_token:error', { success: false, message: 'Missing data' });
          return;
        }

        console.log(`📱 Saving FCM token via socket for: ${driverId}`);
        console.log(`   Token: ${fcmToken.substring(0, 30)}...`);

        await User.findByIdAndUpdate(driverId, {
          $set: { 
            fcmToken: fcmToken,
            fcmTokenUpdatedAt: new Date()
          }
        });

        console.log(`✅ FCM token saved for driver ${driverId}`);
        socket.emit('fcm_token:saved', { success: true });

      } catch (error) {
        console.error('❌ driver:save_fcm_token error:', error);
        socket.emit('fcm_token:error', { success: false, message: error.message });
      }
    });

    // Admin join event
    socket.on('admin:join', () => {
      socket.join('admin-room');
      socket.emit('admin:joined', {
        success: true,
        room: 'admin-room',
        socketId: socket.id
      });
    });

    // Admin test event
    socket.on('admin:test', (data) => {
      socket.emit('admin:test_response', {
        success: true,
        message: 'Test received',
        yourSocketId: socket.id,
        timestamp: new Date().toISOString(),
        rooms: Array.from(socket.rooms)
      });
    });

    // =========================================================================
    // DRIVER STATUS UPDATE
    // =========================================================================
    socket.on('updateDriverStatus', async (payload = {}) => {
      try {
        const {
          driverId,
          isOnline,
          location,
          lat,
          lng,
          fcmToken,
          profileData,
          vehicleType,
        } = payload;

        if (!driverId) return;

        const user = await resolveUserByIdOrPhone(driverId);
        if (!user) {
          console.warn(`updateDriverStatus: user not found for ${driverId}`);
          return;
        }

        const userIdStr = user._id.toString();

        const set = {
          socketId: socket.id,
          isOnline: !!isOnline,
          lastConnectedAt: new Date(),
          lastHeartbeat: new Date(),
          lastLocationUpdate: new Date(),
        };

        if (location?.coordinates?.length === 2) {
          set.location = { type: 'Point', coordinates: location.coordinates };
        } else if (
          typeof lat === 'number' &&
          typeof lng === 'number' &&
          !Number.isNaN(lat) &&
          !Number.isNaN(lng)
        ) {
          set.location = { type: 'Point', coordinates: [lng, lat] };
        }

        if (fcmToken) set.fcmToken = fcmToken;

        const allowedProfileKeys = [
          'name', 'photoUrl', 'rating', 'vehicleBrand', 'vehicleNumber', 'vehicleType',
        ];

        if (profileData && typeof profileData === 'object') {
          for (const key of allowedProfileKeys) {
            if (profileData[key] !== undefined && profileData[key] !== null) {
              set[key] = key === 'vehicleType'
                ? String(profileData[key]).toLowerCase().trim()
                : profileData[key];
            }
          }
        }

        if (vehicleType) {
          set.vehicleType = String(vehicleType).toLowerCase().trim();
        }

        await User.findByIdAndUpdate(user._id, { 
          $set: set,
          $unset: { lastDisconnectedAt: "" }
        }, { new: true });

        // Clean up old socket entries
        for (const [existingSocketId, existingDriverId] of connectedDrivers.entries()) {
          if (existingDriverId === userIdStr && existingSocketId !== socket.id) {
            connectedDrivers.delete(existingSocketId);
          }
        }

        connectedDrivers.set(socket.id, userIdStr);

        // Join user room for session management
        if (user.phone) {
          socket.join(`user:${user.phone}`);
          socket.data.phone = user.phone;
        }

        // Send active trip immediately after status update
        if (isOnline) {
          await sendActiveTripToDriver(socket, userIdStr);
        }

        socket.emit('driver:statusUpdated', { 
          ok: true, 
          isOnline: !!isOnline,
          socketId: socket.id,
          driverId: userIdStr
        });

        console.log(`📶 Driver ${userIdStr} is now ${isOnline ? 'ONLINE ✅' : 'OFFLINE 🔴'}`);
      } catch (e) {
        emitTripError({ socket, message: 'Failed to update driver status.' });
        console.error('❌ updateDriverStatus error:', e);
      }
    });

    // =========================================================================
    // DRIVER RECONNECT WITH ACTIVE TRIP
    // =========================================================================
    socket.on('driver:reconnect_with_trip', async ({ driverId, tripId }) => {
      try {
        console.log('🔄 DRIVER RECONNECT REQUEST', driverId, tripId);

        const driver = await User.findById(driverId).lean();
        if (!driver) {
          socket.emit('reconnect:failed', { message: 'Driver not found' });
          return;
        }

        // Update socket immediately
        await User.findByIdAndUpdate(driverId, { 
          $set: { 
            socketId: socket.id,
            isOnline: true,
            lastConnectedAt: new Date(),
            lastHeartbeat: new Date()
          },
          $unset: { lastDisconnectedAt: "" }
        });

        connectedDrivers.set(socket.id, driverId.toString());

        // Join user room for session management
        if (driver.phone) {
          socket.join(`user:${driver.phone}`);
          socket.data.phone = driver.phone;
        }

        // If tripId provided, verify and send
        if (tripId) {
          const trip = await Trip.findById(tripId).lean();
          if (!trip) {
            socket.emit('reconnect:failed', { message: 'Trip not found', shouldClearTrip: true });
            return;
          }

          const activeStatuses = ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'];
          const isActive = activeStatuses.includes(trip.status) || 
            (trip.status === 'completed' && !trip.paymentCollected);

          if (!isActive) {
            socket.emit('reconnect:failed', { 
              message: `Trip is ${trip.status}`, 
              shouldClearTrip: true, 
              tripStatus: trip.status 
            });
            return;
          }

          const customer = await User.findById(trip.customerId)
            .select('name phone photoUrl rating')
            .lean();

          socket.emit('reconnect:success', {
            tripId: trip._id.toString(),
            status: trip.status,
            rideStatus: trip.rideStatus,
            otp: trip.otp,
            trip: {
              pickup: {
                lat: trip.pickup.coordinates[1],
                lng: trip.pickup.coordinates[0],
                address: trip.pickup.address
              },
              drop: {
                lat: trip.drop.coordinates[1],
                lng: trip.drop.coordinates[0],
                address: trip.drop.address
              },
              fare: trip.fare
            },
            customer: customer ? {
              id: customer._id.toString(),
              name: customer.name,
              phone: customer.phone,
              photoUrl: customer.photoUrl,
              rating: customer.rating
            } : null,
            paymentInfo: trip.status === 'completed' ? {
              fare: trip.finalFare || trip.fare,
              paymentCollected: trip.paymentCollected,
              awaitingCashCollection: !trip.paymentCollected
            } : null
          });

          console.log(`✅ Driver ${driverId} reconnected with trip ${tripId}`);
        } else {
          // No tripId provided - check if driver has active trip
          await sendActiveTripToDriver(socket, driverId);
          socket.emit('reconnect:success', { message: 'Reconnected successfully' });
        }
      } catch (e) {
        console.error('❌ driver:reconnect_with_trip error:', e);
        socket.emit('reconnect:failed', { message: 'Reconnection failed', error: e.message });
      }
    });

    // =========================================================================
    // REQUEST ACTIVE TRIP (for app restart scenarios)
    // =========================================================================
    socket.on('driver:request_active_trip', async ({ driverId }) => {
      try {
        if (!driverId) {
          socket.emit('active_trip:none', { message: 'No driverId provided' });
          return;
        }

        console.log(`📱 Driver ${driverId} requesting active trip data`);

        const sent = await sendActiveTripToDriver(socket, driverId);
        
        if (!sent) {
          socket.emit('active_trip:none', { message: 'No active trip found' });
        }
      } catch (e) {
        console.error('❌ driver:request_active_trip error:', e);
        socket.emit('active_trip:error', { message: e.message });
      }
    });

    // =========================================================================
    // CUSTOMER REGISTER
    // =========================================================================
    socket.on('customer:register', async ({ customerId }) => {
      try {
        if (!customerId) {
          socket.emit('customer:registered', { success: false, error: 'customerId missing' });
          return;
        }

        const user = await resolveUserByIdOrPhone(customerId);
        if (!user) {
          socket.emit('customer:registered', {
            success: false,
            error: 'User not found in database',
            providedId: customerId
          });
          return;
        }

        for (const [existingSocketId, existingCustomerId] of connectedCustomers.entries()) {
          if (existingCustomerId === user._id.toString()) {
            connectedCustomers.delete(existingSocketId);
          }
        }

        await User.findByIdAndUpdate(user._id, { $set: { socketId: socket.id } }, { new: true });

        connectedCustomers.set(socket.id, user._id.toString());

        // Join user room for session management
        if (user.phone) {
          socket.join(`user:${user.phone}`);
          socket.data.phone = user.phone;
        }

        socket.emit('customer:registered', {
          success: true,
          customerId: user._id.toString(),
          mongoId: user._id.toString(),
          socketId: socket.id,
          phone: user.phone,
          name: user.name,
          firebaseUid: user.firebaseUid
        });
      } catch (e) {
        console.error('❌ customer:register error:', e);
        socket.emit('customer:registered', { success: false, error: e.message });
      }
    });

    // =========================================================================
    // CUSTOMER REQUEST TRIP
    // =========================================================================
    socket.on('customer:request_trip', async (payload) => {
      try {
        if (!validateTripPayload(payload)) {
          emitTripError({ socket, message: 'Invalid trip request payload.' });
          return;
        }

        const user = await resolveUserByIdOrPhone(payload.customerId);
        if (!user) {
          emitTripError({ socket, message: 'Customer not found in database.' });
          return;
        }

        payload.customerId = user._id.toString();

        const { type } = payload;
        let controllerFn;
        if (type === 'short') controllerFn = createShortTrip;
        else if (type === 'parcel') controllerFn = createParcelTrip;
        else if (type === 'long') controllerFn = createLongTrip;
        else {
          emitTripError({ socket, message: 'Unknown trip type.' });
          return;
        }

        const req = { body: payload };
        const res = {
          status: (code) => ({
            json: (data) => {
              socket.emit('trip:request_response', { ...data, status: code });
              if (data.success && data.tripId) {
                console.log(`🛣️ Trip request (${type}) created. TripId: ${data.tripId}`);
                if (data.drivers === 0) {
                  emitTripError({ socket, tripId: data.tripId, message: 'No drivers available.' });
                }
              } else if (!data.success) {
                emitTripError({ socket, message: data.message });
              }
            },
          }),
        };

        await controllerFn(req, res);
      } catch (e) {
        emitTripError({ socket, message: 'Internal server error.' });
        console.error('❌ customer:request_trip error:', e);
      }
    });

    // =========================================================================
    // DRIVER ACCEPT TRIP
    // =========================================================================
    socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
      try {
        console.log('');
        console.log('='.repeat(60));
        console.log(`🚗 Driver ${driverId} accepting trip ${tripId}`);
        console.log('='.repeat(60));

        if (!driverId || !tripId) {
          socket.emit('trip:accept_failed', {
            message: 'Missing driverId or tripId',
            reason: 'invalid_request'
          });
          return;
        }

        const existingTrip = await Trip.findById(tripId)
          .select('version status cancelledAt cancelledBy')
          .lean();

        if (!existingTrip) {
          socket.emit('trip:accept_failed', {
            message: 'Trip not found',
            reason: 'trip_not_found'
          });
          return;
        }

        if (existingTrip.status !== 'requested') {
          socket.emit('trip:accept_failed', {
            message: `Trip is already ${existingTrip.status}`,
            reason: 'trip_unavailable'
          });
          return;
        }

        if (existingTrip.cancelledAt || existingTrip.cancelledBy) {
          socket.emit('trip:accept_failed', {
            message: 'Trip was cancelled by customer',
            reason: 'trip_cancelled'
          });
          return;
        }

        const currentVersion = existingTrip.version || 1;

        // Atomic reserve driver
        const driver = await User.findOneAndUpdate(
          {
            _id: driverId,
            $or: [
              { isBusy: { $ne: true } },
              { isBusy: { $exists: false } }
            ],
            $or: [
              { currentTripId: null },
              { currentTripId: { $exists: false } }
            ]
          },
          {
            $set: {
              isBusy: true,
              currentTripId: tripId,
              canReceiveNewRequests: false,
              lastTripAcceptedAt: new Date()
            }
          },
          {
            new: true,
            select: 'name phone photoUrl rating vehicleBrand vehicleNumber location'
          }
        ).lean();

        if (!driver) {
          socket.emit('trip:accept_failed', {
            message: 'You are already on another trip',
            reason: 'driver_busy'
          });
          return;
        }

        // Atomic reserve trip with version lock
        const trip = await Trip.findOneAndUpdate(
          {
            _id: tripId,
            status: 'requested',
            version: currentVersion,
            $or: [
              { cancelledAt: { $exists: false } },
              { cancelledAt: null }
            ]
          },
          {
            $set: {
              assignedDriver: driverId,
              status: 'driver_assigned',
              acceptedAt: new Date()
            },
            $inc: { version: 1 }
          },
          { new: true }
        ).lean();

        if (!trip) {
          // Rollback driver
          await User.findByIdAndUpdate(driverId, {
            $set: {
              isBusy: false,
              currentTripId: null,
              canReceiveNewRequests: true
            }
          });

          const checkTrip = await Trip.findById(tripId).lean();
          let failReason = 'trip_unavailable';
          let failMessage = 'Trip no longer available';

          if (checkTrip) {
            if (checkTrip.cancelledAt || checkTrip.cancelledBy) {
              failReason = 'trip_cancelled';
              failMessage = 'Trip was cancelled by customer';
            } else if (checkTrip.status === 'driver_assigned') {
              failReason = 'trip_taken';
              failMessage = 'Trip was accepted by another driver';
            }
          }

          socket.emit('trip:accept_failed', { message: failMessage, reason: failReason });
          return;
        }

        console.log(`✅ Trip ${tripId} assigned to driver ${driverId}`);
        stopTripRetry(tripId);

        const customer = await User.findById(trip.customerId)
          .select('name phone photoUrl rating socketId')
          .lean();

        if (!customer) {
          // Rollback
          await User.findByIdAndUpdate(driverId, {
            $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: true }
          });
          await Trip.findByIdAndUpdate(tripId, {
            $unset: { assignedDriver: 1 },
            $set: { status: 'requested', acceptedAt: null },
            $inc: { version: 1 }
          });
          socket.emit('trip:accept_failed', { message: 'Customer not found', reason: 'customer_missing' });
          return;
        }

        const { generateOTP } = await import('../utils/otpGeneration.js');
        const rideCode = generateOTP();

        await Trip.findByIdAndUpdate(tripId, { $set: { otp: rideCode } });

        let customerSocketId = customer.socketId;
        if (!customerSocketId) {
          const customerIdStr = trip.customerId.toString();
          for (const [socketId, custId] of connectedCustomers.entries()) {
            if (custId === customerIdStr) {
              customerSocketId = socketId;
              break;
            }
          }
        }

        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:accepted', {
            tripId: tripId.toString(),
            rideCode,
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
              fare: trip.fare || 0
            },
            driver: {
              id: driver._id.toString(),
              name: driver.name || 'Driver',
              phone: driver.phone || null,
              photoUrl: driver.photoUrl || null,
              rating: driver.rating || 4.8,
              vehicleBrand: driver.vehicleBrand || 'Vehicle',
              vehicleNumber: driver.vehicleNumber || 'N/A',
              location: driver.location ? {
                lat: driver.location.coordinates[1],
                lng: driver.location.coordinates[0],
              } : null,
            },
          });
        }

        socket.emit('trip:confirmed_for_driver', {
          tripId: tripId.toString(),
          rideCode,
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
            fare: trip.fare || 0
          },
          customer: {
            id: customer._id.toString(),
            name: customer.name || 'Customer',
            phone: customer.phone || null,
            photoUrl: customer.photoUrl || null,
            rating: customer.rating || 5.0,
          }
        });

        // Notify other drivers
        const otherDrivers = await User.find({
          isDriver: true,
          isOnline: true,
          _id: { $ne: driverId },
          socketId: { $exists: true, $ne: null }
        }).select('socketId').lean();

        otherDrivers.forEach(otherDriver => {
          if (otherDriver.socketId) {
            io.to(otherDriver.socketId).emit('trip:taken', {
              tripId,
              message: 'This trip has been accepted by another driver'
            });
          }
        });

        console.log(`✅ SUCCESS: Trip accepted by ${driver.name}`);
        console.log('='.repeat(60));

      } catch (e) {
        console.error('❌ driver:accept_trip error:', e);

        try {
          if (driverId) {
            await User.findByIdAndUpdate(driverId, {
              $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: true }
            });
          }
          if (tripId) {
            await Trip.findByIdAndUpdate(tripId, {
              $unset: { assignedDriver: 1, otp: 1 },
              $set: { status: 'requested', acceptedAt: null }
            });
          }
        } catch (rollbackError) {
          console.error('❌ Rollback failed:', rollbackError);
        }

        socket.emit('trip:accept_failed', {
          message: 'Failed to accept trip. Please try again.',
          reason: 'server_error'
        });
      }
    });

    // =========================================================================
    // CUSTOMER CANCEL SEARCH
    // =========================================================================
    socket.on('customer:cancel_search', async ({ tripId, customerId, reason }) => {
      try {
        if (!tripId || !customerId) {
          socket.emit('cancel:failed', { success: false, message: 'tripId and customerId required' });
          return;
        }

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
            socket.emit('cancel:failed', { success: false, message: 'Trip not found' });
            return;
          }

          if (existingTrip.status === 'driver_assigned') {
            socket.emit('cancel:failed', {
              success: false,
              message: 'Driver already accepted. Use cancel ride instead.',
              status: existingTrip.status
            });
            return;
          }

          if (existingTrip.status === 'cancelled') {
            socket.emit('cancel:success', { success: true, message: 'Already cancelled', alreadyCancelled: true });
            return;
          }

          socket.emit('cancel:failed', { success: false, message: 'Cannot cancel at this stage', status: existingTrip.status });
          return;
        }

        stopTripRetry(tripId);

        const onlineDrivers = await User.find({
          isDriver: true,
          isOnline: true,
          socketId: { $exists: true, $ne: null }
        }).select('socketId').lean();

        onlineDrivers.forEach(driver => {
          if (driver.socketId) {
            io.to(driver.socketId).emit('trip:cancelled', {
              tripId,
              reason: 'customer_cancelled_search',
              message: 'Customer cancelled the search'
            });
          }
        });

        socket.emit('cancel:success', { success: true, message: 'Search cancelled successfully', tripId });
        console.log(`🛑 Trip ${tripId} cancelled by customer`);

      } catch (e) {
        console.error('❌ customer:cancel_search error:', e);
        socket.emit('cancel:failed', { success: false, message: 'Failed to cancel: ' + e.message });
      }
    });

    // =========================================================================
    // DRIVER START RIDE
    // =========================================================================
    socket.on('driver:start_ride', async ({ tripId, driverId, otp }) => {
      try {
        const trip = await Trip.findById(tripId);
        if (!trip) {
          socket.emit('trip:start_error', { message: 'Trip not found' });
          return;
        }

        if (trip.otp !== otp) {
          socket.emit('trip:start_error', { message: 'Invalid OTP. Please check the code.' });
          return;
        }

        if (trip.status !== 'driver_assigned' && trip.status !== 'driver_at_pickup') {
          socket.emit('trip:start_error', { message: `Cannot start ride. Status is: ${trip.status}` });
          return;
        }

        await Trip.findByIdAndUpdate(tripId, { 
          $set: { status: 'ride_started', rideStartTime: new Date() },
          $inc: { version: 1 }
        });

        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }

        const rideStartedPayload = {
          tripId: tripId.toString(),
          message: 'Ride has started',
          timestamp: new Date().toISOString()
        };

        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:ride_started', rideStartedPayload);
        }

        socket.emit('trip:ride_started', { 
          tripId: tripId.toString(), 
          message: 'Ride started successfully', 
          timestamp: new Date().toISOString() 
        });

        console.log(`🚀 Ride ${tripId} started`);
      } catch (e) {
        console.error('❌ driver:start_ride error:', e);
        socket.emit('trip:start_error', { message: 'Failed to start ride: ' + e.message });
      }
    });

    // =========================================================================
    // DRIVER COMPLETE RIDE
    // =========================================================================
    socket.on('driver:complete_ride', async ({ tripId, driverId }) => {
      try {
        const trip = await Trip.findById(tripId);
        if (!trip) {
          socket.emit('trip:complete_error', { message: 'Trip not found' });
          return;
        }

        if (trip.status !== 'ride_started') {
          socket.emit('trip:complete_error', { message: 'Ride has not started yet' });
          return;
        }

        const fare = trip.fare || trip.estimatedFare || 100;

        await Trip.findByIdAndUpdate(tripId, {
          $set: {
            status: 'completed',
            rideStatus: 'completed',
            rideEndTime: new Date(),
            completedAt: new Date(),
            finalFare: fare,
            paymentCollected: false
          },
          $inc: { version: 1 }
        });

        await User.findByIdAndUpdate(driverId, {
          $set: {
            currentTripId: tripId,
            isBusy: true,
            canReceiveNewRequests: false,
            awaitingCashCollection: true,
            lastTripCompletedAt: new Date()
          }
        });

        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }

        const rideCompletedPayload = {
          tripId: tripId.toString(),
          fare,
          originalFare: trip.originalFare || null,
          discountApplied: trip.discountApplied || 0,
          coinsUsed: trip.coinsUsed || 0,
          message: 'Ride completed',
          timestamp: new Date().toISOString(),
          awaitingPayment: true
        };

        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:completed', rideCompletedPayload);
        }

        socket.emit('trip:completed', {
          ...rideCompletedPayload,
          message: 'Ride completed. Please collect ₹' + fare.toFixed(2) + ' from customer.',
          awaitingCashCollection: true
        });

        console.log(`✅ Ride ${tripId} completed`);
      } catch (e) {
        console.error('❌ driver:complete_ride error:', e);
        socket.emit('trip:complete_error', { message: 'Failed to complete ride: ' + e.message });
      }
    });

    // =========================================================================
    // DRIVER GOING TO PICKUP
    // =========================================================================
    socket.on('driver:going_to_pickup', async ({ tripId, driverId }) => {
      try {
        await Trip.findByIdAndUpdate(tripId, { 
          $set: { status: 'driver_going_to_pickup' },
          $inc: { version: 1 }
        });

        const trip = await Trip.findById(tripId).lean();
        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }
        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:driver_going_to_pickup', { 
            tripId: tripId.toString(), 
            message: 'Driver is on the way to pickup' 
          });
        }
        socket.emit('trip:status_updated', { success: true });
      } catch (e) {
        console.error('❌ driver:going_to_pickup error:', e);
      }
    });

    // =========================================================================
    // DRIVER ARRIVED AT PICKUP
    // =========================================================================
    socket.on('trip:arrived_at_pickup', async ({ tripId, driverId }) => {
      try {
        await Trip.findByIdAndUpdate(tripId, { 
          $set: { status: 'driver_at_pickup' },
          $inc: { version: 1 }
        });

        const trip = await Trip.findById(tripId).lean();
        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }
        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:driver_arrived', { 
            tripId: tripId.toString(), 
            message: 'Driver has arrived at pickup location' 
          });
        }
        socket.emit('trip:status_updated', { success: true });
      } catch (e) {
        console.error('❌ trip:arrived_at_pickup error:', e);
      }
    });

    // =========================================================================
    // DRIVER LOCATION UPDATE
    // =========================================================================
    socket.on('driver:location', async ({ tripId, driverId, latitude, longitude, sequence, timestamp, bearing, heading, speed }) => {
      try {
        // ✅ Accept 0 as valid coordinate (fix: !latitude was blocking equator coords)
        if (!tripId || !driverId || latitude == null || longitude == null) return;

        // ── Step 1: Calculate bearing from previous position if not provided ──
        let calculatedBearing = bearing ?? heading ?? null;

        if (calculatedBearing == null) {
          // Get previous location from DB to calculate direction of travel
          const prevDriver = await User.findById(driverId)
            .select('location lastBearing')
            .lean();

          if (prevDriver?.location?.coordinates) {
            const [prevLng, prevLat] = prevDriver.location.coordinates;
            const distMoved = Math.sqrt(
              Math.pow(latitude - prevLat, 2) + Math.pow(longitude - prevLng, 2)
            );
            // Only calculate bearing if driver actually moved (avoid noise)
            if (distMoved > 0.0001) {
              const dLon = (longitude - prevLng) * Math.PI / 180;
              const lat1 = prevLat * Math.PI / 180;
              const lat2 = latitude * Math.PI / 180;
              const y = Math.sin(dLon) * Math.cos(lat2);
              const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
              calculatedBearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
            } else {
              calculatedBearing = prevDriver.lastBearing ?? null;
            }
          }
        }

        // ── Step 2: Save location + bearing to DB ────────────────────────────
        const updateSet = {
          location: { type: 'Point', coordinates: [longitude, latitude] },
          lastLocationUpdate: new Date(),
          lastHeartbeat: new Date()
        };
        if (typeof sequence === 'number') updateSet.locationSequence = sequence;
        if (calculatedBearing !== null) updateSet.lastBearing = calculatedBearing;

        await User.findByIdAndUpdate(driverId, { $set: updateSet });

        // ── Step 3: Get trip and calculate distance ──────────────────────────
        const trip = await Trip.findById(tripId).select('customerId drop status').lean();
        if (!trip) return;

        const dropLat = trip.drop.coordinates[1];
        const dropLng = trip.drop.coordinates[0];
        const distanceKm = calculateDistance(latitude, longitude, dropLat, dropLng);
        const distanceInMeters = distanceKm * 1000;

        if (distanceInMeters <= 500 && trip.status === 'ride_started') {
          await User.findByIdAndUpdate(driverId, { $set: { canReceiveNewRequests: true } });
        }

        // ── Step 4: Find customer socket — Map first, DB fallback ────────────
        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;

        // Try in-memory map first (fast path)
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }

        // 🔥 CRITICAL FIX: Fall back to DB socketId if map is stale
        // This happens when customer reconnects — map doesn't always update
        if (!customerSocketId) {
          const customerDoc = await User.findById(trip.customerId).select('socketId').lean();
          if (customerDoc?.socketId) {
            customerSocketId = customerDoc.socketId;
            console.log(`📡 Using DB socketId for customer ${customerIdStr}: ${customerSocketId}`);
          }
        }

        // ── Step 5: Emit to customer ─────────────────────────────────────────
        if (customerSocketId) {
          io.to(customerSocketId).emit('driver:locationUpdate', {
            tripId: tripId.toString(),
            driverId,
            latitude,
            longitude,
            bearing: calculatedBearing,         // 🚀 Flutter needs this for smooth rotation
            heading: calculatedBearing,          // alias for compatibility
            speed: speed ?? null,
            distanceToDestination: Math.round(distanceInMeters),
            sequence: sequence ?? Date.now(),    // Always send a sequence number
            timestamp: timestamp ?? new Date().toISOString()
          });
          console.log(`📡 Location → customer | lat:${latitude.toFixed(5)} lng:${longitude.toFixed(5)} bearing:${calculatedBearing?.toFixed(0) ?? 'N/A'}°`);
        } else {
          console.warn(`⚠️ No customer socket for trip ${tripId} (customer: ${customerIdStr})`);
        }
      } catch (e) {
        console.error('❌ driver:location error:', e);
      }
    });

    // =========================================================================
    // CUSTOMER LOCATION UPDATE
    // =========================================================================
    socket.on('customer:location', async ({ tripId, customerId, latitude, longitude, sequence, timestamp }) => {
      try {
        if (!tripId || !customerId || !latitude || !longitude) return;

        await User.findByIdAndUpdate(customerId, {
          $set: {
            location: { type: 'Point', coordinates: [longitude, latitude] },
            lastLocationUpdate: new Date()
          }
        });

        const trip = await Trip.findById(tripId).lean();
        if (trip && trip.assignedDriver) {
          const driver = await User.findById(trip.assignedDriver).select('socketId').lean();
          if (driver?.socketId) {
            io.to(driver.socketId).emit('customer:locationUpdate', {
              tripId: tripId.toString(),
              customerId,
              latitude,
              longitude,
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (e) {
        console.error('❌ customer:location error:', e);
      }
    });

    // =========================================================================
    // DRIVER HEARTBEAT - Critical for background mode
    // =========================================================================
    socket.on('driver:heartbeat', async ({ tripId, driverId, timestamp, location }) => {
      try {
        if (!driverId) return;

        const updateData = {
          $set: { 
            lastHeartbeat: new Date(),
            lastLocationUpdate: new Date(),
            socketId: socket.id,
            isOnline: true
          }
        };

        if (location && location.lat && location.lng) {
          updateData.$set.location = {
            type: 'Point',
            coordinates: [location.lng, location.lat]
          };
        }

        await User.findByIdAndUpdate(driverId, updateData);

        if (tripId) {
          await Trip.findByIdAndUpdate(tripId, { 
            $set: { lastDriverHeartbeat: new Date() } 
          });
        }

        socket.emit('heartbeat:ack', { 
          timestamp: Date.now(),
          socketId: socket.id 
        });
      } catch (e) {
        console.error('❌ driver:heartbeat error:', e);
      }
    });

    // =========================================================================
    // CHAT HANDLERS
    // =========================================================================
    socket.on('chat:join', (data) => {
      try {
        const { tripId, userId } = data;
        if (!tripId) return;
        socket.join(`chat_${tripId}`);
        socket.to(`chat_${tripId}`).emit('chat:user_joined', { userId, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ chat:join error:', error);
      }
    });

    socket.on('chat:leave', (data) => {
      try {
        const { tripId, userId } = data;
        if (!tripId) return;
        socket.leave(`chat_${tripId}`);
        socket.to(`chat_${tripId}`).emit('chat:user_left', { userId, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ chat:leave error:', error);
      }
    });

    socket.on('chat:send_message', async (data) => {
      try {
        const { tripId, fromId, toId, message, timestamp } = data;
        if (!tripId || !fromId || !toId || !message) {
          socket.emit('chat:error', { error: 'Missing required fields' });
          return;
        }

        try {
          const chatMessage = new ChatMessage({
            tripId, senderId: fromId, receiverId: toId, message,
            timestamp: timestamp ? new Date(timestamp) : new Date()
          });
          await chatMessage.save();
        } catch (dbError) {
          console.warn('⚠️ Failed to save chat message:', dbError);
        }

        const messageData = {
          tripId, fromId, toId, senderId: fromId, receiverId: toId, message,
          timestamp: timestamp || new Date().toISOString()
        };

        socket.to(`chat_${tripId}`).emit('chat:receive_message', messageData);
        socket.emit('chat:message_sent', { success: true, timestamp: messageData.timestamp });

        let recipientSocketId = null;
        for (const [socketId, userId] of connectedCustomers.entries()) {
          if (userId === toId) { recipientSocketId = socketId; break; }
        }
        if (!recipientSocketId) {
          for (const [socketId, userId] of connectedDrivers.entries()) {
            if (userId === toId) { recipientSocketId = socketId; break; }
          }
        }
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('chat:receive_message', messageData);
        }
      } catch (error) {
        console.error('❌ chat:send_message error:', error);
        socket.emit('chat:error', { error: 'Failed to send message' });
      }
    });

    socket.on('chat:typing', (data) => {
      try {
        const { tripId, userId, isTyping } = data;
        if (!tripId) return;
        socket.to(`chat_${tripId}`).emit('chat:typing_status', { userId, isTyping, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ chat:typing error:', error);
      }
    });

    socket.on('chat:mark_read', async (data) => {
      try {
        const { tripId, userId } = data;
        if (!tripId || !userId) return;
        await ChatMessage.updateMany({ tripId, receiverId: userId, read: false }, { $set: { read: true } });
        socket.to(`chat_${tripId}`).emit('chat:messages_read', { userId, tripId, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ chat:mark_read error:', error);
      }
    });

    socket.on('chat:get_unread', async (data) => {
      try {
        const { userId } = data;
        if (!userId) return;
        const unreadCount = await ChatMessage.countDocuments({ receiverId: userId, read: false });
        socket.emit('chat:unread_count', { userId, count: unreadCount, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ chat:get_unread error:', error);
      }
    });

    // =========================================================================
    // DRIVER GO OFFLINE (Explicit - Only way to go offline)
    // =========================================================================
    socket.on('driver:go_offline', async ({ driverId }) => {
      try {
        const driver = await User.findById(driverId).select('currentTripId isBusy name').lean();
        if (!driver) return;
        
        if (driver.currentTripId || driver.isBusy) {
          socket.emit('driver:offline_blocked', { 
            success: false, 
            message: 'Cannot go offline during active trip', 
            currentTripId: driver.currentTripId 
          });
          return;
        }

        await User.findByIdAndUpdate(driverId, { 
          $set: { isOnline: false, socketId: null, canReceiveNewRequests: false } 
        });
        
        connectedDrivers.delete(socket.id);
        console.log(`🔴 Driver ${driverId} went offline (explicit request)`);
        
        socket.emit('driver:offline_success', { success: true });
        socket.disconnect(true);
      } catch (e) {
        console.error('❌ driver:go_offline error:', e);
      }
    });

    // =========================================================================
    // TRIP RETRY REQUEST
    // =========================================================================
    socket.on('trip:rerequest', async ({ tripId, customerId, vehicleType, retryAttempt }) => {
      try {
        if (!tripId) return;

        const trip = await Trip.findById(tripId).lean();
        if (!trip || trip.status !== 'requested' || trip.cancelledAt) {
          socket.emit('trip:rerequest_failed', { message: 'Trip no longer available', shouldCancelSearch: true });
          return;
        }

        const nearbyDrivers = await User.find({
          isDriver: true,
          vehicleType: vehicleType,
          isOnline: true,
          isBusy: { $ne: true },
          $or: [
            { currentTripId: null },
            { currentTripId: { $exists: false } }
          ],
          location: {
            $near: {
              $geometry: { type: 'Point', coordinates: trip.pickup.coordinates },
              $maxDistance: DISTANCE_LIMITS.short || 5000,
            },
          },
        })
          .select('name phone vehicleType location isOnline socketId fcmToken')
          .lean();

        if (nearbyDrivers.length === 0) return;

        const payload = {
          tripId: trip._id.toString(),
          type: trip.type,
          vehicleType: vehicleType,
          customerId: customerId,
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
          fare: trip.fare || 0,
          retryAttempt: retryAttempt,
          isRetry: true
        };

        broadcastToDrivers(nearbyDrivers, payload);
        console.log(`🔄 Retry #${retryAttempt}: Sent to ${nearbyDrivers.length} drivers`);

      } catch (e) {
        console.error('❌ trip:rerequest error:', e);
      }
    });

    // =========================================================================
    // ✅ DISCONNECT HANDLER - UPDATED FOR SESSION MANAGEMENT
    // =========================================================================
    socket.on('disconnect', async () => {
      try {
        const driverId = connectedDrivers.get(socket.id);
        const customerId = connectedCustomers.get(socket.id);

        if (driverId) {
          console.log(`⚠️ Driver ${driverId} socket disconnected - STAYING ONLINE`);

          // Only clear socketId - Driver STAYS ONLINE
          await User.findByIdAndUpdate(driverId, {
            $set: {
              socketId: null,
              lastDisconnectedAt: new Date()
            }
          });

          connectedDrivers.delete(socket.id);
          
          console.log(`✅ Driver ${driverId} socket cleared - REMAINS ONLINE for FCM requests`);
        }

        if (customerId) {
          connectedCustomers.delete(socket.id);
          await User.findByIdAndUpdate(customerId, {
            $set: { socketId: null, lastDisconnectedAt: new Date() }
          });
        }

        // Note: We don't automatically logout on disconnect
        // User might just lose connection temporarily
        // Session remains active until explicit logout or new login on another device
      } catch (e) {
        console.error('❌ disconnect cleanup error:', e);
      }
    });

    // Add support socket handlers
    initSupportSockets(io, socket);

  }); // END OF io.on('connection')

  // =========================================================================
  // AUTO-CLEANUP EXPIRED TRIPS
  // =========================================================================
  setInterval(async () => {
    try {
      const now = new Date();
      const expiredTrips = await Trip.find({
        status: 'requested',
        createdAt: { $lt: new Date(now.getTime() - TRIP_TIMEOUT_MS) }
      });

      if (!expiredTrips.length) return;

      for (const trip of expiredTrips) {
        await Trip.findByIdAndUpdate(trip._id, {
          $set: {
            status: 'timeout',
            timeoutAt: new Date(),
            timeoutReason: 'No driver accepted within 60 seconds'
          },
          $inc: { version: 1 }
        });

        stopTripRetry(trip._id.toString());

        const customer = await User.findById(trip.customerId).select('socketId').lean();
        if (customer?.socketId) {
          io.to(customer.socketId).emit('trip:timeout', {
            tripId: trip._id.toString(),
            message: 'No drivers available right now. Please try again.',
            reason: 'timeout'
          });
        }

        const onlineDrivers = await User.find({
          isDriver: true,
          isOnline: true,
          socketId: { $exists: true, $ne: null }
        }).select('socketId').lean();

        onlineDrivers.forEach(driver => {
          if (driver.socketId) {
            io.to(driver.socketId).emit('trip:expired', {
              tripId: trip._id.toString(),
              message: 'This request has expired'
            });
          }
        });
      }
    } catch (e) {
      console.error('❌ Cleanup job error:', e);
    }
  }, 10000);

  console.log('⏰ Trip cleanup job started');
  startNotificationRetryJob();
  startStaleTripCleanup();
  console.log('🚀 Socket.IO initialized with session management');

};

export { io, connectedDrivers, connectedCustomers };
