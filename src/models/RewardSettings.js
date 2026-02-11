// models/RewardSettings.js
import mongoose from 'mongoose';

const distanceTierSchema = new mongoose.Schema({
  minDistance: { type: Number, required: true }, // in km
  maxDistance: { type: Number, required: true }, // in km (use Infinity for 10+)
  platformFee: { type: Number, required: true }, // ₹ per ride
  coinsPerRide: { type: Number, required: true },
  coinsRequiredForDiscount: { type: Number, required: true },
  discountAmount: { type: Number, required: true }, // ₹ off
});

const rewardSettingsSchema = new mongoose.Schema({
  distanceTiers: {
    type: [distanceTierSchema],
    default: [
      {
        minDistance: 0,
        maxDistance: 3,
        platformFee: 5,
        coinsPerRide: 5,
        coinsRequiredForDiscount: 50,
        discountAmount: 10,
      },
      {
        minDistance: 3,
        maxDistance: 5,
        platformFee: 7,
        coinsPerRide: 5,
        coinsRequiredForDiscount: 50,
        discountAmount: 15,
      },
      {
        minDistance: 5,
        maxDistance: 10,
        platformFee: 10,
        coinsPerRide: 5,
        coinsRequiredForDiscount: 50,
        discountAmount: 20,
      },
      {
        minDistance: 10,
        maxDistance: Infinity,
        platformFee: 15,
        coinsPerRide: 5,
        coinsRequiredForDiscount: 50,
        discountAmount: 25,
      },
    ],
  },
  weekendBonus: {
    type: Number,
    default: 0, // Can keep for future use
  },
  referralBonus: {
    type: Number,
    default: 50,
  },
  isDiscountEnabled: {
    type: Boolean,
    default: true, // ✅ NEW: Toggle to enable/disable discount system
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: String,
  },
});

// Helper method to get tier based on distance
rewardSettingsSchema.methods.getTierByDistance = function(distance) {
  return this.distanceTiers.find(
    tier => distance >= tier.minDistance && distance < tier.maxDistance
  ) || this.distanceTiers[this.distanceTiers.length - 1]; // fallback to last tier
};

const RewardSettings = mongoose.model('RewardSettings', rewardSettingsSchema);
export default RewardSettings;