// services/SessionManager.js
import admin from 'firebase-admin';
import User from '../models/User.js';

class SessionManager {
  /**
   * 🔐 Handle user login - check for existing sessions and force logout if needed
   * 🔥 ROLE-BASED SESSION CONTROL: Only force logout for same role
   * @param {String} phone - User's phone number
   * @param {String} deviceId - Unique device identifier
   * @param {String} fcmToken - Firebase Cloud Messaging token
   * @param {Object} io - Socket.io instance
   * @param {String} role - User role ("customer" or "driver") - defaults to "customer"
   * @param {String} ipAddress - User's IP address (optional)
   * @param {String} userAgent - User's browser/app agent (optional)
   * @returns {Object} - Session info and logout status
   */
  static async handleLogin(phone, deviceId, fcmToken, io = null, role = "customer", ipAddress = null, userAgent = null) {
    try {
      // 🔥 ROLE-BASED SESSION CONTROL: Default to customer if role not specified
      const loginRole = role || "customer";
      
      console.log(`🔐 Session Manager: Handling login for ${phone} as ${loginRole} on device ${deviceId}`);
      
      // Find user by phone
      const user = await User.findOne({ phone });
      
      if (!user) {
        console.log(`⚠️ User not found: ${phone}`);
        return {
          success: false,
          error: 'User not found',
        };
      }

      // 🔥 ROLE-BASED SESSION CONTROL: Check for existing session for SAME ROLE ONLY
      const existingSession = user.sessionsByRole?.[loginRole];
      const hasActiveSessionSameRole = existingSession?.isActive && existingSession?.deviceId && existingSession?.deviceId !== deviceId;
      
      let forcedLogout = false;
      let oldDeviceId = null;
      let oldFcmToken = null;

      if (hasActiveSessionSameRole) {
        console.log(`⚠️ User ${phone} (${loginRole}) has active session on device ${existingSession.deviceId}`);
        console.log(`🔄 Forcing logout on old device (SAME ROLE ONLY)...`);
        
        oldDeviceId = existingSession.deviceId;
        oldFcmToken = existingSession.fcmToken;
        forcedLogout = true;

        // 🔥 Archive old session with ROLE information
        user.previousSessions.push({
          deviceId: oldDeviceId,
          fcmToken: oldFcmToken,
          loginAt: existingSession.loginAt,
          logoutAt: new Date(),
          reason: 'force_logout',
          role: loginRole,
          ipAddress: ipAddress || 'unknown',
          userAgent: userAgent || 'unknown',
        });

        // 🔥 CRITICAL: Send force logout via BOTH FCM and Socket.io for reliability
        // IMPORTANT: Only notify the OLD device, not other roles
        
        // 1️⃣ Send FCM notification (works even if app is closed)
        if (oldFcmToken) {
          await this.sendForceLogoutNotification(oldFcmToken, phone, loginRole, deviceId);
        }

        // 2️⃣ Send Socket.io event ONLY to this role
        if (io) {
          // 🔥 Send to role-specific room to ensure other roles aren't affected
          io.to(`user:${phone}:${loginRole}`).emit('force_logout', {
            type: 'force_logout',
            role: loginRole,
            reason: 'multi_device_login',
            message: `Your ${loginRole} account has been logged in on another device`,
            newDeviceId: deviceId,
            oldDeviceId: oldDeviceId,
            timestamp: new Date().toISOString(),
          });
          
          console.log(`📡 Sent force_logout socket event to room: user:${phone}:${loginRole}`);
        }
      } else {
        console.log(`✅ No active session for ${phone} (${loginRole}) or same deviceId`);
      }

      // 🆕 Deduplicate: Unset this token from any other users first
      if (fcmToken) {
        await User.updateMany(
          { 
            _id: { $ne: user._id }, 
            $or: [{ fcmToken: fcmToken }, { 'currentFcmToken': fcmToken } ] 
          },
          { 
            $unset: { fcmToken: "", currentFcmToken: "" },
            // 🔥 Also unset from sessionsByRole[role].fcmToken if it matches
          }
        );
      }

      // 🔥 ROLE-BASED SESSION CONTROL: Update ONLY for the current role
      if (!user.sessionsByRole) {
        user.sessionsByRole = {
          customer: { deviceId: null, socketId: null, fcmToken: null, loginAt: null, isActive: false },
          driver: { deviceId: null, socketId: null, fcmToken: null, loginAt: null, isActive: false }
        };
      }

      // 🔥 Update the role-specific session
      user.sessionsByRole[loginRole] = {
        deviceId: deviceId,
        fcmToken: fcmToken,
        loginAt: new Date(),
        isActive: true
      };

      // 🔥 Keep backward compatibility: Update legacy fields only for primary role
      if (!user.role || user.role === loginRole) {
        user.currentDeviceId = deviceId;
        user.currentFcmToken = fcmToken;
        user.lastLoginAt = new Date();
        user.sessionActive = true;
      }

      // 🧹 Clean old sessions (keep last 10)
      if (user.previousSessions.length > 10) {
        user.previousSessions = user.previousSessions.slice(-10);
      }

      await user.save();

      console.log(`✅ Session updated for ${phone} (${loginRole}) on device ${deviceId}`);
      console.log(`📊 Active sessions: customer=${user.sessionsByRole?.customer?.isActive ? 'YES' : 'NO'}, driver=${user.sessionsByRole?.driver?.isActive ? 'YES' : 'NO'}`);

      return {
        success: true,
        forcedLogout,
        oldDeviceId,
        role: loginRole,
        sessionInfo: {
          deviceId: user.sessionsByRole[loginRole].deviceId,
          loginAt: user.sessionsByRole[loginRole].loginAt,
          active: user.sessionsByRole[loginRole].isActive,
          role: loginRole,
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
   * 🔥 ROLE-BASED SESSION CONTROL: Include role in notification
   * @param {String} fcmToken - Firebase Cloud Messaging token
   * @param {String} phone - User's phone number (for logging)
   * @param {String} role - User role (for logging)
   * @param {String} newDeviceId - New device ID that caused the logout
   */
  static async sendForceLogoutNotification(fcmToken, phone, role = "customer", newDeviceId = null) {
    try {
      console.log(`📤 Sending force logout notification to ${phone} (${role})`);

      const message = {
        token: fcmToken,
        notification: {
          title: 'Account Login Detected',
          body: `Your ${role} account was logged in on another device. You've been logged out for security.`,
        },
        data: {
          type: 'force_logout',
          role: role,
          reason: 'multi_device_login',
          message: `Your ${role} account was logged in on another device`,
          timestamp: new Date().toISOString(),
          ...(newDeviceId && { newDeviceId }),
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
   * 🔥 ROLE-BASED SESSION CONTROL: Logout only for specified role
   * @param {String} phone - User's phone number
   * @param {String} reason - Logout reason
   * @param {String} role - User role to logout ("customer" or "driver") - defaults to "customer"
   */
  static async handleLogout(phone, reason = 'user_logout', role = "customer") {
    try {
      const logoutRole = role || "customer";
      console.log(`👋 Handling logout for ${phone} (${logoutRole}), reason: ${reason}`);

      const user = await User.findOne({ phone });
      
      if (!user) {
        console.log(`⚠️ User not found during logout: ${phone}`);
        return { success: false, error: 'User not found' };
      }

      // 🔥 ROLE-BASED SESSION CONTROL: Archive and clear ONLY for the specified role
      const roleSession = user.sessionsByRole?.[logoutRole];
      if (roleSession && roleSession.deviceId) {
        user.previousSessions.push({
          deviceId: roleSession.deviceId,
          fcmToken: roleSession.fcmToken,
          loginAt: roleSession.loginAt,
          logoutAt: new Date(),
          reason,
          role: logoutRole,
        });
      }

      // 🔥 Clear session for this role only
      if (!user.sessionsByRole) {
        user.sessionsByRole = {
          customer: { deviceId: null, socketId: null, fcmToken: null, loginAt: null, isActive: false },
          driver: { deviceId: null, socketId: null, fcmToken: null, loginAt: null, isActive: false }
        };
      }

      user.sessionsByRole[logoutRole] = {
        deviceId: null,
        socketId: null,
        fcmToken: null,
        loginAt: null,
        isActive: false
      };

      // 🔥 Keep backward compatibility: Only update legacy fields if this is the primary role
      if (!user.role || user.role === logoutRole) {
        user.currentDeviceId = null;
        user.currentFcmToken = null;
        user.sessionActive = false;
      }

      await user.save();

      console.log(`✅ User ${phone} (${logoutRole}) logged out successfully`);
      console.log(`📊 Active sessions: customer=${user.sessionsByRole?.customer?.isActive ? 'YES' : 'NO'}, driver=${user.sessionsByRole?.driver?.isActive ? 'YES' : 'NO'}`);

      return { success: true, role: logoutRole };
    } catch (error) {
      console.error('❌ SessionManager.handleLogout error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 🔍 Check if user has active session
   * 🔥 ROLE-BASED SESSION CONTROL: Check status per role
   * @param {String} phone - User's phone number
   * @param {String} role - User role to check ("customer" or "driver")
   * @returns {Object} - Session status
   */
  static async getSessionStatus(phone, role = "customer") {
    try {
      const checkRole = role || "customer";
      const user = await User.findOne({ phone });
      
      if (!user) {
        return { active: false, error: 'User not found' };
      }

      // 🔥 ROLE-BASED SESSION CONTROL: Return status for specific role
      const roleSession = user.sessionsByRole?.[checkRole];
      return {
        active: roleSession?.isActive || false,
        deviceId: roleSession?.deviceId || null,
        loginAt: roleSession?.loginAt || null,
        role: checkRole,
      };
    } catch (error) {
      console.error('❌ SessionManager.getSessionStatus error:', error);
      return { active: false, error: error.message };
    }
  }

  /**
   * 🔄 Refresh FCM token for existing session
   * 🔥 ROLE-BASED SESSION CONTROL: Refresh token for specific role
   * @param {String} phone - User's phone number
   * @param {String} newFcmToken - New FCM token
   * @param {String} role - User role ("customer" or "driver")
   */
  static async refreshFcmToken(phone, newFcmToken, role = "customer") {
    try {
      const refreshRole = role || "customer";
      const user = await User.findOne({ phone });
      
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      // 🆕 Deduplicate FCM token
      await User.updateMany(
        { 
          _id: { $ne: user._id }, 
          $or: [{ fcmToken: newFcmToken }, { currentFcmToken: newFcmToken } ] 
        },
        { $unset: { fcmToken: "", currentFcmToken: "" } }
      );

      // 🔥 ROLE-BASED SESSION CONTROL: Update FCM token for specific role
      if (!user.sessionsByRole) {
        user.sessionsByRole = {
          customer: { deviceId: null, socketId: null, fcmToken: null, loginAt: null, isActive: false },
          driver: { deviceId: null, socketId: null, fcmToken: null, loginAt: null, isActive: false }
        };
      }

      user.sessionsByRole[refreshRole].fcmToken = newFcmToken;

      // 🔥 Keep backward compatibility
      if (!user.role || user.role === refreshRole) {
        user.currentFcmToken = newFcmToken;
        user.fcmToken = newFcmToken;
      }

      await user.save();

      console.log(`✅ FCM token refreshed for ${phone} (${refreshRole})`);

      return { success: true, role: refreshRole };
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