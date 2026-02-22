// src/controllers/locationController.js
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import { io } from '../server.js'; 

/**
 * Resolve a user by MongoDB ObjectId or phone number
 */
const resolveUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;

  // If it's a valid Mongo ObjectId
  if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
    const byId = await User.findById(idOrPhone);
    if (byId) return byId;
  }

  // Else try finding by phone
  return await User.findOne({ phone: idOrPhone });
};

/**
 * Common function to build coordinates
 */
const buildCoordinates = (coordinates, latitude, longitude) => {
  if (coordinates && Array.isArray(coordinates) && coordinates.length === 2) {
    return coordinates;
  }
  if (typeof latitude === 'number' && typeof longitude === 'number') {
    return [longitude, latitude]; // GeoJSON expects [lng, lat]
  }
  return null;
};

/**
 * ✅ ENHANCED: Update driver location with sequence tracking
 * Prevents out-of-order updates from network delays
 */
const updateDriverLocation = async (req, res) => {
  try {
    const { 
      driverId, 
      tripId, 
      coordinates, 
      latitude, 
      longitude, 
      sequence,
      timestamp,
      bearing,   // ✅ NEW: bearing/heading from driver device
      heading,   // ✅ alias
      speed      // ✅ optional speed
    } = req.body;

    console.log('');
    console.log('📍 DRIVER LOCATION UPDATE REQUEST (HTTP)');
    console.log(`   Driver ID: ${driverId}`);
    console.log(`   Trip ID: ${tripId || 'N/A'}`);
    console.log(`   Latitude: ${latitude}`);
    console.log(`   Longitude: ${longitude}`);
    console.log(`   Sequence: ${sequence || 'N/A'}`);

    const user = await resolveUserByIdOrPhone(driverId);
    if (!user) {
      console.log(`❌ Driver not found: ${driverId}`);
      return res.status(404).json({ success: false, message: 'Driver not found.' });
    }

    const coords = buildCoordinates(coordinates, latitude, longitude);
    if (!coords) {
      console.log('❌ Invalid coordinates');
      return res.status(400).json({ success: false, message: 'Coordinates required.' });
    }

    // ── Calculate bearing from previous position if not provided ─────────────
    let calculatedBearing = bearing ?? heading ?? null;
    if (calculatedBearing == null && user.location?.coordinates) {
      const [prevLng, prevLat] = user.location.coordinates;
      const newLat = coords[1], newLng = coords[0];
      const distMoved = Math.sqrt(Math.pow(newLat - prevLat, 2) + Math.pow(newLng - prevLng, 2));
      if (distMoved > 0.0001) {
        const dLon = (newLng - prevLng) * Math.PI / 180;
        const lat1 = prevLat * Math.PI / 180;
        const lat2 = newLat * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        calculatedBearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
      } else {
        calculatedBearing = user.lastBearing ?? null;
      }
    }

    console.log(`   Coordinates: [${coords[1]}, ${coords[0]}]`);
    console.log(`   Bearing: ${calculatedBearing?.toFixed(0) ?? 'N/A'}°`);

    const updateQuery = { _id: user._id };

    if (timestamp) {
      const clientTime = new Date(timestamp);
      updateQuery.$or = [
        { lastLocationUpdate: { $lt: clientTime } },
        { lastLocationUpdate: { $exists: false } }
      ];
    }

    const updateSet = {
      location: { type: 'Point', coordinates: coords },
      updatedAt: new Date()
    };
    if (typeof sequence === 'number') updateSet.locationSequence = sequence;
    if (timestamp) updateSet.lastLocationUpdate = new Date(timestamp);
    if (calculatedBearing !== null) updateSet.lastBearing = calculatedBearing;

    const result = await User.findOneAndUpdate(
      updateQuery,
      { $set: updateSet },
      { new: true, select: 'locationSequence lastLocationUpdate location socketId lastBearing' }
    );

    if (!result && typeof sequence === 'number') {
      console.log(`⚠️ IGNORED: Out-of-order location update for driver ${driverId}`);
      return res.status(200).json({ 
        success: true, 
        message: 'Ignored (older sequence)',
        ignored: true,
        currentSequence: user.locationSequence,
        receivedSequence: sequence
      });
    }

    if (!result) {
      console.log(`❌ Failed to update driver location`);
      return res.status(500).json({ success: false, message: 'Failed to update location.' });
    }

    console.log(`✅ Driver location updated successfully`);

    // ✅ EMIT VIA SOCKET to customer with bearing
    if (tripId) {
      const trip = await Trip.findById(tripId).lean();
      if (trip && trip.customerId) {
        const customer = await User.findById(trip.customerId).select('socketId').lean();
        if (customer?.socketId) {
          const dropLat = trip.drop.coordinates[1];
          const dropLng = trip.drop.coordinates[0];
          const distance = calculateDistance(coords[1], coords[0], dropLat, dropLng);
          const distanceInMeters = distance * 1000;

          const payload = {
            tripId,
            driverId: user._id.toString(),
            latitude: coords[1],
            longitude: coords[0],
            bearing: calculatedBearing,         // 🚀 Flutter needs this
            heading: calculatedBearing,
            speed: speed ?? null,
            distanceToDestination: Math.round(distanceInMeters),
            sequence: result.locationSequence ?? sequence,
            timestamp: result.lastLocationUpdate ?? new Date()
          };

          io.to(customer.socketId).emit('driver:locationUpdate', payload);
          console.log(`📡 HTTP → Emitted location to customer socket: ${customer.socketId}`);
        } else {
          console.log(`⚠️ Customer socket not found for trip ${tripId}`);
        }
      }
    }

    console.log('');

    return res.status(200).json({ 
      success: true, 
      message: 'Driver location updated.',
      sequence: result.locationSequence,
      timestamp: result.lastLocationUpdate
    });
  } catch (err) {
    console.error(`❌ Error in updateDriverLocation: ${err.stack}`);
    return res.status(500).json({ success: false, message: 'Failed to update driver location.' });
  }
};

    
// ✅ Helper function for distance calculation
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // km
}

