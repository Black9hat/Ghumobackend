// src/models/AppSettings.js
import mongoose from 'mongoose';

const appSettingsSchema = new mongoose.Schema(
  {
    // ── Welcome Coupon ──────────────────────────────────────────────────────
    welcomeCoupon: {
      enabled:               { type: Boolean, default: true  },
      useFixedWelcomeAmount: { type: Boolean, default: false },
      discountAmount:        { type: Number,  default: 25    },
      fareAdjustment:        { type: Number,  default: 0     },
      vehicleType: {
        type:    String,
        enum:    ['all', 'bike', 'auto', 'car', 'premium', 'xl'],
        default: 'all',
      },
      exactAmount:  { type: Number, default: null },
      fixedAmounts: {
        type: {
          all:     { type: Number, default: null },
          bike:    { type: Number, default: null },
          auto:    { type: Number, default: null },
          car:     { type: Number, default: null },
          premium: { type: Number, default: null },
          xl:      { type: Number, default: null },
        },
        default: () => ({ all: null, bike: null, auto: null, car: null, premium: null, xl: null }),
      },
      code:         { type: String, default: 'WELCOME25' },
      validityDays: { type: Number, default: 365 },
    },

    // ── Coins System ────────────────────────────────────────────────────────
    coins: {
      enabled:                     { type: Boolean, default: true  },
      coinsPerRide:                { type: Number,  default: 5     },
      conversionRate:              { type: Number,  default: 0.10  },
      maxDiscountPerRide:          { type: Number,  default: 20    },
      coinsRequiredForMaxDiscount: { type: Number,  default: 100   },

      distanceBonuses: {
        type: [
          {
            _id:   false,
            label: { type: String, default: ''   },
            maxKm: { type: Number, default: null },
            bonus: { type: Number, default: 0    },
          },
        ],
        default: [
          { label: '0–3 km', maxKm: 3,    bonus: 1 },
          { label: '3–8 km', maxKm: 8,    bonus: 2 },
          { label: '8+ km',  maxKm: null, bonus: 4 },
        ],
      },

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

      randomBonusCoins:  { type: Number, default: 10   },
      randomBonusChance: { type: Number, default: 0.20 },
    },

    // ── Referral System ─────────────────────────────────────────────────────
    referral: {
      enabled:                  { type: Boolean, default: true },

      // Cycle-based thresholds
      baseReferralsRequired:    { type: Number, default: 5  },
      extraReferralsPerCycle:   { type: Number, default: 2  },
      maxReferralCycles:        { type: Number, default: 3  },

      // Coupon rewards
      baseCouponAmount:         { type: Number, default: 30 },
      extraCouponAmount:        { type: Number, default: 10 },
      rewardCouponValidityDays: { type: Number, default: 90 },

      // Coin rewards
      baseCoinsReward:          { type: Number, default: 50 },
      extraCoinsReward:         { type: Number, default: 10 },

      // Legacy aliases (kept for backwards-compat with old reads)
      referralsRequired:        { type: Number, default: 5  },
      rewardCouponAmount:       { type: Number, default: 30 },
      rewardCoins:              { type: Number, default: 50 },
    },

    // ── Driver Referral System ───────────────────────────────────────────────
    driverReferral: {
      enabled:           { type: Boolean, default: true  },
      referralsRequired: { type: Number,  default: 1     },
      ridesToComplete:   { type: Number,  default: 1     },
      rewardAmount:      { type: Number,  default: 100   },
    },

    updatedAt: { type: Date,   default: Date.now    },
    updatedBy: { type: String, default: 'system'    },
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