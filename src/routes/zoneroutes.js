import express from 'express';
import {
  createZone,
  getZones,
  updateZone,
  deleteZone,
  checkServiceAvailability,
} from '../controllers/zonecontroller.js';

const router = express.Router();

// POST   /api/zones/create  → create a new zone
router.post('/create', createZone);

// GET    /api/zones/         → get all zones
router.get('/', getZones);

// PUT    /api/zones/:id      → update serviceEnabled / surgeMultiplier / driverIncentive / vehicleTypes
router.put('/:id', updateZone);

// DELETE /api/zones/:id      → delete a zone
router.delete('/:id', deleteZone);

// POST   /api/zones/check    → check if a lat/lng is within a service zone
// Body: { "lat": number, "lng": number }
router.post('/check', checkServiceAvailability);

export default router;
