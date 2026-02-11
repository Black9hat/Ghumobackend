// src/routes/tripRoutes.js
import mongoose from 'mongoose'; // Add at top if not present

import express from 'express';
import User from '../models/User.js'; // ✅ ADD THIS
import Trip from '../models/Trip.js'; // ✅ ADD THIS
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
} from '../controllers/tripController.js';
const router = express.Router();

Trip.schema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate();
  
  // Check if paymentCollected is being set to true
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

// ============================================
// ADD THIS DEBUG ENDPOINT TO tripRoutes.js
// ============================================

// Debug: Check payment collection status
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
    
    // Check if trip is completed but payment not collected
    const needsCashCollection = trip.status === 'completed' && !trip.paymentCollected;
    
    console.log('\n🔍 Analysis:');
    console.log(`   Needs Cash Collection: ${needsCashCollection ? 'YES' : 'NO'}`);
    
    if (trip.paymentCollected && !trip.paymentCollectedAt) {
      console.log('   ⚠️ WARNING: paymentCollected is TRUE but no timestamp!');
      console.log('   This indicates payment was marked collected incorrectly');
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
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});
router.post("/support/request", requestTripSupport);

/**
 * @route   POST /api/trip/short
 * @desc    Create a short city ride
 */
router.post('/short', createShortTrip);
router.get('/:tripId', getTripByIdWithPayment);
/**
 * @route   POST /api/trip/parcel
 * @desc    Create a parcel delivery ride
 */
router.post('/parcel', createParcelTrip);
router.get('/driver/active/:driverId', getDriverActiveTrip);

/**
 * @route   POST /api/trip/long
 * @desc    Create a long intercity ride
 */
router.post('/long', createLongTrip);

/**
 * @route   POST /api/trip/:id/accept
 * @desc    Driver accepts the trip
 */
router.post('/:id/accept', acceptTrip);

/**
 * @route   POST /api/trip/:id/reject
 * @desc    Driver rejects the trip
 */
router.post('/:id/reject', rejectTrip);

router.post('/complete', completeTrip);
router.post('/cancel-search', cancelTripByCustomer);
router.post('/cancel', cancelTrip);

/**
 * @route   GET /api/trip/active/:customerId
 * @desc    Check if customer has an active ride
 */
router.get('/active/:customerId', getActiveRide);

/**
 * @route   GET /api/trip/:id
 * @desc    Get trip details by ID
 */

/**
 * @route   POST /api/trip/going-to-pickup
 * @desc    Driver marks going to pickup
 */
router.post('/going-to-pickup', goingToPickup);

/**
 * @route   POST /api/trip/start-ride
 * @desc    Driver starts the ride with OTP
 */
router.post('/start-ride', startRide);

/**
 * @route   POST /api/trip/complete-ride
 * @desc    Driver completes the ride
 */
router.post('/complete-ride', completeRideWithVerification);

/**
 * @route   POST /api/trip/confirm-cash
 * @desc    Driver confirms cash collection
 */
router.post('/confirm-cash', confirmCashCollection);

// ========================================
// 🐛 DEBUG ENDPOINTS
// ========================================

/**
 * @route   GET /api/trip/debug/driver/:driverId/status
 * @desc    Get detailed driver availability status
 */
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

/**
 * @route   GET /api/trip/debug/drivers
 * @desc    Find nearby drivers (for testing)
 */
// Add this to tripRoutes.js - TEMPORARY DEBUG ENDPOINT
// Add to tripRoutes.js - Complete diagnostic test

