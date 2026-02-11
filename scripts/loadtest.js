import http from 'k6/http';
import { sleep, check } from 'k6';

export let options = {
  vus: 10,           // 10 virtual users to start — change later
  duration: '1m',    // total test length
  thresholds: {
    http_req_duration: ['p(95) < 1000'] // goal: 95% requests < 1000ms
  }
};

const BASE = 'https://chauncey-unpercolated-roastingly.ngrok-free.dev'; // <<< change this

export default function () {
  // 1) Login (adjust endpoint/payload for your app)
  let loginRes = http.post(`${BASE}/api/auth/login`, JSON.stringify({
    phone: "9999999999", otp: "0000"
  }), { headers: { 'Content-Type': 'application/json' } });

  check(loginRes, { 'login ok': (r) => r.status === 200 || r.status === 201 });

  const token = loginRes.json('token') || '';

  // 2) Create a trip (adjust payload)
  let tripRes = http.post(`${BASE}/api/trips`, JSON.stringify({
    pickup: { lat: 12.97, lng: 77.59 },
    drop:   { lat: 12.95, lng: 77.58 },
    type: 'short'
  }), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  });

  check(tripRes, { 'trip created': (r) => r.status === 200 || r.status === 201 });

  sleep(Math.random() * 3); // wait 0-3s before next action
}
