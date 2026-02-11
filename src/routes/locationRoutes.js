// src/routes/locationRoutes.js

import express from 'express';
import {
  updateDriverLocation,
  updateCustomerLocation,
  getDriverLocation,
  getCustomerLocation,
} from '../controllers/locationController.js';

const router = express.Router();

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