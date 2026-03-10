// src/controllers/driverEarningsController.js
// Handles CRUD for DriverEarningsPlan and subscription listings.
// Used by the Admin panel's "Driver Earnings Management" page.

import DriverEarningsPlan from '../models/DriverEarningsPlan.js';
import DriverPlan from '../models/DriverPlan.js';
import User from '../models/User.js';

// ── GET /api/admin/driver-earnings/plans ──────────────────────────
export const getDriverEarningsPlans = async (req, res) => {
  try {
    const plans = await DriverEarningsPlan.find().sort({ createdAt: -1 });
    res.json({ success: true, plans });
  } catch (error) {
    console.error('❌ getDriverEarningsPlans error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch plans', error: error.message });
  }
};

// ── POST /api/admin/driver-earnings/plans ─────────────────────────
export const createDriverEarningsPlan = async (req, res) => {
  try {
    const { planName, description, monthlyFee, commissionPercent, minRideValue, status } = req.body;

    if (!planName?.trim()) {
      return res.status(400).json({ success: false, message: 'planName is required' });
    }

    const existing = await DriverEarningsPlan.findOne({ planName: { $regex: new RegExp(`^${planName.trim()}$`, 'i') } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A plan with this name already exists' });
    }

    const plan = new DriverEarningsPlan({
      planName: planName.trim(),
      description: description || '',
      monthlyFee: monthlyFee ?? 0,
      commissionPercent: commissionPercent ?? 10,
      minRideValue: minRideValue ?? 0,
      status: status || 'active',
      createdBy: req.admin?._id,
    });

    await plan.save();
    res.status(201).json({ success: true, message: 'Plan created successfully', plan });
  } catch (error) {
    console.error('❌ createDriverEarningsPlan error:', error);
    res.status(500).json({ success: false, message: 'Failed to create plan', error: error.message });
  }
};

// ── PUT /api/admin/driver-earnings/plans/:planId ──────────────────
export const updateDriverEarningsPlan = async (req, res) => {
  try {
    const { planId } = req.params;
    const updates = req.body;

    // Protect immutable fields
    delete updates._id;
    delete updates.createdBy;
    delete updates.createdAt;

    const plan = await DriverEarningsPlan.findByIdAndUpdate(planId, updates, { new: true, runValidators: true });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    res.json({ success: true, message: 'Plan updated successfully', plan });
  } catch (error) {
    console.error('❌ updateDriverEarningsPlan error:', error);
    res.status(500).json({ success: false, message: 'Failed to update plan', error: error.message });
  }
};

// ── DELETE /api/admin/driver-earnings/plans/:planId ───────────────
export const deleteDriverEarningsPlan = async (req, res) => {
  try {
    const { planId } = req.params;
    const plan = await DriverEarningsPlan.findByIdAndDelete(planId);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }
    res.json({ success: true, message: 'Plan deleted successfully' });
  } catch (error) {
    console.error('❌ deleteDriverEarningsPlan error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete plan', error: error.message });
  }
};

// ── GET /api/admin/driver-earnings/subscriptions ─────────────────
// Returns DriverPlan (Razorpay-purchased plans) for all drivers,
// joined with driver info — matches DriverSubscription shape in frontend.
export const getDriverSubscriptions = async (req, res) => {
  try {
    const activePlans = await DriverPlan.find({ isActive: true, paymentStatus: 'completed' })
      .populate('driver', 'name phone totalEarnings')
      .sort({ activatedDate: -1 });

    const subscriptions = activePlans.map((dp) => {
      const monthlyFee = dp.amountPaid || dp.monthlyFee || 0;
      const monthlyEarnings = dp.driver?.totalEarnings || 0;
      const profitLoss = monthlyEarnings - monthlyFee;
      return {
        _id: dp._id,
        driverId: dp.driver?._id,
        driverName: dp.driver?.name || 'Unknown',
        driverPhone: dp.driver?.phone || '',
        planId: dp.plan,
        planName: dp.planName,
        monthlyFee,
        commissionPercent: dp.commissionRate || 0,
        monthlyEarnings,
        profitLoss,
        status: dp.expiryDate && dp.expiryDate < new Date() ? 'expired' : 'active',
        activatedDate: dp.activatedDate,
        expiryDate: dp.expiryDate,
      };
    });

    res.json({ success: true, subscriptions });
  } catch (error) {
    console.error('❌ getDriverSubscriptions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch subscriptions', error: error.message });
  }
};
