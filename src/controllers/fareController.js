import asyncHandler from "express-async-handler";
import Rate from "../models/Rate.js";
import { calcFare } from "../utils/fareCalc.js";
import { getGoogleRouteDuration } from "../utils/getGoogleRouteDuration.js";
import User from "../models/User.js";
import AppSettings from "../models/AppSettings.js";
// 🪙 Coins: preview how many coins the customer will earn for this ride
import { calculateCoinsForRide, getCoinsConfig } from "../services/coinService.js";

/**
 * POST /api/fares/calc
 * Calculates smart, time-based, competitive fares using shared Google Maps data.
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
    customerId,   // 🎁 needed for welcome coupon eligibility check
  } = req.body;

  const vType = vehicleType?.toLowerCase?.();
  if (!state || !vType || !category) {
    return res.status(400).json({
      ok: false,
      message: "Missing required fields: state, vehicleType, or category",
    });
  }

  /* ---------------------------------------------------------
   * 1️⃣ Fetch shared route data (only once for all vehicles)
   * --------------------------------------------------------- */
  let sharedRoute = null;
  if (origin && destination) {
  const gStart = process.hrtime.bigint(); // ⏱ START Google timer
  try {
    console.log("📡 Fetching Google route (shared for all vehicles)...");
    sharedRoute = await getGoogleRouteDuration(origin, destination, "car");

    if (sharedRoute) {
      console.log(
        `✅ Google Route (car): ${sharedRoute.distanceKm.toFixed(2)} km | ${(sharedRoute.durationSec / 60).toFixed(1)} mins`
      );
    }
  } catch (err) {
    console.error("⚠️ Google Maps fetch failed:", err.message);
  } finally {
    // ⏱ END Google timer (store in profiler)
    if (req.__profile) {
      req.__profile.googleMs += Number(
        process.hrtime.bigint() - gStart
      ) / 1e6;
    }
  }
}


  // Use shared route for all vehicles
  let liveDistanceKm = sharedRoute?.distanceKm || distanceKm;
  let liveDurationMin = sharedRoute
    ? sharedRoute.durationSec / 60
    : durationMin || 15;

  /* ---------------------------------------------------------
   * 2️⃣ Fetch DB Rate
   * --------------------------------------------------------- */
  const query = {
    state: new RegExp(`^${state}$`, "i"),
    vehicleType: vType,
    category,
  };
  if (category !== "long") query.city = new RegExp(`^${city}$`, "i");

const dbStart = process.hrtime.bigint(); // ⏱ START Mongo timer
const dbRate = await Rate.findOne(query);

