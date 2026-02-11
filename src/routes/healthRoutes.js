// src/routes/healthRoutes.js
import express from 'express';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';

const router = express.Router();

router.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {},
    };

    // Check database
    try {
      await User.findOne().limit(1);
      health.checks.database = 'ok';
    } catch (e) {
      health.checks.database = 'error';
      health.status = 'degraded';
    }

    // Check Socket.IO
    try {
      const socketCount = io ? io.engine.clientsCount : 0;
      health.checks.socketIO = {
        status: 'ok',
        connectedClients: socketCount,
      };
    } catch (e) {
      health.checks.socketIO = { status: 'error' };
      health.status = 'degraded';
    }

    // Check active trips
    try {
      const activeTrips = await Trip.countDocuments({
        status: { $in: ['requested', 'driver_assigned', 'ride_started'] },
      });
      health.checks.activeTrips = activeTrips;
    } catch (e) {
      health.checks.activeTrips = 'error';
    }

    // Check online drivers
    try {
      const onlineDrivers = await User.countDocuments({
        isDriver: true,
        isOnline: true,
      });
      health.checks.onlineDrivers = onlineDrivers;
    } catch (e) {
      health.checks.onlineDrivers = 'error';
    }

    // Check migration status
    try {
      const totalDrivers = await User.countDocuments({ isDriver: true });
      const migratedDrivers = await User.countDocuments({
        isDriver: true,
        currentTripId: { $exists: true },
      });
      
      health.checks.migration = {
        total: totalDrivers,
        migrated: migratedDrivers,
        percentage: totalDrivers > 0 ? Math.round((migratedDrivers / totalDrivers) * 100) : 0,
      };
      
      if (migratedDrivers < totalDrivers) {
        health.status = 'warning';
      }
    } catch (e) {
      health.checks.migration = 'error';
    }

    const statusCode = health.status === 'ok' ? 200 : health.status === 'warning' ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;