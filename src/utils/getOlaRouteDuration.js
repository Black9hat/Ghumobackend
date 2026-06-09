// utils/getOlaRouteDuration.js
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

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

  // ✅ POST request — Ola Maps Directions API does not accept GET
  const url = `https://api.olamaps.io/routing/v1/directions`;

  try {
    const res = await axios.post(url, null, {
      params: {
        origin: `${origin.lat},${origin.lng}`,
        destination: `${destination.lat},${destination.lng}`,
        api_key: OLA_API_KEY,
      },
    });

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

    const baseDurationSec = leg.duration;
    const distanceKm      = leg.distance / 1000;

    const vehicleAdjust = {
      bike:    0.6,
      auto:    0.8,
      car:     1.0,
      premium: 1.05,
      xl:      1.1,
    };

    const adjustedDurationSec = baseDurationSec * (vehicleAdjust[vehicleType] || 1.0);

    console.log(
      `✅ Ola Maps Route (${vehicleType}): ${distanceKm.toFixed(2)} km | ` +
      `base=${Math.round(baseDurationSec / 60)}min → adjusted=${Math.round(adjustedDurationSec / 60)}min`
    );

    return { distanceKm, durationSec: adjustedDurationSec };

  } catch (err) {
    // Log the full response body for easier debugging
    const status = err.response?.status;
    const body   = JSON.stringify(err.response?.data)?.slice(0, 200);
    console.error(`⚠️ Ola Maps fetch failed [${status}]: ${err.message} | body: ${body}`);
    return null;
  }
}