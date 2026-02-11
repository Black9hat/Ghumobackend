/**
 * Go India Fare Calculation v7 (Admin-Controlled Only)
 * ─────────────────────────────────────────────────────
 * ✅ Fare = Admin-controlled via DB rate document
 * ✅ Multipliers: peak, night, manualSurge (from DB only)
 * ❌ No discounts, no competitor logic
 * ❌ Incentive is NOT part of fare (handled separately)
 */

export function calcFare({
  rate,
  distanceKm = 0,
  durationMin = 0,
  startTime = null,
  dropTime = null,
}) {
  // ─────────────────────────────────────────────────────
  // 1️⃣ VALIDATION
  // ─────────────────────────────────────────────────────
  if (!rate) throw new Error("Rate document missing.");

  const category = rate.category;
  if (category !== "short") throw new Error(`Unsupported category: ${category}`);

  const vehicle = rate.vehicleType?.toLowerCase?.() || "bike";
  const roundOff = (num) => Math.round(num / 5) * 5;

  // ─────────────────────────────────────────────────────
  // 2️⃣ INTERNAL FALLBACK CONFIG (if DB missing values)
  // ─────────────────────────────────────────────────────
  const internal = {
    bike:    { baseFare: 30, baseFareDistanceKm: 1, perKm: 10, minFare: 55,  platformCommission: 0.10 },
    auto:    { baseFare: 45, baseFareDistanceKm: 2, perKm: 14, minFare: 70,  platformCommission: 0.10 },
    car:     { baseFare: 70, baseFareDistanceKm: 2, perKm: 22, minFare: 90,  platformCommission: 0.12 },
    premium: { baseFare: 80, baseFareDistanceKm: 2, perKm: 24, minFare: 100, platformCommission: 0.12 },
    xl:      { baseFare: 95, baseFareDistanceKm: 2, perKm: 26, minFare: 120, platformCommission: 0.12 },
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
  // 4️⃣ PLATFORM FEE (Tiered by Distance)
  // ─────────────────────────────────────────────────────
  const platformFee =
    distanceKm <= 3  ? 5  :   // 0–3 km  → ₹5
    distanceKm <= 5  ? 7  :   // 3–5 km  → ₹7
    distanceKm <= 10 ? 10 :   // 5–10 km → ₹10
    15;                       // >10 km  → ₹15

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
  const hour = new Date(startTime || new Date()).getHours();
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
  // 8️⃣ ✅ FINAL FARE (Admin-Controlled Multipliers ONLY)
  // ─────────────────────────────────────────────────────
  let finalFare = baseFareTotal;

  if (peakHour) {
    finalFare *= rate.peakMultiplier || 1;
  }

  if (nightHour) {
    finalFare *= rate.nightMultiplier || 1;
  }

  if (rate.manualSurge) {
    finalFare *= rate.manualSurge;
  }

  // ─────────────────────────────────────────────────────
  // 9️⃣ GST & FINAL TOTAL
  // ─────────────────────────────────────────────────────
  const gstAmount   = (finalFare * gstPercent) / 100;
  const total       = Math.max(roundOff(finalFare + gstAmount), minFare);
  const platformCut = total * platformCommission;
  const driverGets  = total - platformCut;

  // ─────────────────────────────────────────────────────
  // 🔍 DEBUG LOG
  // ─────────────────────────────────────────────────────
  console.log(
    `🧾 Fare: ₹${total} | ${vehicle.toUpperCase()} | ${distanceKm} km | ` +
    `${peakHour ? "🚀 Peak" : nightHour ? "🌙 Night" : "☀️ Normal"} | ` +
    `Hour: ${hour}`
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
      peakMultiplier:  peakHour  ? (rate.peakMultiplier  || 1) : null,
      nightMultiplier: nightHour ? (rate.nightMultiplier || 1) : null,
      manualSurge:     rate.manualSurge || null,
      
      // Final breakdown
      fareAfterMultipliers: roundOff(finalFare),
      gstPercent,
      gstAmount: roundOff(gstAmount),
      minFare,
      
      // Earnings split
      platformCommissionPercent: platformCommission * 100,
      platformEarning: roundOff(platformCut),
      driverEarning: roundOff(driverGets),
    },
  };
}