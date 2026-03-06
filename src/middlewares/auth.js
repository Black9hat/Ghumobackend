// middlewares/auth.js
// Enhanced to support BOTH Firebase auth AND admin token
// Your existing Firebase auth stays intact!

import admin from "../utils/firebase.js";
import User from "../models/User.js";

export const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const adminToken = req.headers['x-admin-token'];

    // ✅ Method 1: Try Firebase authentication (your existing code)
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        console.log("🔐 Verifying Firebase token for support...");

        const decodedToken = await admin.auth().verifyIdToken(token);
        const phoneInToken =
          decodedToken.phone_number ||
          (decodedToken.phone ? `+91${decodedToken.phone}` : null);

        if (!phoneInToken) {
          console.log("⚠️ No phone number in Firebase token");
        } else {
          console.log("✅ Firebase token verified for:", phoneInToken);
          const phone = phoneInToken.replace(/\D/g, "").slice(-10);
          const user = await User.findOne({ phone });

          if (!user) {
            console.log(`❌ User not found in DB for phone: ${phone}`);
          } else {
            console.log(`✅ User authenticated via Firebase:
              MongoDB ID: ${user._id}
              Phone: ${user.phone}
              Role: ${user.role}
              Is Driver: ${user.isDriver}`);

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
              authMethod: 'firebase'
            };
            return next();
          }
        }
      } catch (firebaseError) {
        console.log("⚠️ Firebase verification failed:", firebaseError.message);
      }
    }

    // ✅ Method 2: Try admin token (new - for admin dashboard)
    if (adminToken && process.env.ADMIN_TOKEN) {
      if (adminToken === process.env.ADMIN_TOKEN) {
        console.log("✅ Admin authenticated via x-admin-token");
        
        req.user = {
          uid: 'admin',
          _id: 'admin',
          id: 'admin',
          mongoId: 'admin',
          phone: 'admin',
          role: 'admin',
          isDriver: false,
          firebaseUid: 'admin',
          authMethod: 'admin-token'
        };
        return next();
      } else {
        console.log("❌ Invalid admin token");
      }
    }

    return res.status(401).json({
      success: false,
      message: "No valid authentication provided",
      available: {
        firebase: "Send 'Authorization: Bearer <firebase-token>' header",
        admin: "Send 'x-admin-token: <admin-secret>' header"
      }
    });

  } catch (error) {
    console.error("❌ Auth middleware error:", error);
    return res.status(401).json({
      success: false,
      message: "Authentication error",
      error: error.message,
    });
  }
};

export const isDriver = async (req, res, next) => {
  if (!req.user || !req.user.isDriver) {
    return res.status(403).json({ 
      success: false, 
      message: 'Driver access required' 
    });
  }
  next();
};

export const isCustomer = async (req, res, next) => {
  if (!req.user || req.user.isDriver) {
    return res.status(403).json({ 
      success: false, 
      message: 'Customer access required' 
    });
  }
  next();
};

export const isAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }

  const isAdminUser = req.user.role === 'admin' || req.user.authMethod === 'admin-token';
  
  if (!isAdminUser) {
    return res.status(403).json({ 
      success: false, 
      message: 'Admin access required' 
    });
  }
  next();
};

export default authenticateUser;