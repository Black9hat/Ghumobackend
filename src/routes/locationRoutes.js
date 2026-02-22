// src/routes/locationRoutes.js

import express from 'express';
import {
  updateDriverLocation,
  updateCustomerLocation,
  getDriverLocation,
  getCustomerLocation,
  getDirections,             // ✅ NEW: Polyline proxy for Flutter
} from '../controllers/locationController.js';

const router = express.Router();

/**
 * @route   GET /api/location/directions
 * @desc    Proxy Google Directions API for Flutter polyline drawing
 *          Flutter calls: GET /api/directions?origin=lat,lng&destination=lat,lng&mode=driving
 *          ⚠️  Register this ALSO at app-level as /api/directions (see note below)
 */
router.get('/directions', getDirections);

/**
 * @route   POST /api/location/update/driver
 * @desc    Update live driver GPS location
 */
router.post('/updateDriver', updateDriverLocation);

/**
 * @route   POST /api/location/update/customer
 * @desc    Update live customer GPS location
 */
router.post('/update/customer', updateCustomerLocation);

/**
 * @route   GET /api/location/driver/:id
 * @desc    Get current driver location by driverId
 */
router.get('/driver/:id', getDriverLocation);

/**
 * @route   GET /api/location/customer/:id
 * @desc    Get current customer location by customerId
 */
router.get('/customer/:id', getCustomerLocation); // ✅ Only this one!

export default router;
// ⚠️  IMPORTANT: Flutter calls /api/directions (not /api/location/directions)
// If locationRoutes is mounted at /api/location, add this to your app.js/server.js:
//
//   import { getDirections } from './controllers/locationController.js';
//   app.get('/api/directions', getDirections);
//
// OR mount locationRoutes at /api as well:
//   app.use('/api', locationRoutes);  (in addition to existing mount)
