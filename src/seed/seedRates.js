/* eslint-disable no-console */
/* ------------------ 1. Load env & deps ------------------ */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Rate from '../models/Rate.js';

/* ------------------ 2. Connect to Mongo ------------------ */
await connectDB();

/* ------------------ 3. Define tariff cards --------------- */
/**
 * One object = one document in the Rate collection.
 * Hyderabad for short and parcel. Long-trip rates apply to entire Telangana.
 */
const rates = [
  /* ────────────── Hyderabad, Telangana ────────────── */

  // ───── SHORT-TRIP: Go India Fare Table ─────
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'bike',
    category: 'short',
    baseFareDistanceKm: 1,
    baseFare: 20,
    perKm: 16.67,
    perMin: 0.7,
    minFare: 65,
    platformFeePercent: 10,
    gstPercent: 5,
    nightMultiplier: 1.33,   // 33% increase for all vehicles (you can adjust)
peakMultiplier: 1.15,    // 15% increase during peak
manualSurge: 1.0,        // default

  },
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'auto',
    category: 'short',
    baseFareDistanceKm: 2,
    baseFare: 40,
    perKm: 19.5,
    perMin: 1.5,
    minFare: 75,
    platformFeePercent: 12,
    gstPercent: 5,
    nightMultiplier: 1.33,   // 33% increase for all vehicles (you can adjust)
peakMultiplier: 1.15,    // 15% increase during peak
manualSurge: 1.0,        // default

  },
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'car',
    category: 'short',
    baseFareDistanceKm: 2,
    baseFare: 60,
    perKm: 23.5,
    perMin: 2.5,
    minFare: 90,
    platformFeePercent: 15,
    gstPercent: 5,
    nightMultiplier: 1.33,   // 33% increase for all vehicles (you can adjust)
peakMultiplier: 1.15,    // 15% increase during peak
manualSurge: 1.0,        // default

  },
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'premium',
    category: 'short',
    baseFareDistanceKm: 2,
    baseFare: 80,
    perKm: 25,
    perMin: 3,
    minFare: 100,
    platformFeePercent: 15,
    gstPercent: 5,
    nightMultiplier: 1.33,   // 33% increase for all vehicles (you can adjust)
peakMultiplier: 1.15,    // 15% increase during peak
manualSurge: 1.0,        // default

  },
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'xl',
    category: 'short',
    baseFareDistanceKm: 2,
    baseFare: 100,
    perKm: 28,
    perMin: 4,
    minFare: 120,
    platformFeePercent: 15,
    gstPercent: 5,
    nightMultiplier: 1.33,   // 33% increase for all vehicles (you can adjust)
peakMultiplier: 1.15,    // 15% increase during peak
manualSurge: 1.0,        // default

  },

  // ───── LONG-TRIP: Intercity (Telangana-wide) ─────
  {
    state: 'telangana',
    vehicleType: 'car',
    category: 'long',
    fuelPerKm: 15,
    day1DriverFee: 1500,
    subsequentDayDriverFee: 900,
    halfDayReturnFee: 750,
  },
  {
    state: 'telangana',
    vehicleType: 'premium',
    category: 'long',
    fuelPerKm: 18,
    day1DriverFee: 1800,
    subsequentDayDriverFee: 1000,
    halfDayReturnFee: 850,
  },
  {
    state: 'telangana',
    vehicleType: 'xl',
    category: 'long',
    fuelPerKm: 20,
    day1DriverFee: 2000,
    subsequentDayDriverFee: 1100,
    halfDayReturnFee: 900,
  },

  // ───── PARCEL DELIVERY (Bike only) ─────
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'bike',
    category: 'parcel',
    baseFare: 25,          // fixed pickup cost
    perKm: 7,              // distance charge
    platformFee: 15,       // flat handling fee
    maxWeightKg: 10,       // weight cap
    weightRates: {
      baseKg: 5,
      baseCharge: 40,
      perExtraKg: 5,
    },
  },
];

/* ------------------ 4. Seed the collection --------------- */
console.log('⏳ Clearing existing rates for Telangana…');
await Rate.deleteMany({ state: 'telangana' }); // remove old Telangana rates

console.log(`⏳ Inserting ${rates.length} updated tariff cards…`);
await Rate.insertMany(rates);

console.log('✅ Go India rates seeded successfully!');
await mongoose.disconnect();
process.exit(0);