router.post('/debug/ultimate-test/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const testTripId = '68f0138c156e2454fa076922';
    
    console.log('\n' + '='.repeat(80));
    console.log('🔬 ULTIMATE DEBUG TEST - Finding Why Updates Fail');
    console.log('='.repeat(80));
    console.log(`Testing driver: ${driverId}`);
    console.log(`Test trip ID: ${testTripId}`);
    
    const results = {
      initialState: null,
      tests: [],
      finalState: null,
      diagnosis: []
    };
    
    // ============================================
    // TEST 0: Initial State
    // ============================================
    console.log('\n📊 TEST 0: Getting initial state...');
    const initial = await User.findById(driverId).lean();
    results.initialState = {
      isBusy: initial.isBusy,
      currentTripId: initial.currentTripId,
      updatedAt: initial.updatedAt
    };
    console.log('Initial:', results.initialState);
    
    // ============================================
    // TEST 1: findByIdAndUpdate
    // ============================================
    console.log('\n🧪 TEST 1: findByIdAndUpdate with $set...');
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
      values: {
        isBusy: verify1.isBusy,
        currentTripId: verify1.currentTripId
      }
    });
    console.log('Updated?', results.tests[0].actuallyUpdated);
    
    // Reset for next test
    await User.findByIdAndUpdate(driverId, { 
      $set: { isBusy: false, currentTripId: null } 
    });
    await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
    
    // ============================================
    // TEST 2: updateOne
    // ============================================
    console.log('\n🧪 TEST 2: updateOne with $set...');
    const test2Result = await User.updateOne(
      { _id: driverId },
      { $set: { isBusy: true, currentTripId: testTripId } }
    );
    
    const verify2 = await User.findById(driverId).lean();
    results.tests.push({
      name: 'updateOne',
      matchedCount: test2Result.matchedCount,
      modifiedCount: test2Result.modifiedCount,
      actuallyUpdated: verify2.isBusy === true && verify2.currentTripId?.toString() === testTripId,
      values: {
        isBusy: verify2.isBusy,
        currentTripId: verify2.currentTripId
      }
    });
    console.log('Updated?', results.tests[1].actuallyUpdated);
    
    // Reset
    await User.findByIdAndUpdate(driverId, { 
      $set: { isBusy: false, currentTripId: null } 
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // ============================================
    // TEST 3: Direct MongoDB (bypass Mongoose)
    // ============================================
    console.log('\n🧪 TEST 3: Direct MongoDB collection.updateOne...');
    const test3Result = await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(driverId) },
      { $set: { isBusy: true, currentTripId: new mongoose.Types.ObjectId(testTripId) } }
    );
    
    const verify3 = await User.collection.findOne(
      { _id: new mongoose.Types.ObjectId(driverId) }
    );
    results.tests.push({
      name: 'Direct MongoDB',
      matchedCount: test3Result.matchedCount,
      modifiedCount: test3Result.modifiedCount,
      actuallyUpdated: verify3.isBusy === true,
      values: {
        isBusy: verify3.isBusy,
        currentTripId: verify3.currentTripId
      }
    });
    console.log('Updated?', results.tests[2].actuallyUpdated);
    
    // Reset
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(driverId) },
      { $set: { isBusy: false, currentTripId: null } }
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // ============================================
    // TEST 4: Save method
    // ============================================
    console.log('\n🧪 TEST 4: Using document.save()...');
    const doc = await User.findById(driverId);
    doc.isBusy = true;
    doc.currentTripId = testTripId;
    await doc.save();
    
    const verify4 = await User.findById(driverId).lean();
    results.tests.push({
      name: 'document.save()',
      actuallyUpdated: verify4.isBusy === true && verify4.currentTripId?.toString() === testTripId,
      values: {
        isBusy: verify4.isBusy,
        currentTripId: verify4.currentTripId
      }
    });
    console.log('Updated?', results.tests[3].actuallyUpdated);
    
    // ============================================
    // Final State
    // ============================================
    console.log('\n📊 FINAL STATE:');
    const finalState = await User.findById(driverId).lean();
    results.finalState = {
      isBusy: finalState.isBusy,
      currentTripId: finalState.currentTripId,
      updatedAt: finalState.updatedAt
    };
    console.log('Final:', results.finalState);
    
    // ============================================
    // Diagnosis
    // ============================================
    console.log('\n🔍 DIAGNOSIS:');
    
    const allWorked = results.tests.every(t => t.actuallyUpdated);
    const noneWorked = results.tests.every(t => !t.actuallyUpdated);
    const someWorked = !allWorked && !noneWorked;
    
    if (allWorked) {
      results.diagnosis.push('✅ ALL update methods work - Issue is in acceptTrip logic');
      results.diagnosis.push('Check: Race conditions, transaction rollbacks, or timing issues');
      console.log('✅ Updates work fine - check acceptTrip flow');
    } else if (noneWorked) {
      results.diagnosis.push('❌ NO update methods work - Database/Schema issue');
      results.diagnosis.push('Check: Schema middleware, database permissions, or field conflicts');
      console.log('❌ NO updates work - major issue!');
    } else {
      results.diagnosis.push('⚠️ Some methods work, others don\'t - Mongoose middleware issue');
      results.diagnosis.push(`Working: ${results.tests.filter(t => t.actuallyUpdated).map(t => t.name).join(', ')}`);
      results.diagnosis.push(`Failing: ${results.tests.filter(t => !t.actuallyUpdated).map(t => t.name).join(', ')}`);
      console.log('⚠️ Inconsistent - middleware interfering');
    }
    
    // Check if middleware exists
    const hasPreSave = User.schema._pres && User.schema._pres.get('save')?.length > 0;
    const hasPreUpdate = User.schema._pres && User.schema._pres.get('findOneAndUpdate')?.length > 0;
    
    if (hasPreSave || hasPreUpdate) {
      results.diagnosis.push(`⚠️ Middleware detected: ${hasPreSave ? 'pre(save)' : ''} ${hasPreUpdate ? 'pre(findOneAndUpdate)' : ''}`);
      console.log('⚠️ Found middleware hooks');
    }
    
    console.log('='.repeat(80));
    console.log('TEST COMPLETE\n');
    
    res.json({
      success: true,
      summary: {
        allMethodsWork: allWorked,
        noMethodsWork: noneWorked,
        someMethodsWork: someWorked
      },
      ...results
    });
    
  } catch (err) {
    console.error('🔥 Test failed:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message,
      stack: err.stack 
    });
  }
});
router.post('/debug/test-accept', async (req, res) => {
  try {
    const { driverId, tripId } = req.body;
    
    console.log('\n' + '='.repeat(80));
    console.log('🧪 DEEP DEBUG: Testing Accept Trip Flow');
    console.log('='.repeat(80));
    console.log(`Driver ID: ${driverId}`);
    console.log(`Trip ID: ${tripId}`);
    console.log('='.repeat(80));
    
    // STEP 1: Get initial state
    console.log('\n📊 STEP 1: Getting initial driver state...');
    const driverBefore = await User.findById(driverId).lean();
    console.log('Driver state BEFORE:', {
      _id: driverBefore._id,
      name: driverBefore.name,
      isBusy: driverBefore.isBusy,
      currentTripId: driverBefore.currentTripId,
      isOnline: driverBefore.isOnline,
      // Show ALL fields to check for duplicates
      allKeys: Object.keys(driverBefore)
    });
    
    // STEP 2: Try the update
    console.log('\n📝 STEP 2: Attempting update...');
    const updateResult = await User.findByIdAndUpdate(
      driverId,
      {
        $set: {
          isBusy: true,
          currentTripId: tripId
        }
      },
      { 
        new: true,
        runValidators: false,
        lean: true
      }
    );
    
    console.log('Update result:', {
      success: updateResult ? 'YES' : 'NO',
      isBusy: updateResult?.isBusy,
      currentTripId: updateResult?.currentTripId
    });
    
    // STEP 3: Verify with fresh query
    console.log('\n🔍 STEP 3: Fresh query to verify...');
    const driverAfter = await User.findById(driverId).lean();
    console.log('Driver state AFTER:', {
      _id: driverAfter._id,
      name: driverAfter.name,
      isBusy: driverAfter.isBusy,
      currentTripId: driverAfter.currentTripId,
      isOnline: driverAfter.isOnline
    });
    
    // STEP 4: Direct MongoDB query (bypass Mongoose)
    console.log('\n🔧 STEP 4: Direct MongoDB check...');
    const directQuery = await User.collection.findOne(
      { _id: new mongoose.Types.ObjectId(driverId) }
    );
    console.log('Direct MongoDB result:', {
      isBusy: directQuery.isBusy,
      currentTripId: directQuery.currentTripId,
      hasMultipleCurrentTripId: Object.keys(directQuery).filter(k => k.includes('currentTripId')).length
    });
    
    // STEP 5: Try using updateOne instead
    console.log('\n🔄 STEP 5: Trying updateOne...');
    const updateOneResult = await User.updateOne(
      { _id: driverId },
      { 
        $set: { 
          isBusy: true,
          currentTripId: tripId,
          testField: 'test123' // Add a test field to see if ANY update works
        } 
      }
    );
    console.log('updateOne result:', updateOneResult);
    
    // STEP 6: Check again
    console.log('\n✅ STEP 6: Final verification...');
    const finalCheck = await User.findById(driverId).lean();
    console.log('Final state:', {
      isBusy: finalCheck.isBusy,
      currentTripId: finalCheck.currentTripId,
      testField: finalCheck.testField,
      updatedAt: finalCheck.updatedAt
    });
    
    console.log('\n' + '='.repeat(80));
    console.log('🏁 TEST COMPLETE');
    console.log('='.repeat(80) + '\n');
    
    res.json({
      success: true,
      states: {
        before: {
          isBusy: driverBefore.isBusy,
          currentTripId: driverBefore.currentTripId
        },
        afterFindByIdAndUpdate: {
          isBusy: updateResult?.isBusy,
          currentTripId: updateResult?.currentTripId
        },
        afterFreshQuery: {
          isBusy: driverAfter.isBusy,
          currentTripId: driverAfter.currentTripId
        },
        directMongoDB: {
          isBusy: directQuery.isBusy,
          currentTripId: directQuery.currentTripId
        },
        final: {
          isBusy: finalCheck.isBusy,
          currentTripId: finalCheck.currentTripId,
          testField: finalCheck.testField
        }
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
    res.status(500).json({ 
      success: false, 
      error: err.message,
      stack: err.stack 
    });
  }
});
router.get('/debug/drivers', async (req, res) => {
  try {
    const { lat, lng, maxDistance = 10000, vehicleType = 'bike' } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({ 
        success: false, 
        message: 'lat and lng query parameters required' 
      });
    }

    const drivers = await User.find({
      isDriver: true,
      vehicleType,
      isOnline: true,
      location: {
        $near: {
          $geometry: { 
            type: 'Point', 
            coordinates: [parseFloat(lng), parseFloat(lat)] 
          },
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

/**
 * @route   GET /api/trip/debug/all-drivers
 * @desc    Get all drivers and their status (admin only)
 */
router.get('/debug/all-drivers', async (req, res) => {
  try {
    const drivers = await User.find({ isDriver: true })
      .select('name phone vehicleType isOnline isBusy currentTripId canReceiveNewRequests')
      .lean();
    
    const stats = {
      total: drivers.length,
      online: drivers.filter(d => d.isOnline).length,
      busy: drivers.filter(d => d.isBusy).length,
      available: drivers.filter(d => d.isOnline && !d.isBusy && !d.currentTripId).length,
      stuck: drivers.filter(d => d.isBusy && !d.currentTripId).length
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