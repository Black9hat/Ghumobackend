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
      enabled:        { type: Boolean, default: true },
      discountAmount: { type: Number,  default: 25 },       // ₹ off
      fareAdjustment: { type: Number,  default: 15 },       // internal markup before discount
      code:           { type: String,  default: 'WELCOME25' }, // auto-created coupon code
      validityDays:   { type: Number,  default: 365 },
    },

    // ── Coins System ─────────────────────────────────────────────────────────
    coins: {
      // ── Core (existing — DO NOT change field names) ───────────────────────
      enabled:                     { type: Boolean, default: true },
      coinsPerRide:                { type: Number,  default: 5 },
      conversionRate:              { type: Number,  default: 0.10 },  // 1 coin = ₹0.10
      maxDiscountPerRide:          { type: Number,  default: 20 },    // max ₹ off via coins
      coinsRequiredForMaxDiscount: { type: Number,  default: 200 },   // 200 coins → ₹20

      // ── Distance Bonus Tiers (admin-editable) ─────────────────────────────
      // Sorted ascending by maxKm. Last tier should have maxKm: null (open-ended).
      // coinService.js reads these to compute earn preview on every fare call.
      distanceBonuses: {
        type: [
          {
            _id:   false,
            label: { type: String, default: '' },
            maxKm: { type: Number, default: null },  // null = "everything above prev tier"
            bonus: { type: Number, default: 0 },
          },
        ],
        default: [
          { label: '0–3 km', maxKm: 3,    bonus: 1 },
          { label: '3–8 km', maxKm: 8,    bonus: 2 },
          { label: '8+ km',  maxKm: null, bonus: 4 },
        ],
      },

      // ── Vehicle Bonus Map (admin-editable) ────────────────────────────────
      // Extra coins on top of base + distance, by vehicle type.
      vehicleBonuses: {
        type: {
          bike:    { type: Number, default: 1 },
          auto:    { type: Number, default: 2 },
          car:     { type: Number, default: 3 },
          premium: { type: Number, default: 3 },
          xl:      { type: Number, default: 4 },
        },
        default: () => ({ bike: 1, auto: 2, car: 3, premium: 3, xl: 4 }),
      },

      // ── Lucky / Random Bonus (admin-editable) ─────────────────────────────
      // Hidden from fare card preview — shown as a surprise after ride completes.
      randomBonusCoins:  { type: Number, default: 10 },    // coins awarded on a lucky ride
      randomBonusChance: { type: Number, default: 0.20 },  // probability 0–1  (0.20 = 20%)
    },

    // ── Referral System ──────────────────────────────────────────────────────
    referral: {
      enabled:                  { type: Boolean, default: true },
      referralsRequired:        { type: Number,  default: 5 },   // 5 completed referrals → reward
      rewardCouponAmount:       { type: Number,  default: 30 },  // ₹30 coupon
      rewardCoins:              { type: Number,  default: 50 },  // 50 coins
      rewardCouponValidityDays: { type: Number,  default: 90 },
    },

    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: 'system' },
  },
  { collection: 'app_settings' }
);

// ── Static helper ─────────────────────────────────────────────────────────────
// Unchanged — all callers using AppSettings.getSettings() continue to work.
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
