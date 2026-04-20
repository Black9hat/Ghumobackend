// src/models/Plan.js
// Plan template — admin creates these; drivers can subscribe to them.
// Fields mirror CommissionSetting so plan-active drivers get identical
// per-vehicle economics as no-plan drivers, just with different values.

import mongoose from 'mongoose';

const planSchema = new mongoose.Schema(
  {
    // ─────────────────────────────────────────────────────────
    // IDENTITY
    // ─────────────────────────────────────────────────────────
    planName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    planType: {
      type: String,
      enum: ['basic', 'standard', 'premium'],
      required: true,
    },

    description: {
      type: String,
      default: '',
      trim: true,
    },

    benefits: {
      type: [String],
      default: [],
    },

    // ─────────────────────────────────────────────────────────
    // PRICING
    // ─────────────────────────────────────────────────────────
    planPrice: {
      type: Number,
      default: 0,
      min: 0,
    },

    monthlyFee: {
      type: Number,
      default: 0,
      min: 0,
    },

    durationDays: {
      type: Number,
      default: 30,
      min: 1,
    },

    // ─────────────────────────────────────────────────────────
    // COMMISSION  (mirrors CommissionSetting.commissionPercent)
    // ─────────────────────────────────────────────────────────
    commissionRate: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 20,
    },

    noCommission: {
      type: Boolean,
      default: false,
    },

    // ─────────────────────────────────────────────────────────
    // PER-RIDE INCENTIVE  (mirrors CommissionSetting.perRideIncentive)
    // Cash credited to the driver wallet after each completed ride.
    // 0 = hidden from driver UI (same rule as CommissionSetting).
    // ─────────────────────────────────────────────────────────
    perRideIncentive: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─────────────────────────────────────────────────────────
    // PLATFORM FEE  (mirrors CommissionSetting.platformFeeFlat / Percent)
    // Added on top of the fare and paid by the customer.
    // ─────────────────────────────────────────────────────────
    platformFeeFlat: {
      type: Number,
      default: 0,
      min: 0,
    },

    platformFeePercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // ─────────────────────────────────────────────────────────
    // TIME-BASED WINDOW (optional — restrict benefits to hours)
    // ─────────────────────────────────────────────────────────
    isTimeBasedPlan: {
      type: Boolean,
      default: false,
    },

    planStartTime: {
      type: String,
      default: '00:00',
      trim: true,
    },

    planEndTime: {
      type: String,
      default: '23:59',
      trim: true,
    },

    // ─────────────────────────────────────────────────────────
    // OFFER WINDOW (optional — plan only purchasable between these dates)
    // ─────────────────────────────────────────────────────────
    planActivationDate: {
      type: Date,
      default: null,
    },

    planExpiryDate: {
      type: Date,
      default: null,
    },

    // ─────────────────────────────────────────────────────────
    // STATUS & AUDIT
    // ─────────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    // Aggregate stats (incremented when drivers buy / earn)
    totalPurchases: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalRevenueGenerated: {
      type: Number,
      default: 0,
      min: 0,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────────────────────────
// INSTANCE METHOD: safe subset returned to the driver app
// ─────────────────────────────────────────────────────────────────
planSchema.methods.getDriverInfo = function () {
  return {
    _id:               this._id,
    planName:          this.planName,
    planType:          this.planType,
    description:       this.description,
    benefits:          this.benefits,
    planPrice:         this.planPrice,
    durationDays:      this.durationDays,
    commissionRate:    this.noCommission ? 0 : this.commissionRate,
    noCommission:      this.noCommission,
    perRideIncentive:  this.perRideIncentive,
    platformFeeFlat:   this.platformFeeFlat,
    platformFeePercent:this.platformFeePercent,
    isTimeBasedPlan:   this.isTimeBasedPlan,
    planStartTime:     this.planStartTime,
    planEndTime:       this.planEndTime,
  };
};

export default mongoose.models.Plan || mongoose.model('Plan', planSchema);