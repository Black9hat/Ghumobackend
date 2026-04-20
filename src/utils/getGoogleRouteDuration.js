// utils/getGoogleRouteDuration.js
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

/**
 * Fetch live route data (distance + duration) from Google Maps API
 * and adjust it dynamically by vehicle type.
 */
export async function getGoogleRouteDuration(origin, destination, vehicleType = "car") {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

  if (!GOOGLE_API_KEY) {
    console.error("❌ GOOGLE_API_KEY missing in environment.");
    return null;
  }

  if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) {
    console.warn("⚠️ Invalid origin/destination coordinates");
    return null;
  }

  // 🚗 Choose Google route mode based on vehicle type
  const modeMap = {
    bike: "two_wheeler",
    auto: "driving",
    car: "driving",
    premium: "driving",
    xl: "driving",
  };
  const mode = modeMap[vehicleType] || "driving";

  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&mode=${mode}&departure_time=now&key=${GOOGLE_API_KEY}`;

  try {
    const res = await axios.get(url);

    if (res.data.status !== "OK" || !res.data.routes?.length) {
      console.error("Google API Error:", res.data.status, res.data.error_message);
      return null;
    }

    const leg = res.data.routes[0].legs[0];
    const baseDuration = leg.duration_in_traffic
      ? leg.duration_in_traffic.value
      : leg.duration.value;

    // 🧭 Vehicle-type adjustment multipliers
    const vehicleAdjust = {
      bike: 0.6,     // Bikes move 40% faster
      auto: 0.8,     // Autos ~20% faster
      car: 1.0,      // Baseline
      premium: 1.05, // Slightly slower (safer routes)
      xl: 1.1,       // Slower in traffic
    };

    const adjustedDurationSec = baseDuration * (vehicleAdjust[vehicleType] || 1.0);

    console.log(
      `✅ Google Route (${vehicleType}): ${(leg.distance.value / 1000).toFixed(2)} km | ${Math.round(
        adjustedDurationSec / 60
      )} mins`
    );

    return {
      distanceKm: leg.distance.value / 1000,
      durationSec: adjustedDurationSec,
    };
  } catch (err) {
    console.error("⚠️ Google Maps fetch failed:", err.message);
    return null;
  }
}
