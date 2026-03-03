// src/middlewares/authMiddleware.js
import admin from "../utils/firebase.js";
import User from "../models/User.js";

// =====================================================
// 🔐 Protect normal users (Driver / Customer)
// =====================================================
export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "No token provided",
      });
    }

    const token = authHeader.split(" ")[1];
    console.log("🔐 Verifying Firebase token...");

    const decodedToken = await admin.auth().verifyIdToken(token);

    // 📱 Extract phone number from Firebase token
    const phoneInToken =
      decodedToken.phone_number ||
      (decodedToken.phone ? `+91${decodedToken.phone}` : null);

    if (!phoneInToken) {
      return res.status(401).json({
        success: false,
        message: "Phone number not found in token",
      });
    }

    console.log("🔐 Token verified for:", phoneInToken);

    // Normalize phone number (extract last 10 digits)
    const phone = phoneInToken.replace(/\D/g, "").slice(-10);

    const user = await User.findOne({ phone });

    if (!user) {
      console.log(`❌ User not found in DB for phone: ${phone}`);
      return res.status(401).json({
        success: false,
        message: "User not found in DB",
      });
    }

    console.log(`✅ User authenticated:
     MongoDB ID: ${user._id}
     Phone: ${user.phone}
     Role: ${user.role}
     Vehicle Type: ${user.vehicleType || "not set"}`);

    // =====================================================
    // 🔥 Attach identity securely
    // =====================================================
    req.user = {
      ...decodedToken,

      // 🔑 MongoDB identity (ALL formats for safety)
      _id: user._id,
      id: user._id,            // legacy support
      mongoId: user._id,       // clarity
      dbUser: user,            // full db user for controllers

      // User-level metadata
      phone: user.phone,
      role: user.role,
      isDriver: user.isDriver,
      vehicleType: user.vehicleType,
      firebaseUid: decodedToken.uid,
    };

    next();
  } catch (error) {
    console.error("❌ Auth middleware error:", error);
    return res.status(401).json({
      success: false,
      message: "Token invalid or expired",
      error: error.message,
    });
  }
};

// =====================================================
// 🔐 Verify Firebase Token (raw, no DB lookup)
// =====================================================
export const verifyFirebaseToken = async (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Missing Authorization header",
    });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid Firebase token",
      error: err.message,
    });
  }
};

// =====================================================
// 🔐 Admin only middleware
// =====================================================
export const adminOnly = (req, res, next) => {
  try {
    const adminPhoneNumbers = [
      "+919999999999",
      "+918888888888",
    ];

    const userPhone = req.user.phone_number || req.user.phone;

    if (!adminPhoneNumbers.includes(userPhone)) {
      return res.status(403).json({
        success: false,
        message: "Admin access only",
      });
    }

    next();
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Error checking admin rights",
      error: err.message,
    });
  }
};
