// src/models/Plan.js - Plan Template Model

import mongoose from 'mongoose';

const planSchema = new mongoose.Schema(
  {
    // Basic Info
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

    // Commission & Earnings
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

    // Subscription
    monthlyFee: {
      type: Number,
      required: true,
      min: 0,
      // Subscription cost in INR (0 = free plan)
    },

    // Features
    benefits: [
      {
        type: String,
        trim: true,
        // e.g., "Zero commission", "24/7 support", "Priority matching"
      },
    ],

    // Status
    isActive: {
      type: Boolean,
      default: true,
      // If false, new drivers cannot subscribe to this plan
    },

    // Metadata
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      // Admin who created this plan template
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Index for quick lookup
planSchema.index({ planType: 1, isActive: 1 });
planSchema.index({ createdAt: -1 });

export default mongoose.model('Plan', planSchema);