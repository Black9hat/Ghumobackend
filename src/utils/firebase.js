// src/config/firebase.js
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// Parse service account JSON from ENV
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export default admin;
