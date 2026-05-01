import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 10,
  duration: "10s",
};

const BASE_URL = "http://192.168.1.70:5002";

// 👉 Replace with REAL token of the test driver
const DRIVER_TOKEN = "<<PUT_CORRECT_DRIVER_JWT_HERE>>";

// 👉 Replace with the real assigned driverId for test user
const DRIVER_ID = "68d38a5cfd6c50b2b22abc16";

// 👉 This will be filled after trip creation
let tripId = null;

export default function () {

  // STEP 1 — Create a short trip (same as before)
  if (!tripId) {
    const payload = JSON.stringify({
      customerId: "68e24aea3b861586df2d728e",
      pickup: {
        coordinates: [78.4937, 17.391],
        address: "Test Pickup",
      },
      drop: {
        coordinates: [78.4938, 17.3912],
        address: "Test Drop",
      },
      vehicleType: "bike",
      fare: 50,
    });

    const res = http.post(`${BASE_URL}/api/trip/short`, payload, {
      headers: { "Content-Type": "application/json" },
    });

    check(res, { "trip created": r => r.status === 200 });

    try {
      const body = JSON.parse(res.body);
      tripId = body?.trip?._id;
      console.log("🚀 Trip Created:", tripId);
    } catch (e) {}

    sleep(1);
    return;
  }

  // STEP 2 — Driver marks ARRIVED
  const arrivedRes = http.post(
    `${BASE_URL}/api/trip/${tripId}/arrived`,
    JSON.stringify({ driverId: DRIVER_ID }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DRIVER_TOKEN}`,
      },
    }
  );

  console.log("\n=== DRIVER ARRIVED ===");
  console.log("Driver:", DRIVER_ID);
  console.log("Trip:", tripId);
  console.log("STATUS:", arrivedRes.status);
  console.log("BODY:", arrivedRes.body);
  console.log("======================\n");

  check(arrivedRes, {
    "arrived: status is 200": (r) => r.status === 200,
    "arrived: accepted by correct driver": (r) =>
      JSON.parse(r.body)?.success === true ||
      JSON.parse(r.body)?.reason === "not_assigned",
  });

  sleep(1);
}