function toRad(value) {
  return value * Math.PI / 180;
}
/**
 * ✅ ENHANCED: Update customer location with sequence tracking
 * Prevents out-of-order updates from network delays
 */
const updateCustomerLocation = async (req, res) => {
  try {
    const { 
      customerId, 
      tripId, 
      coordinates, 
      latitude, 
      longitude,
      sequence,      // ✅ NEW: Sequence number from client
      timestamp      // ✅ NEW: Client timestamp
    } = req.body;

    console.log('');
    console.log('📍 CUSTOMER LOCATION UPDATE REQUEST');
    console.log(`   Customer ID: ${customerId}`);
    console.log(`   Sequence: ${sequence || 'N/A'}`);
    console.log(`   Timestamp: ${timestamp || 'N/A'}`);

    // 🔹 Resolve customer (either by _id or phone)
    const user = await resolveUserByIdOrPhone(customerId);
    if (!user) {
      console.log(`❌ Customer not found: ${customerId}`);
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    // 🔹 Normalize coordinates
    const coords = buildCoordinates(coordinates, latitude, longitude);
    if (!coords) {
      console.log('❌ Invalid coordinates');
      return res.status(400).json({ success: false, message: 'Coordinates required.' });
    }

    console.log(`   Coordinates: [${coords[1]}, ${coords[0]}]`);
    console.log(`   Current DB Sequence: ${user.locationSequence || 0}`);

    // ✅ ATOMIC UPDATE: Only if sequence is newer
    const updateQuery = {
      _id: user._id
    };

    // ✅ Add sequence check if provided by client
    if (typeof sequence === 'number') {
      updateQuery.$or = [
        { locationSequence: { $lt: sequence } },      // Newer sequence
        { locationSequence: { $exists: false } }      // First update
      ];
    }

    const updateData = {
      $set: {
        location: { type: 'Point', coordinates: coords },
        updatedAt: new Date()
      }
    };

    // ✅ Add sequence and timestamp if provided
    if (typeof sequence === 'number') {
      updateData.$set.locationSequence = sequence;
    }
    if (timestamp) {
      updateData.$set.lastLocationUpdate = new Date(timestamp);
    }

    const result = await User.findOneAndUpdate(
      updateQuery,
      updateData,
      { new: true, select: 'locationSequence lastLocationUpdate location' }
    );

    // ❌ Sequence check failed - older update
    if (!result && typeof sequence === 'number') {
      console.log(`⚠️ IGNORED: Out-of-order location update for customer ${customerId}`);
      console.log(`   Received sequence ${sequence} is older than current ${user.locationSequence}`);
      return res.status(200).json({ 
        success: true, 
        message: 'Ignored (older sequence)',
        ignored: true,
        currentSequence: user.locationSequence,
        receivedSequence: sequence
      });
    }

    if (!result) {
      console.log(`❌ Failed to update customer location`);
      return res.status(500).json({ success: false, message: 'Failed to update location.' });
    }

    console.log(`✅ Customer location updated successfully`);
    console.log(`   New sequence: ${result.locationSequence || 'N/A'}`);

    // 🔹 Broadcast to driver if trip is active
    if (tripId) {
      const trip = await Trip.findById(tripId).lean();
      if (trip && trip.assignedDriver) {
        const driver = await User.findById(trip.assignedDriver).select('socketId').lean();
        if (driver?.socketId) {
          const payload = {
            tripId,
            customerId: user._id.toString(),
            latitude: coords[1],
            longitude: coords[0],
            sequence: result.locationSequence,
            timestamp: result.lastLocationUpdate || new Date()
          };

          io.to(driver.socketId).emit('location:update_customer', payload);
          console.log(`📡 Sent customer location to driver socket: ${driver.socketId}`);
        } else {
          console.warn(`⚠️ No active socket found for driver ${trip.assignedDriver}`);
        }
      }
    }

    console.log('');

    return res.status(200).json({
      success: true,
      message: 'Customer location updated.',
      sequence: result.locationSequence,
      timestamp: result.lastLocationUpdate
    });
  } catch (err) {
    console.error(`❌ Error in updateCustomerLocation: ${err.stack}`);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to update customer location.' 
    });
  }
};

