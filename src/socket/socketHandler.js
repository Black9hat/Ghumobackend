// src/socket/socketHandler.js
// ✅ PRODUCTION — customerIdStr bug fixed, accept trip unified, complete ride fixed,
//                 trip retry updates retryCount, no duplicate payment paths

import User from '../models/User.js';
import Trip from '../models/Trip.js';
import Wallet from '../models/Wallet.js';
import mongoose from 'mongoose';
import ChatMessageModel from '../models/ChatMessage.js';
import { startNotificationRetryJob } from '../utils/notificationRetry.js';
import { startStaleTripCleanup } from '../utils/staleTripsCleanup.js';
// sendToDriver: kept for future direct FCM socket events
// Currently FCM handled by notificationRetry job + confirmCashCollection controller
import { sendToDriver } from '../utils/fcmSender.js';
import { broadcastToDrivers } from '../utils/tripBroadcaster.js';
import { initSupportSockets } from './supportSocketHandler.js';
import { stopTripRetry } from '../utils/tripRetryBroadcaster.js';
import { generateOTP } from '../utils/otpGeneration.js';

// Import controller functions so socket handlers use same logic as HTTP routes
// This prevents duplicate code paths that can diverge
import {
  confirmCashCollection as httpConfirmCashCollection,
} from '../controllers/tripController.js';

const TRIP_TIMEOUT_MS = 60000;
const ChatMessage = mongoose.models.ChatMessage || ChatMessageModel;

let io;

const connectedDrivers   = new Map(); // socketId → driverId
const connectedCustomers = new Map(); // socketId → customerId

const DISTANCE_LIMITS = {
  short:         5000,
  parcel:        5000,
  long_same_day: 20000,
  long_multi_day: 50000,
};

// ══════════════════════════════════════════════════════════
// UTILITY HELPERS
// ══════════════════════════════════════════════════════════

function toRad(v) { return v * Math.PI / 180; }

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const normalizePhone = (phone) => phone ? String(phone).replace(/[^0-9]/g, '') : null;

const validateTripPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const { type, customerId, pickup, drop } = payload;
  if (!type || !customerId || !pickup || !drop) return false;
  if (!Array.isArray(pickup.coordinates) || pickup.coordinates.length !== 2) return false;
  if (!Array.isArray(drop.coordinates)   || drop.coordinates.length   !== 2) return false;
  return true;
};

const resolveUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;
  try {
    if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
      const byId = await User.findById(idOrPhone);
      if (byId) return byId;
    }
    const byFirebase = await User.findOne({ firebaseUid: idOrPhone });
    if (byFirebase) return byFirebase;
    return await User.findOne({ phone: normalizePhone(idOrPhone) });
  } catch (err) {
    console.error('❌ resolveUserByIdOrPhone error:', err);
    return null;
  }
};

async function getActiveTrip(driverId) {
  try {
    const driver = await User.findById(driverId).select('currentTripId').lean();
    if (!driver?.currentTripId) return null;

    const trip = await Trip.findById(driver.currentTripId).lean();
    if (!trip) return null;

    const activeStatuses = ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'];
    const isActive = activeStatuses.includes(trip.status) ||
      (trip.status === 'completed' && !trip.paymentCollected);
    if (!isActive) return null;

    const customer = await User.findById(trip.customerId)
      .select('name phone photoUrl rating').lean();

    return { trip, customer };
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
    socket.emit('active_trip:restore', {
      tripId:     trip._id.toString(),
      status:     trip.status,
      otp:        trip.otp,
      trip: {
        pickup: { lat: trip.pickup.coordinates[1], lng: trip.pickup.coordinates[0], address: trip.pickup.address },
        drop:   { lat: trip.drop.coordinates[1],   lng: trip.drop.coordinates[0],   address: trip.drop.address },
        fare:   trip.fare,
        type:   trip.type,
      },
      customer: customer
        ? { id: customer._id.toString(), name: customer.name, phone: customer.phone, photoUrl: customer.photoUrl, rating: customer.rating }
        : null,
      paymentInfo: trip.status === 'completed'
        ? { fare: trip.finalFare || trip.fare, paymentCollected: trip.paymentCollected, awaitingCashCollection: !trip.paymentCollected }
        : null,
    });
    console.log(`📦 Active trip ${trip._id} sent to driver ${driverId}`);
    return true;
  } catch (e) {
    console.error('❌ sendActiveTripToDriver error:', e);
    return false;
  }
}

// ✅ Helper: find customer socket from in-memory map OR DB fallback
async function resolveCustomerSocketId(customerId) {
  const custIdStr = customerId.toString();
  // 1. Check in-memory map first (fastest)
  for (const [socketId, custId] of connectedCustomers.entries()) {
    if (custId === custIdStr) return socketId;
  }
  // 2. Fall back to DB socketId (handles reconnects that didn't re-register)
  const customer = await User.findById(custIdStr).select('socketId').lean();
  return customer?.socketId || null;
}

// ══════════════════════════════════════════════════════════
// SESSION MANAGEMENT EXPORTS
// ══════════════════════════════════════════════════════════

export const emitForceLogout = (io, phone, data) => {
  try {
    io.to(`user:${phone}`).emit('force_logout', {
      reason:      data.reason  || 'multi_device_login',
      message:     data.message || 'Your account has been logged in on another device',
      newDeviceId: data.newDeviceId,
      timestamp:   new Date().toISOString(),
    });
    return { success: true };
  } catch (err) {
    console.error('❌ emitForceLogout error:', err);
    return { success: false, error: err.message };
  }
};

export const emitToUser = (io, phone, event, data) => {
  try {
    io.to(`user:${phone}`).emit(event, data);
    return { success: true };
  } catch (err) {
    console.error(`❌ emitToUser error for ${phone}:`, err);
    return { success: false, error: err.message };
  }
};

// ══════════════════════════════════════════════════════════
// MAIN SOCKET INIT
// ══════════════════════════════════════════════════════════

