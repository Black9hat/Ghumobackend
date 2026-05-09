// src/middlewares/authMiddleware.js
import admin from "../utils/firebase.js";
import User from "../models/User.js";

const resolveRequestedRole = (req) => {
  const headerRole = String(
    req.headers['x-app-role'] ||
      req.headers['x-user-role'] ||
      req.headers['x-client-role'] ||
      req.headers['x-role'] ||
      ''
  ).toLowerCase().trim();

  const bodyRole = String(req.body?.role || req.query?.role || '').toLowerCase().trim();
  const path = String(req.originalUrl || req.path || '').toLowerCase();

  if (headerRole === 'driver' || headerRole === 'customer') return headerRole;
  if (bodyRole === 'driver' || bodyRole === 'customer') return bodyRole;

  if (path.startsWith('/api/driver')) return 'driver';
  if (path.startsWith('/api/customer')) return 'customer';
  if (path.startsWith('/api/notifications')) return 'driver';
  if (path.includes('/admin/notifications') || path.includes('/admin/offers')) return 'customer';

  return null;
};

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

    const requestedRole = resolveRequestedRole(req);
    let user = requestedRole
      ? await User.findOne({ phone, role: requestedRole })
      : await User.findOne({ phone });

    if (!user) {
      const matches = await User.find({ phone }).select('_id phone role isDriver vehicleType');

      if (matches.length === 1) {
        user = matches[0];
      } else if (matches.length > 1) {
        if (requestedRole) {
          user = matches.find((candidate) => candidate.role === requestedRole) || null;
        }

        if (!user) {
          const driverMatch = matches.find((candidate) => candidate.role === 'driver' || candidate.isDriver);
          const customerMatch = matches.find((candidate) => candidate.role === 'customer' && !candidate.isDriver);
          user = requestedRole === 'driver' ? driverMatch || customerMatch : customerMatch || driverMatch;
        }
      }
    }

    if (!user) {
      console.log(`❌ User not found in DB for phone: ${phone}`);
      return res.status(401).json({
        success: false,
        message: "User not found in DB",
      });
    }

    const effectiveRole = user.isDriver ? 'driver' : (user.role || 'customer');

    console.log(`✅ User authenticated:
     MongoDB ID: ${user._id}
     Phone: ${user.phone}
     Role: ${effectiveRole}
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
      role: effectiveRole,
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
