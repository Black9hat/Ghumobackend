// src/utils/fcmSender.js
// VERSION: FIXED-V6 — Admin notifications get notification block for killed-app delivery

import admin from 'firebase-admin';
import User from '../models/User.js';

// ✅ FIX: Mobile OS strictly blocks "http://" in the background. Enforce "https://"
const getFullImageUrl = (url) => {
  if (!url) return null;
  let secureUrl = url.replace('http://', 'https://');

  if (secureUrl.startsWith('https://')) return secureUrl;

  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.BACKEND_URL || "https://ghumobackend.onrender.com";

  const cleanUrl = secureUrl.startsWith("/") ? secureUrl : `/${secureUrl}`;
  const fullUrl = `${baseUrl}${cleanUrl}`;

  console.log(`🖼️ Image URL: ${url} → ${fullUrl}`);
  return fullUrl;
};

const CHANNEL_ID = 'high_importance_channel_v3';

export const sendToDriver = async (fcmToken, dataPayload = {}) => {
  if (!fcmToken) {
    console.error('❌ No FCM token provided');
    return { success: false, error: 'No FCM token' };
  }

  try {
    const pickup = dataPayload.pickup || {};
    const drop = dataPayload.drop || {};
    const fullImageUrl = getFullImageUrl(dataPayload.imageUrl);
    const tripId = String(dataPayload.tripId || '');

    // ✅ KEY FIX: Detect if this is an admin notification (not a trip request).
    // Trip requests must be pure data-only (native overlay handles them).
    // Admin/broadcast notifications need a notification block so Android
    // can display them even when the app is killed.
    const isAdminNotification =
      dataPayload.notificationType === 'ADMIN_NOTIFICATION' ||
      dataPayload.notificationType === 'TRIP_REASSIGNED' ||
      (!tripId && dataPayload.title);

    const message = {
      token: fcmToken,

      data: {
        tripId,
        type: String(dataPayload.type || dataPayload.notificationType || 'TRIP_REQUEST'),
        fare: String(dataPayload.fare || 0),
        vehicleType: String(dataPayload.vehicleType || 'bike'),
        customerId: String(dataPayload.customerId || ''),
        paymentMethod: String(dataPayload.paymentMethod || 'cash'),
        isDestinationMatch: String(dataPayload.isDestinationMatch || false),
        timestamp: new Date().toISOString(),

        pickupAddress: String(pickup.address || dataPayload.pickupAddress || 'Pickup Location'),
        pickupLat: String(pickup.lat || dataPayload.pickupLat || 0),
        pickupLng: String(pickup.lng || dataPayload.pickupLng || 0),

        dropAddress: String(drop.address || dataPayload.dropAddress || 'Drop Location'),
        dropLat: String(drop.lat || dataPayload.dropLat || 0),
        dropLng: String(drop.lng || dataPayload.dropLng || 0),

        title: String(dataPayload.title || 'New Trip Request'),
        body: String(dataPayload.body || ''),
        imageUrl: fullImageUrl || '',
        image: fullImageUrl || '',
      },

      android: {
        priority: 'high',
        ttl: 2 * 60 * 60 * 1000,
        collapseKey: tripId
          ? `trip_request_${tripId}`
          : `admin_notification_${Date.now()}`,
      },

      apns: {
        headers: {
          'apns-priority': '10',
          ...(tripId
            ? { 'apns-collapse-id': `trip_request_${tripId}` }
            : {}),
        },
        payload: {
          aps: {
            'content-available': 1,
            // ✅ For admin notifications, also show alert on iOS
            ...(isAdminNotification && {
              alert: {
                title: String(dataPayload.title || 'New Notification'),
                body: String(dataPayload.body || ''),
              },
              sound: 'default',
            }),
          },
        },
        ...(isAdminNotification && fullImageUrl && {
          fcmOptions: { image: fullImageUrl },
        }),
      },
    };

    // ✅ FIX: Admin notifications get a top-level notification block.
    // This ensures Android shows the notification even when app is killed.
    // Trip requests stay pure data-only so native overlay handles them.
    if (isAdminNotification) {
      message.notification = {
        title: String(dataPayload.title || 'New Notification'),
        body: String(dataPayload.body || ''),
        ...(fullImageUrl && { imageUrl: fullImageUrl }),
      };
      message.android.notification = {
        channelId: CHANNEL_ID,
        priority: 'high',
        ...(fullImageUrl && { imageUrl: fullImageUrl }),
      };
    }

    console.log('');
    console.log('═'.repeat(70));
    console.log('📤 SENDING FCM TO DRIVER');
    console.log('═'.repeat(70));
    console.log(`   Token: ${fcmToken.substring(0, 20)}...`);
    console.log(`   Type: ${message.data.type}`);
    console.log(`   Is Admin Notification: ${isAdminNotification}`);
    console.log(`   Has notification block: ${!!message.notification}`);
    console.log(`   Trip ID: ${tripId || 'N/A'}`);
    console.log(`   Title: ${message.data.title}`);
    console.log(`   Body: ${message.data.body}`);
    console.log(`   Image: ${fullImageUrl || 'none'}`);
    console.log('═'.repeat(70));
    console.log('');

    const response = await admin.messaging().send(message);
    console.log(`✅ FCM sent successfully: ${response}`);

    return { success: true, messageId: response };

  } catch (error) {
    console.error('═'.repeat(70));
    console.error(`❌ FCM SEND FAILED`);
    console.error('═'.repeat(70));
    console.error(`   Error: ${error.message}`);
    console.error(`   Code: ${error.code}`);
    console.error(`   Token: ${fcmToken.substring(0, 20)}...`);
    console.error('═'.repeat(70));

    if (
      error.code === 'messaging/registration-token-not-registered' ||
      error.code === 'messaging/invalid-registration-token'
    ) {
      try {
        await User.updateOne(
          { fcmToken: fcmToken },
          { $unset: { fcmToken: "" } }
        );
        console.log(`✅ Invalid token removed from database`);
      } catch (dbError) {
        console.log(`⚠️ Could not remove token: ${dbError.message}`);
      }
      return { success: false, error: 'Token expired/invalid', tokenRemoved: true };
    }

    return { success: false, error: error.message };
  }
};