/**
 * Get latest driver location
 */
const getDriverLocation = async (req, res) => {
  try {
    const { driverId } = req.params;
    
    console.log(`🔍 Fetching driver location: ${driverId}`);
    
    const user = await resolveUserByIdOrPhone(driverId);

    if (!user || !user.location) {
      console.log(`❌ Driver not found or location missing: ${driverId}`);
      return res.status(404).json({ 
        success: false, 
        message: 'Driver not found or location missing.' 
      });
    }

    const [lng, lat] = user.location.coordinates || [null, null];
    
    console.log(`✅ Driver location found: [${lat}, ${lng}]`);
    
    return res.status(200).json({
      success: true,
      driverId: user._id,
      location: user.location,
      latitude: lat,
      longitude: lng,
      sequence: user.locationSequence,
      lastUpdate: user.lastLocationUpdate
    });
  } catch (err) {
    console.error(`❌ Error in getDriverLocation: ${err.stack}`);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch driver location.' 
    });
  }
};

/**
 * Get latest customer location
 */
const getCustomerLocation = async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🔍 Looking up customer location for ID: ${id}`);
    
    const user = await resolveUserByIdOrPhone(id);
    
    if (!user) {
      console.log(`❌ Customer not found: ${id}`);
      return res.status(404).json({ 
        success: false, 
        message: 'Customer not found' 
      });
    }

    if (!user.location || !user.location.coordinates) {
      console.log(`⚠️ Customer found but no location data: ${user._id}`);
      return res.status(200).json({
        success: true,
        message: 'Customer location not available',
        customerId: user._id,
        location: null,
        latitude: null,
        longitude: null,
        sequence: null,
        lastUpdate: null
      });
    }

    const [lng, lat] = user.location.coordinates;
    console.log(`✅ Customer location found: [${lat}, ${lng}]`);
    
    return res.status(200).json({
      success: true,
      customerId: user._id,
      latitude: lat,
      longitude: lng,
      sequence: user.locationSequence,
      lastUpdate: user.lastLocationUpdate
    });
  } catch (err) {
    console.error(`❌ Error in getCustomerLocation: ${err.stack}`);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch customer location.' 
    });
  }
};

/**
 * ✅ NEW: Get driver location by TRIP ID
 * Flutter polls this at /api/trip/:tripId/driver-location
 * This is the API fallback when socket isn't firing
 */
const getDriverLocationByTripId = async (req, res) => {
  try {
    const { tripId } = req.params;

    if (!tripId) {
      return res.status(400).json({ success: false, message: 'tripId required' });
    }

    const trip = await Trip.findById(tripId)
      .select('assignedDriver customerId status')
      .lean();

    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (!trip.assignedDriver) {
      return res.status(200).json({ success: false, message: 'No driver assigned yet' });
    }

    const driver = await User.findById(trip.assignedDriver)
      .select('location lastBearing locationSequence lastLocationUpdate name')
      .lean();

    if (!driver || !driver.location?.coordinates) {
      return res.status(200).json({ success: false, message: 'Driver location not available' });
    }

    const [lng, lat] = driver.location.coordinates;

    return res.status(200).json({
      success: true,
      driverLocation: {          // Flutter checks for this field
        lat,
        lng,
        latitude: lat,
        longitude: lng,
        bearing: driver.lastBearing ?? null,
        heading: driver.lastBearing ?? null,
        sequence: driver.locationSequence ?? null,
        lastUpdate: driver.lastLocationUpdate ?? null
      },
      location: {                // alternate field name
        lat,
        lng,
        latitude: lat,
        longitude: lng
      },
      tripId: tripId.toString(),
      driverId: driver._id.toString(),
      driverName: driver.name
    });
  } catch (err) {
    console.error(`❌ Error in getDriverLocationByTripId: ${err.stack}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch driver location.' });
  }
};

