// src/utils/fcmHelper.js

import admin from "./firebase.js";
import User from "../models/User.js";

// ════════════════════════════════════════════════════════════════
// 🔥 PUT YOUR ACTUAL SERVER URL HERE!
// ════════════════════════════════════════════════════════════════
const SERVER_URL = "https://chauncey-unpercolated-roastingly.ngrok-free.dev";  // ← CHANGE THIS!
// ════════════════════════════════════════════════════════════════

/**
 * Convert all data payload values to STRING (FCM Requirement)
 */
const toStringData = (obj = {}) => {
  const result = {};
  Object.keys(obj).forEach((key) => {
    if (obj[key] !== undefined && obj[key] !== null) {
      result[key] = String(obj[key]);
    }
  });
  return result;
};

/**
 * Get full image URL - FIXED with hardcoded URL
 */
const getFullImageUrl = (url) => {
  if (!url) return null;
  
  // Already absolute URL
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  
  // ✅ Use hardcoded SERVER_URL
  const cleanPath = url.startsWith("/") ? url : `/${url}`;
  const fullUrl = `${SERVER_URL}${cleanPath}`;
  
  console.log(`🖼️ Image URL: ${fullUrl}`);
  return fullUrl;
};

/**
 * Handle FCM Errors Gracefully
 */
const handleFCMError = async (error, userId) => {
  console.error("❌ FCM Error:", error.code, error.message);

  if (
    error.code === "messaging/invalid-argument" ||
    error.code === "messaging/registration-token-not-registered" ||
    (error.message && error.message.includes("entity was not found"))
  ) {
    if (userId) {
      await User.findByIdAndUpdate(userId, { $unset: { fcmToken: "" } });
      console.warn("🧹 Removed invalid FCM token for user:", userId);
    }
    return {
      success: false,
      error: "RECIPIENT_NOT_FOUND",
      message: "Device token or recipient not found",
    };
  }

  return {
    success: false,
    error: "FCM_ERROR",
    message: error.message,
  };
};

/**
 * ✅ FCM SEND FUNCTION WITH IMAGE SUPPORT
 */
export const sendFCMNotification = async ({
  userId,
  token,
  title,
  body,
  type = "general",
  imageUrl = null,
  data = {},
}) => {
  if (!token || typeof token !== "string") {
    console.warn("⚠️ Invalid FCM token, skipping");
    return { success: false, message: "Invalid FCM Token" };
  }

  // ✅ Get full image URL
  const fullImageUrl = getFullImageUrl(imageUrl);

  console.log(`📤 Sending FCM:`);
  console.log(`   Title: ${title}`);
  console.log(`   Body: ${body}`);
  console.log(`   🖼️ Image: ${fullImageUrl || 'none'}`);

  const message = {
    token,
    
    // ✅ Notification payload
    notification: {
      title: String(title),
      body: String(body),
      ...(fullImageUrl && { image: fullImageUrl }),  // ✅ 'image' not 'imageUrl'
    },
    
    // ✅ Android
    android: {
      priority: "high",
      notification: {
        sound: "default",
        channelId: "high_importance_channel",
        ...(fullImageUrl && { imageUrl: fullImageUrl }),
      },
    },
    
    // ✅ iOS
    apns: {
      headers: {
        "apns-priority": "10",
      },
      payload: {
        aps: {
          alert: { title: String(title), body: String(body) },
          sound: "default",
          "mutable-content": 1,
        },
      },
      fcm_options: {
        ...(fullImageUrl && { image: fullImageUrl }),
      },
    },
    
    // ✅ Data payload
    data: toStringData({
      type,
      title,
      body,
      image: fullImageUrl || "",
      click_action: "FLUTTER_NOTIFICATION_CLICK",
      ...data,
    }),
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("✅ FCM Sent:", response);
    return { success: true, response };
  } catch (error) {
    return await handleFCMError(error, userId);
  }
};

export default { sendFCMNotification };