// src/controllers/authController.js
import admin from "../utils/firebase.js";
import User  from "../models/User.js";
import { recomputeDriverDocumentStatus } from "./documentController.js";
import { normalizePhone } from "../utils/phoneNormalizer.js";
import SessionManager from "../services/SessionManager.js";
import {
  assignWelcomeCoupon,
  ensureReferralCode,
  recordReferralSignup,
} from "../services/rewardService.js";

/* ────────────── Firebase Sync ────────────── */
export const firebaseSync = async (req, res) => {
  try {
    const { phone, firebaseUid, role, referralCode, deviceId, fcmToken } = req.body;

    if (!phone || !firebaseUid) {
      return res.status(400).json({
        message: "Phone and firebaseUid are required",
      });
    }

    const phoneKey = normalizePhone(phone);
    if (!phoneKey) {
      return res.status(400).json({
        message: "Invalid phone number format",
      });
    }
    
    // 🔥 ROLE-BASED SESSION CONTROL: Default role to "customer" if not specified
    const loginRole = role || "customer";
    const deviceIdValue = deviceId || req.body.deviceInfo?.deviceId || "unknown";
    
    console.log(`✅ Firebase sync: ${phoneKey} | uid: ${firebaseUid} | role: ${loginRole} | device: ${deviceIdValue}`);

    // ── Find or Create User ──────────────────────────────────────────────────
    let user      = await User.findOne({ phone: phoneKey });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = new User({
        phone:       phoneKey,
        name:        "New User",
        role:        loginRole,
        isDriver:    loginRole === "driver",
        firebaseUid,
        vehicleType: loginRole === "driver" ? null : undefined,
        location: {
          type:        "Point",
          coordinates: [78.4867, 17.385],
        },
      });
      await user.save();
      console.log(`✅ New user: ${user._id} (role: ${loginRole})`);

      // ── Post-registration rewards (customers only, non-blocking) ──────────
      if (loginRole === 'customer') {

        // 1. Generate referral code
        ensureReferralCode(user._id).catch((e) =>
          console.warn('⚠️ Referral code gen failed:', e.message)
        );

        // 2. Assign welcome coupon
        assignWelcomeCoupon(user._id).catch((e) =>
          console.warn('⚠️ Welcome coupon failed:', e.message)
        );

        // 3. Record referral if code provided
        if (referralCode && referralCode.trim().length >= 4) {
          console.log(`🎯 New user referral attempt: ${referralCode.trim()} → ${user._id}`);
          recordReferralSignup(user._id, referralCode.trim())
            .then((result) => {
              if (result.success) {
                console.log(`✅ Referral recorded: ${referralCode} → ${user._id}`);
              } else {
                console.warn(`⚠️ Referral not recorded: ${result.message}`);
              }
            })
            .catch((e) =>
              console.warn('⚠️ Referral signup failed:', e.message)
            );
        } else {
          console.log(`ℹ️ No referral code provided for new user ${user._id}`);
        }
      }

    } else {
      // Existing user login
      if (!user.firebaseUid) {
        user.firebaseUid = firebaseUid;
        await user.save();
      }

      if (loginRole === "driver" && user.role !== "driver") {
        isNewUser        = true;
        user.role        = "driver";
        user.isDriver    = true;
        user.vehicleType = null;
        await user.save();
        console.log(`🔄 Converted to driver: ${user._id}`);
      } else {
        console.log(`✅ Existing user login: ${user._id} | referredBy: ${user.referredBy || 'none'} | referralCode in body: ${referralCode || 'none'}`);
      }

      // ✅ Late referral: user reinstalled with referral link but not yet referred
      if (
        referralCode &&
        referralCode.trim().length >= 4 &&
        loginRole === 'customer' &&
        !user.referredBy
      ) {
        console.log(`🎯 Late referral attempt: ${referralCode.trim()} → ${user._id}`);
        recordReferralSignup(user._id, referralCode.trim())
          .then((r) => {
            if (r.success) {
              console.log(`✅ Late referral recorded: ${referralCode} → ${user._id}`);
            } else {
              console.warn(`⚠️ Late referral not recorded: ${r.message}`);
            }
          })
          .catch((e) => console.warn('⚠️ Late referral error:', e.message));
      } else if (loginRole === 'customer' && !user.referredBy) {
        // Log why late referral was skipped
        if (!referralCode || referralCode.trim().length < 4) {
          console.log(`ℹ️ Late referral skipped: no referralCode in request for ${user._id}`);
        }
      }
    }

    // ── Recompute driver document status ─────────────────────────────────────
    if (user.isDriver && user.vehicleType) {
      try {
        await recomputeDriverDocumentStatus(user._id.toString());
        user = await User.findById(user._id);
        console.log(`🔁 Doc status: ${user.documentStatus}`);
      } catch (err) {
        console.error("⚠️ Doc recompute failed:", err.message);
      }
    }

    // ── Generate Custom Token ─────────────────────────────────────────────────
    let firebaseToken = null;
    try {
      firebaseToken = await admin.auth().createCustomToken(
        firebaseUid,
        { phone: user.phone }
      );
    } catch (err) {
      console.error("⚠️ Token creation failed:", err.message);
    }

    // ── Lazy referral code for existing customers ─────────────────────────────
    if (loginRole === 'customer' && !user.referralCode) {
      ensureReferralCode(user._id).catch(() => {});
    }

    // 🔥 ROLE-BASED SESSION CONTROL: Handle session with role awareness
    console.log(`🔐 Processing session for ${phoneKey} (${loginRole})`);
    const sessionResult = await SessionManager.handleLogin(
      phoneKey,
      deviceIdValue,
      fcmToken || user.fcmToken || null,
      null, // io instance not available in HTTP context
      loginRole
    );

    if (!sessionResult.success) {
      console.warn(`⚠️ Session handling failed: ${sessionResult.error}`);
    } else if (sessionResult.forcedLogout) {
      console.log(`⚠️ Old ${loginRole} session force-logged out: ${sessionResult.oldDeviceId}`);
    }

    const profileComplete = user.name !== "New User";
    const docsApproved    = user.documentStatus === "approved";

    return res.status(200).json({
      message:         isNewUser ? "Registration successful" : "Login successful",
      newUser:         isNewUser,
      docsApproved,
      profileComplete,
      customerId:      user._id,
      userId:          user._id,
      user: {
        _id:                   user._id,
        phone:                 user.phone,
        name:                  user.name,
        role:                  loginRole,
        isDriver:              user.isDriver,
        vehicleType:           user.vehicleType,
        documentStatus:        user.documentStatus,
        memberSince:           _formatMemberSince(user.createdAt),
        referralCode:          user.referralCode || null,
        coins:                 user.coins || 0,
        welcomeCouponAssigned: user.welcomeCouponAssigned || false,
      },
      firebaseToken,
      sessionInfo: {
        deviceId: deviceIdValue,
        role: loginRole,
        forcedLogout: sessionResult.forcedLogout || false,
        oldDeviceId: sessionResult.oldDeviceId || null,
      },
    });
  } catch (error) {
    console.error("🔥 Firebase sync error:", error);
    return res.status(500).json({
      message: "An error occurred during sync.",
      error:   error.message,
    });
  }
};

function _formatMemberSince(createdAt) {
  const date  = new Date(createdAt);
  const month = date.toLocaleString("default", { month: "long" });
  const year  = date.getFullYear();
  return `${month} ${year}`;
}