/**
 * ✅ NEW: Google Directions proxy endpoint
 * Flutter calls /api/directions?origin=lat,lng&destination=lat,lng&mode=driving
 * Proxies to Google Directions API and returns polyline
 */
const getDirections = async (req, res) => {
  try {
    const { origin, destination, mode = 'driving' } = req.query;

    if (!origin || !destination) {
      return res.status(400).json({ success: false, message: 'origin and destination required' });
    }

    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

    if (!GOOGLE_API_KEY) {
      console.error('❌ GOOGLE_API_KEY missing');
      return res.status(500).json({ success: false, message: 'Maps API not configured' });
    }

    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=${mode}&key=${GOOGLE_API_KEY}`;

    console.log(`🗺️ Directions: ${origin} → ${destination} (${mode})`);

    // Use built-in fetch (Node 18+) or fall back to http module
    let data;
    try {
      const response = await fetch(url);
      data = await response.json();
    } catch (fetchErr) {
      // Fallback: use https module
      const https = await import('https');
      data = await new Promise((resolve, reject) => {
        https.default.get(url, (resp) => {
          let body = '';
          resp.on('data', chunk => body += chunk);
          resp.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(e); }
          });
        }).on('error', reject);
      });
    }

    console.log(`🗺️ Google response status: ${data.status}`);

    if (data.status !== 'OK') {
      return res.status(200).json({
        status: data.status,
        error_message: data.error_message,
        routes: []
      });
    }

    // Return exactly what Flutter expects (same shape as Google Directions API)
    return res.status(200).json(data);
  } catch (err) {
    console.error(`❌ Error in getDirections: ${err.stack}`);
    return res.status(500).json({ success: false, message: 'Directions fetch failed' });
  }
};

export {
  updateDriverLocation,
  updateCustomerLocation,
  getDriverLocation,
  getCustomerLocation,
  getDriverLocationByTripId,  // ✅ NEW: For Flutter's /api/trip/:id/driver-location poll
  getDirections,              // ✅ NEW: For Flutter's /api/directions polyline
};
