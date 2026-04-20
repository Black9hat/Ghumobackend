/**
 * Go India Fare Calculation v9 (Admin-Controlled Only)
 * ─────────────────────────────────────────────────────
 * ✅ Fare = Admin-controlled via DB rate document
 * ✅ Multipliers: peak, night, manualSurge (from DB only)
 * ✅ platformFee = from DB (rate.platformFee) — no tiered hardcoding
 * ✅ Surge applied to minFare too — night/peak multiplier applies even when minFare kicks in
 * ❌ No discounts, no competitor logic
 * ❌ Incentive is NOT part of fare (handled separately)
 */

export function calcFare({
  rate,
  distanceKm = 0,
  durationMin = 0,
  startTime = null,
  dropTime = null,
  // 🎁 Welcome coupon params (passed from fareController when eligible)
  applyWelcomeCoupon = false,
  welcomeFareAdjustment = 0,
  welcomeDiscountAmount = 0,
}) {
  // ─────────────────────────────────────────────────────
  // 1️⃣ VALIDATION
  // ─────────────────────────────────────────────────────
  if (!rate) throw new Error("Rate document missing.");

  const category = rate.category;
  if (category !== "short") throw new Error(`Unsupported category: ${category}`);

  const vehicle = rate.vehicleType?.toLowerCase?.() || "bike";
const roundOff = (num) => Math.ceil(num);

  // ─────────────────────────────────────────────────────
  // 2️⃣ INTERNAL FALLBACK CONFIG (if DB missing values)
  // ─────────────────────────────────────────────────────
  const internal = {
    bike:    { baseFare: 30, baseFareDistanceKm: 1, perKm: 10, minFare: 55,  platformCommission: 0.10 },
    auto:    { baseFare: 45, baseFareDistanceKm: 1, perKm: 14, minFare: 70,  platformCommission: 0.10 },
    car:     { baseFare: 70, baseFareDistanceKm: 1, perKm: 22, minFare: 90,  platformCommission: 0.12 },
    premium: { baseFare: 80, baseFareDistanceKm: 1, perKm: 24, minFare: 100, platformCommission: 0.12 },
    xl:      { baseFare: 95, baseFareDistanceKm: 1, perKm: 26, minFare: 120, platformCommission: 0.12 },
  };

  const fallback = internal[vehicle] || internal.bike;

  // ─────────────────────────────────────────────────────
  // 3️⃣ LOAD RATE VALUES (DB → Fallback)
  // ─────────────────────────────────────────────────────
  const baseFare           = rate.baseFare ?? fallback.baseFare;
  const baseDistance       = rate.baseFareDistanceKm ?? fallback.baseFareDistanceKm;
  const perKm              = rate.perKm ?? fallback.perKm;
  const perMin             = rate.perMin ?? 0;
  const minFare            = rate.minFare ?? fallback.minFare;
  const platformCommission = (rate.platformFeePercent ?? (fallback.platformCommission * 100)) / 100;
  const gstPercent         = rate.gstPercent ?? 0;

  // ─────────────────────────────────────────────────────
  // 4️⃣ PLATFORM FEE — from DB only (rate.platformFee)
  // ─────────────────────────────────────────────────────
  const platformFee = rate.platformFee ?? 0;

  // ─────────────────────────────────────────────────────
  // 5️⃣ BASE FARE CALCULATION
  // ─────────────────────────────────────────────────────
  const chargeableDistance = Math.max(0, distanceKm - baseDistance);

  let baseFareTotal =
    baseFare +
    (chargeableDistance * perKm) +
    platformFee +
    (durationMin * perMin);

  // ─────────────────────────────────────────────────────
  // 6️⃣ TIME ANALYSIS (Peak / Night Detection)
  // ─────────────────────────────────────────────────────
const hour = Number(
  new Date(startTime || new Date()).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false,
  })
);
  const peakHour  = (hour >= 7 && hour < 10) || (hour >= 17 && hour < 21);
  const nightHour = hour >= 22 || hour < 6;

  // ─────────────────────────────────────────────────────
  // 7️⃣ TRIP DURATION (Fallback Calculation)
  // ─────────────────────────────────────────────────────
  let tripDuration = durationMin;
  if (!tripDuration && startTime && dropTime) {
    try {
      const start = new Date(startTime);
      const end = new Date(dropTime);
      tripDuration = Math.max((end - start) / 60000, 1);
    } catch {
      tripDuration = 0;
    }
  }

  // ─────────────────────────────────────────────────────
  // 8️⃣ SURGE MULTIPLIER — collected once, applied to both fare AND minFare
  // ─────────────────────────────────────────────────────
  let surgeMultiplier = 1;

  if (peakHour)         surgeMultiplier *= rate.peakMultiplier  || 1;
  if (nightHour)        surgeMultiplier *= rate.nightMultiplier || 1;
  if (rate.manualSurge) surgeMultiplier *= rate.manualSurge;

  let finalFare = baseFareTotal * surgeMultiplier;

  // Surge also applies to minFare — e.g. night surge 1.5 → minFare ₹165 × 1.5 = ₹248
  const surgedMinFare = roundOff(minFare * surgeMultiplier);

  console.log(
    `📊 Surge: ×${surgeMultiplier} | baseFareTotal=₹${baseFareTotal.toFixed(2)} → ` +
    `finalFare=₹${finalFare.toFixed(2)} | minFare=₹${minFare} → surgedMinFare=₹${surgedMinFare}`
  );

  // ─────────────────────────────────────────────────────
  // 8️⃣b 🎁 WELCOME COUPON ADJUSTMENT (First Ride Only)
  // Applied AFTER surge, BEFORE final minFare clamp
  // ─────────────────────────────────────────────────────
  let welcomeCouponApplied = false;
  let appliedFareAdjustment = 0;
  let appliedDiscountAmount = 0;

  if (applyWelcomeCoupon && welcomeDiscountAmount > 0) {
    finalFare = finalFare + welcomeFareAdjustment - welcomeDiscountAmount;
    finalFare = Math.max(finalFare, surgedMinFare);
    welcomeCouponApplied = true;
    appliedFareAdjustment = welcomeFareAdjustment;
    appliedDiscountAmount = welcomeDiscountAmount;
    console.log(`🎁 Welcome Coupon Applied: +₹${welcomeFareAdjustment} adj, -₹${welcomeDiscountAmount} discount → ₹${finalFare}`);
  }

  // ─────────────────────────────────────────────────────
  // 9️⃣ GST & FINAL TOTAL
  // surgedMinFare used — surge applies even when minFare kicks in
  // ─────────────────────────────────────────────────────
  const gstAmount   = (finalFare * gstPercent) / 100;
  const total       = Math.max(roundOff(finalFare + gstAmount), surgedMinFare);
  const platformCut = total * platformCommission;
  const driverGets  = total - platformCut;

  // ─────────────────────────────────────────────────────
  // 🔍 DEBUG LOG
  // ─────────────────────────────────────────────────────
  console.log(
    `🧾 Fare: ₹${total} | ${vehicle.toUpperCase()} | ${distanceKm} km | ` +
    `${peakHour ? "🚀 Peak" : nightHour ? "🌙 Night" : "☀️ Normal"} | ` +
    `Hour: ${hour} | minFare used: ${total === surgedMinFare ? `✅ ₹${surgedMinFare}` : "❌ (normal fare higher)"}`
  );

  // ─────────────────────────────────────────────────────
  // 🔟 RETURN RESPONSE
  // ─────────────────────────────────────────────────────
  return {
    success: true,
    type: "short",
    vehicleType: vehicle,
    total,
    remarks: `Admin-controlled fare (${peakHour ? "Peak" : nightHour ? "Night" : "Normal"})`,

    breakdown: {
      // Base components
      baseFare,
      baseDistance,
      chargeableDistance,
      perKm,
      perMin,
      platformFee,
      baseFareTotal: roundOff(baseFareTotal),

      // Time factors
      tripDuration: `${Math.round(tripDuration)} mins`,
      hour,
      peakHour,
      nightHour,

      // Applied multipliers (from DB)
      surgeMultiplier,
      peakMultiplier:  peakHour  ? (rate.peakMultiplier  || 1) : null,
      nightMultiplier: nightHour ? (rate.nightMultiplier || 1) : null,
      manualSurge:     rate.manualSurge || null,

      // Final breakdown
      fareAfterMultipliers: roundOff(finalFare),
      gstPercent,
      gstAmount: roundOff(gstAmount),
      minFare,
      surgedMinFare,
      minFareApplied: total === surgedMinFare,

      // Earnings split
      platformCommissionPercent: platformCommission * 100,
      platformEarning: roundOff(platformCut),
      driverEarning: roundOff(driverGets),

      // 🎁 Welcome coupon info
      welcomeCouponApplied,
      welcomeFareAdjustment: welcomeCouponApplied ? appliedFareAdjustment : 0,
      welcomeDiscountAmount: welcomeCouponApplied ? appliedDiscountAmount : 0,
    },
  };
}