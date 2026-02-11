// routes/coupons.routes.js
import express from 'express';
import admin from 'firebase-admin';
import Coupon from '../models/Coupon.js';
import CouponUsage from '../models/CouponUsage.js';
import Customer from '../models/User.js';
import Trip from '../models/Trip.js';

const router = express.Router();

// Middleware to verify Firebase token
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// GET - Fetch all active coupons available to customer
// 🚗 UPDATED: Now includes vehicle type filter
router.get('/available/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { vehicleType } = req.query; // 🚗 NEW: Optional vehicle type filter

    console.log(`🎫 Fetching available coupons for customer: ${customerId}, vehicle: ${vehicleType || 'all'}`);

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get customer's completed rides count
    const completedRidesCount = await Trip.countDocuments({
      customerId,
      status: 'COMPLETED',
    });

    const now = new Date();

    // Fetch all active and valid coupons
    const allCoupons = await Coupon.find({
      isActive: true,
      validFrom: { $lte: now },
      validUntil: { $gte: now },
    }).sort({ createdAt: -1 });

    // Check eligibility for each coupon
    const couponsWithEligibility = await Promise.all(
      allCoupons.map(async (coupon) => {
        // Check if user has already used this coupon
        const userUsageCount = await CouponUsage.countDocuments({
          customerId,
          couponId: coupon._id,
        });

        // Check eligibility
        let isEligible = true;
        let reason = '';

        // 🚗 NEW: Check vehicle applicability
        const isVehicleApplicable = coupon.isApplicableForVehicle(vehicleType);
        if (!isVehicleApplicable) {
          isEligible = false;
          const applicableList = coupon.applicableVehicles.filter(v => v !== 'all').join(', ');
          reason = `Only applicable for: ${applicableList || 'specific vehicles'}`;
        }

        // 1. Check max usage per user
        if (isEligible && userUsageCount >= coupon.maxUsagePerUser) {
          isEligible = false;
          reason = 'You have already used this coupon';
        }

        // 2. Check total usage limit
        if (isEligible &&
          coupon.totalUsageLimit !== null &&
          coupon.currentUsageCount >= coupon.totalUsageLimit
        ) {
          isEligible = false;
          reason = 'Coupon usage limit reached';
        }

        // 3. Check user type eligibility
        if (isEligible && coupon.eligibleUserTypes.includes('NEW') && !coupon.eligibleUserTypes.includes('ALL') && completedRidesCount > 0) {
          isEligible = false;
          reason = 'This coupon is only for new users';
        }

        if (isEligible && coupon.eligibleUserTypes.includes('EXISTING') && !coupon.eligibleUserTypes.includes('ALL') && completedRidesCount === 0) {
          isEligible = false;
          reason = 'This coupon is only for existing users';
        }

        // 4. Check minimum rides completed
        if (isEligible && completedRidesCount < coupon.minRidesCompleted) {
          isEligible = false;
          reason = `Complete ${coupon.minRidesCompleted - completedRidesCount} more ride(s) to unlock`;
        }

        // 5. Check maximum rides completed
        if (isEligible &&
          coupon.maxRidesCompleted !== null &&
          completedRidesCount > coupon.maxRidesCompleted
        ) {
          isEligible = false;
          reason = 'You have exceeded the maximum rides for this coupon';
        }

        // 6. Check ride number applicability
        const nextRideNumber = completedRidesCount + 1;

        if (isEligible && coupon.applicableFor === 'FIRST_RIDE' && nextRideNumber !== 1) {
          isEligible = false;
          reason = 'Valid only for first ride';
        }

        if (isEligible && coupon.applicableFor === 'NTH_RIDE' && nextRideNumber !== coupon.rideNumber) {
          isEligible = false;
          if (nextRideNumber < coupon.rideNumber) {
            reason = `Valid on ride ${coupon.rideNumber} (${
              coupon.rideNumber - nextRideNumber
            } more to go)`;
          } else {
            reason = `Was valid only on ride ${coupon.rideNumber}`;
          }
        }

        if (isEligible && coupon.applicableFor === 'EVERY_NTH_RIDE') {
          if (nextRideNumber % coupon.rideNumber !== 0) {
            const ridesRemaining = coupon.rideNumber - (nextRideNumber % coupon.rideNumber);
            isEligible = false;
            reason = `Valid every ${coupon.rideNumber} rides (${ridesRemaining} more to go)`;
          }
        }

        if (isEligible &&
          coupon.applicableFor === 'SPECIFIC_RIDES' &&
          !coupon.specificRideNumbers.includes(nextRideNumber)
        ) {
          isEligible = false;
          const nextApplicableRide = coupon.specificRideNumbers.find(
            (num) => num > nextRideNumber
          );
          if (nextApplicableRide) {
            reason = `Valid on ride ${nextApplicableRide} (${
              nextApplicableRide - nextRideNumber
            } more to go)`;
          } else {
            reason = `Valid only on rides: ${coupon.specificRideNumbers.join(', ')}`;
          }
        }

        return {
          _id: coupon._id,
          code: coupon.code,
          description: coupon.description,
          discountType: coupon.discountType,
          discountValue: coupon.discountValue,
          maxDiscountAmount: coupon.maxDiscountAmount,
          minFareAmount: coupon.minFareAmount,
          applicableVehicles: coupon.applicableVehicles, // 🚗 NEW
          applicableFor: coupon.applicableFor,
          rideNumber: coupon.rideNumber,
          specificRideNumbers: coupon.specificRideNumbers,
          validUntil: coupon.validUntil,
          isEligible,
          eligibilityReason: reason,
          userUsageCount,
          maxUsagePerUser: coupon.maxUsagePerUser,
          remainingUsages: coupon.maxUsagePerUser - userUsageCount,
        };
      })
    );

    console.log(
      `✅ Found ${couponsWithEligibility.length} coupons, ${
        couponsWithEligibility.filter((c) => c.isEligible).length
      } eligible`
    );

    res.json({
      success: true,
      coupons: couponsWithEligibility,
      customerRidesCompleted: completedRidesCount,
      nextRideNumber: completedRidesCount + 1,
    });
  } catch (error) {
    console.error('❌ Error fetching available coupons:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST - Validate coupon code
// 🚗 UPDATED: Now validates vehicle type
router.post('/validate', verifyToken, async (req, res) => {
  try {
    const { customerId, couponCode, estimatedFare, vehicleType } = req.body; // 🚗 NEW: vehicleType

    console.log(`🔍 Validating coupon: ${couponCode} for customer: ${customerId}, vehicle: ${vehicleType}`);

    if (!couponCode || !customerId || !estimatedFare) {
      return res.status(400).json({
        success: false,
        error: 'couponCode, customerId, and estimatedFare are required',
      });
    }

    // Find coupon
    const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() });

    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: 'Invalid coupon code',
      });
    }

    // Check if coupon is valid
    if (!coupon.isValid()) {
      return res.status(400).json({
        success: false,
        error: 'Coupon is expired or inactive',
      });
    }

    // 🚗 NEW: Check vehicle applicability
    if (vehicleType && !coupon.isApplicableForVehicle(vehicleType)) {
      const applicableList = coupon.applicableVehicles.filter(v => v !== 'all');
      return res.status(400).json({
        success: false,
        error: `This coupon is only valid for: ${applicableList.join(', ')}`,
        applicableVehicles: applicableList,
      });
    }

    // Get customer
    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }

    // Get completed rides count
    const completedRidesCount = await Trip.countDocuments({
      customerId,
      status: 'COMPLETED',
    });

    const nextRideNumber = completedRidesCount + 1;

    // Check user usage
    const userUsageCount = await CouponUsage.countDocuments({
      customerId,
      couponId: coupon._id,
    });

    if (userUsageCount >= coupon.maxUsagePerUser) {
      return res.status(400).json({
        success: false,
        error: 'You have already used this coupon maximum times',
      });
    }

    // Check total usage limit
    if (
      coupon.totalUsageLimit !== null &&
      coupon.currentUsageCount >= coupon.totalUsageLimit
    ) {
      return res.status(400).json({
        success: false,
        error: 'Coupon usage limit reached',
      });
    }

    // Check user type eligibility
    if (coupon.eligibleUserTypes.includes('NEW') && !coupon.eligibleUserTypes.includes('ALL') && completedRidesCount > 0) {
      return res.status(400).json({
        success: false,
        error: 'This coupon is only valid for new users (first ride)',
      });
    }

    if (coupon.eligibleUserTypes.includes('EXISTING') && !coupon.eligibleUserTypes.includes('ALL') && completedRidesCount === 0) {
      return res.status(400).json({
        success: false,
        error: 'This coupon is only valid for existing users',
      });
    }

    // Check minimum rides completed
    if (completedRidesCount < coupon.minRidesCompleted) {
      return res.status(400).json({
        success: false,
        error: `You need to complete ${
          coupon.minRidesCompleted - completedRidesCount
        } more ride(s) to use this coupon`,
      });
    }

    // Check maximum rides completed
    if (
      coupon.maxRidesCompleted !== null &&
      completedRidesCount > coupon.maxRidesCompleted
    ) {
      return res.status(400).json({
        success: false,
        error: 'You have exceeded the maximum rides for this coupon',
      });
    }

    // Check ride number applicability
    if (coupon.applicableFor === 'FIRST_RIDE' && nextRideNumber !== 1) {
      return res.status(400).json({
        success: false,
        error: 'This coupon is valid only for your first ride',
      });
    }

    if (coupon.applicableFor === 'NTH_RIDE' && nextRideNumber !== coupon.rideNumber) {
      return res.status(400).json({
        success: false,
        error: `This coupon is valid only on ride number ${coupon.rideNumber}`,
      });
    }

    if (coupon.applicableFor === 'EVERY_NTH_RIDE') {
      if (nextRideNumber % coupon.rideNumber !== 0) {
        const ridesRemaining = coupon.rideNumber - (nextRideNumber % coupon.rideNumber);
        return res.status(400).json({
          success: false,
          error: `This coupon is valid every ${coupon.rideNumber} rides. Complete ${ridesRemaining} more ride(s)`,
        });
      }
    }

    if (
      coupon.applicableFor === 'SPECIFIC_RIDES' &&
      !coupon.specificRideNumbers.includes(nextRideNumber)
    ) {
      return res.status(400).json({
        success: false,
        error: `This coupon is valid only on rides: ${coupon.specificRideNumbers.join(', ')}`,
      });
    }

    // Check minimum fare amount
    if (estimatedFare < coupon.minFareAmount) {
      return res.status(400).json({
        success: false,
        error: `Minimum fare of ₹${coupon.minFareAmount} required to use this coupon`,
      });
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.discountType === 'PERCENTAGE') {
      discountAmount = (estimatedFare * coupon.discountValue) / 100;
      if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
        discountAmount = coupon.maxDiscountAmount;
      }
    } else {
      // FIXED
      discountAmount = coupon.discountValue;
    }

    // Ensure discount doesn't exceed fare
    discountAmount = Math.min(discountAmount, estimatedFare);

    const finalFare = Math.max(0, estimatedFare - discountAmount);

    console.log(`✅ Coupon validated: ${couponCode}, discount: ₹${discountAmount}`);

    res.json({
      success: true,
      valid: true,
      coupon: {
        _id: coupon._id,
        code: coupon.code,
        description: coupon.description,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        applicableVehicles: coupon.applicableVehicles, // 🚗 NEW
      },
      discountAmount,
      originalFare: estimatedFare,
      finalFare,
      message: `Coupon applied! You saved ₹${discountAmount.toFixed(2)}`,
    });
  } catch (error) {
    console.error('❌ Error validating coupon:', error);
    res.status(500).json({ success: false, error: 'Failed to validate coupon' });
  }
});

