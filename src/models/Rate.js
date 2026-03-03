import mongoose from 'mongoose';

/**
 * One document = one tariff card for ONE city/state + ONE vehicle type.
 * “category” tells calcFare whether it’s a short‑trip, long‑trip, or parcel product.
 */
const rateSchema = new mongoose.Schema(
  {
    /* ───────── General keys ───────── */
    state : { type: String, required: true },
    city  : { type: String, required: false },          // city optional (long‑trip uses only state)

    vehicleType : {
      type: String,
      required: true,
      enum: ['bike', 'auto', 'car', 'premium', 'xl', 'lcv', 'icv']
    },

    category : {
      type: String,
      required: true,
      enum: ['short', 'long', 'parcel']
    },

    /* ───────── Short‑trip fields ───────── */
    baseFareDistanceKm : Number,
    baseFare           : Number,
    perKm              : Number,
    perMin             : Number,
    minFare            : Number,
    platformFeePercent : Number,
    gstPercent         : Number,

    /* ───────── Long‑trip fields ───────── */
    fuelPerKm              : Number,
    day1DriverFee          : Number,
    subsequentDayDriverFee : Number,
    halfDayReturnFee       : Number,

    /* ───────── Parcel‑delivery fields ───────── */
    platformFee : Number,    // flat handling / platform margin (₹)
    maxWeightKg : Number,    // hard weight limit for bikes (e.g., 10 kg)
    weightRates : {
      baseKg     : Number,   // included weight (e.g., 5 kg)
      baseCharge : Number,   // charge if weight > baseKg
      perExtraKg : Number    // ₹ per extra kg beyond baseKg
    }
  },
  { timestamps: true }
);

/* Unique index when city exists (short & parcel). Long‑trip docs omit city */
rateSchema.index(
  { state: 1, city: 1, vehicleType: 1, category: 1 },
  {
    unique: true,
    partialFilterExpression: { city: { $exists: true } }
  }
);

export default mongoose.model('Rate', rateSchema);
