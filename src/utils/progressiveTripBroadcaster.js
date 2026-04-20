import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { broadcastToDrivers } from './tripBroadcaster.js';

const PHASE_RADII = [2000, 3000, 5000];
const SECOND_ATTEMPT_DELAY_MS = 30000;

// Map<tripId, controller>
const activeControllers = new Map();
// Map<tripId, Map<driverId, { phase, attempt }>>
const tripDriverNotifications = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toStrId = (value) => (value ? String(value) : '');

const buildPayloadFromTrip = (trip) => ({
  tripId: toStrId(trip._id),
  type: trip.type || 'short',
  vehicleType: trip.vehicleType,
  customerId: toStrId(trip.customerId),
  fare: Number(trip.fare || 0),
  pickup: {
    lat: Number(trip.pickup?.coordinates?.[1] || 0),
    lng: Number(trip.pickup?.coordinates?.[0] || 0),
    address: String(trip.pickup?.address || 'Pickup'),
  },
  drop: {
    lat: Number(trip.drop?.coordinates?.[1] || 0),
    lng: Number(trip.drop?.coordinates?.[0] || 0),
    address: String(trip.drop?.address || 'Drop'),
  },
  isDestinationMatch: false,
});

const toRad = (v) => (v * Math.PI) / 180;

const distanceMeters = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const getTripRuntimeStatus = async (tripId) => {
  const trip = await Trip.findById(tripId)
    .select('status assignedDriver cancelledAt cancelledBy')
    .lean();

  if (!trip) return { active: false, reason: 'not_found' };
  if (trip.status !== 'requested') return { active: false, reason: `status_${trip.status}` };
  if (trip.assignedDriver) return { active: false, reason: 'driver_assigned' };
  if (trip.cancelledAt || trip.cancelledBy) return { active: false, reason: 'cancelled' };

  return { active: true };
};

const fetchPhaseDrivers = async (controller, radius) => {
  const excludedIds = Array.from(controller.state.notifiedDrivers.keys());
  const trip = controller.state.trip;

  const query = {
    isDriver: true,
    isOnline: true,
    isBusy: { $ne: true },
    vehicleType: trip.vehicleType,
    $or: [
      { socketId: { $exists: true, $ne: null } },
      { fcmToken: { $exists: true, $ne: null } },
    ],
    $and: [
      { $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }] },
    ],
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: trip.pickup.coordinates },
        $maxDistance: radius,
      },
    },
  };

  if (excludedIds.length > 0) {
    query._id = { $nin: excludedIds };
  }

  return User.find(query)
    .select('_id name socketId fcmToken vehicleType location')
    .lean();
};

const fetchDriversForSecondAttempt = async (controller, phaseNumber) => {
  const driverIds = [];

  for (const [driverId, record] of controller.state.notifiedDrivers.entries()) {
    if (record.phase === phaseNumber && record.attempt === 1) {
      driverIds.push(driverId);
    }
  }

  if (driverIds.length === 0) return [];

  return User.find({
    _id: { $in: driverIds },
    isDriver: true,
    isOnline: true,
    isBusy: { $ne: true },
    $or: [
      { socketId: { $exists: true, $ne: null } },
      { fcmToken: { $exists: true, $ne: null } },
    ],
    $and: [
      { $or: [{ currentTripId: null }, { currentTripId: { $exists: false } }] },
    ],
  })
    .select('_id name socketId fcmToken vehicleType location')
    .lean();
};

const sendAttempt = async (controller, drivers, phaseNumber, attemptNumber) => {
  if (!drivers || drivers.length === 0) return 0;

  const sendList = [];

  for (const driver of drivers) {
    const driverId = toStrId(driver._id);
    const record = controller.state.notifiedDrivers.get(driverId);

    if (!record && attemptNumber === 1) {
      sendList.push(driver);
      controller.state.notifiedDrivers.set(driverId, {
        phase: phaseNumber,
        attempt: 1,
      });
      continue;
    }

    if (
      record &&
      record.phase === phaseNumber &&
      record.attempt === 1 &&
      attemptNumber === 2
    ) {
      sendList.push(driver);
      controller.state.notifiedDrivers.set(driverId, {
        phase: phaseNumber,
        attempt: 2,
      });
    }
  }

  if (sendList.length === 0) return 0;

  const payload = {
    ...buildPayloadFromTrip(controller.state.trip),
    isRetry: attemptNumber === 2,
  };

  await broadcastToDrivers(sendList, payload);
  return sendList.length;
};

const waitWithChecks = async (controller, tripId, ms) => {
  const endAt = Date.now() + ms;

  while (Date.now() < endAt) {
    if (!controller.state.active) return false;

    const runtime = await getTripRuntimeStatus(tripId);
    if (!runtime.active) {
      controller.state.active = false;
      return false;
    }

    const remaining = endAt - Date.now();
    await sleep(Math.min(1000, Math.max(remaining, 0)));
  }

  return controller.state.active;
};

