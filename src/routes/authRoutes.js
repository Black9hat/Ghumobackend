// src/routes/authRoutes.js
import express from 'express';
import User from '../models/User.js';
import SessionManager from '../services/SessionManager.js';
import crypto from 'crypto';

const router = express.Router();

/* ================================
   🔐 FIREBASE SYNC ENDPOINT
   WITH SESSION MANAGEMENT
================================= */
router.post('/firebase-sync', async (req, res) => {
  try {
    const { phone, firebaseUid, role, fcmToken, deviceInfo } = req.body;

    console.log(`📱 Firebase sync request for ${phone}`);

    // Validation
    if (!phone || !firebaseUid) {
      return res.status(400).json({
        success: false,
        error: 'Phone and Firebase UID are required',
      });
    }

    // 🔑 Generate device ID (unique per device)
    // Use deviceInfo if provided, otherwise generate from FCM token
    let deviceId;
    if (deviceInfo?.deviceId) {
      deviceId = deviceInfo.deviceId;
    } else if (fcmToken) {
      // Create deterministic device ID from FCM token
      deviceId = crypto
        .createHash('sha256')
        .update(fcmToken)
        .digest('hex')
        .substring(0, 16);
    } else {
      // Fallback: generate random device ID
      deviceId = crypto.randomBytes(8).toString('hex');
    }

    console.log(`🔑 Device ID: ${deviceId}`);

    // Get IP address and user agent
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Find or create user
    let user = await User.findOne({ phone });

    if (!user) {
      // Create new user
      console.log(`✨ Creating new user: ${phone}`);

      user = new User({
        phone,
        name: phone, // Default name, should be updated later
        firebaseUid,
        role: role || 'customer',
        isDriver: role === 'driver',
        location: {
          type: 'Point',
          coordinates: [0, 0], // Default coordinates
        },
        currentDeviceId: deviceId,
        currentFcmToken: fcmToken,
        lastLoginAt: new Date(),
        sessionActive: true,
      });

      await user.save();

      console.log(`✅ New user created: ${user._id}`);

      return res.json({
        success: true,
        user: {
          _id: user._id,
          phone: user.phone,
          name: user.name,
          email: user.email,
          role: user.role,
          profileComplete: false,
        },
        customerId: user._id.toString(),
        profileComplete: false,
        isNewUser: true,
        sessionInfo: {
          deviceId,
          loginAt: user.lastLoginAt,
        },
      });
    }

    // 🔐 EXISTING USER - HANDLE SESSION MANAGEMENT
    console.log(`👤 Existing user found: ${user._id}`);

    // Update Firebase UID if changed
    if (user.firebaseUid !== firebaseUid) {
      user.firebaseUid = firebaseUid;
      await user.save();
    }

    // 🚨 CHECK FOR MULTI-DEVICE LOGIN
    const sessionResult = await SessionManager.handleLogin(
      phone,
      deviceId,
      fcmToken || user.currentFcmToken || '',
      req.io, // Socket.io instance (attached by middleware)
      ipAddress,
      userAgent
    );

    if (!sessionResult.success) {
      console.error(`❌ Session management failed:`, sessionResult.error);
      // Continue with login even if session management fails
    }

    if (sessionResult.forcedLogout) {
      console.log(`⚠️ Forced logout on device ${sessionResult.oldDeviceId}`);
    }

    // 🔥 FIX: Correct profile completion check
    // Profile is complete if user has set name (different from phone) and gender
    const profileComplete = !!(
      user.name && 
      user.name !== user.phone && 
      user.gender
    );

    console.log(`🔍 Profile completion check for ${phone}:`);
    console.log(`   Name: ${user.name}`);
    console.log(`   Gender: ${user.gender}`);
    console.log(`   Profile Complete: ${profileComplete}`);

    // Return user data
    res.json({
      success: true,
      user: {
        _id: user._id,
        phone: user.phone,
        name: user.name,
        email: user.email,
        gender: user.gender,
        role: user.role,
        isDriver: user.isDriver,
        profileComplete,
      },
      customerId: user._id.toString(),
      profileComplete, // 🔥 CRITICAL: This is what Flutter app checks!
      isNewUser: false,
      sessionInfo: {
        deviceId,
        loginAt: user.lastLoginAt,
        forcedLogout: sessionResult.forcedLogout,
        oldDeviceId: sessionResult.oldDeviceId,
      },
    });
  } catch (error) {
    console.error('❌ Firebase sync error:', error);
    res.status(500).json({
      success: false,
      error: 'Firebase sync failed',
      message: error.message,
    });
  }
});

/* ================================
   👋 LOGOUT ENDPOINT
================================= */
router.post('/logout', async (req, res) => {
  try {
    const { phone, reason } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number required',
      });
    }

    const result = await SessionManager.handleLogout(phone, reason || 'user_logout');

    if (result.success) {
      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error('❌ Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed',
    });
  }
});

/* ================================
   🔄 REFRESH FCM TOKEN ENDPOINT
================================= */
router.post('/refresh-fcm-token', async (req, res) => {
  try {
    const { phone, fcmToken } = req.body;

    if (!phone || !fcmToken) {
      return res.status(400).json({
        success: false,
        error: 'Phone and FCM token required',
      });
    }

    const result = await SessionManager.refreshFcmToken(phone, fcmToken);

    res.json(result);
  } catch (error) {
    console.error('❌ FCM token refresh error:', error);
    res.status(500).json({
      success: false,
      error: 'Token refresh failed',
    });
  }
});

/* ================================
   🔍 CHECK SESSION STATUS ENDPOINT
================================= */
router.get('/session-status/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    const status = await SessionManager.getSessionStatus(phone);

    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error('❌ Session status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get session status',
    });
  }
});

/* ================================
   📊 GET SESSION HISTORY
================================= */
router.get('/session-history/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { limit = 10 } = req.query;

    const user = await User.findOne({ phone }).select('previousSessions');

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Get latest sessions
    const sessions = user.previousSessions
      .sort((a, b) => b.loginAt - a.loginAt)
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      sessions,
      total: user.previousSessions.length,
    });
  } catch (error) {
    console.error('❌ Session history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get session history',
    });
  }
});

/* ================================
   🧹 CLEAN OLD SESSIONS
================================= */
router.post('/clean-sessions/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    const user = await User.findOne({ phone });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const beforeCount = user.previousSessions.length;
    user.cleanOldSessions();
    await user.save();
    const afterCount = user.previousSessions.length;

    res.json({
      success: true,
      message: 'Old sessions cleaned',
      removed: beforeCount - afterCount,
      remaining: afterCount,
    });
  } catch (error) {
    console.error('❌ Clean sessions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clean sessions',
    });
  }
});

export default router;