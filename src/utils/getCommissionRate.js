// src/utils/getCommissionRate.js
// ✅ Single source of truth for commission rate lookup
// Commission comes from Rate.platformFeePercent per vehicle type
// as configured in the Fare Management admin page.
// Falls back to 20% if no rate found for the vehicleType.

import Rate from '../models/Rate.js';

/**
 * Get commission rate (as a decimal, e.g. 0.15 for 15%) for a given vehicleType.
 * Looks up Rate.platformFeePercent from DB. Falls back to 0.20 (20%).
 *
 * @param {string} vehicleType - 'bike' | 'auto' | 'car' | 'premium' | 'xl'
 * @returns {Promise<number>} commission rate as decimal (e.g. 0.15)
 */
export async function getCommissionRate(vehicleType) {
  try {
    if (!vehicleType) return 0.20;

    const vType = vehicleType.toString().trim().toLowerCase();

    // Prefer short-trip rate; fall back to any category for that vehicleType
    const rate = await Rate.findOne({
      vehicleType: vType,
      platformFeePercent: { $exists: true, $ne: null },
    })
      .select('platformFeePercent')
      .lean();

    if (rate?.platformFeePercent != null) {
      const pct = Number(rate.platformFeePercent);
      if (!isNaN(pct) && pct > 0) {
        return pct / 100;
      }
    }

    console.warn(`⚠️ getCommissionRate: no platformFeePercent for vehicleType="${vType}" — using default 20%`);
    return 0.20;
  } catch (err) {
    console.error('❌ getCommissionRate error:', err.message);
    return 0.20; // safe fallback
  }
}

/**
 * Get commission rate as a percentage (e.g. 15 for 15%).
 * Convenience wrapper over getCommissionRate.
 *
 * @param {string} vehicleType
 * @returns {Promise<number>} percentage number (e.g. 15)
 */
export async function getCommissionPercent(vehicleType) {
  const rate = await getCommissionRate(vehicleType);
  return Math.round(rate * 100 * 100) / 100; // 2 decimal places
}
