// src/models/DriverPlan.js - ENHANCED Per-Driver Plan Assignment Model with Payment Support

import mongoose from 'mongoose';

/**
 * DriverPlan stores:
 * 1. A snapshot of the plan terms at assignment time (immutable)
 * 2. Driver-specific plan details (activation date, expiry date, status)
 * 3. Payment information (if driver purchased the plan)
 *
 * Snapshot approach means editing a Plan template later will NOT
 * retroactively change drivers already on that plan.
 */
const driverPlanSchema = new mongoose.Schema(
  {
    // ════════════════════════════════════════════════════════════════════
    // RELATIONSHIPS
    // ════════════════════════════════════════════════════════════════════
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      required: true,
    },

    // ════════════════════════════════════════════════════════════════════
    // SNAPSHOT OF PLAN TERMS AT TIME OF ASSIGNMENT
    // (These are copies - editing Plan template won't affect existing DriverPlans)
    // ════════════════════════════════════════════════════════════════════
    planName: {
      type: String,
      required: true,
      trim: true,
    },
    planType: {
      type: String,
      enum: ['basic', 'standard', 'premium'],
      required: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    commissionRate: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    bonusMultiplier: {
      type: Number,
      required: true,
      min: 1.0,
    },
    noCommission: {
      type: Boolean,
      default: false,
    },
    monthlyFee: {
      type: Number,
      required: true,
      min: 0,
    },
    benefits: [
      {
        type: String,
        trim: true,
      },
    ],

    // ════════════════════════════════════════════════════════════════════
    // ✨ NEW: SNAPSHOT OF PLAN PURCHASE DETAILS
    // ════════════════════════════════════════════════════════════════════
    planPrice: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Price at time of purchase (snapshot from Plan)',
    },

    durationDays: {
      type: Number,
      default: 30,
      min: 1,
      description: 'Plan validity duration in days (snapshot from Plan)',
    },

    // ════════════════════════════════════════════════════════════════════
    // ✨ NEW: TIME-BASED WINDOW SNAPSHOT
    // ════════════════════════════════════════════════════════════════════
    isTimeBasedPlan: {
      type: Boolean,
      default: false,
      description: 'Snapshot: is this a time-restricted plan?',
    },

    planStartTime: {
      type: String,
      default: '00:00',
      description: 'Snapshot: start time HH:MM from original plan',
    },

    planEndTime: {
      type: String,
      default: '23:59',
      description: 'Snapshot: end time HH:MM from original plan',
    },

    // ════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ════════════════════════════════════════════════════════════════════
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    activatedDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expiryDate: {
      type: Date,
      default: null,
      index: true,
      description: 'When plan expires (auto-set based on durationDays)',
    },

    // ════════════════════════════════════════════════════════════════════
    // ✨ NEW: PAYMENT TRACKING (For driver-initiated purchases)
    // ════════════════════════════════════════════════════════════════════
    razorpayPaymentId: {
      type: String,
      sparse: true,
      index: true,
      description: 'Razorpay payment ID from successful payment',
    },

    razorpayOrderId: {
      type: String,
      sparse: true,
      index: true,
      description: 'Razorpay order ID for this plan purchase',
    },

    amountPaid: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Actual amount paid by driver (in INR)',
    },

    planPurchaseDate: {
      type: Date,
      default: null,
      description: 'When driver bought this plan (null for admin-assigned)',
    },

    paymentStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
      index: true,
      description: 'Payment status for driver-purchased plans',
    },

    purchaseMethod: {
      type: String,
      enum: ['admin_assigned', 'driver_purchase'],
      default: 'admin_assigned',
      index: true,
      description: 'Was this plan assigned by admin or purchased by driver?',
    },

    // ════════════════════════════════════════════════════════════════════
    // ADMIN METADATA
    // ════════════════════════════════════════════════════════════════════
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      description: 'Admin who created this assignment',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reason: {
      type: String,
      trim: true,
      default: '',
      description: 'Why was this plan assigned? (admin notes)',
    },

    // ════════════════════════════════════════════════════════════════════
    // DEACTIVATION INFO
    // ════════════════════════════════════════════════════════════════════
    deactivatedDate: {
      type: Date,
      default: null,
      description: 'When plan was manually deactivated',
    },

    deactivationReason: {
      type: String,
      trim: true,
      default: '',
      enum: ['', 'expired', 'manual_deactivation', 'driver_requested', 'payment_failed'],
      description: 'Why plan was deactivated',
    },
  },
  { timestamps: true }
);

