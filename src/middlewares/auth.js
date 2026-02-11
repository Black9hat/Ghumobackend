// middlewares/auth.js
// Compatible with your existing Firebase auth system

import admin from "../utils/firebase.js";
import User from "../models/User.js";

/**
 * Authenticate user from Firebase token (for support routes)
 * This is the same as your existing 'protect' middleware
 */
export const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "No token provided",
      });
    }

    const token = authHeader.split(" ")[1];
    console.log("🔐 Verifying Firebase token for support...");

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

    console.log("✅ Token verified for:", phoneInToken);

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

    console.log(`✅ User authenticated for support:
     MongoDB ID: ${user._id}
     Phone: ${user.phone}
     Role: ${user.role}
     Is Driver: ${user.isDriver}`);

    // 🔒 Attach identity (same format as your existing middleware)
    req.user = {
      ...decodedToken,
      _id: user._id,
      id: user._id,
      mongoId: user._id,
      dbUser: user,
      phone: user.phone,
      role: user.role,
      isDriver: user.isDriver,
      vehicleType: user.vehicleType,
      firebaseUid: decodedToken.uid,
    };

    next();
  } catch (error) {
    console.error("❌ Support auth middleware error:", error);
    return res.status(401).json({
      success: false,
      message: "Token invalid or expired",
      error: error.message,
    });
  }
};

/**
 * Check if user is driver
 */
export const isDriver = async (req, res, next) => {
  if (!req.user || !req.user.isDriver) {
    return res.status(403).json({ 
      success: false, 
      message: 'Driver access required' 
    });
  }
  next();
};

/**
 * Check if user is customer
 */
export const isCustomer = async (req, res, next) => {
  if (!req.user || req.user.isDriver) {
    return res.status(403).json({ 
      success: false, 
      message: 'Customer access required' 
    });
  }
  next();
};