// ⏱ END Mongo timer
if (req.__profile) {
  req.__profile.mongoMs += Number(
    process.hrtime.bigint() - dbStart
  ) / 1e6;
}
  if (dbRate)
    console.log("📦 [DB RATE FOUND]", {
      vehicleType: dbRate.vehicleType,
      category: dbRate.category,
      baseFare: dbRate.baseFare,
      perKm: dbRate.perKm,
    });
  else console.warn("⚠️ No DB rate found — using internal defaults");

  const rate = dbRate || { vehicleType: vType, category };

  /* ---------------------------------------------------------
   * 3️⃣ Apply per-vehicle travel time adjustment
   * --------------------------------------------------------- */
  const vehicleTimeFactor = {
    bike: 0.8, // faster
    auto: 0.9,
    car: 1.0,
    premium: 1.05,
    xl: 1.1,
  }[vType] || 1.0;

  liveDurationMin *= vehicleTimeFactor;

  const startTime = new Date().toISOString();
  const dropTime = new Date(Date.now() + liveDurationMin * 60 * 1000).toISOString();

  console.log("🟢 [FINAL FARE INPUT]", {
    vehicleType: vType,
    distanceKm: liveDistanceKm,
    durationMin: liveDurationMin,
    startTime,
    dropTime,
  });

  /* ---------------------------------------------------------
   * 3️⃣b 🎁 Welcome Coupon Eligibility Check
   * --------------------------------------------------------- */
  let applyWelcomeCoupon = false;
  let welcomeFareAdjustment = 0;
  let welcomeDiscountAmount = 0;
  let welcomeCouponCode = "";

  if (customerId) {
    try {
      const [customer, appSettings] = await Promise.all([
        User.findById(customerId).select("welcomeCouponUsed").lean(),
        AppSettings.findOne().lean(),
      ]);

      const wc = appSettings?.welcomeCoupon;
      const netSaving = (Number(wc?.discountAmount) || 0) - (Number(wc?.fareAdjustment) || 0);

      if (
        wc?.enabled === true &&
        customer?.welcomeCouponUsed === false &&
        netSaving > 0  // only apply if customer actually saves money
      ) {
        applyWelcomeCoupon = true;
        welcomeFareAdjustment = Number(wc.fareAdjustment) || 0;
        welcomeDiscountAmount = Number(wc.discountAmount) || 0;
        welcomeCouponCode = wc.code || "WELCOME";
        console.log(`🎁 Welcome coupon eligible for customer ${customerId}: adj=₹${welcomeFareAdjustment}, discount=₹${welcomeDiscountAmount}, netSaving=₹${netSaving}`);
      } else if (wc?.enabled === true && netSaving <= 0) {
        console.warn(`⚠️ Welcome coupon NOT applied: fareAdjustment (₹${wc.fareAdjustment}) >= discountAmount (₹${wc.discountAmount}). Fix in admin Reward Config.`);
      }
    } catch (err) {
      // Non-blocking — if check fails, just calculate fare normally
      console.warn("⚠️ Welcome coupon eligibility check failed:", err.message);
    }
  }

  /* ---------------------------------------------------------
   * 4️⃣ Calculate fare
   * --------------------------------------------------------- */
  let result;
  try {
    result = calcFare({
      rate,
      distanceKm: liveDistanceKm,
      durationMin: liveDurationMin,
      tripDays,
      returnTrip,
      surge,
      weight,
      startTime,
      dropTime,
      // 🎁 Welcome coupon
      applyWelcomeCoupon,
      welcomeFareAdjustment,
      welcomeDiscountAmount,
    });
  } catch (err) {
    console.error("❌ Fare calculation error:", err);
    return res.status(400).json({ ok: false, message: err.message });
  }

  /* ---------------------------------------------------------
   * 5️⃣ 🪙 Calculate coins preview (non-blocking)
   * All bonus values come from AppSettings (admin-controlled).
   * applyRandom=false → preview only; random bonus shown after ride.
   * --------------------------------------------------------- */
  let coinsEarn = 0;
  let coinsBreakdown = null;
  try {
    const coinConfig = await getCoinsConfig();
    if (coinConfig.enabled) {
      const coinPreview = calculateCoinsForRide({
        distanceKm:  liveDistanceKm,
        vehicleType: vType,
        coinConfig,
        applyRandom: false,   // No random bonus in preview — surprise on completion
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
  res.json({
    ok: true,
    rateSource: dbRate ? "db" : "internal",
    usedGoogleData: !!(origin && destination),
    ...result,
    // 🪙 Coins the user will earn for completing this ride (shown under fare in Flutter)
    coinsEarn,
    coinsBreakdown,   // base/distanceBonus/vehicleBonus breakdown for Flutter display
    // 🎁 Welcome coupon block (Flutter app uses this to show discount banner)
    welcomeCoupon: applyWelcomeCoupon
      ? {
          applied: true,
          code: welcomeCouponCode,
          discountAmount: welcomeDiscountAmount,
          fareAdjustment: welcomeFareAdjustment,
          // netSaving = what the customer actually saves vs. original base fare
          netSaving: welcomeDiscountAmount - welcomeFareAdjustment,
          message: `🎉 Welcome discount of ₹${welcomeDiscountAmount - welcomeFareAdjustment} applied on your first ride!`,
        }
      : { applied: false },
  });
});