// ════════════════════════════════════════════════════════════════════
// INDEXES FOR PERFORMANCE
// ════════════════════════════════════════════════════════════════════

// Find driver's current active plan
driverPlanSchema.index({ driver: 1, isActive: 1, expiryDate: 1 });

// Analytics aggregations
driverPlanSchema.index({ planType: 1, isActive: 1 });
driverPlanSchema.index({ plan: 1, isActive: 1 });

// Payment tracking
driverPlanSchema.index({ razorpayPaymentId: 1, paymentStatus: 1 });
driverPlanSchema.index({ razorpayOrderId: 1 });

// Purchase analytics
driverPlanSchema.index({ purchaseMethod: 1, planPurchaseDate: -1 });
driverPlanSchema.index({ planPurchaseDate: -1 });

// Find expired plans
driverPlanSchema.index({ isActive: 1, expiryDate: 1 });

// Find plans by time window
driverPlanSchema.index({ isTimeBasedPlan: 1, isActive: 1 });

// ════════════════════════════════════════════════════════════════════
// VIRTUAL PROPERTIES
// ════════════════════════════════════════════════════════════════════

/**
 * Calculate days remaining until expiry
 */
driverPlanSchema.virtual('daysRemaining').get(function () {
  if (!this.expiryDate || !this.isActive) return 0;
  const now = new Date();
  if (this.expiryDate < now) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((this.expiryDate - now) / msPerDay);
});

/**
 * Check if plan is expired
 */
driverPlanSchema.virtual('isExpired').get(function () {
  if (!this.expiryDate) return false;
  return this.expiryDate < new Date();
});

/**
 * Check if plan was purchased by driver
 */
driverPlanSchema.virtual('isPurchased').get(function () {
  return this.purchaseMethod === 'driver_purchase';
});

driverPlanSchema.set('toJSON', { virtuals: true });
driverPlanSchema.set('toObject', { virtuals: true });

// ════════════════════════════════════════════════════════════════════
// SCHEMA METHODS
// ════════════════════════════════════════════════════════════════════

/**
 * Check if plan is currently in valid time window
 */
driverPlanSchema.methods.isInTimeWindow = function () {
  if (!this.isTimeBasedPlan) return true;

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const startTime = this.planStartTime;
  const endTime = this.planEndTime;

  // If endTime < startTime, plan wraps around midnight
  if (endTime < startTime) {
    return currentTime >= startTime || currentTime <= endTime;
  }
  return currentTime >= startTime && currentTime <= endTime;
};

/**
 * Check if plan is currently active and valid
 */
driverPlanSchema.methods.isValidNow = function () {
  // Check basic status
  if (!this.isActive) return false;

  // Check expiry date
  if (this.isExpired) return false;

  // Check time window if applicable
  if (this.isTimeBasedPlan && !this.isInTimeWindow()) return false;

  return true;
};

/**
 * Get driver-facing plan info
 */
driverPlanSchema.methods.getDriverInfo = function () {
  return {
    _id: this._id,
    planName: this.planName,
    type: this.planType,
    commissionRate: this.commissionRate,
    bonusMultiplier: this.bonusMultiplier,
    benefits: this.benefits,
    activatedDate: this.activatedDate,
    expiryDate: this.expiryDate,
    daysRemaining: this.daysRemaining,
    isActive: this.isActive && !this.isExpired,
    isPurchased: this.isPurchased,
    amountPaid: this.amountPaid,
  };
};

/**
 * Mark plan as expired
 */
driverPlanSchema.methods.markAsExpired = async function () {
  this.isActive = false;
  this.deactivatedDate = new Date();
  this.deactivationReason = 'expired';
  return this.save();
};

/**
 * Deactivate plan manually
 */
driverPlanSchema.methods.deactivate = async function (reason = 'manual_deactivation') {
  this.isActive = false;
  this.deactivatedDate = new Date();
  this.deactivationReason = reason;
  return this.save();
};

/**
 * Mark payment as completed
 */
driverPlanSchema.methods.markPaymentCompleted = async function (paymentId, orderId) {
  this.razorpayPaymentId = paymentId;
  this.razorpayOrderId = orderId;
  this.paymentStatus = 'completed';
  this.planPurchaseDate = new Date();
  
  // Auto-set expiry date based on duration
  if (this.durationDays) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + this.durationDays);
    this.expiryDate = expiryDate;
  }
  
  this.isActive = true;
  return this.save();
};

export default mongoose.model('DriverPlan', driverPlanSchema);