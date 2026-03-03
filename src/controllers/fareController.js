import asyncHandler from "express-async-handler";
import Rate from "../models/Rate.js";
import { calcFare } from "../utils/fareCalc.js";
import { getGoogleRouteDuration } from "../utils/getGoogleRouteDuration.js";

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
    });
  } catch (err) {
    console.error("❌ Fare calculation error:", err);
    return res.status(400).json({ ok: false, message: err.message });
  }

  /* ---------------------------------------------------------
   * 5️⃣ Respond
   * --------------------------------------------------------- */
  res.json({
    ok: true,
    rateSource: dbRate ? "db" : "internal",
    usedGoogleData: !!(origin && destination),
    ...result,
  });
});
