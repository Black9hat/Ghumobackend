// src/utils/fcmSender.js

import admin from 'firebase-admin';
import User from '../models/User.js';

/**
 * Get full image URL
 */
const getFullImageUrl = (url) => {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  
  const baseUrl = process.env.BACKEND_URL || "https://your-api.com";
  return `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
};

/**
 * ✅ Send FCM notification to driver (WORKS WHEN APP IS KILLED)
 */
export const sendToDriver = async (fcmToken, dataPayload = {}) => {
  if (!fcmToken) {
    return { success: false, error: 'No FCM token' };
  }

  try {
    // Extract pickup and drop
    const pickup = dataPayload.pickup || {};
    const drop = dataPayload.drop || {};
    
    // ✅ Get full image URL if provided
    const fullImageUrl = getFullImageUrl(dataPayload.imageUrl);

    const message = {
      token: fcmToken,
      
      // DATA-ONLY payload for trip requests
      data: {
        // Core trip data
        tripId: String(dataPayload.tripId || ''),
        type: String(dataPayload.type || 'TRIP_REQUEST'),
        fare: String(dataPayload.fare || 0),
        vehicleType: String(dataPayload.vehicleType || 'bike'),
        customerId: String(dataPayload.customerId || ''),
        paymentMethod: String(dataPayload.paymentMethod || 'cash'),
        isDestinationMatch: String(dataPayload.isDestinationMatch || false),
        timestamp: new Date().toISOString(),
        
        // FLAT structure for pickup
        pickupAddress: String(pickup.address || 'Pickup Location'),
        pickupLat: String(pickup.lat || 0),
        pickupLng: String(pickup.lng || 0),
        
        // FLAT structure for drop
        dropAddress: String(drop.address || 'Drop Location'),
        dropLat: String(drop.lat || 0),
        dropLng: String(drop.lng || 0),
        
        // ✅ Image URL if provided
        imageUrl: fullImageUrl || '',
      },

      android: {
        priority: 'high',
      },

      apns: {
        headers: {
          'apns-priority': '10',
        }
      },
    };

    console.log('');
    console.log('═'.repeat(70));
    console.log('📤 SENDING FCM TO DRIVER');
    console.log('═'.repeat(70));
    console.log(`   Token: ${fcmToken.substring(0, 20)}...`);
    console.log(`   Trip ID: ${message.data.tripId}`);
    console.log(`   Fare: ₹${message.data.fare}`);
    console.log(`   Image: ${fullImageUrl || 'none'}`);
    console.log('═'.repeat(70));
    console.log('');

    const response = await admin.messaging().send(message);
    console.log(`✅ FCM sent successfully: ${response}`);
    
    return { success: true, messageId: response };

  } catch (error) {
    console.error(`❌ FCM SEND FAILED: ${error.message}`);
    
    // Handle invalid tokens
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      
      try {
        await User.updateOne(
          { fcmToken: fcmToken },
          { $unset: { fcmToken: "" } }
        );
        console.log(`✅ Invalid token removed from database`);
      } catch (dbError) {
        console.log(`⚠️ Could not remove token: ${dbError.message}`);
      }
      
      return { 
        success: false, 
        error: 'Token expired/invalid',
        tokenRemoved: true
      };
    }

    return { success: false, error: error.message };
  }
};

/**
 * ✅ Send notification to customer WITH IMAGE SUPPORT
 */
export const sendToCustomer = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) return { success: false, error: 'No FCM token' };

  try {
    // ✅ Get full image URL if provided
    const fullImageUrl = getFullImageUrl(data.imageUrl);

    console.log(`📤 Sending FCM to Customer:`);
    console.log(`   Title: ${title}`);
    console.log(`   Body: ${body}`);
    console.log(`   Image: ${fullImageUrl || 'none'}`);

    const message = {
      token: fcmToken,
      
      // ✅ NOTIFICATION with image
      notification: { 
        title, 
        body,
        ...(fullImageUrl && { imageUrl: fullImageUrl }),  // ✅ Add image
      },
      
      // ✅ DATA with image
      data: { 
        type: data.type || 'customer',
        imageUrl: fullImageUrl || '',  // ✅ Include image in data
        ...Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
      },
      
      // ✅ ANDROID config with image
      android: { 
        priority: 'high',
        notification: {
          channelId: 'high_importance_channel',
          priority: 'high',
          sound: 'default',
          ...(fullImageUrl && { imageUrl: fullImageUrl }),  // ✅ Android image
        }
      },
      
      // ✅ iOS config with image
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
            'mutable-content': 1,  // ✅ Required for iOS images
          }
        },
        fcm_options: {
          ...(fullImageUrl && { image: fullImageUrl }),  // ✅ iOS image
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log(`✅ Customer FCM Success: ${response}`);
    return { success: true, messageId: response };
    
  } catch (error) {
    console.error('❌ Customer FCM Error:', error.message);
    
    // Remove invalid token
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      await User.updateOne({ fcmToken }, { $unset: { fcmToken: "" } });
    }
    
    return { success: false, error: error.message };
  }
};

export default { sendToDriver, sendToCustomer };