import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 30,          // 30 customers creating trips
  duration: "20s",  // test for 20 seconds
};

const URL = "http://192.168.1.70:5002/api/trip/short";

export default function () {
  const lat = 17.385 + Math.random() * 0.005;
  const lng = 78.4867 + Math.random() * 0.005;

  const payload = JSON.stringify({
    customerId: "68e24aea3b861586df2d728e", // your test customer
    pickup: { 
      coordinates: [lng, lat], 
      address: "Load Test Pickup"
    },
    drop: { 
      coordinates: [lng + 0.01, lat + 0.01], 
      address: "Load Test Drop"
    },
    vehicleType: "bike",
    fare: 60
  });

  const params = {
    headers: { "Content-Type": "application/json" }
  };

  const res = http.post(URL, payload, params);

  check(res, {
    "status is 200": (r) => r.status === 200,
    "got trip object": (r) => JSON.parse(r.body)?.trip !== undefined,
    "assigned driver exists": (r) =>
      JSON.parse(r.body)?.trip?.driverId !== undefined,
  });

  sleep(1); // important to avoid infinite traffic flood
}
