import asyncHandler from "express-async-handler";
import Rate from "../models/Rate.js";
import { calcFare } from "../utils/fareCalc.js";
import { getOlaRouteDuration } from "../utils/getOlaRouteDuration.js"; // ✅ Ola Maps (replaces Google)
import User from "../models/User.js";
import AppSettings from "../models/AppSettings.js";
// 🪙 Coins: preview how many coins the customer will earn for this ride
import { calculateCoinsForRide, getCoinsConfig } from "../services/coinService.js";

/**
 * POST /api/fares/calc
 * Calculates smart, time-based, competitive fares using Ola Maps route data.
 * Each vehicle gets its own adjusted duration from Ola Maps.
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
   * 1️⃣ Fetch Ola Maps route — per vehicle type
   *    Distance is same for all vehicles (road distance).
   *    Duration is adjusted per vehicle inside getOlaRouteDuration
   *    (bike 0.6×, auto 0.8×, car 1.0×, premium 1.05×, xl 1.1×)
   * --------------------------------------------------------- */
  let liveDistanceKm = distanceKm;
  let liveDurationMin = durationMin || 15;

  if (origin && destination) {
    const gStart = process.hrtime.bigint(); // ⏱ START timer
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
        req.__profile.googleMs += Number(
          process.hrtime.bigint() - gStart
        ) / 1e6;
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
   * 3️⃣ Timestamps for peak/night detection
   * NOTE: vehicleTimeFactor removed — duration now comes
   *       correctly adjusted per vehicle from Ola Maps above.
   * --------------------------------------------------------- */
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
  let welcomeExactAmount = 0;
  let welcomeCouponCode = "";
  let welcomeVehicleType = "all";

  if (customerId) {
    try {
      const [customer, appSettings] = await Promise.all([
        User.findById(customerId).select("welcomeCouponUsed").lean(),
        AppSettings.findOne().lean(),
      ]);

      const wc = appSettings?.welcomeCoupon;
      const netSaving = (Number(wc?.discountAmount) || 0) - (Number(wc?.fareAdjustment) || 0);
      const configuredVehicleType = String(wc?.vehicleType || "all").toLowerCase();
      const vehicleAllowed = configuredVehicleType === "all" || configuredVehicleType === vType;

      if (
        wc?.enabled === true &&
        customer?.welcomeCouponUsed === false &&
        netSaving > 0 && // only apply if customer actually saves money
        vehicleAllowed
      ) {
        applyWelcomeCoupon = true;
        welcomeFareAdjustment = Number(wc.fareAdjustment) || 0;
        welcomeDiscountAmount = Number(wc.discountAmount) || 0;
        welcomeExactAmount = Number(wc.exactAmount) > 0 ? Number(wc.exactAmount) : netSaving;
        welcomeCouponCode = wc.code || "WELCOME";
        welcomeVehicleType = configuredVehicleType;
        console.log(`🎁 Welcome coupon eligible for customer ${customerId}: adj=₹${welcomeFareAdjustment}, discount=₹${welcomeDiscountAmount}, netSaving=₹${netSaving}`);
      } else if (wc?.enabled === true && !vehicleAllowed) {
        console.log(`Welcome coupon not applied for ${vType}; configured for ${configuredVehicleType}.`);
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
    usedOlaMaps: !!(origin && destination), // ✅ renamed from usedGoogleData
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
          exactAmount: welcomeExactAmount,
          displayAmount: welcomeExactAmount,
          vehicleType: welcomeVehicleType,
          // netSaving = what the customer actually saves vs. original base fare
          netSaving: welcomeDiscountAmount - welcomeFareAdjustment,
          message: `Welcome discount of Rs ${welcomeExactAmount} applied on your first ride!`,
        }
      : { applied: false },
  });
});