export const initSocket = (ioInstance) => {
  io = ioInstance;

  io.on('connection', async (socket) => {
    console.log(`🟢 New connection: ${socket.id}`);

    // Admin connection
    const isAdmin = socket.handshake.query?.role === 'admin' || socket.handshake.auth?.role === 'admin';
    if (isAdmin) {
      socket.join('admin-room');
      socket.emit('admin:connected', { success: true, socketId: socket.id, timestamp: new Date().toISOString() });
    }

    // Driver reconnect via handshake query
    const queryDriverId = socket.handshake.query?.driverId || socket.handshake.auth?.driverId;
    if (queryDriverId) {
      console.log(`🔄 Driver ${queryDriverId} connecting via handshake`);

      const driver = await User.findById(queryDriverId).select('phone').lean();
      await User.findByIdAndUpdate(queryDriverId, {
        $set: { socketId: socket.id, isOnline: true, lastConnectedAt: new Date(), lastHeartbeat: new Date() },
        $unset: { lastDisconnectedAt: '' },
      });
      connectedDrivers.set(socket.id, queryDriverId);

      if (driver?.phone) {
        socket.join(`user:${driver.phone}`);
        socket.data.phone = driver.phone;
      }

      // Join driver room for targeted emits
      socket.join(`driver_${queryDriverId}`);

      await sendActiveTripToDriver(socket, queryDriverId);
    }

    // ──────────────────────────────────────────────────
    // USER ROOMS (session management)
    // ──────────────────────────────────────────────────
    socket.on('user:join', async ({ phone }) => {
      if (!phone) return;
      socket.join(`user:${phone}`);
      socket.data.phone = phone;
      socket.emit('user:joined', { success: true, room: `user:${phone}`, socketId: socket.id, timestamp: new Date().toISOString() });
    });

    socket.on('user:leave', ({ phone }) => {
      if (phone) socket.leave(`user:${phone}`);
    });

    socket.on('user:connect', async ({ phone, customerId, role }) => {
      if (!phone) { socket.emit('error', { message: 'Phone required' }); return; }
      socket.join(`user:${phone}`);
      if (customerId) socket.join(`customer_${customerId}`);
      if (role === 'driver' && customerId) socket.join(`driver_${customerId}`);
      socket.data.phone = phone;
      socket.data.customerId = customerId;
      socket.data.role = role;
      socket.emit('connection:success', { message: 'Connected', socketId: socket.id, timestamp: new Date().toISOString() });
    });

    socket.on('user:logout', async ({ phone, reason }) => {
      if (!phone) return;
      try {
        const SessionManager = (await import('../services/SessionManager.js')).default;
        const result = await SessionManager.handleLogout(phone, reason || 'user_logout');
        if (result.success) {
          socket.emit('logout:success', { message: 'Logged out', timestamp: new Date().toISOString() });
          Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });
        } else {
          socket.emit('error', { message: result.error || 'Logout failed' });
        }
      } catch (e) {
        console.error('❌ user:logout error:', e);
      }
    });

    // Admin events
    socket.on('admin:join', () => {
      socket.join('admin-room');
      socket.emit('admin:joined', { success: true, room: 'admin-room', socketId: socket.id });
    });

    // ──────────────────────────────────────────────────
    // FCM TOKEN
    // ──────────────────────────────────────────────────
    socket.on('driver:save_fcm_token', async ({ driverId, fcmToken }) => {
      if (!driverId || !fcmToken) { socket.emit('fcm_token:error', { message: 'Missing data' }); return; }
      await User.findByIdAndUpdate(driverId, { $set: { fcmToken, fcmTokenUpdatedAt: new Date() } });
      socket.emit('fcm_token:saved', { success: true });
    });

    // ──────────────────────────────────────────────────
    // DRIVER STATUS UPDATE
    // ──────────────────────────────────────────────────
    socket.on('updateDriverStatus', async (payload = {}) => {
      try {
        const { driverId, isOnline, location, lat, lng, fcmToken, profileData, vehicleType } = payload;
        if (!driverId) return;

        const user = await resolveUserByIdOrPhone(driverId);
        if (!user) return;

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
        } else if (typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng)) {
          set.location = { type: 'Point', coordinates: [lng, lat] };
        }

        if (fcmToken) set.fcmToken = fcmToken;
        if (vehicleType) set.vehicleType = String(vehicleType).toLowerCase().trim();

        const allowedProfileKeys = ['name', 'photoUrl', 'rating', 'vehicleBrand', 'vehicleNumber', 'vehicleType'];
        if (profileData && typeof profileData === 'object') {
          for (const key of allowedProfileKeys) {
            if (profileData[key] != null) {
              set[key] = key === 'vehicleType' ? String(profileData[key]).toLowerCase().trim() : profileData[key];
            }
          }
        }

        await User.findByIdAndUpdate(user._id, { $set: set, $unset: { lastDisconnectedAt: '' } }, { new: true });

        // Clean up stale socket entries for this driver
        for (const [sid, did] of connectedDrivers.entries()) {
          if (did === userIdStr && sid !== socket.id) connectedDrivers.delete(sid);
        }
        connectedDrivers.set(socket.id, userIdStr);

        // Join rooms
        socket.join(`driver_${userIdStr}`);
        if (user.phone) { socket.join(`user:${user.phone}`); socket.data.phone = user.phone; }

        if (isOnline) await sendActiveTripToDriver(socket, userIdStr);

        socket.emit('driver:statusUpdated', { ok: true, isOnline: !!isOnline, socketId: socket.id, driverId: userIdStr });
        console.log(`📶 Driver ${userIdStr} ${isOnline ? 'ONLINE ✅' : 'OFFLINE 🔴'}`);
      } catch (e) {
        console.error('❌ updateDriverStatus error:', e);
      }
    });

    // ──────────────────────────────────────────────────
    // DRIVER RECONNECT
    // ──────────────────────────────────────────────────
    socket.on('driver:reconnect_with_trip', async ({ driverId, tripId }) => {
      try {
        const driver = await User.findById(driverId).lean();
        if (!driver) { socket.emit('reconnect:failed', { message: 'Driver not found' }); return; }

        await User.findByIdAndUpdate(driverId, {
          $set: { socketId: socket.id, isOnline: true, lastConnectedAt: new Date() },
          $unset: { lastDisconnectedAt: '' },
        });
        connectedDrivers.set(socket.id, driverId.toString());
        socket.join(`driver_${driverId}`);
        if (driver.phone) { socket.join(`user:${driver.phone}`); socket.data.phone = driver.phone; }

        if (tripId) {
          const trip = await Trip.findById(tripId).lean();
          if (!trip) { socket.emit('reconnect:failed', { message: 'Trip not found', shouldClearTrip: true }); return; }

          const activeStatuses = ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'];
          const isActive = activeStatuses.includes(trip.status) || (trip.status === 'completed' && !trip.paymentCollected);
          if (!isActive) { socket.emit('reconnect:failed', { message: `Trip is ${trip.status}`, shouldClearTrip: true, tripStatus: trip.status }); return; }

          const customer = await User.findById(trip.customerId).select('name phone photoUrl rating').lean();

          socket.emit('reconnect:success', {
            tripId: trip._id.toString(), status: trip.status, otp: trip.otp,
            trip: {
              pickup: { lat: trip.pickup.coordinates[1], lng: trip.pickup.coordinates[0], address: trip.pickup.address },
              drop:   { lat: trip.drop.coordinates[1],   lng: trip.drop.coordinates[0],   address: trip.drop.address },
              fare: trip.fare,
            },
            customer: customer ? { id: customer._id.toString(), name: customer.name, phone: customer.phone, photoUrl: customer.photoUrl, rating: customer.rating } : null,
            paymentInfo: trip.status === 'completed'
              ? { fare: trip.finalFare || trip.fare, paymentCollected: trip.paymentCollected, awaitingCashCollection: !trip.paymentCollected }
              : null,
          });
        } else {
          await sendActiveTripToDriver(socket, driverId);
          socket.emit('reconnect:success', { message: 'Reconnected successfully' });
        }
      } catch (e) {
        console.error('❌ driver:reconnect_with_trip error:', e);
        socket.emit('reconnect:failed', { message: 'Reconnection failed' });
      }
    });

    // ──────────────────────────────────────────────────
    // REQUEST ACTIVE TRIP (app restart / splash check)
    // Issue #19 — splash screen ride check
    // ──────────────────────────────────────────────────
    socket.on('driver:request_active_trip', async ({ driverId }) => {
      if (!driverId) { socket.emit('active_trip:none', { message: 'No driverId' }); return; }
      const sent = await sendActiveTripToDriver(socket, driverId);
      if (!sent) socket.emit('active_trip:none', { message: 'No active trip found' });
    });

    // ──────────────────────────────────────────────────
    // CUSTOMER REGISTER
    // ──────────────────────────────────────────────────
    socket.on('customer:register', async ({ customerId }) => {
      try {
        if (!customerId) { socket.emit('customer:registered', { success: false, error: 'customerId missing' }); return; }

        const user = await resolveUserByIdOrPhone(customerId);
        if (!user) { socket.emit('customer:registered', { success: false, error: 'User not found' }); return; }

        // Clean up old entries for this customer
        for (const [sid, cid] of connectedCustomers.entries()) {
          if (cid === user._id.toString()) connectedCustomers.delete(sid);
        }

        await User.findByIdAndUpdate(user._id, { $set: { socketId: socket.id } });
        connectedCustomers.set(socket.id, user._id.toString());

        // Join rooms
        socket.join(`customer_${user._id.toString()}`);
        if (user.phone) { socket.join(`user:${user.phone}`); socket.data.phone = user.phone; }

        socket.emit('customer:registered', {
          success: true, customerId: user._id.toString(),
          mongoId: user._id.toString(), socketId: socket.id,
          phone: user.phone, name: user.name,
        });
      } catch (e) {
        console.error('❌ customer:register error:', e);
        socket.emit('customer:registered', { success: false, error: e.message });
      }
    });

    // ──────────────────────────────────────────────────
    // CUSTOMER REQUEST TRIP
    // ──────────────────────────────────────────────────
    socket.on('customer:request_trip', async (payload) => {
      try {
        if (!validateTripPayload(payload)) {
          socket.emit('trip:error', { message: 'Invalid trip request payload.' }); return;
        }

        const user = await resolveUserByIdOrPhone(payload.customerId);
        if (!user) { socket.emit('trip:error', { message: 'Customer not found.' }); return; }

        payload.customerId = user._id.toString();

        // Import here to avoid circular deps at module load
        const { createShortTrip, createParcelTrip, createLongTrip } = await import('../controllers/tripController.js');

        const fnMap = { short: createShortTrip, parcel: createParcelTrip, long: createLongTrip };
        const controllerFn = fnMap[payload.type];
        if (!controllerFn) { socket.emit('trip:error', { message: 'Unknown trip type.' }); return; }

        const req = { body: payload };
        const res = {
          status: (code) => ({
            json: (data) => {
              socket.emit('trip:request_response', { ...data, status: code });
              if (data.success && data.tripId && data.drivers === 0) {
                socket.emit('trip:error', { tripId: data.tripId, message: 'No drivers available.' });
              } else if (!data.success) {
                socket.emit('trip:error', { message: data.message });
              }
            },
          }),
        };

        await controllerFn(req, res);
      } catch (e) {
        console.error('❌ customer:request_trip error:', e);
        socket.emit('trip:error', { message: 'Internal server error.' });
      }
    });

    // ──────────────────────────────────────────────────
    // DRIVER ACCEPT TRIP
    // ✅ FIXED: Unified with HTTP acceptTrip logic, checks active trip, proper rollback
    // Issue #12 — prevent multiple ride accept
    // ──────────────────────────────────────────────────
    socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
      try {
        if (!driverId || !tripId) {
          socket.emit('trip:accept_failed', { message: 'Missing driverId or tripId', reason: 'invalid_request' }); return;
        }

        // ✅ Pre-check trip status (fast, no lock needed yet)
        const existingTrip = await Trip.findById(tripId).select('version status cancelledAt assignedDriver').lean();
        if (!existingTrip) { socket.emit('trip:accept_failed', { message: 'Trip not found', reason: 'trip_not_found' }); return; }
        if (existingTrip.status !== 'requested') { socket.emit('trip:accept_failed', { message: `Trip is already ${existingTrip.status}`, reason: 'trip_unavailable' }); return; }
        if (existingTrip.cancelledAt) { socket.emit('trip:accept_failed', { message: 'Trip was cancelled', reason: 'trip_cancelled' }); return; }

        // ✅ Check driver doesn't already have an active trip (issue #12)
        const driverBusyCheck = await User.findOne({
          _id: driverId,
          $or: [{ isBusy: true }, { currentTripId: { $ne: null, $exists: true } }],
        }).select('_id currentTripId').lean();

        if (driverBusyCheck) {
          socket.emit('trip:accept_failed', {
            message: 'You already have an active ride. Complete it before accepting another.',
            reason:  'driver_busy',
            currentTripId: driverBusyCheck.currentTripId,
          });
          return;
        }

        const currentVersion = existingTrip.version ?? null;
        const rideCode = generateOTP();

        // ✅ Atomic two-step: reserve driver, then reserve trip with version lock
        // version lock: if currentVersion is null (old doc), match $exists:false OR version:null
        // if currentVersion is a number, match exactly — prevents two drivers racing
        const driver = await User.findOneAndUpdate(
          {
            _id: driverId,
            isBusy: { $ne: true },
            $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }],
          },
          {
            $set: {
              isBusy: true, currentTripId: tripId,
              canReceiveNewRequests: false, lastTripAcceptedAt: new Date(),
            },
          },
          { new: true, select: 'name phone photoUrl rating vehicleBrand vehicleNumber location goToDestination' }
        ).lean();

        if (!driver) {
          socket.emit('trip:accept_failed', { message: 'You are already on another trip', reason: 'driver_busy' }); return;
        }

        const trip = await Trip.findOneAndUpdate(
          {
            _id: tripId, status: 'requested',
            // ✅ Version lock: handle both versioned docs and legacy docs with no version field
            ...(currentVersion === null
              ? { $or: [{ version: { $exists: false } }, { version: null }] }
              : { version: currentVersion }
            ),
            $or: [{ cancelledAt: { $exists: false } }, { cancelledAt: null }],
          },
          {
            $set: { assignedDriver: driverId, status: 'driver_assigned', acceptedAt: new Date(), otp: rideCode },
            $inc: { version: 1 },
          },
          { new: true }
        ).lean();

        if (!trip) {
          // ✅ Full rollback
          await User.findByIdAndUpdate(driverId, {
            $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: true },
          });

          const checkTrip = await Trip.findById(tripId).lean();
          let reason = 'trip_unavailable', message = 'Trip no longer available';
          if (checkTrip?.cancelledAt) { reason = 'trip_cancelled'; message = 'Trip was cancelled'; }
          else if (checkTrip?.status === 'driver_assigned') { reason = 'trip_taken'; message = 'Trip was accepted by another driver'; }

          socket.emit('trip:accept_failed', { message, reason });
          return;
        }

        stopTripRetry(tripId);

        // ✅ Auto-disable goToDestination mode if active
        if (driver.goToDestination?.enabled) {
          await User.findByIdAndUpdate(driverId, {
            $set: { 'goToDestination.enabled': false, 'goToDestination.disabledAt': new Date() },
          });
        }

        const customer = await User.findById(trip.customerId)
          .select('name phone photoUrl rating socketId').lean();

        if (!customer) {
          // Rollback
          await User.findByIdAndUpdate(driverId, { $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: true } });
          await Trip.findByIdAndUpdate(tripId, { $unset: { assignedDriver: 1, otp: 1 }, $set: { status: 'requested' }, $inc: { version: 1 } });
          socket.emit('trip:accept_failed', { message: 'Customer not found', reason: 'customer_missing' }); return;
        }

        const tripPayload = {
          pickup: { lat: trip.pickup.coordinates[1], lng: trip.pickup.coordinates[0], address: trip.pickup.address || 'Pickup Location' },
          drop:   { lat: trip.drop.coordinates[1],   lng: trip.drop.coordinates[0],   address: trip.drop.address   || 'Drop Location' },
          fare:   trip.fare || 0,
        };

        const driverPayload = {
          id:            driver._id.toString(),
          name:          driver.name          || 'Driver',
          phone:         driver.phone         || null,
          photoUrl:      driver.photoUrl      || null,
          rating:        driver.rating        || 4.8,
          vehicleBrand:  driver.vehicleBrand  || 'Vehicle',
          vehicleNumber: driver.vehicleNumber || 'N/A',
          location: driver.location?.coordinates
            ? { lat: driver.location.coordinates[1], lng: driver.location.coordinates[0] }
            : null,
        };

        // Notify customer
        const customerSocketId = await resolveCustomerSocketId(trip.customerId);
        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:accepted', {
            tripId: tripId.toString(), rideCode,
            trip: tripPayload, driver: driverPayload,
          });
        }

        // Confirm to driver
        socket.emit('trip:confirmed_for_driver', {
          tripId: tripId.toString(), rideCode,
          trip: tripPayload,
          customer: {
            id:       customer._id.toString(),
            name:     customer.name     || 'Customer',
            phone:    customer.phone    || null,
            photoUrl: customer.photoUrl || null,
            rating:   customer.rating   || 5.0,
          },
        });

        // Notify other online drivers trip is taken
        const otherDrivers = await User.find({
          isDriver: true, isOnline: true, _id: { $ne: driverId },
          socketId: { $exists: true, $ne: null },
        }).select('socketId').lean();

        otherDrivers.forEach(d => {
          io.to(d.socketId).emit('trip:taken', { tripId, message: 'This trip has been accepted by another driver' });
        });

        console.log(`✅ Trip ${tripId} accepted by driver ${driver.name}`);

      } catch (e) {
        console.error('❌ driver:accept_trip error:', e);
        // Attempt rollback on unexpected error
        try {
          if (driverId) await User.findByIdAndUpdate(driverId, { $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: true } });
        } catch { /* ignore rollback errors */ }
        socket.emit('trip:accept_failed', { message: 'Failed to accept trip. Please try again.', reason: 'server_error' });
      }
    });

    // ──────────────────────────────────────────────────
    // CUSTOMER CANCEL SEARCH
    // Issue #13 — ride cancel handling
    // ──────────────────────────────────────────────────
    socket.on('customer:cancel_search', async ({ tripId, customerId, reason }) => {
      try {
        if (!tripId || !customerId) { socket.emit('cancel:failed', { success: false, message: 'tripId and customerId required' }); return; }

        const trip = await Trip.findOneAndUpdate(
          { _id: tripId, customerId, status: 'requested', $or: [{ assignedDriver: { $exists: false } }, { assignedDriver: null }] },
          { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: customerId, cancellationReason: reason || 'customer_cancelled_search' }, $inc: { version: 1 } },
          { new: true }
        ).lean();

        if (!trip) {
          const existing = await Trip.findById(tripId).lean();
          if (!existing) { socket.emit('cancel:failed', { success: false, message: 'Trip not found' }); return; }
          if (existing.status === 'driver_assigned') { socket.emit('cancel:failed', { success: false, message: 'Driver already accepted. Use cancel ride instead.', status: existing.status }); return; }
          if (existing.status === 'cancelled') { socket.emit('cancel:success', { success: true, message: 'Already cancelled', alreadyCancelled: true }); return; }
          socket.emit('cancel:failed', { success: false, message: 'Cannot cancel at this stage', status: existing.status }); return;
        }

        stopTripRetry(tripId);

        // ✅ Notify ALL online drivers (issue #14)
        const onlineDrivers = await User.find({ isDriver: true, isOnline: true, socketId: { $exists: true, $ne: null } }).select('socketId').lean();
        onlineDrivers.forEach(d => {
          io.to(d.socketId).emit('trip:cancelled', { tripId, reason: 'customer_cancelled_search', message: 'Customer cancelled the search' });
        });

        socket.emit('cancel:success', { success: true, message: 'Search cancelled', tripId });
        console.log(`🛑 Trip ${tripId} cancelled by customer`);
      } catch (e) {
        console.error('❌ customer:cancel_search error:', e);
        socket.emit('cancel:failed', { success: false, message: e.message });
      }
    });

    // ──────────────────────────────────────────────────
    // DRIVER GOING TO PICKUP
    // ──────────────────────────────────────────────────
    socket.on('driver:going_to_pickup', async ({ tripId, driverId }) => {
      try {
        if (!tripId || !driverId) { socket.emit('trip:status_error', { message: 'tripId and driverId required' }); return; }

        // ✅ Atomic: auth + status guard in single query — no TOCTOU
        const trip = await Trip.findOneAndUpdate(
          { _id: tripId, assignedDriver: driverId, status: 'driver_assigned' },
          { $set: { status: 'driver_going_to_pickup' }, $inc: { version: 1 } },
          { new: true }
        ).lean();

        if (!trip) {
          const existing = await Trip.findById(tripId).select('status assignedDriver').lean();
          if (!existing) { socket.emit('trip:status_error', { message: 'Trip not found' }); return; }
          if (existing.assignedDriver?.toString() !== driverId.toString()) { socket.emit('trip:status_error', { message: 'Not authorized for this trip' }); return; }
          socket.emit('trip:status_updated', { success: true, alreadyUpdated: true, status: existing.status }); return;
        }

        const customerSocketId = await resolveCustomerSocketId(trip.customerId);
        if (customerSocketId) io.to(customerSocketId).emit('trip:driver_going_to_pickup', { tripId: tripId.toString(), message: 'Driver is on the way' });
        socket.emit('trip:status_updated', { success: true, status: 'driver_going_to_pickup' });
        console.log(`🚗 Driver ${driverId} going to pickup for trip ${tripId}`);
      } catch (e) { console.error('❌ driver:going_to_pickup error:', e); socket.emit('trip:status_error', { message: e.message }); }
    });

    // ──────────────────────────────────────────────────
    // DRIVER ARRIVED AT PICKUP
    // ──────────────────────────────────────────────────
    socket.on('trip:arrived_at_pickup', async ({ tripId, driverId }) => {
      try {
        if (!tripId || !driverId) { socket.emit('trip:status_error', { message: 'tripId and driverId required' }); return; }

        // ✅ Atomic: auth + status guard — accepts both statuses since driver may skip going_to_pickup
        const trip = await Trip.findOneAndUpdate(
          { _id: tripId, assignedDriver: driverId, status: { $in: ['driver_assigned', 'driver_going_to_pickup'] } },
          { $set: { status: 'driver_at_pickup', arrivedAt: new Date() }, $inc: { version: 1 } },
          { new: true }
        ).lean();

        if (!trip) {
          const existing = await Trip.findById(tripId).select('status assignedDriver').lean();
          if (!existing) { socket.emit('trip:status_error', { message: 'Trip not found' }); return; }
          if (existing.assignedDriver?.toString() !== driverId.toString()) { socket.emit('trip:status_error', { message: 'Not authorized for this trip' }); return; }
          socket.emit('trip:status_updated', { success: true, alreadyUpdated: true, status: existing.status }); return;
        }

        const customerSocketId = await resolveCustomerSocketId(trip.customerId);
        if (customerSocketId) io.to(customerSocketId).emit('trip:driver_arrived', { tripId: tripId.toString(), message: 'Driver arrived at pickup' });
        socket.emit('trip:status_updated', { success: true, status: 'driver_at_pickup' });
        console.log(`📍 Driver ${driverId} arrived at pickup for trip ${tripId}`);
      } catch (e) { console.error('❌ trip:arrived_at_pickup error:', e); socket.emit('trip:status_error', { message: e.message }); }
    });

    // ──────────────────────────────────────────────────
    // DRIVER START RIDE (via socket — same validation as HTTP)
    // ──────────────────────────────────────────────────
    socket.on('driver:start_ride', async ({ tripId, driverId, otp }) => {
      try {
        if (!tripId || !driverId || !otp) { socket.emit('trip:start_error', { message: 'tripId, driverId and otp required' }); return; }

        // ✅ Atomic: auth + OTP + status all checked in single query — eliminates TOCTOU
        // If two identical events arrive simultaneously, only one will match & update
        const trip = await Trip.findOneAndUpdate(
          {
            _id:            tripId,
            assignedDriver: driverId,
            otp:            otp,
            status:         { $in: ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup'] },
          },
          {
            $set: { status: 'ride_started', rideStartTime: new Date() },
            $inc: { version: 1 },
          },
          { new: true }
        ).lean();

        if (!trip) {
          // Diagnose reason for failure
          const existing = await Trip.findById(tripId).select('status assignedDriver otp').lean();
          if (!existing) { socket.emit('trip:start_error', { message: 'Trip not found' }); return; }
          if (existing.assignedDriver?.toString() !== driverId.toString()) { socket.emit('trip:start_error', { message: 'Not authorized' }); return; }
          if (existing.otp !== otp) { socket.emit('trip:start_error', { message: 'Invalid OTP' }); return; }
          if (existing.status === 'ride_started') {
            // Idempotent — already started (e.g. double-tap), just confirm
            socket.emit('trip:ride_started', { tripId: tripId.toString(), message: 'Ride already started', alreadyStarted: true });
            return;
          }
          socket.emit('trip:start_error', { message: `Cannot start from status: ${existing.status}` }); return;
        }

        const customerSocketId = await resolveCustomerSocketId(trip.customerId);
        const payload = { tripId: tripId.toString(), message: 'Ride started', timestamp: new Date().toISOString() };
        if (customerSocketId) io.to(customerSocketId).emit('trip:ride_started', payload);
        socket.emit('trip:ride_started', { ...payload, message: 'Ride started successfully' });

        console.log(`🚀 Ride ${tripId} started`);
      } catch (e) {
        console.error('❌ driver:start_ride error:', e);
        socket.emit('trip:start_error', { message: e.message });
      }
    });

    // ──────────────────────────────────────────────────
    // DRIVER COMPLETE RIDE (via socket)
    // ✅ FIXED: Does NOT update wallet here — wallet is only updated in confirmCashCollection
    //           Sets paymentCollected: false correctly, uses walletUpdated field
    //           Issue #16 — ride completes, then cash collection triggers wallet
    // ──────────────────────────────────────────────────
    socket.on('driver:complete_ride', async ({ tripId, driverId }) => {
      try {
        if (!tripId || !driverId) { socket.emit('trip:complete_error', { message: 'tripId and driverId required' }); return; }

        // ✅ Atomic: auth + status guard in single query — prevents double-completion
        // If driver taps "Complete" twice simultaneously, only first call matches status:'ride_started'
        const trip = await Trip.findOneAndUpdate(
          { _id: tripId, assignedDriver: driverId, status: 'ride_started' },
          {
            $set: {
              status:           'completed',
              completedAt:      new Date(),
              paymentCollected: false,
              walletUpdated:    false,
              paymentStatus:    'pending',
            },
            $inc: { version: 1 },
          },
          { new: false } // ← return OLD doc to read fare before update
        ).lean();

        if (!trip) {
          const existing = await Trip.findById(tripId).select('status assignedDriver fare finalFare paymentCollected').lean();
          if (!existing) { socket.emit('trip:complete_error', { message: 'Trip not found' }); return; }
          if (existing.assignedDriver?.toString() !== driverId.toString()) { socket.emit('trip:complete_error', { message: 'Not authorized' }); return; }
          if (existing.status === 'completed') {
            // Idempotent — already completed (double-tap), re-send the completion payload
            const fare = parseFloat(existing.finalFare || existing.fare || 0);
            socket.emit('trip:completed', {
              tripId, fare, message: `Collect ₹${fare.toFixed(2)} from customer.`,
              awaitingCashCollection: !existing.paymentCollected,
              alreadyCompleted: true,
            });
            return;
          }
          socket.emit('trip:complete_error', { message: `Cannot complete from status: ${existing.status}` }); return;
        }

        // ✅ Type-safe fare — old data may store fare as string
        const fare = parseFloat(trip.fare || 0);

        // Set finalFare now that we have the value (update didn't include it above)
        await Trip.findByIdAndUpdate(tripId, { $set: { finalFare: fare } });

        // Driver stays busy until cash collected
        await User.findByIdAndUpdate(driverId, {
          $set: {
            currentTripId:          tripId,
            isBusy:                 true,
            canReceiveNewRequests:  false,
            awaitingCashCollection: true,
            lastTripCompletedAt:    new Date(),
          },
        });

        const customerSocketId = await resolveCustomerSocketId(trip.customerId);

        const completedPayload = {
          tripId:          tripId.toString(),
          fare,
          originalFare:    trip.originalFare    || null,
          discountApplied: trip.discountApplied || 0,
          coinsUsed:       trip.coinsUsed       || 0,
          message:         'Ride completed',
          timestamp:       new Date().toISOString(),
          awaitingPayment: true,
        };

        if (customerSocketId) io.to(customerSocketId).emit('trip:completed', completedPayload);

        socket.emit('trip:completed', {
          ...completedPayload,
          message:                `Ride completed. Please collect ₹${fare.toFixed(2)} from customer.`,
          awaitingCashCollection: true,
        });

        console.log(`✅ Ride ${tripId} completed — awaiting cash collection`);
      } catch (e) {
        console.error('❌ driver:complete_ride error:', e);
        socket.emit('trip:complete_error', { message: e.message });
      }
    });

    // ──────────────────────────────────────────────────
    // DRIVER CASH COLLECTED (via socket)
    // ✅ NEW: Delegates to HTTP controller to avoid duplicate payment logic
    //         Issue #7 — cash collected button disables, driver → next ride
    // ──────────────────────────────────────────────────
    socket.on('driver:cash_collected', async ({ tripId, driverId, fare }) => {
      try {
        if (!tripId || !driverId) {
          socket.emit('cash:collection_error', { message: 'tripId and driverId required' }); return;
        }

        // Delegate to HTTP controller function — single source of truth for wallet logic
        const req = { body: { tripId, driverId, fare }, io };
        const res = {
          status: (code) => ({
            json: (data) => {
              if (data.success) {
                socket.emit('cash:collected', {
                  success:      true,
                  tripId,
                  amount:       data.amount,
                  fareBreakdown: data.fareBreakdown,
                  wallet:       data.wallet,
                  coinReward:   data.coinReward,
                  message:      'Cash collected. Ready for next ride!',
                });
              } else if (data.alreadyProcessed) {
                socket.emit('cash:collected', { success: true, tripId, alreadyProcessed: true, message: 'Already collected' });
              } else {
                socket.emit('cash:collection_error', { message: data.message });
              }
            },
          }),
        };

        await httpConfirmCashCollection(req, res);
      } catch (e) {
        console.error('❌ driver:cash_collected error:', e);
        socket.emit('cash:collection_error', { message: e.message });
      }
    });

    // ──────────────────────────────────────────────────
    // DRIVER LOCATION UPDATE
    // ✅ FIXED: customerIdStr was undefined — now properly resolved
    //           Issue #15 — near drop location, driver ready for next ride
    // ──────────────────────────────────────────────────
    socket.on('driver:location', async ({ tripId, driverId, latitude, longitude, sequence, timestamp }) => {
      try {
        if (!driverId || latitude == null || longitude == null) return;

        // Update driver location in DB
        const locUpdate = {
          $set: {
            location: { type: 'Point', coordinates: [longitude, latitude] },
            lastLocationUpdate: new Date(),
            lastHeartbeat:      new Date(),
            socketId:           socket.id,
          },
        };
        if (typeof sequence === 'number') locUpdate.$set.locationSequence = sequence;
        await User.findByIdAndUpdate(driverId, locUpdate);

        if (!tripId) return;

        const trip = await Trip.findById(tripId).select('customerId drop status').lean();
        if (!trip) return;

        // ✅ FIXED: declare customerId string properly
        const custIdStr = trip.customerId.toString();

        const dropLat = trip.drop.coordinates[1];
        const dropLng = trip.drop.coordinates[0];
        const distKm  = calculateDistance(latitude, longitude, dropLat, dropLng);
        const distM   = distKm * 1000;

        // ✅ Issue #15 — near drop: flag driver as ready for next ride requests
        if (distM <= 500 && trip.status === 'ride_started') {
          await User.findByIdAndUpdate(driverId, { $set: { canReceiveNewRequests: true } });
        }

        // ✅ FIXED: use resolveCustomerSocketId helper instead of undefined custIdStr
        const customerSocketId = await resolveCustomerSocketId(custIdStr);

        if (customerSocketId) {
          io.to(customerSocketId).emit('driver:locationUpdate', {
            tripId:                  tripId.toString(),
            driverId,
            latitude,
            longitude,
            distanceToDestination:   Math.round(distM),
            sequence:                typeof sequence === 'number' ? sequence : Date.now(),
            timestamp:               new Date().toISOString(),
          });
        }
      } catch (e) {
        console.error('❌ driver:location error:', e);
      }
    });

    // ──────────────────────────────────────────────────
    // CUSTOMER LOCATION UPDATE
    // ──────────────────────────────────────────────────
    socket.on('customer:location', async ({ tripId, customerId, latitude, longitude }) => {
      try {
        if (!customerId || latitude == null || longitude == null) return;
        await User.findByIdAndUpdate(customerId, {
          $set: { location: { type: 'Point', coordinates: [longitude, latitude] }, lastLocationUpdate: new Date() },
        });
        if (tripId) {
          const trip = await Trip.findById(tripId).select('assignedDriver').lean();
          if (trip?.assignedDriver) {
            const driver = await User.findById(trip.assignedDriver).select('socketId').lean();
            if (driver?.socketId) {
              io.to(driver.socketId).emit('customer:locationUpdate', {
                tripId: tripId.toString(), customerId, latitude, longitude, timestamp: new Date().toISOString(),
              });
            }
          }
        }
      } catch (e) { console.error('❌ customer:location error:', e); }
    });

    // ──────────────────────────────────────────────────
    // DRIVER HEARTBEAT
    // ──────────────────────────────────────────────────
    socket.on('driver:heartbeat', async ({ tripId, driverId, location }) => {
      try {
        if (!driverId) return;
        const update = {
          $set: { lastHeartbeat: new Date(), lastLocationUpdate: new Date(), socketId: socket.id, isOnline: true },
        };
        if (location?.lat && location?.lng) {
          update.$set.location = { type: 'Point', coordinates: [location.lng, location.lat] };
        }
        await User.findByIdAndUpdate(driverId, update);
        if (tripId) await Trip.findByIdAndUpdate(tripId, { $set: { lastDriverHeartbeat: new Date() } });
        socket.emit('heartbeat:ack', { timestamp: Date.now(), socketId: socket.id });
      } catch (e) { console.error('❌ driver:heartbeat error:', e); }
    });

    // ──────────────────────────────────────────────────
    // TRIP RETRY (from client — supplements server retry loop)
    // Issue #17 — retry trip request every 10s
    // ──────────────────────────────────────────────────
    socket.on('trip:rerequest', async ({ tripId, customerId, vehicleType, retryAttempt }) => {
      try {
        if (!tripId) return;

        const trip = await Trip.findById(tripId).lean();
        if (!trip || trip.status !== 'requested' || trip.cancelledAt) {
          socket.emit('trip:rerequest_failed', { message: 'Trip no longer available', shouldCancelSearch: true }); return;
        }

        const nearbyDrivers = await User.find({
          isDriver: true, vehicleType, isOnline: true, isBusy: { $ne: true },
          $or: [{ socketId: { $exists: true, $ne: null } }, { fcmToken: { $exists: true, $ne: null } }],
          $and: [{ $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }] }],
          location: {
            $near: { $geometry: { type: 'Point', coordinates: trip.pickup.coordinates }, $maxDistance: DISTANCE_LIMITS.short },
          },
        }).select('name phone vehicleType location socketId fcmToken').lean();

        if (!nearbyDrivers.length) return;

        // ✅ Update retry tracking on trip
        await Trip.findByIdAndUpdate(tripId, {
          $set:  { lastBroadcastAt: new Date() },
          $inc:  { retryCount: 1 },
        });

        const payload = {
          tripId:       trip._id.toString(),
          type:         trip.type,
          vehicleType,
          customerId,
          pickup: { lat: trip.pickup.coordinates[1], lng: trip.pickup.coordinates[0], address: trip.pickup.address || 'Pickup Location' },
          drop:   { lat: trip.drop.coordinates[1],   lng: trip.drop.coordinates[0],   address: trip.drop.address   || 'Drop Location' },
          fare:         trip.fare || 0,
          retryAttempt,
          isRetry:      true,
        };

        broadcastToDrivers(nearbyDrivers, payload);
        console.log(`🔄 Retry #${retryAttempt}: sent to ${nearbyDrivers.length} drivers`);
      } catch (e) { console.error('❌ trip:rerequest error:', e); }
    });

    // ──────────────────────────────────────────────────
    // DRIVER GO OFFLINE (explicit — only way to go offline)
    // ──────────────────────────────────────────────────
    socket.on('driver:go_offline', async ({ driverId }) => {
      try {
        const driver = await User.findById(driverId).select('currentTripId isBusy').lean();
        if (!driver) return;

        if (driver.currentTripId || driver.isBusy) {
          socket.emit('driver:offline_blocked', {
            success: false, message: 'Cannot go offline during active trip', currentTripId: driver.currentTripId,
          });
          return;
        }

        await User.findByIdAndUpdate(driverId, {
          $set: { isOnline: false, socketId: null, canReceiveNewRequests: false },
        });
        connectedDrivers.delete(socket.id);
        socket.emit('driver:offline_success', { success: true });
        socket.disconnect(true);
        console.log(`🔴 Driver ${driverId} went offline`);
      } catch (e) { console.error('❌ driver:go_offline error:', e); }
    });

    // ──────────────────────────────────────────────────
    // CHAT HANDLERS
    // ──────────────────────────────────────────────────
    socket.on('chat:join', ({ tripId, userId }) => {
      if (!tripId) return;
      socket.join(`chat_${tripId}`);
      socket.to(`chat_${tripId}`).emit('chat:user_joined', { userId, timestamp: new Date().toISOString() });
    });

    socket.on('chat:leave', ({ tripId, userId }) => {
      if (!tripId) return;
      socket.leave(`chat_${tripId}`);
      socket.to(`chat_${tripId}`).emit('chat:user_left', { userId, timestamp: new Date().toISOString() });
    });

    socket.on('chat:send_message', async ({ tripId, fromId, toId, message, timestamp }) => {
      try {
        if (!tripId || !fromId || !toId || !message) { socket.emit('chat:error', { error: 'Missing fields' }); return; }

        try {
          await new ChatMessage({ tripId, senderId: fromId, receiverId: toId, message, timestamp: timestamp ? new Date(timestamp) : new Date() }).save();
        } catch (dbErr) { console.warn('⚠️ Chat save failed:', dbErr.message); }

        const msgData = { tripId, fromId, toId, senderId: fromId, receiverId: toId, message, timestamp: timestamp || new Date().toISOString() };
        socket.to(`chat_${tripId}`).emit('chat:receive_message', msgData);
        socket.emit('chat:message_sent', { success: true, timestamp: msgData.timestamp });

        // Direct delivery fallback
        let recipientSocket = null;
        for (const [sid, uid] of connectedCustomers.entries()) { if (uid === toId) { recipientSocket = sid; break; } }
        if (!recipientSocket) for (const [sid, uid] of connectedDrivers.entries()) { if (uid === toId) { recipientSocket = sid; break; } }
        if (recipientSocket) io.to(recipientSocket).emit('chat:receive_message', msgData);
      } catch (e) { console.error('❌ chat:send_message error:', e); socket.emit('chat:error', { error: 'Failed to send' }); }
    });

    socket.on('chat:typing', ({ tripId, userId, isTyping }) => {
      if (tripId) socket.to(`chat_${tripId}`).emit('chat:typing_status', { userId, isTyping, timestamp: new Date().toISOString() });
    });

    socket.on('chat:mark_read', async ({ tripId, userId }) => {
      try {
        if (!tripId || !userId) return;
        await ChatMessage.updateMany({ tripId, receiverId: userId, read: false }, { $set: { read: true } });
        socket.to(`chat_${tripId}`).emit('chat:messages_read', { userId, tripId, timestamp: new Date().toISOString() });
      } catch (e) { console.error('❌ chat:mark_read error:', e); }
    });

    socket.on('chat:get_unread', async ({ userId }) => {
      try {
        if (!userId) return;
        const count = await ChatMessage.countDocuments({ receiverId: userId, read: false });
        socket.emit('chat:unread_count', { userId, count, timestamp: new Date().toISOString() });
      } catch (e) { console.error('❌ chat:get_unread error:', e); }
    });

    // ──────────────────────────────────────────────────
    // DISCONNECT
    // ✅ Driver stays ONLINE — only socketId cleared
    // Session stays active — no automatic logout
    // Issue #10 — do not logout on disconnect
    // ──────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      try {
        const driverId   = connectedDrivers.get(socket.id);
        const customerId = connectedCustomers.get(socket.id);

        if (driverId) {
          // ✅ Clear socketId only — driver STAYS ONLINE for FCM fallback
          await User.findByIdAndUpdate(driverId, {
            $set:   { socketId: null, lastDisconnectedAt: new Date() },
          });
          connectedDrivers.delete(socket.id);
          console.log(`⚡ Driver ${driverId} disconnected — stays online for FCM`);
        }

        if (customerId) {
          await User.findByIdAndUpdate(customerId, {
            $set: { socketId: null, lastDisconnectedAt: new Date() },
          });
          connectedCustomers.delete(socket.id);
        }
      } catch (e) { console.error('❌ disconnect error:', e); }
    });

    // Support sockets
    initSupportSockets(io, socket);

  }); // end io.on('connection')

  // ══════════════════════════════════════════════════════════
  // AUTO-CLEANUP EXPIRED TRIPS (every 10s)
  // Issue #22 — timeout → mark as timeout, not delete
  // ══════════════════════════════════════════════════════════
  setInterval(async () => {
    try {
      // ✅ Batch: process max 50 at a time — prevents memory spike if many expire together
      const expiredTrips = await Trip.find({
        status:    'requested',
        createdAt: { $lt: new Date(Date.now() - TRIP_TIMEOUT_MS) },
      }).limit(50).lean();

      if (!expiredTrips.length) return;

      for (const trip of expiredTrips) {
        // ✅ Atomic status guard — if two cleanup workers race, only one wins
        const updated = await Trip.findOneAndUpdate(
          { _id: trip._id, status: 'requested' },
          { $set: { status: 'timeout', timeoutAt: new Date(), timeoutReason: 'No driver accepted within 60s' }, $inc: { version: 1 } },
          { new: false }
        ).lean();

        if (!updated) continue; // Already handled by another process

        stopTripRetry(trip._id.toString());

        const customer = await User.findById(trip.customerId).select('socketId').lean();
        if (customer?.socketId) {
          io.to(customer.socketId).emit('trip:timeout', {
            tripId:  trip._id.toString(),
            message: 'No drivers available right now. Please try again.',
            reason:  'timeout',
          });
        }

        const onlineDrivers = await User.find({ isDriver: true, isOnline: true, socketId: { $exists: true, $ne: null } }).select('socketId').lean();
        onlineDrivers.forEach(d => {
          io.to(d.socketId).emit('trip:expired', { tripId: trip._id.toString() });
        });
      }
    } catch (e) { console.error('❌ Cleanup job error:', e); }
  }, 10000);

  console.log('⏰ Trip cleanup job started');
  startNotificationRetryJob();
  startStaleTripCleanup();
  console.log('🚀 Socket.IO initialized');
};

export { io, connectedDrivers, connectedCustomers };