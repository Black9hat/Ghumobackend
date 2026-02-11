// src/utils/fcmSender.js

import admin from 'firebase-admin';
import User from '../models/User.js';

/**
 * ✅ Get full absolute image URL for Railway deployment
 */
const getFullImageUrl = (url) => {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  
  // Railway uses RAILWAY_PUBLIC_DOMAIN or you can use BACKEND_URL
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.BACKEND_URL || "https://api.example.com";
  
  // Ensure proper URL construction
  const cleanUrl = url.startsWith("/") ? url : `/${url}`;
  const fullUrl = `${baseUrl}${cleanUrl}`;
  
  console.log(`🖼️ Image URL: ${url} → ${fullUrl}`);
  return fullUrl;
};

/**
 * ✅ Send FCM notification to driver (WORKS WHEN APP IS KILLED)
 */
export const sendToDriver = async (fcmToken, dataPayload = {}) => {
  if (!fcmToken) {
    console.error('❌ No FCM token provided');
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
        
        // ✅ Image URL if provided (MUST be full URL)
        imageUrl: fullImageUrl || '',
      },

      android: {
        priority: 'high',
      },

      apns: {
        headers: {
          'apns-priority': '10',
        },
        payload: {
          aps: {
            'content-available': 1,
          }
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
    console.error('═'.repeat(70));
    console.error(`❌ FCM SEND FAILED`);
    console.error('═'.repeat(70));
    console.error(`   Error: ${error.message}`);
    console.error(`   Code: ${error.code}`);
    console.error(`   Token: ${fcmToken.substring(0, 20)}...`);
    console.error('═'.repeat(70));
    
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
 * ✅ Send notification to customer WITH FULL IMAGE SUPPORT
 */
export const sendToCustomer = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) {
    console.error('❌ No FCM token provided');
    return { success: false, error: 'No FCM token' };
  }

  try {
    // ✅ Get full absolute image URL
    const fullImageUrl = getFullImageUrl(data.imageUrl);

    console.log('');
    console.log('═'.repeat(70));
    console.log('📤 SENDING FCM TO CUSTOMER');
    console.log('═'.repeat(70));
    console.log(`   Title: ${title}`);
    console.log(`   Body: ${body}`);
    console.log(`   Image URL: ${fullImageUrl || 'none'}`);
    console.log(`   Token: ${fcmToken.substring(0, 20)}...`);
    console.log('═'.repeat(70));
    console.log('');

    const message = {
      token: fcmToken,
      
      // ✅ NOTIFICATION payload with image
      notification: { 
        title, 
        body,
        // ⚠️ imageUrl at root notification level (FCM spec)
        ...(fullImageUrl && { imageUrl: fullImageUrl }),
      },
      
      // ✅ DATA payload - all values must be strings
      data: { 
        type: String(data.type || 'customer'),
        imageUrl: String(fullImageUrl || ''),
        tripId: String(data.tripId || ''),
        timestamp: new Date().toISOString(),
        // Include any other data as strings
        ...Object.fromEntries(
          Object.entries(data)
            .filter(([k]) => k !== 'imageUrl' && k !== 'type' && k !== 'tripId')
            .map(([k, v]) => [k, String(v)])
        ),
      },
      
      // ✅ ANDROID specific config
      android: { 
        priority: 'high',
        notification: {
          channelId: 'high_importance_channel', // MUST match Flutter app
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
          defaultLightSettings: true,
          // ⚠️ Android image at this level
          ...(fullImageUrl && { imageUrl: fullImageUrl }),
        }
      },
      
      // ✅ iOS specific config
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            alert: { 
              title, 
              body 
            },
            sound: 'default',
            badge: 1,
            'mutable-content': 1,  // Required for rich notifications
            'content-available': 1,
          }
        },
        // ⚠️ iOS image in fcm_options
        fcm_options: {
          ...(fullImageUrl && { image: fullImageUrl }),
        },
      },
    };

    console.log('📦 Final FCM Message:');
    console.log(JSON.stringify(message, null, 2));

    const response = await admin.messaging().send(message);
    
    console.log('');
    console.log('═'.repeat(70));
    console.log('✅ CUSTOMER FCM SENT SUCCESSFULLY');
    console.log('═'.repeat(70));
    console.log(`   Message ID: ${response}`);
    console.log('═'.repeat(70));
    console.log('');
    
    return { success: true, messageId: response };
    
  } catch (error) {
    console.error('');
    console.error('═'.repeat(70));
    console.error('❌ CUSTOMER FCM FAILED');
    console.error('═'.repeat(70));
    console.error(`   Error: ${error.message}`);
    console.error(`   Code: ${error.code}`);
    console.error(`   Token: ${fcmToken.substring(0, 20)}...`);
    
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split('\n')[0]}`);
    }
    console.error('═'.repeat(70));
    console.error('');
    
    // Remove invalid token from database
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
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
