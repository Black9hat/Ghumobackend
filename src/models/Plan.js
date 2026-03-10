// src/models/Plan.js - ENHANCED Plan Template Model with Purchase Support

import mongoose from 'mongoose';

const planSchema = new mongoose.Schema(
  {
    // ════════════════════════════════════════════════════════════════════
    // BASIC INFO
    // ════════════════════════════════════════════════════════════════════
    planName: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      // e.g., "Premium Pro", "Standard", "Basic"
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

    // ════════════════════════════════════════════════════════════════════
    // COMMISSION & EARNINGS
    // ════════════════════════════════════════════════════════════════════
    commissionRate: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      // Percentage the platform takes (e.g., 20 = 20%)
      // When noCommission = true, this is ignored
    },
    bonusMultiplier: {
      type: Number,
      required: true,
      min: 1.0,
      // Multiplier for driver earnings (e.g., 1.2 = 20% bonus)
      // Formula: driverEarning * bonusMultiplier
    },
    noCommission: {
      type: Boolean,
      default: false,
      // If true: ignore commissionRate, apply 0% commission
    },

    // ════════════════════════════════════════════════════════════════════
    // ✨ NEW: PURCHASE CONFIGURATION
    // ════════════════════════════════════════════════════════════════════
    planPrice: {
      type: Number,
      required: true,
      min: 0,
      description: 'Price driver pays to purchase this plan (in INR)',
      // e.g., 299 for a monthly plan
    },

    durationDays: {
      type: Number,
      required: true,
      default: 30,
      min: 1,
      description: 'How many days the plan is valid after driver purchases it',
      // e.g., 30 days = 1 month subscription
      // When driver buys, expiryDate = activatedDate + durationDays
    },

    // ════════════════════════════════════════════════════════════════════
    // ✨ NEW: TIME-BASED WINDOW (Optional - for time-locked promotions)
    // ════════════════════════════════════════════════════════════════════
    isTimeBasedPlan: {
      type: Boolean,
      default: false,
      description: 'If true, plan only benefits apply during planStartTime - planEndTime',
      // Use case: "6 AM to 11 PM peak hours only" promotions
    },

    planStartTime: {
      type: String,
      default: '00:00',
      match: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/,
      description: 'Start time in HH:MM format, e.g., "06:00"',
      // Only used if isTimeBasedPlan = true
    },

    planEndTime: {
      type: String,
      default: '23:59',
      match: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/,
      description: 'End time in HH:MM format, e.g., "23:00"',
      // Only used if isTimeBasedPlan = true
      // If endTime < startTime, plan wraps around midnight
    },

    // ════════════════════════════════════════════════════════════════════
    // SUBSCRIPTION (Monthly Fee - separate from purchase price)
    // ════════════════════════════════════════════════════════════════════
    monthlyFee: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      // Used for admin-assigned plans
      // For driver-purchased plans, planPrice is the main cost
    },

    // ════════════════════════════════════════════════════════════════════
    // FEATURES
    // ════════════════════════════════════════════════════════════════════
    benefits: [
      {
        type: String,
        trim: true,
        // e.g., "Zero commission", "1.2x earnings", "24/7 support"
      },
    ],

    // ════════════════════════════════════════════════════════════════════
    // STATUS
    // ════════════════════════════════════════════════════════════════════
    isActive: {
      type: Boolean,
      default: true,
      index: true,
      // If false, new drivers cannot purchase this plan
    },

    // ════════════════════════════════════════════════════════════════════
    // METADATA
    // ════════════════════════════════════════════════════════════════════
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      // Admin who created this plan template
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // ════════════════════════════════════════════════════════════════════
    // OFFER WINDOW (Admin sets when plan is available to buy)
    // ════════════════════════════════════════════════════════════════════
    planActivationDate: {
      type: Date,
      default: null,
      description: 'Date from which this plan becomes available for purchase (null = always available)',
    },
    planExpiryDate: {
      type: Date,
      default: null,
      description: 'Date after which this plan can no longer be purchased (null = never expires)',
    },

    // ════════════════════════════════════════════════════════════════════
    // STATS (For admin dashboard)
    // ════════════════════════════════════════════════════════════════════
    totalPurchases: {
      type: Number,
      default: 0,
      index: true,
    },
    totalRevenueGenerated: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastPurchaseDate: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// ════════════════════════════════════════════════════════════════════
// INDEXES FOR PERFORMANCE
// ════════════════════════════════════════════════════════════════════

// Quick lookups for available plans
planSchema.index({ planType: 1, isActive: 1 });

// For analytics
planSchema.index({ createdAt: -1 });
planSchema.index({ totalPurchases: -1 });
planSchema.index({ isTimeBasedPlan: 1, isActive: 1 });

// For search
planSchema.index({ planName: 'text', description: 'text' });

// ════════════════════════════════════════════════════════════════════
// VIRTUAL PROPERTIES
// ════════════════════════════════════════════════════════════════════

// Get average revenue per purchase
planSchema.virtual('avgRevenuePerPurchase').get(function () {
  if (this.totalPurchases === 0) return 0;
  return Math.round((this.totalRevenueGenerated / this.totalPurchases) * 100) / 100;
});

// Get plan summary for driver
planSchema.virtual('driverSummary').get(function () {
  return {
    planName: this.planName,
    type: this.planType,
    price: this.planPrice,
    duration: `${this.durationDays} days`,
    commission: this.noCommission ? '0%' : `${this.commissionRate}%`,
    bonus: this.bonusMultiplier !== 1 ? `${Math.round((this.bonusMultiplier - 1) * 100)}% bonus` : 'No bonus',
    benefits: this.benefits,
  };
});

planSchema.set('toJSON', { virtuals: true });
planSchema.set('toObject', { virtuals: true });

// ════════════════════════════════════════════════════════════════════
// SCHEMA METHODS
// ════════════════════════════════════════════════════════════════════

/**
 * Check if plan is currently in valid time window
 * Used for isTimeBasedPlan validation
 */
planSchema.methods.isInTimeWindow = function () {
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
 * Check if plan is currently available for purchase (offer window)
 */
planSchema.methods.isAvailableForPurchase = function () {
  const now = new Date();
  if (this.planActivationDate && now < this.planActivationDate) return false;
  if (this.planExpiryDate && now > this.planExpiryDate) return false;
  return this.isActive;
};

/**
 * Get plan display info for driver app
 */
planSchema.methods.getDriverInfo = function () {
  return {
    _id: this._id,
    planName: this.planName,
    type: this.planType,
    price: this.planPrice,
    duration: this.durationDays,
    commissionRate: this.noCommission ? 0 : this.commissionRate,
    bonusMultiplier: this.bonusMultiplier,
    benefits: this.benefits,
    isTimeBasedPlan: this.isTimeBasedPlan,
    timeWindow: this.isTimeBasedPlan ? `${this.planStartTime} - ${this.planEndTime}` : null,
    description: this.description,
    planActivationDate: this.planActivationDate,
    planExpiryDate: this.planExpiryDate,
    availableForPurchase: this.isAvailableForPurchase(),
  };
};

/**
 * Update stats after purchase
 */
planSchema.methods.recordPurchase = async function (amountPaid) {
  this.totalPurchases += 1;
  this.totalRevenueGenerated += amountPaid;
  this.lastPurchaseDate = new Date();
  return this.save();
};

export default mongoose.model('Plan', planSchema);