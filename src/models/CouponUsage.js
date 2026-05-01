// models/CouponUsage.js
import mongoose from 'mongoose';

const couponUsageSchema = new mongoose.Schema({
  couponId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Coupon',
    required: true,
  },
  couponCode: {
    type: String,
    required: true,
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true,
  },
  tripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
    default: null,
  },
  originalFare: {
    type: Number,
    required: true,
  },
  discountAmount: {
    type: Number,
    required: true,
  },
  finalFare: {
    type: Number,
    required: true,
  },
  // 🚗 NEW: Track which vehicle type was used
  vehicleType: {
    type: String,
    enum: ['bike', 'auto', 'car', 'premium', 'xl', 'unknown'],
    default: 'unknown',
  },
  usedAt: {
    type: Date,
    default: Date.now,
  },
});

couponUsageSchema.index({ customerId: 1, couponId: 1 });
couponUsageSchema.index({ couponCode: 1 });
couponUsageSchema.index({ vehicleType: 1 });

export default mongoose.model('CouponUsage', couponUsageSchema);