// src/controllers/planController.js - Plan Management & Earning Calculations

import Plan from '../models/Plan.js';
import DriverPlan from '../models/DriverPlan.js';
import Wallet from '../models/Wallet.js';
import User from '../models/User.js';
import mongoose from 'mongoose';

// ═══════════════════════════════════════════════════════════════════
// PLAN TEMPLATES - CRUD OPERATIONS (ADMIN)
// ═══════════════════════════════════════════════════════════════════

/**
 * CREATE PLAN TEMPLATE
 * POST /api/admin/plans
 * Body: { planName, planType, commissionRate, bonusMultiplier, monthlyFee, noCommission, description, benefits }
 */
export const createPlan = async (req, res) => {
  try {
   // AFTER
const {
  planName,
  planType,
  commissionRate,
  bonusMultiplier,
  noCommission,
  monthlyFee,
  planPrice,      // ← ADD
  durationDays,   // ← ADD
  description,
  benefits
} = req.body;

    // Validation
    if (!planName || !planType) {
      return res.status(400).json({
        success: false,
        message: 'planName and planType are required'
      });
    }

    if (commissionRate < 0 || commissionRate > 100) {
      return res.status(400).json({
        success: false,
        message: 'commissionRate must be between 0 and 100'
      });
    }

    if (bonusMultiplier < 1.0) {
      return res.status(400).json({
        success: false,
        message: 'bonusMultiplier must be >= 1.0'
      });
    }

    // Check if plan already exists
    const existing = await Plan.findOne({ planName });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Plan with this name already exists'
      });
    }

   // AFTER
const plan = new Plan({
  planName,
  planType,
  commissionRate: noCommission ? 0 : commissionRate,
  bonusMultiplier,
  noCommission,
  monthlyFee: monthlyFee || 0,
  planPrice: planPrice ?? monthlyFee ?? 0,   // ← ADD (falls back to monthlyFee for backwards compat)
  durationDays: durationDays || 30,          // ← ADD
  description: description || '',
  benefits: benefits || [],
  createdBy: req.admin?._id || req.admin?.id,
  isActive: true
});

    await plan.save();

    console.log(`✅ Plan created: ${plan._id} | ${planName}`);

    res.status(201).json({
      success: true,
      message: 'Plan created successfully',
      data: plan
    });
  } catch (error) {
    console.error('❌ createPlan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create plan',
      error: error.message
    });
  }
};

/**
 * GET ALL PLANS
 * GET /api/admin/plans?active=true
 */
export const getPlans = async (req, res) => {
  try {
    const { active, planType, isActive } = req.query;
    let query = {};

    if (active === 'true' || isActive === 'true') {
      query.isActive = true;
    } else if (isActive === 'false') {
      query.isActive = false;
    }

    if (planType) {
      query.planType = planType;
    }

    const plans = await Plan.find(query)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: plans,
      count: plans.length
    });
  } catch (error) {
    console.error('❌ getPlans error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch plans',
      error: error.message
    });
  }
};

/**
 * GET PLAN BY ID
 * GET /api/admin/plans/:planId
 */
export const getPlanById = async (req, res) => {
  try {
    const { planId } = req.params;

    const plan = await Plan.findById(planId).populate('createdBy', 'name email');
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
    }

    res.json({
      success: true,
      data: plan
    });
  } catch (error) {
    console.error('❌ getPlanById error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch plan',
      error: error.message
    });
  }
};

/**
 * UPDATE PLAN TEMPLATE
 * PUT /api/admin/plans/:planId
 */
export const updatePlan = async (req, res) => {
  try {
    const { planId } = req.params;
    const updates = req.body;

    // Don't allow changing planType
    delete updates.planType;
    delete updates.createdBy;

    // Validate commission and bonus if provided
    if (updates.commissionRate !== undefined) {
      if (updates.commissionRate < 0 || updates.commissionRate > 100) {
        return res.status(400).json({
          success: false,
          message: 'commissionRate must be between 0 and 100'
        });
      }
    }

    if (updates.bonusMultiplier !== undefined) {
      if (updates.bonusMultiplier < 1.0) {
        return res.status(400).json({
          success: false,
          message: 'bonusMultiplier must be >= 1.0'
        });
      }
    }

    updates.updatedBy = req.admin?._id || req.admin?.id;
    updates.updatedAt = new Date();

    const plan = await Plan.findByIdAndUpdate(planId, updates, { new: true });
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
    }

    console.log(`✅ Plan updated: ${planId}`);

    res.json({
      success: true,
      message: 'Plan updated successfully',
      data: plan
    });
  } catch (error) {
    console.error('❌ updatePlan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update plan',
      error: error.message
    });
  }
};

