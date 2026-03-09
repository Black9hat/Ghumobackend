// src/controllers/planPaymentController.js - Plan Purchase Payment Handler

import Plan from '../models/Plan.js';
import DriverPlan from '../models/DriverPlan.js';
import PaymentPlan from '../models/PaymentPlan.js';
import Wallet from '../models/Wallet.js';
import User from '../models/User.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import mongoose from 'mongoose';

// ════════════════════════════════════════════════════════════════════
// RAZORPAY INITIALIZATION
// ════════════════════════════════════════════════════════════════════
let razorpay = null;
try {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log('✅ Razorpay initialized for plan payments');
} catch (error) {
  console.error('❌ Razorpay init failed:', error.message);
}

// ════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════════

const safeEmit = (reqIo, room, event, data) => {
  try {
    if (reqIo) {
      reqIo.to(room).emit(event, data);
      console.log(`✅ Emitted: ${event} to ${room}`);
    }
  } catch (err) {
    console.warn(`⚠️ Socket emit failed: ${err.message}`);
  }
};

// ════════════════════════════════════════════════════════════════════
// 1. CREATE RAZORPAY ORDER FOR PLAN PURCHASE
// POST /api/driver/plans/:planId/create-order
// ════════════════════════════════════════════════════════════════════
export const createRazorpayPlanOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { planId } = req.params;
    const driverId = req.user._id;

    // ── Validation ──
    if (!planId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'planId is required',
      });
    }

    // ── Verify driver exists ──
    const driver = await User.findById(driverId).session(session);
    if (!driver || !driver.isDriver) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Driver not found or not verified',
      });
    }

    // ── Fetch plan ──
    const plan = await Plan.findById(planId).session(session);
    if (!plan) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Plan not found',
      });
    }

    if (!plan.isActive) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'This plan is no longer available',
      });
    }

    // ── Check if driver already has active plan ──
    const activeDriverPlan = await DriverPlan.findOne({
      driver: driverId,
      isActive: true,
      expiryDate: { $gte: new Date() },
    }).session(session);

    // ⚠️ Optional: Prevent multiple simultaneous plans
    // Uncomment if business requirement is "one plan per driver at a time"
    // if (activeDriverPlan) {
    //   await session.abortTransaction();
    //   return res.status(400).json({
    //     success: false,
    //     message: 'You already have an active plan. Please wait for it to expire.',
    //     activePlanExpiry: activeDriverPlan.expiryDate
    //   });
    // }

    // ── Check for recent duplicate orders (prevent accidental duplicates) ──
    const recentOrder = await PaymentPlan.findOne({
      driverId,
      planId,
      paymentStatus: 'pending',
      createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) }, // Last 5 minutes
    }).session(session);

    if (recentOrder) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Please wait before trying to purchase this plan again',
        existingOrderId: recentOrder.razorpayOrderId,
      });
    }

    // ── Create Razorpay order ──
    if (!razorpay) {
      await session.abortTransaction();
      return res.status(500).json({
        success: false,
        message: 'Payment gateway not available',
      });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(plan.planPrice * 100), // Convert to paise
      currency: 'INR',
      receipt: `plan_${driverId}_${planId}_${Date.now()}`,
      notes: {
        driverId: driverId.toString(),
        planId: planId.toString(),
        planName: plan.planName,
        type: 'plan_purchase',
      },
    });

    // ── Save payment record ──
    const paymentRecord = new PaymentPlan({
      driverId,
      planId,
      razorpayOrderId: razorpayOrder.id,
      amount: plan.planPrice,
      paymentStatus: 'pending',
      planName: plan.planName,
      planPrice: plan.planPrice,
      planDurationDays: plan.durationDays,
      initiatedAt: new Date(),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    await paymentRecord.save({ session });
    await session.commitTransaction();

    console.log(
      `✅ Razorpay order created: ${razorpayOrder.id} | Plan: ${plan.planName} | Driver: ${driverId}`
    );

    res.status(201).json({
      success: true,
      message: 'Order created successfully. Proceed to payment.',
      data: {
        orderId: razorpayOrder.id,
        planId: plan._id,
        planName: plan.planName,
        amount: plan.planPrice,
        currency: 'INR',
        durationDays: plan.durationDays,
        benefits: plan.benefits,
        razorpayKey: process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ createRazorpayPlanOrder error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment order',
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

// ════════════════════════════════════════════════════════════════════
// 2. VERIFY PLAN PAYMENT
// POST /api/driver/plans/:planId/verify-payment
// ════════════════════════════════════════════════════════════════════
export const verifyPlanPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { planId } = req.params;
    const {
      razorpayPaymentId,
      razorpayOrderId,
      razorpaySignature,
    } = req.body;

    const driverId = req.user._id;

    // ── Validation ──
    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Missing payment details: razorpayPaymentId, razorpayOrderId, razorpaySignature',
      });
    }

    // ── Verify signature ──
    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      await session.abortTransaction();
      console.error('❌ Invalid Razorpay signature');
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed. Invalid signature.',
      });
    }

    // ── Find payment record ──
    const paymentRecord = await PaymentPlan.findOne({
      razorpayOrderId,
      driverId,
    }).session(session);

    if (!paymentRecord) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Payment order not found',
      });
    }

    // ── Check if already processed ──
    if (paymentRecord.webhookProcessed) {
      await session.abortTransaction();
      return res.status(200).json({
        success: true,
        message: 'Payment already processed',
        data: {
          driverPlanId: paymentRecord.driverPlanId,
          planName: paymentRecord.planName,
          validTill: paymentRecord.completedAt
            ? new Date(paymentRecord.completedAt.getTime() + paymentRecord.planDurationDays * 24 * 60 * 60 * 1000)
            : null,
        },
      });
    }

    // ── Fetch plan ──
    const plan = await Plan.findById(planId).session(session);
    if (!plan) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Plan not found',
      });
    }

    // ── Create DriverPlan record ──
    const now = new Date();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + plan.durationDays);

    const driverPlan = new DriverPlan({
      driver: driverId,
      plan: planId,
      planName: plan.planName,
      planType: plan.planType,
      description: plan.description,
      commissionRate: plan.commissionRate,
      bonusMultiplier: plan.bonusMultiplier,
      noCommission: plan.noCommission,
      monthlyFee: plan.monthlyFee,
      benefits: plan.benefits,
      planPrice: plan.planPrice,
      durationDays: plan.durationDays,
      isTimeBasedPlan: plan.isTimeBasedPlan,
      planStartTime: plan.planStartTime,
      planEndTime: plan.planEndTime,
      isActive: true,
      activatedDate: now,
      expiryDate,
      razorpayPaymentId,
      razorpayOrderId,
      amountPaid: paymentRecord.amount,
      planPurchaseDate: now,
      paymentStatus: 'completed',
      purchaseMethod: 'driver_purchase',
    });

    await driverPlan.save({ session });

    // ── Update payment record ──
    paymentRecord.razorpayPaymentId = razorpayPaymentId;
    paymentRecord.razorpaySignature = razorpaySignature;
    paymentRecord.paymentStatus = 'completed';
    paymentRecord.completedAt = now;
    paymentRecord.driverPlanId = driverPlan._id;
    paymentRecord.webhookProcessed = true;
    paymentRecord.webhookProcessedAt = now;

    await paymentRecord.save({ session });

    // ── Update Plan stats ──
    plan.totalPurchases += 1;
    plan.totalRevenueGenerated += paymentRecord.amount;
    plan.lastPurchaseDate = now;
    await plan.save({ session });

    // ── Create wallet transaction record ──
    const wallet = await Wallet.findOne({ driverId }).session(session);
    if (wallet) {
      wallet.transactions.push({
        type: 'plan_purchase',
        amount: paymentRecord.amount,
        description: `Plan purchase: ${plan.planName}`,
        razorpayOrderId,
        razorpayPaymentId,
        paymentMethod: 'razorpay',
        status: 'completed',
        createdAt: now,
      });
      await wallet.save({ session });
    }

    await session.commitTransaction();

    console.log(
      `✅ Plan payment verified: ${razorpayPaymentId} | Driver: ${driverId} | Plan: ${plan.planName}`
    );

    // ── Emit socket notification ──
    safeEmit(req.io, `driver_${driverId}`, 'plan:activated', {
      planName: plan.planName,
      validTill: expiryDate.toISOString(),
      benefits: plan.benefits,
      message: `✅ Plan "${plan.planName}" activated successfully!`,
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      message: 'Payment verified successfully. Plan activated!',
      data: {
        driverPlanId: driverPlan._id,
        planName: plan.planName,
        type: plan.planType,
        activeSince: now.toISOString(),
        validTill: expiryDate.toISOString(),
        daysValid: plan.durationDays,
        benefits: plan.benefits,
        commissionRate: plan.noCommission ? 0 : plan.commissionRate,
        bonusMultiplier: plan.bonusMultiplier,
        amount: paymentRecord.amount,
      },
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('❌ verifyPlanPayment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

// ════════════════════════════════════════════════════════════════════
// 3. DEACTIVATE CURRENT PLAN
// POST /api/driver/plan/current/deactivate
// ════════════════════════════════════════════════════════════════════
export const deactivateCurrentPlan = async (req, res) => {
  try {
    const driverId = req.user._id;

    const driverPlan = await DriverPlan.findOne({
      driver: driverId,
      isActive: true,
    });

    if (!driverPlan) {
      return res.status(400).json({
        success: false,
        message: 'No active plan to deactivate',
      });
    }

    driverPlan.isActive = false;
    driverPlan.deactivatedDate = new Date();
    driverPlan.deactivationReason = 'driver_requested';

    await driverPlan.save();

    console.log(`✅ Plan deactivated: ${driverPlan._id} | Driver: ${driverId}`);

    safeEmit(req.io, `driver_${driverId}`, 'plan:deactivated', {
      planName: driverPlan.planName,
      message: 'Plan has been deactivated',
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: 'Plan deactivated successfully',
    });
  } catch (error) {
    console.error('❌ deactivateCurrentPlan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to deactivate plan',
      error: error.message,
    });
  }
};

// ════════════════════════════════════════════════════════════════════
// 4. GET PLAN PURCHASE HISTORY (ADMIN)
// GET /api/admin/plans/:planId/purchases
// ════════════════════════════════════════════════════════════════════
export const getPlanPurchaseHistory = async (req, res) => {
  try {
    const { planId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const skip = (page - 1) * limit;

    const purchases = await PaymentPlan.find({ planId, paymentStatus: 'completed' })
      .populate('driverId', 'name phone vehicleNumber')
      .sort({ completedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await PaymentPlan.countDocuments({ planId, paymentStatus: 'completed' });

    res.json({
      success: true,
      data: purchases.map((p) => ({
        _id: p._id,
        driverId: p.driverId._id,
        driverName: p.driverId.name,
        driverPhone: p.driverId.phone,
        amount: p.amount,
        purchaseDate: p.completedAt,
        validTill: new Date(p.completedAt.getTime() + p.planDurationDays * 24 * 60 * 60 * 1000),
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('❌ getPlanPurchaseHistory error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch purchase history',
      error: error.message,
    });
  }
};

// ════════════════════════════════════════════════════════════════════
// 5. GET PLAN REVENUE STATS (ADMIN)
// GET /api/admin/plans/stats/revenue
// ════════════════════════════════════════════════════════════════════
export const getPlanRevenueStats = async (req, res) => {
  try {
    const { from, to } = req.query;

    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    // Total revenue
    const totalRevenue = await PaymentPlan.aggregate([
      {
        $match: {
          paymentStatus: 'completed',
          completedAt: { $gte: fromDate, $lte: toDate },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          count: { $sum: 1 },
          avgOrderValue: { $avg: '$amount' },
        },
      },
    ]);

    // Revenue by plan
    const revenueByPlan = await PaymentPlan.aggregate([
      {
        $match: {
          paymentStatus: 'completed',
          completedAt: { $gte: fromDate, $lte: toDate },
        },
      },
      {
        $group: {
          _id: '$planName',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
          avgPrice: { $avg: '$amount' },
        },
      },
      {
        $sort: { total: -1 },
      },
    ]);

    // Failed payments
    const failedPayments = await PaymentPlan.countDocuments({
      paymentStatus: 'failed',
      createdAt: { $gte: fromDate, $lte: toDate },
    });

    // Daily revenue
    const dailyRevenue = await PaymentPlan.aggregate([
      {
        $match: {
          paymentStatus: 'completed',
          completedAt: { $gte: fromDate, $lte: toDate },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$completedAt' },
          },
          revenue: { $sum: '$amount' },
          purchases: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    res.json({
      success: true,
      data: {
        period: { from: fromDate, to: toDate },
        totalStats: {
          totalRevenue: totalRevenue[0]?.total || 0,
          totalPurchases: totalRevenue[0]?.count || 0,
          avgOrderValue: Math.round((totalRevenue[0]?.avgOrderValue || 0) * 100) / 100,
        },
        revenueByPlan: revenueByPlan.map((p) => ({
          planName: p._id,
          revenue: p.total,
          purchases: p.count,
          avgPrice: Math.round(p.avgPrice * 100) / 100,
          percentage: `${Math.round((p.total / (totalRevenue[0]?.total || 1)) * 100)}%`,
        })),
        failedPayments,
        dailyRevenue: dailyRevenue.map((d) => ({
          date: d._id,
          revenue: d.revenue,
          purchases: d.purchases,
        })),
      },
    });
  } catch (error) {
    console.error('❌ getPlanRevenueStats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch revenue stats',
      error: error.message,
    });
  }
};

export default {
  createRazorpayPlanOrder,
  verifyPlanPayment,
  deactivateCurrentPlan,
  getPlanPurchaseHistory,
  getPlanRevenueStats,
};