// routes/driverRideHistory.js
import express from 'express';
import {
  getDriverRideHistory,
  getDriverRideHistoryByDateRange,
  getDriverMonthlyEarnings,
} from '../controllers/driverRideHistoryController.js';

const router = express.Router();

/**
 * GET /api/driver/ride-history/:driverId
 * Get all completed rides for a driver with fare breakdown
 */
router.get('/ride-history/:driverId', getDriverRideHistory);

/**
 * GET /api/driver/ride-history/:driverId/range
 * Get rides within a specific date range
 * Query params: startDate, endDate (ISO date strings)
 */
router.get('/ride-history/:driverId/range', getDriverRideHistoryByDateRange);

/**
 * GET /api/driver/ride-history/:driverId/monthly
 * Get monthly earnings breakdown by day
 * Query params: year, month (optional, defaults to current month)
 */
router.get('/ride-history/:driverId/monthly', getDriverMonthlyEarnings);

export default router;

// ===========================================
// ADD THIS TO YOUR server.js OR app.js
// ===========================================
/*

import driverRideHistoryRoutes from './routes/driverRideHistory.js';

// Add this with your other routes
app.use('/api/driver', driverRideHistoryRoutes);

*/