// src/routes/tripRoutes.js
import express from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import {
  createShortTrip,
  createParcelTrip,
  createLongTrip,
  acceptTrip,
  getTripByIdWithPayment,
  rejectTrip,
  completeTrip,
  cancelTrip,
  getTripById,
  goingToPickup,
  startRide,
  getActiveRide,
  requestTripSupport,
  cancelTripByCustomer,
  getDriverActiveTrip,
  completeRideWithVerification,
  confirmCashCollection,
  getDriverLocationByTripId,
} from '../controllers/tripController.js';

const router = express.Router();

// ⚠️  DO NOT add Trip.schema.pre() hooks here.
//     Schema middleware must be registered BEFORE mongoose.model() is called,
//     which happens at import time in models/Trip.js.
//     Calling Trip.schema.pre() here has zero effect and just pollutes logs.

// ═══════════════════════════════════════════════════════════════════
// SUPPORT
// ═══════════════════════════════════════════════════════════════════
router.post('/support/request', requestTripSupport);

// ═══════════════════════════════════════════════════════════════════
// TRIP CREATION
// ═══════════════════════════════════════════════════════════════════
router.post('/short',  createShortTrip);
router.post('/parcel', createParcelTrip);
router.post('/long',   createLongTrip);

// ═══════════════════════════════════════════════════════════════════
// DRIVER ACTIONS
// ═══════════════════════════════════════════════════════════════════
router.get('/driver/active/:driverId', getDriverActiveTrip);
router.post('/:id/accept', acceptTrip);
router.post('/:id/reject', rejectTrip);

// ═══════════════════════════════════════════════════════════════════
// TRIP FLOW
// ═══════════════════════════════════════════════════════════════════
router.post('/complete',       completeTrip);
router.post('/cancel-search',  cancelTripByCustomer);
router.post('/cancel',         cancelTrip);
router.post('/going-to-pickup', goingToPickup);
router.post('/start-ride',     startRide);
router.post('/complete-ride',  completeRideWithVerification);
router.post('/confirm-cash',   confirmCashCollection);

// ═══════════════════════════════════════════════════════════════════
// CUSTOMER QUERIES
// ═══════════════════════════════════════════════════════════════════
router.get('/active/:customerId', getActiveRide);

// ✅ MUST be before /:tripId to avoid route collision
router.get('/:tripId/driver-location', getDriverLocationByTripId);
router.get('/:tripId', getTripByIdWithPayment);

// ═══════════════════════════════════════════════════════════════════
// DEBUG ENDPOINTS (dev-only — guarded in prod)
// ═══════════════════════════════════════════════════════════════════
const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
  // Check payment status of a trip
  router.get('/debug/trip/:tripId/payment-status', async (req, res) => {
    try {
      const trip = await Trip.findById(req.params.tripId)
        .select('status paymentCollected paymentCollectedAt paymentStatus walletUpdated walletUpdatedAt completedAt finalFare fare')
        .lean();
      if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });

      res.json({
        success: true,
        trip: { ...trip, id: trip._id },
        analysis: {
          needsCashCollection: trip.status === 'completed' && !trip.paymentCollected,
          walletAlreadyUpdated: trip.walletUpdated,
          suspiciousPayment: trip.paymentCollected && !trip.paymentCollectedAt,
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Release a stuck driver manually
  router.post('/debug/release-driver/:driverId', async (req, res) => {
    try {
      const result = await User.findByIdAndUpdate(
        req.params.driverId,
        { $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: false } },
        { new: true }
      ).select('name isBusy currentTripId').lean();
      if (!result) return res.status(404).json({ success: false, message: 'Driver not found' });
      res.json({ success: true, message: 'Driver released', driver: result });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Driver availability status
  router.get('/debug/driver/:driverId/status', async (req, res) => {
    try {
      const driver = await User.findById(req.params.driverId)
        .select('name isOnline isBusy currentTripId canReceiveNewRequests lastTripCompletedAt')
        .lean();
      if (!driver) return res.status(404).json({ error: 'Driver not found' });

      const activeTrip = await Trip.findOne({
        assignedDriver: driver._id,
        status: { $in: ['driver_assigned', 'ride_started'] },
      }).lean();

      res.json({ driver: { ...driver, id: driver._id }, activeTrip: activeTrip ? { id: activeTrip._id, status: activeTrip.status } : null });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Find nearby drivers
  router.get('/debug/drivers', async (req, res) => {
    try {
      const { lat, lng, maxDistance = 10000, vehicleType = 'bike' } = req.query;
      if (!lat || !lng) return res.status(400).json({ success: false, message: 'lat and lng required' });

      const drivers = await User.find({
        isDriver: true, vehicleType, isOnline: true,
        location: { $near: { $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] }, $maxDistance: parseInt(maxDistance) } },
      }).select('name phone vehicleType location isOnline isBusy currentTripId').lean();

      res.json({ success: true, count: drivers.length, drivers: drivers.map(d => ({ ...d, availability: !d.isBusy && !d.currentTripId ? 'AVAILABLE' : 'BUSY' })) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });

  // All drivers summary
  router.get('/debug/all-drivers', async (req, res) => {
    try {
      const drivers = await User.find({ isDriver: true })
        .select('name phone vehicleType isOnline isBusy currentTripId canReceiveNewRequests').lean();

      const stats = {
        total:     drivers.length,
        online:    drivers.filter(d =>  d.isOnline).length,
        busy:      drivers.filter(d =>  d.isBusy).length,
        available: drivers.filter(d =>  d.isOnline && !d.isBusy && !d.currentTripId).length,
        stuck:     drivers.filter(d =>  d.isBusy && !d.currentTripId).length,
      };

      res.json({
        success: true, stats,
        drivers: drivers.map(d => ({
          id: d._id, name: d.name, phone: d.phone, vehicleType: d.vehicleType,
          isOnline: d.isOnline, isBusy: d.isBusy, currentTripId: d.currentTripId,
          status: d.isOnline && !d.isBusy && !d.currentTripId ? '✅ AVAILABLE' :
                  d.isBusy && d.currentTripId ? '🚗 ON TRIP' :
                  d.isBusy && !d.currentTripId ? '⚠️ STUCK' : '📴 OFFLINE',
        })),
      });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });
}

export default router;