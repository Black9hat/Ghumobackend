import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 20,
  duration: "10s",
};

// 🔑 AUTH TOKEN REQUIRED
const TOKEN = "PASTE_YOUR_JWT_TOKEN_HERE";

const BASE = "http://192.168.1.70:5002/api/trip";

const params = {
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${TOKEN}`
  }
};

// Dummy driver IDs
const DRIVERS = [
  "68d38a5cfd6c50b2b22abc16",
  "68d399855c57b13a34d775ac",
  "68d39bb65c57b13a34d77613",
  "68e58441aae030a783d7e883",
  "68e587ccaae030a783d7e931",
  "68ee00bde37eee05dd7de4ef"
];

const CUSTOMER = "68e24aea3b861586df2d728e";

export default function () {

  // 1️⃣ CREATE SHORT TRIP
  const createPayload = JSON.stringify({
    customerId: CUSTOMER,
    pickup: { coordinates: [78.4937, 17.3910], address: "Test Pickup" },
    drop: { coordinates: [78.4938, 17.3912], address: "Test Drop" },
    vehicleType: "bike",
    fare: 50
  });

  const createRes = http.post(`${BASE}/short`, createPayload, params);

  console.log("\n===== SHORT TRIP CREATION RESPONSE =====");
  console.log("STATUS:", createRes.status);
  console.log("BODY:", createRes.body);
  console.log("========================================");

  let tripId = null;
  try {
    const body = JSON.parse(createRes.body);
    tripId = body?.trip?._id || body?.tripId || null;
  } catch (e) {}

  console.log(`🚀 Extracted Trip ID: ${tripId}`);

  if (!tripId) return;

  // random driver
  const driverId = DRIVERS[Math.floor(Math.random() * DRIVERS.length)];

  // 2️⃣ CALL GOING TO PICKUP
  const pickupPayload = JSON.stringify({
    driverId,
    tripId,
  });

  const pickupRes = http.post(`${BASE}/going-to-pickup`, pickupPayload, params);

  console.log("STATUS:", pickupRes.status);
  console.log("BODY:", pickupRes.body);

  check(pickupRes, {
    "status is 200 or 400": (r) => r.status === 200 || r.status === 400,
  });

  sleep(1);
}
