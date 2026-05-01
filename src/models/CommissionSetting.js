// src/models/CommissionSetting.js
// Global commission + platform fee config, per vehicle type.
// One document per (vehicleType, city) pair with compound unique index.
// Admin edits flow: admin saves → socket broadcasts to all online drivers immediately.
// At trip completion, tripController reads from this collection (never hardcoded).

import mongoose from 'mongoose';

const commissionSettingSchema = new mongoose.Schema(
  {
    // ─────────────────────────────────────────────────────────
    // IDENTITY — one document per vehicleType + city
    // ─────────────────────────────────────────────────────────
    vehicleType: {
      type: String,
      enum: ['bike', 'auto', 'car', 'premium', 'xl', 'all'],
      required: true,
      index: true,
    },

    // 'all' city = global fallback; specific city overrides global
    city: {
      type: String,
      default: 'all',
      index: true,
      trim: true,
      lowercase: true,
    },

    // ─────────────────────────────────────────────────────────
    // COMMISSION (% cut from fare)
    // ─────────────────────────────────────────────────────────
    // Percentage of final fare taken by platform before driver gets paid
    commissionPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 20,
    },

    // ─────────────────────────────────────────────────────────
    // PLATFORM FEE (added to customer bill)
    // ─────────────────────────────────────────────────────────
    // Flat rupee amount added to every trip fare
    platformFeeFlat: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Percentage-based platform fee (% of fare before adding flat fee)
    platformFeePercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // ─────────────────────────────────────────────────────────
    // DRIVER INCENTIVES (per trip, credited to driver wallet)
    // ─────────────────────────────────────────────────────────
    // Fixed cash amount credited to driver per completed ride
    perRideIncentive: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Soft currency (coins) credited to driver per completed ride
    perRideCoins: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─────────────────────────────────────────────────────────
    // STATUS & AUDIT
    // ─────────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    updatedByAdmin: {
      type: String,
      default: 'system',
      trim: true,
    },

    changeNote: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },

    // ✅ Race condition fix: Prevent double-awards for same trip
    lastRideId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ─────────────────────────────────────────────────────────
// COMPOUND UNIQUE INDEX: Prevent duplicates per vehicleType + city
// ─────────────────────────────────────────────────────────
commissionSettingSchema.index(
  { vehicleType: 1, city: 1 },
  { unique: true, sparse: false }
);

// ─────────────────────────────────────────────────────────
// STATIC METHOD: Fetch commission for a vehicle type
// Fallback chain: exact city → global city 'all' → hard default
// ─────────────────────────────────────────────────────────
commissionSettingSchema.statics.getForVehicle = async function (
  vehicleType,
  city = 'all'
) {
  try {
    // Step 1: Try exact city match
    let setting = await this.findOne({
      vehicleType,
      city: city.toLowerCase(),
      isActive: true,
    }).lean();

    // Step 2: Fall back to global ('all') if no city-specific
    if (!setting) {
      setting = await this.findOne({
        vehicleType,
        city: 'all',
        isActive: true,
      }).lean();
    }

    // Step 3: Return found or hard default (NEVER null)
    if (setting) {
      return {
        vehicleType: setting.vehicleType,
        city: setting.city,
        commissionPercent: setting.commissionPercent ?? 20,
        platformFeeFlat: setting.platformFeeFlat ?? 0,
        platformFeePercent: setting.platformFeePercent ?? 0,
        perRideIncentive: setting.perRideIncentive ?? 0,
        perRideCoins: setting.perRideCoins ?? 0,
        isActive: setting.isActive,
      };
    }

    // Hard default (safety net)
    return {
      vehicleType,
      city: 'all',
      commissionPercent: 20,
      platformFeeFlat: 0,
      platformFeePercent: 0,
      perRideIncentive: 0,
      perRideCoins: 0,
      isActive: true,
    };
  } catch (err) {
    console.error('❌ CommissionSetting.getForVehicle error:', err);
    // Return hard default on error (never crash)
    return {
      vehicleType,
      city: 'all',
      commissionPercent: 20,
      platformFeeFlat: 0,
      platformFeePercent: 0,
      perRideIncentive: 0,
      perRideCoins: 0,
      isActive: true,
    };
  }
};

const CommissionSetting =
  mongoose.models.CommissionSetting ||
  mongoose.model('CommissionSetting', commissionSettingSchema);

export default CommissionSetting;
