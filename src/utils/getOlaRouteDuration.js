// utils/getOlaRouteDuration.js
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

/**
 * Fetch live route data (distance + duration) from Ola Maps API
 * and adjust duration by vehicle type.
 *
 * Ola Maps endpoint:
 * GET https://api.olamaps.io/routing/v1/directions
 *   ?origin=lat,lng
 *   &destination=lat,lng
 *   &api_key=OLA_MAPS_API_KEY
 */
export async function getOlaRouteDuration(origin, destination, vehicleType = "car") {
  const OLA_API_KEY = process.env.OLA_MAPS_API_KEY;

  if (!OLA_API_KEY) {
    console.error("❌ OLA_MAPS_API_KEY missing in environment.");
    return null;
  }

  if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) {
    console.warn("⚠️ Invalid origin/destination coordinates");
    return null;
  }

  const url = `https://api.olamaps.io/routing/v1/directions?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&api_key=${OLA_API_KEY}`;

  try {
    const res = await axios.get(url);

    // Ola Maps returns { routes: [...] }
    const routes = res.data?.routes;
    if (!routes?.length) {
      console.error("⚠️ Ola Maps returned no routes:", res.data);
      return null;
    }

    const leg = routes[0]?.legs?.[0];
    if (!leg) {
      console.error("⚠️ Ola Maps route has no legs");
      return null;
    }

    // Ola Maps: duration in seconds, distance in meters
    const baseDurationSec = leg.duration;          // seconds
    const distanceKm      = leg.distance / 1000;   // meters → km

    // ─────────────────────────────────────────────────────
    // Vehicle-type duration adjustment
    // Same logic as the old Google Maps utility
    // Bike/auto are faster through traffic than car
    // ─────────────────────────────────────────────────────
    const vehicleAdjust = {
      bike:    0.6,   // Bikes ~40% faster (lane-splitting, shortcuts)
      auto:    0.8,   // Autos ~20% faster
      car:     1.0,   // Baseline
      premium: 1.05,  // Slightly conservative
      xl:      1.1,   // Slower in traffic
    };

    const adjustedDurationSec = baseDurationSec * (vehicleAdjust[vehicleType] || 1.0);

    console.log(
      `✅ Ola Maps Route (${vehicleType}): ${distanceKm.toFixed(2)} km | ` +
      `base=${Math.round(baseDurationSec / 60)}min → adjusted=${Math.round(adjustedDurationSec / 60)}min`
    );

    return {
      distanceKm,
      durationSec: adjustedDurationSec,
    };
  } catch (err) {
    console.error("⚠️ Ola Maps fetch failed:", err.message);
    return null;
  }
}