// routes/admin.coupons.routes.js
import express from 'express';
import { verifyAdminToken } from '../middlewares/adminAuth.js';
import Coupon from '../models/Coupon.js';
import CouponUsage from '../models/CouponUsage.js';
import Customer from '../models/User.js';

const router = express.Router();

// Valid vehicle types
const VALID_VEHICLES = ['all', 'bike', 'auto', 'car', 'premium', 'xl'];

// --- COUPON MANAGEMENT ---

// GET - Fetch all coupons
router.get('/coupons', async (req, res) => {
  try {
    console.log('🔥 GET /api/admin/coupons');
    
    const coupons = await Coupon.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      coupons,
      count: coupons.length,
    });
  } catch (error) {
    console.error('❌ Error fetching coupons:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET - Fetch single coupon by ID
router.get('/coupons/:id', async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    
    if (!coupon) {
      return res.status(404).json({ success: false, error: 'Coupon not found' });
    }

    res.json({ success: true, coupon });
  } catch (error) {
    console.error('❌ Error fetching coupon:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST - Create new coupon
router.post('/coupons', async (req, res) => {
  try {
    console.log('🔥 POST /api/admin/coupons');
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));

    const {
      code,
      description,
      discountType,
      discountValue,
      maxDiscountAmount,
      minFareAmount,
      applicableVehicles, // 🚗 NEW
      applicableFor,
      rideNumber,
      specificRideNumbers,
      maxUsagePerUser,
      totalUsageLimit,
      validFrom,
      validUntil,
      isActive,
      eligibleUserTypes,
      minRidesCompleted,
      maxRidesCompleted,
    } = req.body;

    // Validation
    if (!code || !description || !discountType || !discountValue || !applicableFor || !validUntil) {
      return res.status(400).json({
        success: false,
        error: 'Required fields: code, description, discountType, discountValue, applicableFor, validUntil',
      });
    }

    // Check if coupon code already exists
    const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
    if (existingCoupon) {
      return res.status(400).json({
        success: false,
        error: 'Coupon code already exists',
      });
    }

    // Validate discount value
    if (discountType === 'PERCENTAGE' && (discountValue <= 0 || discountValue > 100)) {
      return res.status(400).json({
        success: false,
        error: 'Percentage discount must be between 0-100',
      });
    }

    if (discountType === 'FIXED' && discountValue <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Fixed discount must be greater than 0',
      });
    }

    // 🚗 NEW: Validate applicable vehicles
    let validatedVehicles = ['all']; // Default to all vehicles
    if (applicableVehicles && Array.isArray(applicableVehicles) && applicableVehicles.length > 0) {
      // Filter out invalid vehicle types
      validatedVehicles = applicableVehicles
        .map(v => v.toLowerCase().trim())
        .filter(v => VALID_VEHICLES.includes(v));
      
      // If empty after filtering, default to 'all'
      if (validatedVehicles.length === 0) {
        validatedVehicles = ['all'];
      }
    }

    console.log('🚗 Applicable vehicles:', validatedVehicles);

    // Create coupon
    const coupon = await Coupon.create({
      code: code.toUpperCase(),
      description,
      discountType,
      discountValue: Number(discountValue),
      maxDiscountAmount: maxDiscountAmount ? Number(maxDiscountAmount) : null,
      minFareAmount: minFareAmount ? Number(minFareAmount) : 0,
      applicableVehicles: validatedVehicles, // 🚗 NEW
      applicableFor,
      rideNumber: rideNumber ? Number(rideNumber) : null,
      specificRideNumbers: specificRideNumbers || [],
      maxUsagePerUser: maxUsagePerUser ? Number(maxUsagePerUser) : 1,
      totalUsageLimit: totalUsageLimit ? Number(totalUsageLimit) : null,
      validFrom: validFrom || new Date(),
      validUntil: new Date(validUntil),
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      eligibleUserTypes: eligibleUserTypes || ['ALL'],
      minRidesCompleted: minRidesCompleted ? Number(minRidesCompleted) : 0,
      maxRidesCompleted: maxRidesCompleted ? Number(maxRidesCompleted) : null,
      createdBy: req.user?.email || 'admin',
      createdAt: new Date(),
    });

    console.log('✅ Coupon created successfully');
    res.status(201).json({
      success: true,
      message: 'Coupon created successfully',
      coupon,
    });
  } catch (error) {
    console.error('❌ Error creating coupon:', error);
    res.status(500).json({ success: false, error: 'Server error creating coupon' });
  }
});