/**
 * DELETE PLAN TEMPLATE
 * DELETE /api/admin/plans/:planId
 */
export const deletePlan = async (req, res) => {
  try {
    const { planId } = req.params;

    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
    }

    // Block deletion if plan has ever been purchased
    if (plan.totalPurchases > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete plan. It has been purchased ${plan.totalPurchases} time(s). Deactivate it instead.`
      });
    }

    await Plan.findByIdAndDelete(planId);

    console.log(`✅ Plan deleted: ${planId}`);

    res.json({
      success: true,
      message: 'Plan deleted successfully'
    });
  } catch (error) {
    console.error('❌ deletePlan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete plan',
      error: error.message
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// DRIVER PLAN MANAGEMENT (ADMIN)
// ═══════════════════════════════════════════════════════════════════

/**
 * ASSIGN PLAN TO DRIVER
 * POST /api/admin/drivers/:driverId/assign-plan
 * Body: { planId, expiryDays, reason }
 */
export const assignPlanToDriver = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { driverId } = req.params;
    const { planId, expiryDays = 30, reason } = req.body;

    if (!planId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'planId is required'
      });
    }

    // Verify driver exists
    const driver = await User.findById(driverId).session(session);
    if (!driver || !driver.isDriver) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    // Verify plan template exists
    const plan = await Plan.findById(planId).session(session);
    if (!plan) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Plan template not found'
      });
    }

    // Deactivate any existing active plans for this driver
    await DriverPlan.updateMany(
      { driver: driverId, isActive: true },
      { isActive: false },
      { session }
    );

    // Calculate expiry date
    const activatedDate = new Date();
    const expiryDate = new Date(activatedDate);
    expiryDate.setDate(expiryDate.getDate() + expiryDays);

    // Create new driver plan
    const driverPlan = new DriverPlan({
      driver: driverId,
      plan: planId,
      planName: plan.planName,
      planType: plan.planType,
      commissionRate: plan.commissionRate,
      bonusMultiplier: plan.bonusMultiplier,
      noCommission: plan.noCommission,
      monthlyFee: plan.monthlyFee,
      description: plan.description,
      benefits: plan.benefits,
      isActive: true,
      activatedDate,
      expiryDate,
      createdBy: req.admin?._id || req.admin?.id,
      reason: reason || ''
    });

    await driverPlan.save({ session });
    await session.commitTransaction();

    console.log(`✅ Plan assigned to driver: ${driverId} | Plan: ${plan.planName}`);

    res.json({
      success: true,
      message: 'Plan assigned to driver successfully',
      data: driverPlan
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ assignPlanToDriver error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign plan',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};

/**
 * UPDATE DRIVER PLAN
 * PUT /api/admin/drivers/:driverId/plans/:driverPlanId
 * Can modify commission, bonus, expiry for specific driver
 */
export const updateDriverPlan = async (req, res) => {
  try {
    const { driverId, driverPlanId } = req.params;
    const updates = req.body;

    // Don't allow changing driver
    delete updates.driver;
    delete updates.createdBy;
    delete updates.plan;

    updates.updatedAt = new Date();

    const driverPlan = await DriverPlan.findOne({
      _id: driverPlanId,
      driver: driverId
    });

    if (!driverPlan) {
      return res.status(404).json({
        success: false,
        message: 'Driver plan not found'
      });
    }

    // Apply updates
    Object.assign(driverPlan, updates);
    await driverPlan.save();

    console.log(`✅ Driver plan updated: ${driverPlanId}`);

    res.json({
      success: true,
      message: 'Driver plan updated successfully',
      data: driverPlan
    });
  } catch (error) {
    console.error('❌ updateDriverPlan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update driver plan',
      error: error.message
    });
  }
};

/**
 * DEACTIVATE DRIVER PLAN
 * POST /api/admin/drivers/:driverId/plans/:driverPlanId/deactivate
 */
export const deactivateDriverPlan = async (req, res) => {
  try {
    const { driverId, driverPlanId } = req.params;

    const driverPlan = await DriverPlan.findOneAndUpdate(
      { _id: driverPlanId, driver: driverId },
      { isActive: false, updatedAt: new Date() },
      { new: true }
    );

    if (!driverPlan) {
      return res.status(404).json({
        success: false,
        message: 'Driver plan not found'
      });
    }

    console.log(`✅ Driver plan deactivated: ${driverPlanId}`);

    res.json({
      success: true,
      message: 'Driver plan deactivated successfully',
      data: driverPlan
    });
  } catch (error) {
    console.error('❌ deactivateDriverPlan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to deactivate plan',
      error: error.message
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// DRIVER ENDPOINTS (DRIVER APP)
// ═══════════════════════════════════════════════════════════════════

/**
 * GET CURRENT PLAN
 * GET /api/driver/plan/current
 * Returns driver's currently active plan
 */
export const getCurrentPlan = async (req, res) => {
  try {
    const driverId = req.user._id; // From auth middleware

    const driverPlan = await DriverPlan.findOne({
      driver: driverId,
      isActive: true,
      $or: [
        { expiryDate: null }, // No expiry
        { expiryDate: { $gte: new Date() } } // Not expired
      ]
    }).populate('plan');

    if (!driverPlan) {
      // No active plan - return null or default basic plan info
      return res.json({
        success: true,
        data: null,
        message: 'No active plan'
      });
    }

    res.json({
      success: true,
      data: driverPlan
    });
  } catch (error) {
    console.error('❌ getCurrentPlan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch current plan',
      error: error.message
    });
  }
};

/**
 * GET AVAILABLE PLANS (for driver to subscribe)
 * GET /api/driver/plans/available
 */
export const getAvailablePlans = async (req, res) => {
  try {
    const driverId = req.user._id;

    // Find plan IDs the driver currently has an active subscription for
    const activeDriverPlans = await DriverPlan.find({
      driver: driverId,
      isActive: true,
      paymentStatus: 'completed',
      $or: [{ expiryDate: null }, { expiryDate: { $gt: new Date() } }],
    }).select('plan').lean();

    const activePlanIds = activeDriverPlans.map((dp) => dp.plan).filter(Boolean);

    const query = { isActive: true };
    if (activePlanIds.length > 0) {
      query._id = { $nin: activePlanIds };
    }

    const plans = await Plan.find(query).sort({ planType: 1 });

    res.json({
      success: true,
      data: plans
    });
  } catch (error) {
    console.error('❌ getAvailablePlans error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available plans',
      error: error.message
    });
  }
};

/**
 * GET PLAN HISTORY
 * GET /api/driver/plan/history
 */
export const getPlanHistory = async (req, res) => {
  try {
    const driverId = req.user._id;

    const planHistory = await DriverPlan.find({ driver: driverId })
      .populate('plan')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: planHistory
    });
  } catch (error) {
    console.error('❌ getPlanHistory error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch plan history',
      error: error.message
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// EARNING CALCULATION HELPER (Used in trip completion)
// ═══════════════════════════════════════════════════════════════════

/**
 * CALCULATE DRIVER EARNING WITH PLAN BENEFITS
 * Called from tripController after ride completion
 *
 * Returns: { finalEarning, baseEarning, commission, planBonus, appliedPlan }
 */
export const calculateEarningWithPlan = async (driverId, baseEarning) => {
  try {
    // Get driver's current active plan
    const driverPlan = await DriverPlan.findOne({
      driver: driverId,
      isActive: true,
      $or: [
        { expiryDate: null },
        { expiryDate: { $gte: new Date() } }
      ]
    });

    // No plan or plan expired - apply default 20% commission
    if (!driverPlan) {
      const defaultCommission = (baseEarning * 20) / 100;
      const finalEarning = baseEarning - defaultCommission;

      return {
        finalEarning,
        baseEarning,
        commission: defaultCommission,
        planBonus: 0,
        appliedPlan: null,
        planName: 'Basic',
        commissionRate: 20,
        bonusMultiplier: 1.0
      };
    }

    // Plan exists - apply plan benefits
    const commission = driverPlan.noCommission
      ? 0
      : (baseEarning * driverPlan.commissionRate) / 100;

    const afterCommission = baseEarning - commission;
    const planBonus = afterCommission * (driverPlan.bonusMultiplier - 1);
    const finalEarning = afterCommission + planBonus;

    return {
      finalEarning,
      baseEarning,
      commission,
      planBonus,
      appliedPlan: driverPlan._id,
      planName: driverPlan.planName,
      commissionRate: driverPlan.commissionRate,
      bonusMultiplier: driverPlan.bonusMultiplier
    };
  } catch (error) {
    console.error('❌ calculateEarningWithPlan error:', error);
    // Fallback to default calculation
    const defaultCommission = (baseEarning * 20) / 100;
    return {
      finalEarning: baseEarning - defaultCommission,
      baseEarning,
      commission: defaultCommission,
      planBonus: 0,
      appliedPlan: null,
      error: true
    };
  }
};

// ═══════════════════════════════════════════════════════════════════
// TOGGLE PLAN STATUS (ADMIN)
// ═══════════════════════════════════════════════════════════════════

/**
 * TOGGLE PLAN STATUS (enable/disable)
 * PATCH /api/admin/plans/:planId/toggle
 */
export const togglePlanStatus = async (req, res) => {
  try {
    const { planId } = req.params;

    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
    }

    plan.isActive = !plan.isActive;
    plan.updatedBy = req.admin?._id || req.admin?.id;
    await plan.save();

    console.log(`✅ Plan ${plan.isActive ? 'enabled' : 'disabled'}: ${planId}`);

    res.json({
      success: true,
      message: `Plan ${plan.isActive ? 'enabled' : 'disabled'} successfully`,
      data: {
        _id: plan._id,
        planName: plan.planName,
        isActive: plan.isActive
      }
    });
  } catch (error) {
    console.error('❌ togglePlanStatus error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle plan status',
      error: error.message
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// REVENUE STATS (ADMIN)
// ═══════════════════════════════════════════════════════════════════

/**
 * GET REVENUE STATS
 * GET /api/admin/plans/stats/revenue
 */
export const getRevenueStats = async (req, res) => {
  try {
    const plans = await Plan.find({}).lean();

    const totalRevenue = plans.reduce((s, p) => s + (p.totalRevenueGenerated || 0), 0);
    const totalPurchases = plans.reduce((s, p) => s + (p.totalPurchases || 0), 0);
    const activePlansCount = plans.filter((p) => p.isActive).length;

    const mostPopularPlan = plans.reduce((best, p) => {
      if (!best || (p.totalPurchases || 0) > (best.totalPurchases || 0)) return p;
      return best;
    }, null);

    res.json({
      success: true,
      data: {
        totalRevenue,
        totalPurchases,
        activePlansCount,
        mostPopularPlan: mostPopularPlan
          ? { planName: mostPopularPlan.planName, totalPurchases: mostPopularPlan.totalPurchases || 0 }
          : null
      }
    });
  } catch (error) {
    console.error('❌ getRevenueStats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch revenue stats',
      error: error.message
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// PURCHASE HISTORY (ADMIN)
// ═══════════════════════════════════════════════════════════════════

/**
 * GET PURCHASE HISTORY FOR A PLAN
 * GET /api/admin/plans/:planId/purchases
 */
export const getPurchaseHistory = async (req, res) => {
  try {
    const { planId } = req.params;

    const purchases = await DriverPlan.find({ plan: planId })
      .populate('driver', 'name phone')
      .sort({ createdAt: -1 })
      .lean();

    const mapped = purchases.map((dp) => ({
      _id: dp._id,
      driver: dp.driver,
      amountPaid: dp.amountPaid ?? dp.planPrice ?? dp.monthlyFee ?? 0,
      createdAt: dp.createdAt,
      paymentStatus: dp.paymentStatus || 'completed',
      expiryDate: dp.expiryDate,
    }));

    res.json({
      success: true,
      data: mapped
    });
  } catch (error) {
    console.error('❌ getPurchaseHistory error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch purchase history',
      error: error.message
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// ADMIN ANALYTICS & MONITORING
// ═══════════════════════════════════════════════════════════════════

/**
 * GET PLAN ANALYTICS
 * GET /api/admin/plans/analytics?from=2024-01-01&to=2024-01-31
 */
export const getPlanAnalytics = async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    // Total drivers
    const totalDrivers = await User.countDocuments({ isDriver: true });

    // Drivers with active plans
    const driversWithPlans = await DriverPlan.countDocuments({
      isActive: true,
      expiryDate: { $gte: new Date() }
    });

    // Plan breakdown
    const planBreakdown = await DriverPlan.aggregate([
      {
        $match: {
          isActive: true,
          expiryDate: { $gte: new Date() }
        }
      },
      {
        $group: {
          _id: '$planType',
          count: { $sum: 1 },
          totalFees: { $sum: '$monthlyFee' },
          avgCommission: { $avg: '$commissionRate' },
          avgBonus: { $avg: '$bonusMultiplier' }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    // Total revenue from plans
    const totalRevenue = await DriverPlan.aggregate([
      {
        $match: {
          isActive: true,
          expiryDate: { $gte: new Date() }
        }
      },
      {
        $group: {
          _id: null,
          totalMonthlyRevenue: { $sum: '$monthlyFee' }
        }
      }
    ]);

    // Average commission across all plans
    const avgCommission = await DriverPlan.aggregate([
      {
        $match: {
          isActive: true,
          expiryDate: { $gte: new Date() }
        }
      },
      {
        $group: {
          _id: null,
          avg: { $avg: '$commissionRate' }
        }
      }
    ]);

    const adoption = totalDrivers > 0
      ? Math.round((driversWithPlans / totalDrivers) * 100)
      : 0;

    res.json({
      success: true,
      data: {
        period: { from: fromDate, to: toDate },
        totalDrivers,
        driversWithPlans,
        adoptionRate: `${adoption}%`,
        planBreakdown: planBreakdown.map(p => ({
          type: p._id,
          count: p.count,
          percentage: `${Math.round((p.count / driversWithPlans) * 100)}%`,
          totalMonthlyFees: p.totalFees,
          avgCommission: Math.round(p.avgCommission * 100) / 100,
          avgBonus: Math.round(p.avgBonus * 100) / 100
        })),
        totalMonthlyRevenue: totalRevenue[0]?.totalMonthlyRevenue || 0,
        averageCommission: Math.round((avgCommission[0]?.avg || 20) * 100) / 100
      }
    });
  } catch (error) {
    console.error('❌ getPlanAnalytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch analytics',
      error: error.message
    });
  }
};

/**
 * GET ALL DRIVERS WITH PLANS
 * GET /api/admin/drivers/plans?status=active&page=1
 */
export const getDriversWithPlans = async (req, res) => {
  try {
    const { status = 'all', page = 1 } = req.query;
    const limit = 15;
    const skip = (page - 1) * limit;

    let planMatch = {};
    if (status === 'active') {
      planMatch = { isActive: true, expiryDate: { $gte: new Date() } };
    } else if (status === 'inactive') {
      planMatch = { isActive: false };
    } else if (status === 'expired') {
      planMatch = { expiryDate: { $lt: new Date() } };
    }

    const drivers = await User.aggregate([
      {
        $match: { isDriver: true }
      },
      {
        $lookup: {
          from: 'driverplans',
          let: { driverId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$driver', '$$driverId'] },
                ...planMatch
              }
            },
            { $sort: { createdAt: -1 } },
            { $limit: 1 }
          ],
          as: 'currentPlan'
        }
      },
      {
        $addFields: {
          currentPlan: { $arrayElemAt: ['$currentPlan', 0] }
        }
      },
      { $skip: skip },
      { $limit: limit }
    ]);

    const total = await User.countDocuments({ isDriver: true });

    res.json({
      success: true,
      data: drivers,
      pagination: {
        page: parseInt(page),
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ getDriversWithPlans error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch drivers',
      error: error.message
    });
  }
};