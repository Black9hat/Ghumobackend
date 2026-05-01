import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 500,              // simulate 50 drivers online
  duration: "30s",      // run for 30 seconds
};

const URL = "http://192.168.1.70:5002/api/location/updateDriver";

export default function () {
  const sequence = __ITER;  // auto-increasing per driver

  const payload = JSON.stringify({
    driverId: "68e24aea3b861586df2d728e",  // your driver
    latitude: 17.3850 + Math.random() * 0.001,
    longitude: 78.4867 + Math.random() * 0.001,
    sequence: sequence,
    timestamp: new Date().toISOString()
  });

  const params = {
    headers: { "Content-Type": "application/json" }
  };

  const res = http.post(URL, payload, params);

  check(res, {
    "status is 200": (r) => r.status === 200,
  });

  sleep(0.2);  // driver sends location every 200ms
}
