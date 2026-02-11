import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 7,
  duration: "5s",
};

const BASE = "http://192.168.1.70:5002";

export default function () {

  // -----------------------
  // STEP 1 — CREATE TRIP
  // -----------------------

  const createRes = http.post(
    `${BASE}/api/trip/short`,
    JSON.stringify({
      customerId: "68e24aea3b861586df2d728e",
      pickup: { coordinates: [78.4937, 17.391], address: "Test Pickup" },
      drop: { coordinates: [78.4938, 17.3912], address: "Test Drop" },
      vehicleType: "bike",
      fare: 50
    }),
    { headers: { "Content-Type": "application/json" } }
  );

  console.log("\n===== SHORT TRIP CREATION RESPONSE =====");
  console.log("STATUS:", createRes.status);
  console.log("BODY:", createRes.body);
  console.log("========================================");

  let tripId = null;

  try {
    const json = JSON.parse(createRes.body);
    tripId = json.tripId || json.trip?._id || null; // ← FIXED
  } catch (e) {
    tripId = null;
  }

  console.log("🚀 Extracted Trip ID:", tripId);

  check(createRes, {
    "status is 200": (r) => r.status === 200,
    "tripId exists": () => tripId !== null,
  });

  if (!tripId) {
    console.log("❌ No tripId, stopping this VU...");
    sleep(1);
    return;
  }

  // -----------------------
  // STEP 2 — DRIVER ACCEPTS
  // -----------------------

  const drivers = [
    "68d38a5cfd6c50b2b22abc16",
    "68d399855c57b13a34d775ac",
    "68d39bb65c57b13a34d77613",
    "68e58441aae030a783d7e883",
    "68e587ccaae030a783d7e931",
    "68ee00bde37eee05dd7de4ef",
    "68ee0700e37eee05dd7de574"
  ];

  const driverId = drivers[Math.floor(Math.random() * drivers.length)];

  console.log("\n=== DRIVER TRYING TO ACCEPT TRIP ===");
  console.log("Driver:", driverId);
  console.log("Trip:", tripId);
  console.log("====================================");

  const acceptRes = http.post(
    `${BASE}/api/trip/${tripId}/accept`,
    JSON.stringify({ driverId, tripId }),
    { headers: { "Content-Type": "application/json" } }
  );

  console.log("STATUS:", acceptRes.status);
  console.log("BODY:", acceptRes.body);

  check(acceptRes, {
    "status is 200 or 400": (r) => r.status === 200 || r.status === 400,
  });

  sleep(1);
}
