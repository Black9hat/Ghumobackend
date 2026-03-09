import Zone from '../models/zone.js';

/**
 * Ray-casting point-in-polygon algorithm.
 * Returns true if the point (lat, lng) is inside the given polygon.
 * @param {number} lat
 * @param {number} lng
 * @param {Array<{lat: number, lng: number}>} polygon
 * @returns {boolean}
 */
const isPointInPolygon = (lat, lng, polygon) => {
  let inside = false;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;

    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (intersects) inside = !inside;
  }

  return inside;
};

// ─────────────────────────────────────────────
// POST /api/zones/create
// ─────────────────────────────────────────────
export const createZone = async (req, res) => {
  try {
    const { name, type, polygon, serviceEnabled, surgeMultiplier, driverIncentive, vehicleTypes } =
      req.body;

    const zone = await Zone.create({
      name,
      type,
      polygon,
      serviceEnabled,
      surgeMultiplier,
      driverIncentive,
      vehicleTypes,
    });

    return res.status(201).json({ success: true, data: zone });
  } catch (error) {
    console.error('❌ createZone error:', error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/zones/
// ─────────────────────────────────────────────
export const getZones = async (_req, res) => {
  try {
    const zones = await Zone.find().sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: zones });
  } catch (error) {
    console.error('❌ getZones error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// PUT /api/zones/:id
// ─────────────────────────────────────────────
export const updateZone = async (req, res) => {
  try {
    const { id } = req.params;
    const { serviceEnabled, surgeMultiplier, driverIncentive, vehicleTypes } = req.body;

    const allowedUpdates = {};
    if (serviceEnabled !== undefined) allowedUpdates.serviceEnabled = serviceEnabled;
    if (surgeMultiplier !== undefined) allowedUpdates.surgeMultiplier = surgeMultiplier;
    if (driverIncentive !== undefined) allowedUpdates.driverIncentive = driverIncentive;
    if (vehicleTypes !== undefined) allowedUpdates.vehicleTypes = vehicleTypes;

    const zone = await Zone.findByIdAndUpdate(
      id,
      { $set: allowedUpdates },
      { new: true, runValidators: true }
    );

    if (!zone) {
      return res.status(404).json({ success: false, message: 'Zone not found.' });
    }

    return res.status(200).json({ success: true, data: zone });
  } catch (error) {
    console.error('❌ updateZone error:', error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// DELETE /api/zones/:id
// ─────────────────────────────────────────────
export const deleteZone = async (req, res) => {
  try {
    const { id } = req.params;

    const zone = await Zone.findByIdAndDelete(id);

    if (!zone) {
      return res.status(404).json({ success: false, message: 'Zone not found.' });
    }

    return res.status(200).json({ success: true, message: 'Zone deleted successfully.' });
  } catch (error) {
    console.error('❌ deleteZone error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/zones/check
// Body: { lat: number, lng: number }
// ─────────────────────────────────────────────
export const checkServiceAvailability = async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ success: false, message: '`lat` and `lng` are required.' });
    }

    const enabledZones = await Zone.find({ serviceEnabled: true });

    for (const zone of enabledZones) {
      if (isPointInPolygon(lat, lng, zone.polygon)) {
        return res.status(200).json({
          serviceAvailable: true,
          zoneName: zone.name,
          surgeMultiplier: zone.surgeMultiplier,
          vehicleTypes: zone.vehicleTypes,
        });
      }
    }

    return res.status(200).json({
      serviceAvailable: false,
      message: 'Service not available in this area yet',
    });
  } catch (error) {
    console.error('❌ checkServiceAvailability error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
