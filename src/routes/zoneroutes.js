// src/routes/zoneRoutes.js
import express from 'express';
import {
  createZone,
  getZones,
  updateZone,
  deleteZone,
  checkServiceAvailability,
  addExclusionZone,
  removeExclusionZone,
} from '../controllers/zoneController.js';

const router = express.Router();

// ── Zone CRUD ────────────────────────────────────────────────
router.post('/create', createZone);             // Create zone with polygon
router.get('/', getZones);                      // Get all zones (with exclusions)
router.put('/:id', updateZone);                 // Update zone (polygon, settings, exclusions)
router.delete('/:id', deleteZone);              // Delete zone

// ── Exclusion Zones (Holes) ──────────────────────────────────
router.post('/:id/exclusion', addExclusionZone);              // Add a hole to a zone
router.delete('/:id/exclusion/:exclusionId', removeExclusionZone); // Remove a hole

// ── Customer-facing check ────────────────────────────────────
// IMPORTANT: /check must be BEFORE /:id to avoid conflict
router.post('/check', checkServiceAvailability); // Check if lat/lng is in service

export default router;
