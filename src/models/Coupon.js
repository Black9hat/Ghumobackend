// models/Coupon.js
import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  },
  description: {
    type: String,
    required: true,
  },
  discountType: {
    type: String,
    enum: ['PERCENTAGE', 'FIXED'],
    required: true,
  },
  discountValue: {
    type: Number,
    required: true,
    min: 0,
  },
  maxDiscountAmount: {
    type: Number,
    default: null,
  },
  minFareAmount: {
    type: Number,
    default: 0,
  },
  
  // 🚗 NEW: Vehicle-specific coupons
 applicableVehicles: {
  type: [String],
  default: []
},

  
  // Usage conditions
  applicableFor: {
    type: String,
    enum: ['FIRST_RIDE', 'NTH_RIDE', 'EVERY_NTH_RIDE', 'SPECIFIC_RIDES', 'ALL_RIDES'],
    required: true,
  },
  rideNumber: {
    type: Number,
    default: null,
  },
  specificRideNumbers: {
    type: [Number],
    default: [],
  },
  maxUsagePerUser: {
    type: Number,
    default: 1,
  },
  totalUsageLimit: {
    type: Number,
    default: null,
  },
  currentUsageCount: {
    type: Number,
    default: 0,
  },
  // Validity
  validFrom: {
    type: Date,
    default: Date.now,
  },
  validUntil: {
    type: Date,
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  // User restrictions
  eligibleUserTypes: {
    type: [String],
    enum: ['NEW', 'EXISTING', 'ALL'],
    default: ['ALL'],
  },
  minRidesCompleted: {
    type: Number,
    default: 0,
  },
  maxRidesCompleted: {
    type: Number,
    default: null,
  },
  // Metadata
  createdBy: {
    type: String,
    default: 'admin',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for quick lookups
couponSchema.index({ code: 1 });
couponSchema.index({ isActive: 1, validUntil: 1 });
couponSchema.index({ applicableVehicles: 1 });

// Method to check if coupon is valid
couponSchema.methods.isValid = function() {
  const now = new Date();
  return (
    this.isActive &&
    now >= this.validFrom &&
    now <= this.validUntil &&
    (this.totalUsageLimit === null || this.currentUsageCount < this.totalUsageLimit)
  );
};

// 🚗 FIXED: Method to check if coupon is applicable for a vehicle
couponSchema.methods.isApplicableForVehicle = function(vehicleType) {
  if (!this.applicableVehicles || this.applicableVehicles.length === 0) {
    return false;  // empty = no match
  }

  // If 'all' is in the array, coupon applies to all vehicle types
  if (this.applicableVehicles.includes('all')) {
    return true;
  }

  // If no vehicle type specified, return false (can't match specific vehicles)
  if (!vehicleType) {
    return false;
  }

  // Otherwise check if the specific vehicle type is included
  return this.applicableVehicles.includes(vehicleType.toLowerCase());
};


export default mongoose.model('Coupon', couponSchema);