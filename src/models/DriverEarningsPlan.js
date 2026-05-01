// src/models/DriverEarningsPlan.js
// Simple driver earnings plan model used by Driverearningsmanagement admin page.
// Separate from the main Plan/DriverPlan system (which handles Razorpay purchases).

import mongoose from 'mongoose';

const driverEarningsPlanSchema = new mongoose.Schema(
  {
    planName: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    monthlyFee: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    commissionPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 10,
    },
    minRideValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

export default mongoose.model('DriverEarningsPlan', driverEarningsPlanSchema);