// PUT - Update coupon
router.put('/coupons/:id', async (req, res) => {
  try {
    console.log('🔥 PUT /api/admin/coupons/:id');
    
    const coupon = await Coupon.findById(req.params.id);
    
    if (!coupon) {
      return res.status(404).json({ success: false, error: 'Coupon not found' });
    }

    // 🚗 NEW: Handle applicable vehicles update
    if (req.body.applicableVehicles !== undefined) {
  let validatedVehicles = [];

  if (Array.isArray(req.body.applicableVehicles)) {
    validatedVehicles = req.body.applicableVehicles
      .map(v => v.toLowerCase().trim())
      .filter(v => VALID_VEHICLES.includes(v));
  }

  // Do NOT force 'all'
  coupon.applicableVehicles = validatedVehicles;
}


    // Update other fields
    const updateFields = [
      'description',
      'discountType',
      'discountValue',
      'maxDiscountAmount',
      'minFareAmount',
      'applicableFor',
      'rideNumber',
      'specificRideNumbers',
      'maxUsagePerUser',
      'totalUsageLimit',
      'validFrom',
      'validUntil',
      'isActive',
      'eligibleUserTypes',
      'minRidesCompleted',
      'maxRidesCompleted',
    ];

    updateFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        coupon[field] = req.body[field];
      }
    });

    coupon.updatedAt = new Date();
    await coupon.save();

    console.log('✅ Coupon updated successfully');
    res.json({
      success: true,
      message: 'Coupon updated successfully',
      coupon,
    });
  } catch (error) {
    console.error('❌ Error updating coupon:', error);
    res.status(500).json({ success: false, error: 'Server error updating coupon' });
  }
});

// PATCH - Toggle coupon status
router.patch('/coupons/:id/toggle', async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    
    if (!coupon) {
      return res.status(404).json({ success: false, error: 'Coupon not found' });
    }

    coupon.isActive = !coupon.isActive;
    coupon.updatedAt = new Date();
    await coupon.save();

    console.log(`✅ Coupon ${coupon.code} toggled to ${coupon.isActive ? 'active' : 'inactive'}`);
    res.json({
      success: true,
      message: `Coupon ${coupon.isActive ? 'activated' : 'deactivated'} successfully`,
      coupon,
    });
  } catch (error) {
    console.error('❌ Error toggling coupon:', error);
    res.status(500).json({ success: false, error: 'Server error toggling coupon' });
  }
});

// DELETE - Delete coupon
router.delete('/coupons/:id', async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    
    if (!coupon) {
      return res.status(404).json({ success: false, error: 'Coupon not found' });
    }

    console.log('✅ Coupon deleted successfully');
    res.json({
      success: true,
      message: 'Coupon deleted successfully',
    });
  } catch (error) {
    console.error('❌ Error deleting coupon:', error);
    res.status(500).json({ success: false, error: 'Server error deleting coupon' });
  }
});

// GET - Coupon usage statistics
router.get('/coupons/:id/stats', async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    
    if (!coupon) {
      return res.status(404).json({ success: false, error: 'Coupon not found' });
    }

    const usages = await CouponUsage.find({ couponId: req.params.id })
      .populate('customerId', 'name email phone')
      .sort({ usedAt: -1 })
      .limit(50);

    const totalDiscount = usages.reduce((sum, usage) => sum + usage.discountAmount, 0);
    const uniqueUsers = new Set(usages.map((u) => u.customerId?._id?.toString())).size;

    res.json({
      success: true,
      stats: {
        totalUsages: coupon.currentUsageCount,
        uniqueUsers,
        totalDiscountGiven: totalDiscount,
        recentUsages: usages,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching coupon stats:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET - Overall coupon statistics
router.get('/coupons-stats/overview', async (req, res) => {
  try {
    console.log('🔥 GET /api/admin/coupons-stats/overview');

    const totalCoupons = await Coupon.countDocuments();
    const activeCoupons = await Coupon.countDocuments({ isActive: true });
    const expiredCoupons = await Coupon.countDocuments({ validUntil: { $lt: new Date() } });

    const totalUsages = await CouponUsage.countDocuments();
    const totalDiscountGiven = await CouponUsage.aggregate([
      { $group: { _id: null, total: { $sum: '$discountAmount' } } },
    ]);

    const topCoupons = await CouponUsage.aggregate([
      {
        $group: {
          _id: '$couponCode',
          usageCount: { $sum: 1 },
          totalDiscount: { $sum: '$discountAmount' },
        },
      },
      { $sort: { usageCount: -1 } },
      { $limit: 10 },
    ]);

    res.json({
      success: true,
      stats: {
        totalCoupons,
        activeCoupons,
        expiredCoupons,
        totalUsages,
        totalDiscountGiven: totalDiscountGiven[0]?.total || 0,
        topCoupons,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching coupon overview:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;