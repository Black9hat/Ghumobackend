// src/utils/fcmHelper.js
// VERSION: FINAL-V7 — Enforces HTTPS for background images + Correct Admin SDK fields

import admin from './firebase.js';
import User from '../models/User.js';

const SERVER_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.BACKEND_URL || 'https://ghumobackend.onrender.com';

const CHANNEL_ID = 'high_importance_channel_v3';

const toStringData = (obj = {}) => {
  const result = {};
  Object.keys(obj).forEach((key) => {
    if (obj[key] !== undefined && obj[key] !== null) {
      result[key] = String(obj[key]);
    }
  });
  return result;
};

// ✅ FIX: Mobile OS strictly blocks "http://" in the background. Enforce "https://"
const getFullImageUrl = (url) => {
  if (!url) return null;
  // Replace http:// with https://
  let secureUrl = url.replace('http://', 'https://');
  
  if (secureUrl.startsWith('https://')) return secureUrl;
  
  const cleanPath = secureUrl.startsWith('/') ? secureUrl : `/${secureUrl}`;
  return `${SERVER_URL}${cleanPath}`;
};

const handleFCMError = async (error, userId) => {
  console.error('FCM Error:', error.code, error.message);
  if (
    error.code === 'messaging/invalid-argument' ||
    error.code === 'messaging/registration-token-not-registered' ||
    (error.message && error.message.includes('entity was not found'))
  ) {
    if (userId) {
      await User.findByIdAndUpdate(userId, { $unset: { fcmToken: '' } });
    }
    return { success: false, error: 'RECIPIENT_NOT_FOUND', message: 'Device token not found' };
  }
  return { success: false, error: 'FCM_ERROR', message: error.message };
};

export const sendFCMNotification = async ({
  userId,
  token,
  title,
  body,
  type = 'general',
  imageUrl = null,
  data = {},
}) => {
  if (!token || typeof token !== 'string') {
    return { success: false, message: 'Invalid FCM Token' };
  }

  const fullImageUrl = getFullImageUrl(imageUrl);
  console.log('sendFCMNotification [FINAL-V7]:', { title, body, image: fullImageUrl || 'none', channel: CHANNEL_ID });

  // ✅ FIX: Use 'imageUrl' for Node.js Firebase Admin SDK
  const notification = { title: String(title), body: String(body) };
  if (fullImageUrl) {
    notification.image = fullImageUrl; // strictly only 'image' for FCM v1
  }

  const androidNotif = { sound: 'default', channelId: CHANNEL_ID };
  if (fullImageUrl) {
    androidNotif.image = fullImageUrl; // strictly only 'image' for FCM v1
  }

  // ✅ FIX: Use 'imageUrl' for iOS as well
  const iosFcmOptions = {};
  if (fullImageUrl) {
    iosFcmOptions.image = fullImageUrl; // ONLY 'image' for APNS to avoid 'Multiple specifications' error
  }

  const baseData = {
    type,
    title:        String(title),
    body:         String(body),
    image:        fullImageUrl || '',
    imageUrl:     fullImageUrl || '',
    click_action: 'FLUTTER_NOTIFICATION_CLICK',
  };

  const message = {
    token,
    // notification, // ❌ REMOVED: Moving to data-only for higher reliability on Android 14+
    android: {
      priority: 'high',
      ttl: 86400000, 
      // notification: androidNotif, // ❌ REMOVED: Manual display via Flutter handler
    },
    apns: {
      headers: {
        'apns-priority': '10',
      },
      payload: {
        aps: {
          sound: 'default',
          'mutable-content': 1,
        },
      },
      fcmOptions: iosFcmOptions,
    },
    data: toStringData(Object.assign(baseData, data)),
  };

  try {
    const response = await admin.messaging().send(message);
    console.log('FCM Sent:', response);
    return { success: true, response };
  } catch (error) {
    return await handleFCMError(error, userId);
  }
};
export default { sendFCMNotification };