// POST - Apply coupon (record usage)
router.post('/apply', verifyToken, async (req, res) => {
  try {
    const { customerId, couponCode, tripId, originalFare, vehicleType } = req.body; // 🚗 NEW: vehicleType

    console.log(`💳 Applying coupon: ${couponCode} for trip: ${tripId}, vehicle: ${vehicleType}`);

    if (!customerId || !couponCode || !tripId || !originalFare) {
      return res.status(400).json({
        success: false,
        error: 'customerId, couponCode, tripId, and originalFare are required',
      });
    }

    // Find and validate coupon (reuse validation logic)
    const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() });

    if (!coupon || !coupon.isValid()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired coupon',
      });
    }

    // 🚗 NEW: Check vehicle applicability before applying
    if (vehicleType && !coupon.isApplicableForVehicle(vehicleType)) {
      const applicableList = coupon.applicableVehicles.filter(v => v !== 'all');
      return res.status(400).json({
        success: false,
        error: `This coupon is only valid for: ${applicableList.join(', ')}`,
      });
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.discountType === 'PERCENTAGE') {
      discountAmount = (originalFare * coupon.discountValue) / 100;
      if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
        discountAmount = coupon.maxDiscountAmount;
      }
    } else {
      discountAmount = coupon.discountValue;
    }

    discountAmount = Math.min(discountAmount, originalFare);
    const finalFare = Math.max(0, originalFare - discountAmount);

    // Record coupon usage
    await CouponUsage.create({
      couponId: coupon._id,
      couponCode: coupon.code,
      customerId,
      tripId,
      originalFare,
      discountAmount,
      finalFare,
      vehicleType: vehicleType || 'unknown', // 🚗 NEW: Store vehicle type
      usedAt: new Date(),
    });

    // Increment coupon usage count
    coupon.currentUsageCount += 1;
    await coupon.save();

    console.log(`✅ Coupon applied successfully, discount: ₹${discountAmount}`);

    res.json({
      success: true,
      discountApplied: true,
      originalFare,
      discountAmount,
      finalFare,
      couponCode: coupon.code,
    });
  } catch (error) {
    console.error('❌ Error applying coupon:', error);
    res.status(500).json({ success: false, error: 'Failed to apply coupon' });
  }
});

// GET - Customer's coupon usage history
router.get('/history/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    const history = await CouponUsage.find({ customerId })
      .populate('couponId', 'code description discountType discountValue applicableVehicles')
      .sort({ usedAt: -1 })
      .limit(50);

    const formattedHistory = history.map((usage) => ({
      couponCode: usage.couponCode,
      description: usage.couponId?.description || 'N/A',
      originalFare: usage.originalFare,
      discountAmount: usage.discountAmount,
      finalFare: usage.finalFare,
      vehicleType: usage.vehicleType, // 🚗 NEW
      usedAt: usage.usedAt,
    }));

    res.json({
      success: true,
      history: formattedHistory,
    });
  } catch (error) {
    console.error('❌ Error fetching coupon history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
router.get('/', (req, res) => {
  res.json({
    message: '🎫 Coupon System API is active',
    availableEndpoints: [
      'GET /api/coupons/available/:customerId - Get all available coupons',
      'GET /api/coupons/available/:customerId?vehicleType=car - Get coupons for specific vehicle',
      'POST /api/coupons/validate - Validate a coupon code',
      'POST /api/coupons/apply - Apply coupon to trip',
      'GET /api/coupons/history/:customerId - Get usage history',
    ],
  });
});

export default router;