const runProgressiveLoop = async (controller) => {
  const tripId = controller.tripId;

  for (let phaseIndex = 0; phaseIndex < PHASE_RADII.length; phaseIndex++) {
    if (!controller.state.active) break;

    const runtime = await getTripRuntimeStatus(tripId);
    if (!runtime.active) {
      controller.state.active = false;
      break;
    }

    const currentRadius = PHASE_RADII[phaseIndex];
    const phaseNumber = phaseIndex + 1;

    controller.state.currentPhaseIndex = phaseIndex;
    controller.state.currentRadius = currentRadius;

    const phaseDrivers = await fetchPhaseDrivers(controller, currentRadius);

    await sendAttempt(controller, phaseDrivers, phaseNumber, 1);

    const shouldContinue = await waitWithChecks(
      controller,
      tripId,
      SECOND_ATTEMPT_DELAY_MS
    );

    if (!shouldContinue) break;

    const secondAttemptDrivers = await fetchDriversForSecondAttempt(
      controller,
      phaseNumber
    );

    await sendAttempt(controller, secondAttemptDrivers, phaseNumber, 2);
  }
};

export const startProgressiveBroadcast = async (tripInput) => {
  const tripId = toStrId(tripInput?._id || tripInput);
  if (!tripId) return;

  if (activeControllers.has(tripId)) {
    return;
  }

  const trip = tripInput?._id
    ? tripInput
    : await Trip.findById(tripId)
      .select('_id customerId pickup drop vehicleType type fare status assignedDriver cancelledAt cancelledBy')
      .lean();

  if (!trip || !trip.pickup?.coordinates || !trip.drop?.coordinates) {
    return;
  }

  const runtime = await getTripRuntimeStatus(tripId);
  if (!runtime.active) return;

  const controller = {
    tripId,
    state: {
      trip,
      currentPhaseIndex: 0,
      currentRadius: PHASE_RADII[0],
      // Map<driverId, { phase, attempt }>
      notifiedDrivers: tripDriverNotifications.get(tripId) || new Map(),
      accepted: false,
      active: true,
    },
  };

  if (!tripDriverNotifications.has(tripId)) {
    tripDriverNotifications.set(tripId, controller.state.notifiedDrivers);
  }

  activeControllers.set(tripId, controller);

  runProgressiveLoop(controller)
    .catch((err) => {
      console.error('progressive broadcast error:', err.message);
    })
    .finally(() => {
      controller.state.active = false;
      activeControllers.delete(tripId);
      tripDriverNotifications.delete(tripId);
    });
};

export const stopProgressiveBroadcast = (tripId) => {
  const id = toStrId(tripId);
  const controller = activeControllers.get(id);
  if (!controller) {
    tripDriverNotifications.delete(id);
    return;
  }

  controller.state.active = false;
  activeControllers.delete(id);
  tripDriverNotifications.delete(id);
};

export const notifyOnlineDriverForProgressiveBroadcast = async (driverId) => {
  const id = toStrId(driverId);
  if (!id) return;

  const driver = await User.findById(id)
    .select('_id name socketId fcmToken vehicleType location isDriver isOnline isBusy currentTripId')
    .lean();

  if (!driver?.isDriver || !driver.isOnline || driver.isBusy) return;
  if (!driver.location?.coordinates || driver.location.coordinates.length !== 2) return;

  for (const controller of activeControllers.values()) {
    if (!controller.state.active) continue;

    const runtime = await getTripRuntimeStatus(controller.tripId);
    if (!runtime.active) {
      controller.state.active = false;
      continue;
    }

    const driverIdStr = toStrId(driver._id);
    if (controller.state.notifiedDrivers.has(driverIdStr)) continue;

    if (driver.vehicleType !== controller.state.trip.vehicleType) continue;

    const tripCoords = controller.state.trip.pickup?.coordinates;
    if (!tripCoords || tripCoords.length !== 2) continue;

    const distance = distanceMeters(
      Number(tripCoords[1]),
      Number(tripCoords[0]),
      Number(driver.location.coordinates[1]),
      Number(driver.location.coordinates[0])
    );

    if (distance > controller.state.currentRadius) continue;

    const payload = {
      ...buildPayloadFromTrip(controller.state.trip),
      isRetry: false,
    };

    await broadcastToDrivers([driver], payload);

    controller.state.notifiedDrivers.set(driverIdStr, {
      phase: controller.state.currentPhaseIndex + 1,
      attempt: 1,
    });
  }
};

export default {
  startProgressiveBroadcast,
  stopProgressiveBroadcast,
  notifyOnlineDriverForProgressiveBroadcast,
};