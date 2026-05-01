// src/models/Referral.js
import mongoose from 'mongoose';

const referralSchema = new mongoose.Schema(
  {
    // Who shared the code
    referrerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Who used the code — UNIQUE: each user can only be referred ONCE
    referredUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    referralCode: {
      type: String,
      required: true,
      uppercase: true,
      index: true,
    },

    // Phone numbers stored for fraud detection
    referredPhone: {
      type: String,
      default: null,
      index: true,
    },

    referrerPhone: {
      type: String,
      default: null,
    },

    // Lifecycle
    signedUpAt: {
      type: Date,
      default: Date.now,
    },

    firstRideCompleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    firstRideTripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trip',
      default: null,
    },

    firstRideCompletedAt: {
      type: Date,
      default: null,
    },

    // Tracks completed rides by the referred user until they qualify referral.
    completedRideCount: {
      type: Number,
      default: 0,
    },

    // Whether referrer was rewarded for this referral
    referrerRewarded: {
      type: Boolean,
      default: false,
    },

    referrerRewardedAt: {
      type: Date,
      default: null,
    },

    // Fraud flags
    isFlagged: {
      type: Boolean,
      default: false,
      index: true,
    },

    flagReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes
referralSchema.index({ referrerId: 1, firstRideCompleted: 1 });
referralSchema.index({ referredPhone: 1 });
referralSchema.index({ referralCode: 1, firstRideCompleted: 1 });

export default mongoose.model('Referral', referralSchema);