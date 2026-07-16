import asyncHandler from "express-async-handler";
import Rate from "../models/Rate.js";
import { calcFare } from "../utils/fareCalc.js";
import { getOlaRouteDuration } from "../utils/getOlaRouteDuration.js";
import User from "../models/User.js";
import AppSettings from "../models/AppSettings.js";
import { calculateCoinsForRide, getCoinsConfig } from "../services/coinService.js";
import {
  getWelcomeApplicableVehicles,
  getWelcomeDisplayAmount,
  normalizeWelcomeVehicleType,
} from "../utils/welcomeCouponConfig.js";

/**
 * POST /api/fares/calc
 * Calculates smart, time-based, competitive fares using Ola Maps route data.
 */
export const createFare = asyncHandler(async (req, res) => {
  const {
    state,
    city,
    vehicleType,
    category,
    origin,
    destination,
    distanceKm,
    durationMin,
    tripDays,
    returnTrip,
    surge,
    weight,
    customerId,
  } = req.body;

  const vType = vehicleType?.toLowerCase?.();
  if (!state || !vType || !category) {
    return res.status(400).json({
      ok: false,
      message: "Missing required fields: state, vehicleType, or category",
    });
  }

  /* ---------------------------------------------------------
   * 1️⃣ Fetch Ola Maps route — per vehicle type
   * --------------------------------------------------------- */
  let liveDistanceKm = distanceKm;
  let liveDurationMin = durationMin || 15;

  if (origin && destination) {
    const gStart = process.hrtime.bigint();
    try {
      console.log(`📡 Fetching Ola Maps route for ${vType}...`);
      const olaRoute = await getOlaRouteDuration(origin, destination, vType);

      if (olaRoute) {
        liveDistanceKm  = olaRoute.distanceKm;
        liveDurationMin = olaRoute.durationSec / 60;
        console.log(
          `✅ Ola Maps (${vType}): ${liveDistanceKm.toFixed(2)} km | ${liveDurationMin.toFixed(1)} mins`
        );
      } else {
        console.warn(`⚠️ Ola Maps returned null for ${vType} — using fallback values`);
      }
    } catch (err) {
      console.error("⚠️ Ola Maps fetch failed:", err.message);
    } finally {
      if (req.__profile) {
        req.__profile.googleMs += Number(process.hrtime.bigint() - gStart) / 1e6;
      }
    }
  }

  /* ---------------------------------------------------------
   * 2️⃣ Fetch DB Rate
   * --------------------------------------------------------- */
  const query = {
    state: new RegExp(`^${state}$`, "i"),
    vehicleType: vType,
    category,
  };
  if (category !== "long") query.city = new RegExp(`^${city}$`, "i");

  const dbStart = process.hrtime.bigint();
  const dbRate = await Rate.findOne(query);

  if (req.__profile) {
    req.__profile.mongoMs += Number(process.hrtime.bigint() - dbStart) / 1e6;
  }

  if (dbRate) {
    console.log("📦 [DB RATE FOUND]", {
      vehicleType: dbRate.vehicleType,
      category:    dbRate.category,
      baseFare:    dbRate.baseFare,
      perKm:       dbRate.perKm,
    });
  } else {
    console.warn("⚠️ No DB rate found — using internal defaults");
  }

  const rate = dbRate || { vehicleType: vType, category };

  /* ---------------------------------------------------------
   * 3️⃣ Timestamps for peak/night detection
   * --------------------------------------------------------- */
  const startTime = new Date().toISOString();
  const dropTime  = new Date(Date.now() + liveDurationMin * 60 * 1000).toISOString();

  console.log("🟢 [FINAL FARE INPUT]", {
    vehicleType: vType,
    distanceKm:  liveDistanceKm,
    durationMin: liveDurationMin,
    startTime,
    dropTime,
  });

  /* ---------------------------------------------------------
   * 3️⃣b 🎁 Welcome Coupon Eligibility Check
   * --------------------------------------------------------- */
  let applyWelcomeCoupon    = false;
  let welcomeFareAdjustment = 0;
  let welcomeDiscountAmount = 0;
  let welcomeExactAmount    = 0;
  let welcomeCouponCode     = "";
  let welcomeVehicleType    = "all";
  let welcomeCouponSettings = null;

  if (customerId) {
    try {
      const [customer, appSettings] = await Promise.all([
        User.findById(customerId).select("welcomeCouponUsed").lean(),
        AppSettings.findOne().lean(),
      ]);

      const wc = appSettings?.welcomeCoupon;
      welcomeCouponSettings = wc || null;

      const configuredVehicleType = normalizeWelcomeVehicleType(wc?.vehicleType || "all");
      const applicableVehicles = getWelcomeApplicableVehicles(wc);
      const vehicleAllowed =
        applicableVehicles.includes("all") || applicableVehicles.includes(vType);

      if (
        wc?.enabled === true &&
        customer?.welcomeCouponUsed === false &&
        vehicleAllowed
      ) {
        // ✅ FIXED AMOUNT MODE
        if (wc.useFixedWelcomeAmount) {
          const fixedFinalFare = getWelcomeDisplayAmount(wc, vType);

          applyWelcomeCoupon    = true;
          welcomeCouponCode     = wc.code || "WELCOME";
          welcomeVehicleType    = vType;
          welcomeExactAmount    = fixedFinalFare;
          welcomeFareAdjustment = 0;
          welcomeDiscountAmount = 0; // derived after fare calc

          console.log(`🎁 Fixed welcome coupon: Customer pays ONLY ₹${fixedFinalFare} for ${vType}`);
        }
        // ✅ LEGACY MODE
        else {
          const netSaving =
            (Number(wc.discountAmount) || 0) - (Number(wc.fareAdjustment) || 0);

          if (netSaving > 0) {
            applyWelcomeCoupon    = true;
            welcomeFareAdjustment = Number(wc.fareAdjustment) || 0;
            welcomeDiscountAmount = Number(wc.discountAmount) || 0;
            welcomeExactAmount    =
              Number(wc.exactAmount) > 0 ? Number(wc.exactAmount) : netSaving;
            welcomeCouponCode  = wc.code || "WELCOME";
            welcomeVehicleType = configuredVehicleType;

            console.log(
              `🎁 Welcome coupon (legacy): adj=₹${welcomeFareAdjustment}, ` +
              `discount=₹${welcomeDiscountAmount}, netSaving=₹${netSaving}`
            );
          } else {
            console.warn(
              `⚠️ Welcome coupon NOT applied: fareAdjustment (₹${wc.fareAdjustment}) ` +
              `>= discountAmount (₹${wc.discountAmount}). Fix in admin Reward Config.`
            );
          }
        }
      } else if (wc?.enabled === true && !vehicleAllowed) {
        console.log(
          `ℹ️ Welcome coupon skipped for ${vType}; configured for "${configuredVehicleType}" only.`
        );
      }
    } catch (err) {
      console.warn("⚠️ Welcome coupon eligibility check failed:", err.message);
    }
  }

  /* ---------------------------------------------------------
   * 4️⃣ Calculate Fare
   * --------------------------------------------------------- */
  let result;
  try {
    result = calcFare({
      rate,
      distanceKm:  liveDistanceKm,
      durationMin: liveDurationMin,
      tripDays,
      returnTrip,
      surge,
      weight,
      startTime,
      dropTime,
      applyWelcomeCoupon,
      welcomeFareAdjustment,
      welcomeDiscountAmount,
    });
  } catch (err) {
    console.error("❌ Fare calculation error:", err);
    return res.status(400).json({ ok: false, message: err.message });
  }

  /* ---------------------------------------------------------
   * 4️⃣b 🎁 POST-CALC: Apply Fixed Welcome Amount Override
   * ✅ FIXED: result.baseFare doesn't exist in calcFare output —
   *    use multiple fallbacks ending with finalFare
   * --------------------------------------------------------- */
  if (
    applyWelcomeCoupon &&
    welcomeCouponSettings?.useFixedWelcomeAmount &&
    welcomeExactAmount > 0
  ) {
    // Debug: see what calcFare actually returned (remove after verifying)
    console.log("🔬 calcFare result keys:", Object.keys(result).join(", "));

    // ✅ THE FIX — try multiple field names, fall back to finalFare
    const preCouponFare = Number(
      result.baseFare    ??   // explicit base fare (if exists)
      result.totalFare   ??   // some implementations
      result.fare        ??  
        result.total       ??   // ✅ ADD THIS — it's what calcFare actually returns
 // some implementations
      result.finalFare   ??   // ✅ guaranteed fallback
      0
    );

    if (preCouponFare <= 0) {
      console.warn(`🎁 ⚠️ Pre-coupon fare is ${preCouponFare} — override skipped.`);
    } else {
      const calculatedDiscount = Math.max(0, preCouponFare - welcomeExactAmount);
      const cappedFinalFare    = Math.max(welcomeExactAmount, 0);

      result.originalFare    = preCouponFare;      // for transparency in response
      result.welcomeDiscount = calculatedDiscount;
      result.finalFare       = cappedFinalFare;
  result.total           = cappedFinalFare;  // ✅ ADD THIS LINE

      // Back-fill for the response payload
      welcomeDiscountAmount = calculatedDiscount;

      console.log(
        `🎁 ✅ Fixed welcome applied: Original ₹${preCouponFare} ` +
        `→ Final ₹${cappedFinalFare} (discount ₹${calculatedDiscount})`
      );
    }
  }

  /* ---------------------------------------------------------
   * 5️⃣ 🪙 Coins Preview (non-blocking)
   * --------------------------------------------------------- */
  let coinsEarn      = 0;
  let coinsBreakdown = null;
  try {
    const coinConfig = await getCoinsConfig();
    if (coinConfig.enabled) {
      const coinPreview = calculateCoinsForRide({
        distanceKm:  liveDistanceKm,
        vehicleType: vType,
        coinConfig,
        applyRandom: false,
      });
      coinsEarn      = coinPreview.total;
      coinsBreakdown = coinPreview.breakdown;
    }
  } catch (err) {
    console.warn("⚠️ Coins preview failed (non-blocking):", err.message);
  }

  /* ---------------------------------------------------------
   * 6️⃣ Respond
   * --------------------------------------------------------- */
  const isFixedMode = welcomeCouponSettings?.useFixedWelcomeAmount === true;

  const netSaving = isFixedMode
    ? (result.welcomeDiscount ?? welcomeDiscountAmount)
    : welcomeDiscountAmount - welcomeFareAdjustment;

  const welcomeMessage = isFixedMode
    ? `Pay only ₹${welcomeExactAmount} on your first ride!`
    : `Welcome discount of ₹${welcomeDiscountAmount} applied on your first ride!`;

  res.json({
    ok:          true,
    rateSource:  dbRate ? "db" : "internal",
    usedOlaMaps: !!(origin && destination),
    ...result,
    coinsEarn,
    coinsBreakdown,
    welcomeCoupon: applyWelcomeCoupon
      ? {
          applied:        true,
          code:           welcomeCouponCode,
          discountAmount: welcomeDiscountAmount,
          fareAdjustment: welcomeFareAdjustment,
          exactAmount:    welcomeExactAmount,
          displayAmount:  welcomeExactAmount,
          vehicleType:    welcomeVehicleType,
          netSaving,
          message:        welcomeMessage,
        }
      : { applied: false },
  });
});