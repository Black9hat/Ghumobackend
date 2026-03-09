// src/models/DriverPlan.js - Per-Driver Plan Assignment Model

import mongoose from 'mongoose';

/**
 * DriverPlan stores a snapshot of the plan terms at the moment of assignment.
 * Copying commissionRate, bonusMultiplier, etc. onto the record means that
 * editing a Plan template later will NOT retroactively change active drivers.
 */
const driverPlanSchema = new mongoose.Schema(
  {
    // ── Relationships ──────────────────────────────────────────────
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

    // ── Snapshot of plan terms at time of assignment ───────────────
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

    // ── Lifecycle ──────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    activatedDate: {
      type: Date,
      default: Date.now,
    },
    expiryDate: {
      type: Date,
      default: null, // null = no expiry
      index: true,
    },

    // ── Admin metadata ─────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reason: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { timestamps: true }
);

// Compound index: quickly find a driver's current active plan
driverPlanSchema.index({ driver: 1, isActive: 1, expiryDate: 1 });
// Analytics aggregations
driverPlanSchema.index({ planType: 1, isActive: 1 });
driverPlanSchema.index({ plan: 1, isActive: 1 });

export default mongoose.model('DriverPlan', driverPlanSchema);