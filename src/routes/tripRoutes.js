// src/routes/tripRoutes.js
import mongoose from 'mongoose';

import express from 'express';
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import CommissionSetting from '../models/CommissionSetting.js'; // ✅ ADDED
import DriverPlan        from '../models/DriverPlan.js';        // ✅ for incentive multiplier
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

Trip.schema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate();
  if (update.$set && update.$set.paymentCollected === true) {
    console.log('');
    console.log('⚠️ WARNING: paymentCollected being set to TRUE');
    console.log('📍 Call Stack:', new Error().stack);
    console.log('');
  }
  next();
});

Trip.schema.pre('updateOne', function(next) {
  const update = this.getUpdate();
  if (update.$set && update.$set.paymentCollected === true) {
    console.log('');
    console.log('⚠️ WARNING: paymentCollected being set to TRUE (updateOne)');
    console.log('📍 Call Stack:', new Error().stack);
    console.log('');
  }
  next();
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/trips/incentives/:driverId
// Driver app calls this on startup to preview perRideIncentive on the trip
// request card.  Applies the SAME plan-bonus multiplier as
// awardIncentivesToDriver() in tripController so both values always match.
// ════════════════════════════════════════════════════════════════════════════
router.get('/incentives/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;

    const driver = await User.findById(driverId)
      .select('vehicleType city')
      .lean();

    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    const vehicleType = driver.vehicleType || 'bike';
    const city        = driver.city        || 'all';

    // Check for active plan first — same priority as confirmCashCollection
    const activePlan = await DriverPlan.findOne({
      driver:     driverId,
      isActive:   true,
      expiryDate: { $gt: new Date() },
      $or: [
        { paymentStatus: 'completed' },
        { purchaseMethod: 'admin_assigned' },
      ],
    }).select('commissionRate noCommission perRideIncentive platformFeeFlat platformFeePercent planName').lean();

    let commissionRate, perRideIncentive, planApplied = false;

    if (activePlan) {
      commissionRate   = activePlan.noCommission ? 0 : (activePlan.commissionRate ?? 20);
      perRideIncentive = activePlan.perRideIncentive ?? 0;
      planApplied      = true;
    } else {
      const settings   = await CommissionSetting.getForVehicle(vehicleType, city);
      commissionRate   = settings.commissionPercent  ?? 20;
      perRideIncentive = settings.perRideIncentive   ?? 0;
    }

    return res.status(200).json({
      success: true,
      data: {
        perRideIncentive,
        commissionRate,
        planApplied,
        vehicleType,
        city,
      },
    });
  } catch (err) {
    console.error('❌ GET /api/trips/incentives/:driverId:', err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DEBUG ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

router.get('/debug/trip/:tripId/payment-status', async (req, res) => {
  try {
    const { tripId } = req.params;
    
    console.log('\n' + '='.repeat(70));
    console.log('💰 CHECKING PAYMENT STATUS');
    console.log('='.repeat(70));
    console.log(`Trip ID: ${tripId}`);
    
    const trip = await Trip.findById(tripId)
      .select('status rideStatus paymentCollected paymentCollectedAt completedAt')
      .lean();
    
    if (!trip) {
      console.log('❌ Trip not found');
      return res.status(404).json({ 
        success: false, 
        message: 'Trip not found' 
      });
    }
    
    console.log('\n📋 Trip Details:');
    console.log(`   Status: ${trip.status}`);
    console.log(`   Ride Status: ${trip.rideStatus || 'N/A'}`);
    console.log(`   Payment Collected: ${trip.paymentCollected}`);
    console.log(`   Payment Collected At: ${trip.paymentCollectedAt || 'N/A'}`);
    console.log(`   Completed At: ${trip.completedAt || 'N/A'}`);
    
    const needsCashCollection = trip.status === 'completed' && !trip.paymentCollected;
    
    console.log('\n🔍 Analysis:');
    console.log(`   Needs Cash Collection: ${needsCashCollection ? 'YES' : 'NO'}`);
    
    if (trip.paymentCollected && !trip.paymentCollectedAt) {
      console.log('   ⚠️ WARNING: paymentCollected is TRUE but no timestamp!');
    }
    
    console.log('='.repeat(70) + '\n');
    
    res.json({
      success: true,
      trip: {
        id: trip._id,
        status: trip.status,
        rideStatus: trip.rideStatus,
        paymentCollected: trip.paymentCollected,
        paymentCollectedAt: trip.paymentCollectedAt,
        completedAt: trip.completedAt
      },
      analysis: {
        needsCashCollection,
        suspiciousPayment: trip.paymentCollected && !trip.paymentCollectedAt,
        message: needsCashCollection ? 
          'Driver should collect cash now' : 
          trip.paymentCollected ? 
            'Cash already collected' : 
            'Trip not completed yet'
      }
    });
    
  } catch (err) {
    console.error('🔥 Error checking payment status:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/support/request", requestTripSupport);

router.post('/short', createShortTrip);
router.post('/parcel', createParcelTrip);
router.get('/driver/active/:driverId', getDriverActiveTrip);
router.post('/long', createLongTrip);
router.post('/:id/accept', acceptTrip);
router.post('/:id/reject', rejectTrip);
router.post('/complete', completeTrip);
router.post('/cancel-search', cancelTripByCustomer);
router.post('/cancel', cancelTrip);
router.get('/active/:customerId', getActiveRide);
router.post('/going-to-pickup', goingToPickup);
router.post('/start-ride', startRide);
router.post('/complete-ride', completeRideWithVerification);
router.post('/confirm-cash', confirmCashCollection);
router.get('/:tripId/driver-location', getDriverLocationByTripId);
router.get('/:tripId', getTripByIdWithPayment);

router.get('/debug/driver/:driverId/status', async (req, res) => {
  try {
    const driver = await User.findById(req.params.driverId)
      .select('name isOnline isBusy currentTripId canReceiveNewRequests lastTripCompletedAt');
    
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }
    
    const activeTrip = await Trip.findOne({
      assignedDriver: driver._id,
      status: { $in: ['driver_assigned', 'ride_started'] }
    });
    
    res.json({
      driver: {
        id: driver._id,
        name: driver.name,
        isOnline: driver.isOnline,
        isBusy: driver.isBusy,
        currentTripId: driver.currentTripId,
        canReceiveNewRequests: driver.canReceiveNewRequests,
        lastTripCompletedAt: driver.lastTripCompletedAt
      },
      activeTrip: activeTrip ? {
        id: activeTrip._id,
        status: activeTrip.status,
        rideStatus: activeTrip.rideStatus
      } : null,
      availability: {
        shouldReceiveRequests: !driver.isBusy && !driver.currentTripId,
        reason: driver.isBusy ? 'Driver is busy' : 
                driver.currentTripId ? 'Driver has active trip' : 
                'Driver is available'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/debug/ultimate-test/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const testTripId = '68f0138c156e2454fa076922';
    
    console.log('\n' + '='.repeat(80));
    console.log('🔬 ULTIMATE DEBUG TEST - Finding Why Updates Fail');
    console.log('='.repeat(80));
    
    const results = { initialState: null, tests: [], finalState: null, diagnosis: [] };
    
    const initial = await User.findById(driverId).lean();
    results.initialState = {
      isBusy: initial.isBusy,
      currentTripId: initial.currentTripId,
      updatedAt: initial.updatedAt
    };
    
    const test1Result = await User.findByIdAndUpdate(
      driverId,
      { $set: { isBusy: true, currentTripId: testTripId } },
      { new: true, runValidators: false }
    ).lean();
    
    const verify1 = await User.findById(driverId).lean();
    results.tests.push({
      name: 'findByIdAndUpdate',
      returnedUpdate: test1Result ? 'YES' : 'NO',
      actuallyUpdated: verify1.isBusy === true && verify1.currentTripId?.toString() === testTripId,
      values: { isBusy: verify1.isBusy, currentTripId: verify1.currentTripId }
    });

    const allWorked  = results.tests.every(t => t.actuallyUpdated);
    const noneWorked = results.tests.every(t => !t.actuallyUpdated);
    const someWorked = !allWorked && !noneWorked;

    if (allWorked)  results.diagnosis.push('✅ All update methods work correctly');
    if (noneWorked) results.diagnosis.push('❌ No update methods work — possible schema/middleware issue');
    if (someWorked) {
      results.diagnosis.push(`Working: ${results.tests.filter(t => t.actuallyUpdated).map(t => t.name).join(', ')}`);
      results.diagnosis.push(`Failing: ${results.tests.filter(t => !t.actuallyUpdated).map(t => t.name).join(', ')}`);
    }

    console.log('='.repeat(80));
    
    res.json({
      success: true,
      summary: { allMethodsWork: allWorked, noMethodsWork: noneWorked, someMethodsWork: someWorked },
      ...results
    });
    
  } catch (err) {
    console.error('🔥 Test failed:', err);
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

router.post('/debug/test-accept', async (req, res) => {
  try {
    const { driverId, tripId } = req.body;
    
    const driverBefore = await User.findById(driverId).lean();
    
    const updateResult = await User.findByIdAndUpdate(
      driverId,
      { $set: { isBusy: true, currentTripId: tripId } },
      { new: true, runValidators: false, lean: true }
    );
    
    const driverAfter = await User.findById(driverId).lean();
    
    const directQuery = await User.collection.findOne(
      { _id: new mongoose.Types.ObjectId(driverId) }
    );
    
    const updateOneResult = await User.updateOne(
      { _id: driverId },
      { $set: { isBusy: true, currentTripId: tripId, testField: 'test123' } }
    );
    
    const finalCheck = await User.findById(driverId).lean();
    
    res.json({
      success: true,
      states: {
        before:                  { isBusy: driverBefore.isBusy, currentTripId: driverBefore.currentTripId },
        afterFindByIdAndUpdate:  { isBusy: updateResult?.isBusy, currentTripId: updateResult?.currentTripId },
        afterFreshQuery:         { isBusy: driverAfter.isBusy, currentTripId: driverAfter.currentTripId },
        directMongoDB:           { isBusy: directQuery.isBusy, currentTripId: directQuery.currentTripId },
        final:                   { isBusy: finalCheck.isBusy, currentTripId: finalCheck.currentTripId, testField: finalCheck.testField }
      },
      diagnosis: {
        updateWorked: finalCheck.isBusy === true && finalCheck.testField === 'test123',
        possibleIssues: [
          finalCheck.isBusy !== true ? '❌ isBusy not updating' : '✅ isBusy updates',
          finalCheck.currentTripId?.toString() !== tripId ? '❌ currentTripId not updating' : '✅ currentTripId updates',
          finalCheck.testField !== 'test123' ? '❌ No fields are updating (schema/middleware issue)' : '✅ Updates work'
        ]
      }
    });
    
  } catch (err) {
    console.error('🔥 Test error:', err);
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

router.get('/debug/drivers', async (req, res) => {
  try {
    const { lat, lng, maxDistance = 10000, vehicleType = 'bike' } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat and lng query parameters required' });
    }

    const drivers = await User.find({
      isDriver: true,
      vehicleType,
      isOnline: true,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
          $maxDistance: parseInt(maxDistance),
        },
      },
    })
    .select('name phone vehicleType location isOnline isBusy currentTripId')
    .lean();

    res.json({ 
      success: true, 
      count: drivers.length,
      drivers: drivers.map(d => ({
        ...d,
        availability: !d.isBusy && !d.currentTripId ? 'AVAILABLE' : 'BUSY'
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/debug/all-drivers', async (req, res) => {
  try {
    const drivers = await User.find({ isDriver: true })
      .select('name phone vehicleType isOnline isBusy currentTripId canReceiveNewRequests')
      .lean();
    
    const stats = {
      total:     drivers.length,
      online:    drivers.filter(d => d.isOnline).length,
      busy:      drivers.filter(d => d.isBusy).length,
      available: drivers.filter(d => d.isOnline && !d.isBusy && !d.currentTripId).length,
      stuck:     drivers.filter(d => d.isBusy && !d.currentTripId).length
    };
    
    res.json({
      success: true,
      stats,
      drivers: drivers.map(d => ({
        id: d._id,
        name: d.name,
        phone: d.phone,
        vehicleType: d.vehicleType,
        isOnline: d.isOnline,
        isBusy: d.isBusy,
        currentTripId: d.currentTripId,
        status: d.isOnline && !d.isBusy && !d.currentTripId ? '✅ AVAILABLE' :
                d.isBusy && d.currentTripId ? '🚗 ON TRIP' :
                d.isBusy && !d.currentTripId ? '⚠️ STUCK (NEEDS CLEANUP)' :
                '📴 OFFLINE'
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;