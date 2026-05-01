// src/models/CommissionSetting.js
// Global commission + platform fee config, per vehicle type.
// Admin edits flow: admin saves → socket broadcasts to all online drivers immediately.
// At trip completion, tripController reads from this collection (never hardcoded).

import mongoose from 'mongoose';

const commissionSettingSchema = new mongoose.Schema(
  {
    // ─────────────────────────────────────────────────────────
    // IDENTITY — one document per vehicleType (+ optional city)
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
    // COMMISSION
    // ─────────────────────────────────────────────────────────
    // Percentage cut taken from the final fare before driver gets paid
    commissionPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 20,
    },

    // ─────────────────────────────────────────────────────────
    // PLATFORM FEE (added on top of fare, paid by customer)
    // ─────────────────────────────────────────────────────────
    // Flat amount added to every trip
    platformFeeFlat: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Percentage-based fee (applied after flat; rare but supported)
    platformFeePercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // ─────────────────────────────────────────────────────────
    // PER-RIDE DRIVER INCENTIVE (cash credited to driver wallet)
    // ─────────────────────────────────────────────────────────
    perRideIncentive: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Coins credited to driver after each ride
    perRideCoins: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─────────────────────────────────────────────────────────
    // STATUS
    // ─────────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    // Who last changed this — for audit trail
    updatedByAdmin: {
      type: String,
      default: null,
    },

    // Human-readable note for the audit log
    changeNote: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────────────────────────
// UNIQUE CONSTRAINT: one setting per (vehicleType + city) pair
// ─────────────────────────────────────────────────────────────────
commissionSettingSchema.index(
  { vehicleType: 1, city: 1 },
  { unique: true, name: 'unique_vehicle_city_commission' }
);

// ─────────────────────────────────────────────────────────────────
// STATIC HELPER: getForVehicle(vehicleType, city?)
// Priority: exact city match → global 'all' city → hard default
// Used by tripController at ride completion to resolve commission.
// ─────────────────────────────────────────────────────────────────
commissionSettingSchema.statics.getForVehicle = async function (vehicleType, city = 'all') {
  const normalizedVehicle = (vehicleType || 'bike').toLowerCase().trim();
  const normalizedCity = (city || 'all').toLowerCase().trim();

  // Try exact vehicle + city match
  if (normalizedCity !== 'all') {
    const exact = await this.findOne({
      vehicleType: normalizedVehicle,
      city: normalizedCity,
      isActive: true,
    }).lean();
    if (exact) return exact;
  }

  // Fallback: exact vehicle + global city
  const vehicleGlobal = await this.findOne({
    vehicleType: normalizedVehicle,
    city: 'all',
    isActive: true,
  }).lean();
  if (vehicleGlobal) return vehicleGlobal;

  // Fallback: 'all' vehicle + global city (catch-all row)
  const globalFallback = await this.findOne({
    vehicleType: 'all',
    city: 'all',
    isActive: true,
  }).lean();
  if (globalFallback) return globalFallback;

  // Hard default — never returns null
  return {
    vehicleType: normalizedVehicle,
    city: 'all',
    commissionPercent: 20,
    platformFeeFlat: 0,
    platformFeePercent: 0,
    perRideIncentive: 0,
    perRideCoins: 0,
    isActive: true,
    _isFallback: true,
  };
};

// ─────────────────────────────────────────────────────────────────
// STATIC HELPER: getAll()
// Returns every active setting, used for broadcasting config to drivers
// ─────────────────────────────────────────────────────────────────
commissionSettingSchema.statics.getAll = async function () {
  return this.find({ isActive: true }).sort({ vehicleType: 1, city: 1 }).lean();
};

export default mongoose.models.CommissionSetting ||
  mongoose.model('CommissionSetting', commissionSettingSchema);