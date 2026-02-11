// services/SessionManager.js
import admin from 'firebase-admin';
import User from '../models/User.js';

class SessionManager {
  /**
   * 🔐 Handle user login - check for existing sessions and force logout if needed
   * @param {String} phone - User's phone number
   * @param {String} deviceId - Unique device identifier
   * @param {String} fcmToken - Firebase Cloud Messaging token
   * @param {Object} io - Socket.io instance
   * @param {String} ipAddress - User's IP address (optional)
   * @param {String} userAgent - User's browser/app agent (optional)
   * @returns {Object} - Session info and logout status
   */
  static async handleLogin(phone, deviceId, fcmToken, io = null, ipAddress = null, userAgent = null) {
    try {
      console.log(`🔐 Session Manager: Handling login for ${phone} on device ${deviceId}`);
      
      // Find user by phone
      const user = await User.findOne({ phone });
      
      if (!user) {
        console.log(`⚠️ User not found: ${phone}`);
        return {
          success: false,
          error: 'User not found',
        };
      }

      // Check if user is already logged in on a DIFFERENT device
      const hasActiveSession = user.sessionActive && user.currentDeviceId && user.currentDeviceId !== deviceId;
      
      let forcedLogout = false;
      let oldDeviceId = null;
      let oldFcmToken = null;

      if (hasActiveSession) {
        console.log(`⚠️ User ${phone} has active session on device ${user.currentDeviceId}`);
        console.log(`🔄 Forcing logout on old device...`);
        
        oldDeviceId = user.currentDeviceId;
        oldFcmToken = user.currentFcmToken;
        forcedLogout = true;

        // 🔥 Archive old session
        user.previousSessions.push({
          deviceId: oldDeviceId,
          fcmToken: oldFcmToken,
          loginAt: user.lastLoginAt,
          logoutAt: new Date(),
          reason: 'force_logout',
          ipAddress: ipAddress || 'unknown',
          userAgent: userAgent || 'unknown',
        });

        // 🔥 CRITICAL: Send force logout via BOTH FCM and Socket.io for reliability
        
        // 1️⃣ Send FCM notification (works even if app is closed)
        if (oldFcmToken) {
          await this.sendForceLogoutNotification(oldFcmToken, phone);
        }

        // 2️⃣ Send Socket.io event (works if app is open)
        if (io) {
          // Send to the user's room
          io.to(`user:${phone}`).emit('force_logout', {
            reason: 'multi_device_login',
            message: 'Your account has been logged in on another device',
            newDeviceId: deviceId,
            timestamp: new Date().toISOString(),
          });
          
          console.log(`📡 Sent force_logout socket event to room: user:${phone}`);
        }
      }

      // 🆕 Update user's session info
      user.currentDeviceId = deviceId;
      user.currentFcmToken = fcmToken;
      user.lastLoginAt = new Date();
      user.sessionActive = true;

      // 🧹 Clean old sessions (keep last 10)
      if (user.previousSessions.length > 10) {
        user.previousSessions = user.previousSessions.slice(-10);
      }

      await user.save();

      console.log(`✅ Session updated for ${phone} on device ${deviceId}`);

      return {
        success: true,
        forcedLogout,
        oldDeviceId,
        sessionInfo: {
          deviceId: user.currentDeviceId,
          loginAt: user.lastLoginAt,
          active: user.sessionActive,
        },
      };
    } catch (error) {
      console.error('❌ SessionManager.handleLogin error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 🔔 Send force logout push notification via FCM
   * @param {String} fcmToken - Firebase Cloud Messaging token
   * @param {String} phone - User's phone number (for logging)
   */
  static async sendForceLogoutNotification(fcmToken, phone) {
    try {
      console.log(`📤 Sending force logout notification to ${phone}`);

      const message = {
        token: fcmToken,
        notification: {
          title: 'Account Login Detected',
          body: 'Your account was logged in on another device. You\'ve been logged out for security.',
        },
        data: {
          type: 'force_logout',
          reason: 'multi_device_login',
          message: 'Your account was logged in on another device',
          timestamp: new Date().toISOString(),
        },
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'high_importance_channel',
            priority: 'high',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              contentAvailable: true,
            },
          },
        },
      };

      const response = await admin.messaging().send(message);
      console.log(`✅ Force logout notification sent successfully:`, response);
      
      return { success: true, response };
    } catch (error) {
      console.error('❌ Error sending force logout notification:', error);
      
      // Don't throw - logout should still work even if notification fails
      return { success: false, error: error.message };
    }
  }

  /**
   * 👋 Handle user logout
   * @param {String} phone - User's phone number
   * @param {String} reason - Logout reason
   */
  static async handleLogout(phone, reason = 'user_logout') {
    try {
      console.log(`👋 Handling logout for ${phone}, reason: ${reason}`);

      const user = await User.findOne({ phone });
      
      if (!user) {
        console.log(`⚠️ User not found during logout: ${phone}`);
        return { success: false, error: 'User not found' };
      }

      // Archive current session
      if (user.currentDeviceId) {
        user.previousSessions.push({
          deviceId: user.currentDeviceId,
          fcmToken: user.currentFcmToken,
          loginAt: user.lastLoginAt,
          logoutAt: new Date(),
          reason,
        });
      }

      // Clear session
      user.currentDeviceId = null;
      user.currentFcmToken = null;
      user.sessionActive = false;

      await user.save();

      console.log(`✅ User ${phone} logged out successfully`);

      return { success: true };
    } catch (error) {
      console.error('❌ SessionManager.handleLogout error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 🔍 Check if user has active session
   * @param {String} phone - User's phone number
   * @returns {Object} - Session status
   */
  static async getSessionStatus(phone) {
    try {
      const user = await User.findOne({ phone });
      
      if (!user) {
        return { active: false, error: 'User not found' };
      }

      return {
        active: user.sessionActive,
        deviceId: user.currentDeviceId,
        lastLoginAt: user.lastLoginAt,
      };
    } catch (error) {
      console.error('❌ SessionManager.getSessionStatus error:', error);
      return { active: false, error: error.message };
    }
  }

  /**
   * 🔄 Refresh FCM token for existing session
   * @param {String} phone - User's phone number
   * @param {String} newFcmToken - New FCM token
   */
  static async refreshFcmToken(phone, newFcmToken) {
    try {
      const user = await User.findOne({ phone });
      
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      user.currentFcmToken = newFcmToken;
      await user.save();

      console.log(`✅ FCM token refreshed for ${phone}`);

      return { success: true };
    } catch (error) {
      console.error('❌ SessionManager.refreshFcmToken error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 🧹 Clean expired sessions (run as cron job)
   * Removes session data for users who haven't logged in for 30+ days
   */
  static async cleanExpiredSessions() {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const result = await User.updateMany(
        {
          sessionActive: true,
          lastLoginAt: { $lt: thirtyDaysAgo },
        },
        {
          $set: {
            sessionActive: false,
            currentDeviceId: null,
            currentFcmToken: null,
          },
        }
      );

      console.log(`🧹 Cleaned ${result.modifiedCount} expired sessions`);

      return { success: true, count: result.modifiedCount };
    } catch (error) {
      console.error('❌ SessionManager.cleanExpiredSessions error:', error);
      return { success: false, error: error.message };
    }
  }
}

export default SessionManager;