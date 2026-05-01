import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 50,           // 50 customers requesting trips
  duration: "30s",   // for 30 seconds
};

const URL = "http://192.168.1.70:5002/api/trip/short";   // ✅ correct path

export default function () {
  const lat = 17.385 + Math.random() * 0.01;
  const lng = 78.4867 + Math.random() * 0.01;

  const payload = JSON.stringify({
    customerId: "68e24aea3b861586df2d728e",
    pickup: { coordinates: [lng, lat], address: "Test Pickup" },
    drop: { coordinates: [lng + 0.005, lat + 0.005], address: "Test Drop" },
    vehicleType: "bike",
    fare: 50
  });

  const params = {
    headers: { "Content-Type": "application/json" }
  };

  const res = http.post(URL, payload, params);

  check(res, {
    "status is 200": (r) => r.status === 200,
    "tripId returned": (r) => JSON.parse(r.body)?.trip?._id !== undefined
  });

  sleep(1);
}
