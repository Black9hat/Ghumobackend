// models/AppSettings.js
// ─────────────────────────────────────────────────────────────────────────────
// Single-document config collection for all admin-configurable reward params.
// Access via AppSettings.getSettings() — creates defaults on first call.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const appSettingsSchema = new mongoose.Schema(
  {
    // ── Welcome Coupon ────────────────────────────────────────────────────────
    welcomeCoupon: {
      enabled: { type: Boolean, default: true },
      discountAmount: { type: Number, default: 25 },       // ₹ off
      fareAdjustment: { type: Number, default: 15 },       // internal markup before discount
      code: { type: String, default: 'WELCOME25' },        // auto-created coupon code
      validityDays: { type: Number, default: 365 },
    },

    // ── Coins System ─────────────────────────────────────────────────────────
    coins: {
      enabled: { type: Boolean, default: true },
      coinsPerRide: { type: Number, default: 5 },
      conversionRate: { type: Number, default: 0.10 },     // 1 coin = ₹0.10  (100 coins = ₹10)
      maxDiscountPerRide: { type: Number, default: 20 },   // max ₹ discount per ride via coins
      coinsRequiredForMaxDiscount: { type: Number, default: 200 }, // 200 coins → ₹20
    },

    // ── Referral System ──────────────────────────────────────────────────────
    referral: {
      enabled: { type: Boolean, default: true },
      referralsRequired: { type: Number, default: 5 },     // 5 completed referrals → reward
      rewardCouponAmount: { type: Number, default: 30 },   // ₹30 coupon
      rewardCoins: { type: Number, default: 50 },          // 50 coins
      rewardCouponValidityDays: { type: Number, default: 90 },
    },

    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: 'system' },
  },
  { collection: 'app_settings' }
);

// ── Static helper ─────────────────────────────────────────────────────────────
appSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
    console.log('✅ AppSettings initialised with defaults');
  }
  return settings;
};

const AppSettings = mongoose.model('AppSettings', appSettingsSchema);
export default AppSettings;
