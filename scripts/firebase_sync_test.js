import http from 'k6/http';
import { sleep, check } from 'k6';

// ---------------------------
// TEST SETTINGS
// ---------------------------
export let options = {
  vus: 10,            // 10 virtual users
  duration: '30s',    // test runs for 30 seconds

  thresholds: {
    http_req_duration: ['p(95) < 1000'], // 95% requests < 1 second
  },
};

// ---------------------------
// BASE URL
// ---------------------------
const BASE_URL = 'https://chauncey-unpercolated-roastingly.ngrok-free.dev';

// ---------------------------
// MAIN TEST FUNCTION
// ---------------------------
export default function () {
  const phone = "9999999999"; // dummy phone
  const firebaseUid = "test-load-user-123"; // dummy UID
  const role = "customer";

  // ---------------------------
  // CALL LOGIN API
  // ---------------------------

  const payload = JSON.stringify({
    phone: phone,
    firebaseUid: firebaseUid,
    role: role,
  });

  const headers = {
    'Content-Type': 'application/json',
  };

  const res = http.post(
    `${BASE_URL}/api/auth/firebase-sync`,
    payload,
    { headers: headers }
  );

  // ---------------------------
  // CHECK RESPONSE SUCCESS
  // ---------------------------

  check(res, {
    "status is 200": (r) => r.status === 200,
    "firebaseToken exists": (r) => !!r.json("firebaseToken"),
  });

  sleep(1);
}
