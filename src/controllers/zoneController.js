// src/controllers/zoneController.js
import Zone from '../models/zone.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ray-casting point-in-polygon
// Returns true if (lat, lng) is inside the polygon
// ─────────────────────────────────────────────────────────────────────────────
const isPointInPolygon = (lat, lng, polygon) => {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    const intersects = (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/zones/create
// ─────────────────────────────────────────────────────────────────────────────
export const createZone = async (req, res) => {
  try {
    const {
      name, type, polygon, exclusionZones,
      serviceEnabled, surgeMultiplier, driverIncentive, vehicleTypes,
    } = req.body;

    const zone = await Zone.create({
      name, type, polygon,
      exclusionZones: exclusionZones || [],
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/zones/
// ─────────────────────────────────────────────────────────────────────────────
export const getZones = async (_req, res) => {
  try {
    const zones = await Zone.find().sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: zones });
  } catch (error) {
    console.error('❌ getZones error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/zones/:id
// Supports updating: serviceEnabled, surgeMultiplier, driverIncentive,
//                    vehicleTypes, polygon (resize/reshape), exclusionZones
// ─────────────────────────────────────────────────────────────────────────────
export const updateZone = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      serviceEnabled, surgeMultiplier, driverIncentive,
      vehicleTypes, polygon, exclusionZones, name, type,
    } = req.body;

    const allowedUpdates = {};
    if (serviceEnabled !== undefined) allowedUpdates.serviceEnabled = serviceEnabled;
    if (surgeMultiplier !== undefined) allowedUpdates.surgeMultiplier = surgeMultiplier;
    if (driverIncentive !== undefined) allowedUpdates.driverIncentive = driverIncentive;
    if (vehicleTypes !== undefined) allowedUpdates.vehicleTypes = vehicleTypes;
    if (polygon !== undefined) allowedUpdates.polygon = polygon;           // ✅ reshape/extend
    if (exclusionZones !== undefined) allowedUpdates.exclusionZones = exclusionZones; // ✅ add/remove holes
    if (name !== undefined) allowedUpdates.name = name;
    if (type !== undefined) allowedUpdates.type = type;

    const zone = await Zone.findByIdAndUpdate(
      id,
      { $set: allowedUpdates },
      { new: true, runValidators: true }
    );

    if (!zone) return res.status(404).json({ success: false, message: 'Zone not found.' });
    return res.status(200).json({ success: true, data: zone });
  } catch (error) {
    console.error('❌ updateZone error:', error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/zones/:id/exclusion  — add a new exclusion zone (hole)
// Body: { name: string, polygon: [{lat,lng}...] }
// ─────────────────────────────────────────────────────────────────────────────
export const addExclusionZone = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, polygon } = req.body;

    if (!polygon || polygon.length < 3) {
      return res.status(400).json({ success: false, message: 'Exclusion polygon needs at least 3 points.' });
    }

    const zone = await Zone.findByIdAndUpdate(
      id,
      { $push: { exclusionZones: { name: name || 'Excluded Area', polygon } } },
      { new: true, runValidators: true }
    );

    if (!zone) return res.status(404).json({ success: false, message: 'Zone not found.' });
    return res.status(200).json({ success: true, data: zone });
  } catch (error) {
    console.error('❌ addExclusionZone error:', error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/zones/:id/exclusion/:exclusionId  — remove a hole
// ─────────────────────────────────────────────────────────────────────────────
export const removeExclusionZone = async (req, res) => {
  try {
    const { id, exclusionId } = req.params;

    const zone = await Zone.findByIdAndUpdate(
      id,
      { $pull: { exclusionZones: { _id: exclusionId } } },
      { new: true }
    );

    if (!zone) return res.status(404).json({ success: false, message: 'Zone not found.' });
    return res.status(200).json({ success: true, data: zone });
  } catch (error) {
    console.error('❌ removeExclusionZone error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/zones/:id
// ─────────────────────────────────────────────────────────────────────────────
export const deleteZone = async (req, res) => {
  try {
    const { id } = req.params;
    const zone = await Zone.findByIdAndDelete(id);
    if (!zone) return res.status(404).json({ success: false, message: 'Zone not found.' });
    return res.status(200).json({ success: true, message: 'Zone deleted successfully.' });
  } catch (error) {
    console.error('❌ deleteZone error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/zones/check
// Body: { lat: number, lng: number }
//
// Logic:
//   1. Find all enabled zones
//   2. For each zone: check if point is inside main polygon
//   3. If yes: check if point is inside ANY exclusion zone → if so, BLOCKED
//   4. If inside main polygon and NOT in any exclusion → serviceAvailable: true
// ─────────────────────────────────────────────────────────────────────────────
export const checkServiceAvailability = async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ success: false, message: '`lat` and `lng` are required.' });
    }

    const enabledZones = await Zone.find({ serviceEnabled: true });

    for (const zone of enabledZones) {
      // Step 1: Is the point inside the main polygon?
      const inMainZone = isPointInPolygon(lat, lng, zone.polygon);
      if (!inMainZone) continue;

      // Step 2: Is the point inside any exclusion zone (hole)?
      const inExclusionZone = (zone.exclusionZones || []).some(ex =>
        isPointInPolygon(lat, lng, ex.polygon)
      );

      if (inExclusionZone) {
        // Point is in a hole — keep checking other zones
        // (another zone might still cover this point without a hole here)
        continue;
      }

      // ✅ Inside main zone, not in any hole — service available!
      return res.status(200).json({
        serviceAvailable: true,
        zoneName: zone.name,
        surgeMultiplier: zone.surgeMultiplier,
        vehicleTypes: zone.vehicleTypes,
        driverIncentive: zone.driverIncentive,
      });
    }

    return res.status(200).json({
      serviceAvailable: false,
      message: "We don't service this area yet. Please select a location within our coverage zone.",
    });
  } catch (error) {
    console.error('❌ checkServiceAvailability error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