// ✅ Customer side — unchanged
export const sendToCustomer = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) {
    console.error('❌ No FCM token provided');
    return { success: false, error: 'No FCM token' };
  }

  try {
    const fullImageUrl = getFullImageUrl(data.imageUrl);

    console.log('');
    console.log('═'.repeat(70));
    console.log('📤 SENDING FCM TO CUSTOMER');
    console.log('═'.repeat(70));
    console.log(`   Title: ${title}`);
    console.log(`   Body: ${body}`);
    console.log(`   Image URL: ${fullImageUrl || 'none'}`);
    console.log(`   Channel: ${CHANNEL_ID}`);
    console.log(`   Token: ${fcmToken.substring(0, 20)}...`);
    console.log('═'.repeat(70));
    console.log('');

    const notificationBlock = { title, body };
    if (fullImageUrl) {
      notificationBlock.image = fullImageUrl;
    }

    const androidNotification = {
      channelId: CHANNEL_ID,
    };
    if (fullImageUrl) {
      androidNotification.imageUrl = fullImageUrl;
    }

    const message = {
      token: fcmToken,

      notification: notificationBlock,

      data: {
        type: String(data.type || 'customer'),
        title: String(title),
        body: String(body),
        imageUrl: String(fullImageUrl || ''),
        image: String(fullImageUrl || ''),
        tripId: String(data.tripId || ''),
        timestamp: new Date().toISOString(),
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        ...Object.fromEntries(
          Object.entries(data)
            .filter(([k]) => !['imageUrl', 'image', 'type', 'tripId', 'title', 'body'].includes(k))
            .map(([k, v]) => [k, String(v)])
        ),
      },

      android: {
        priority: 'high',
        ttl: 86400000,
        notification: androidNotification,
      },

      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            badge: 1,
            'mutable-content': 1,
            'content-available': 1,
          },
        },
        fcmOptions: {
          ...(fullImageUrl && { image: fullImageUrl }),
        },
      },
    };

    console.log('📦 Final FCM Message (summary):');
    console.log(`   android.notification.channelId: ${CHANNEL_ID}`);
    console.log(`   data.image: ${message.data.image || 'none'}`);

    const response = await admin.messaging().send(message);

    console.log('');
    console.log('✅ CUSTOMER FCM SENT SUCCESSFULLY');
    console.log(`   Message ID: ${response}`);
    console.log('');

    return { success: true, messageId: response };

  } catch (error) {
    console.error('');
    console.error('❌ CUSTOMER FCM FAILED');
    console.error(`   Error: ${error.message}`);
    console.error(`   Code: ${error.code}`);

    if (
      error.code === 'messaging/registration-token-not-registered' ||
      error.code === 'messaging/invalid-registration-token'
    ) {
      try {
        await User.updateOne({ fcmToken }, { $unset: { fcmToken: "" } });
        console.log('✅ Invalid token removed from database');
      } catch (dbError) {
        console.error(`⚠️ Could not remove invalid token: ${dbError.message}`);
      }
    }

    return { success: false, error: error.message };
  }
};

export default { sendToDriver, sendToCustomer };