// zoneRoutes.js
import express from 'express';
import {
  getZones,
  createZone,
  updateZone,
  deleteZone,
  addExclusionZone,
  removeExclusionZone,
  checkServiceAvailability,
  autoGenerateClusters,
}from '../controllers/zoneController.js';

const router = express.Router();

// Must be before /:id routes
router.post('/check',          checkServiceAvailability);
router.post('/auto-generate',  autoGenerateClusters);

router.get  ('/',                          getZones);
router.post ('/create',                    createZone);
router.put  ('/:id',                       updateZone);
router.delete('/:id',                      deleteZone);
router.post ('/:id/exclusion',             addExclusionZone);
router.delete('/:id/exclusion/:exclusionId', removeExclusionZone);

export default router;
