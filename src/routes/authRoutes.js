// src/routes/authRoutes.js
import express        from 'express';
import User           from '../models/User.js';
import SessionManager from '../services/SessionManager.js';
import crypto         from 'crypto';
import {
  assignWelcomeCoupon,
  ensureReferralCode,
  recordReferralSignup,
} from '../services/rewardService.js';

const router = express.Router();

/* ================================
   🔐 FIREBASE SYNC ENDPOINT
   WITH SESSION MANAGEMENT + REFERRAL
================================= */
router.post('/firebase-sync', async (req, res) => {
  try {
    const { phone, firebaseUid, role, fcmToken, deviceInfo } = req.body;

    const referralCode = (() => {
      const raw =
        req.body?.referralCode ??
        req.body?.referral_code ??
        req.body?.ref ??
        req.body?.referredBy ??
        req.body?.referred_by ??
        '';

      const value = String(raw || '').trim();
      if (!value) return null;

      try {
        return decodeURIComponent(value).trim().toUpperCase() || null;
      } catch (_) {
        return value.toUpperCase();
      }
    })();

    console.log(`📱 Firebase sync: ${phone} | referralCode: ${referralCode || 'none'}`);

    if (!phone || !firebaseUid) {
      return res.status(400).json({
        success: false,
        error: 'Phone and Firebase UID are required',
      });
    }

    // ── Device ID ─────────────────────────────────────────────────────────────
    let deviceId;
    if (deviceInfo?.deviceId) {
      deviceId = deviceInfo.deviceId;
    } else if (fcmToken) {
      deviceId = crypto.createHash('sha256').update(fcmToken).digest('hex').substring(0, 16);
    } else {
      deviceId = crypto.randomBytes(8).toString('hex');
    }

    console.log(`🔑 Device ID: ${deviceId}`);

    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';

    // ── Normalize phone (strip +91 prefix) ───────────────────────────────────
    const phoneKey = phone.replace(/^\+91/, '').replace(/^91/, '');

    let user = await User.findOne({ phone: phoneKey });

    // ── NEW USER ──────────────────────────────────────────────────────────────
    if (!user) {
      console.log(`✨ Creating new user: ${phoneKey}`);

      user = new User({
        phone:           phoneKey,
        name:            'New User',
        firebaseUid,
        role:            role || 'customer',
        isDriver:        role === 'driver',
        location: {
          type:        'Point',
          coordinates: [78.4867, 17.385],
        },
        currentDeviceId: deviceId,
        currentFcmToken: fcmToken,
        lastLoginAt:     new Date(),
        sessionActive:   true,
      });

      await user.save();
      console.log(`✅ New user created: ${user._id}`);

      // ── Post-registration rewards (role-specific, non-blocking) ───────────
      if (user.role === 'customer' || user.role === 'driver') {

        // 1. Generate referral code
        ensureReferralCode(user._id, user.role).catch((e) =>
          console.warn('⚠️ Referral code gen failed:', e.message)
        );

        // 2. Assign welcome coupon
        assignWelcomeCoupon(user._id).catch((e) =>
          console.warn('⚠️ Welcome coupon failed:', e.message)
        );

        // 3. ✅ Record referral if code provided
        if (referralCode && referralCode.trim().length >= 4) {
          console.log(`🎯 New user referral attempt: ${referralCode.trim()} → ${user._id}`);
          recordReferralSignup(user._id, referralCode.trim(), user.role)
            .then(async (result) => {
              if (result.success) {
                console.log(`✅ Referral recorded: ${referralCode} → ${user._id}`);
                // Store referrer name and phone with new user
                await User.findByIdAndUpdate(user._id, {
                  referrerName: result.referrerName || 'Driver',
                  referrerPhone: result.referrerPhone,
                });
              } else {
                console.warn(`⚠️ Referral not recorded: ${result.message}`);
              }
            })
            .catch((e) => console.warn('⚠️ Referral signup failed:', e.message));
        } else {
          console.log(`ℹ️ No referral code for new user ${user._id}`);
        }
      }

      return res.json({
        success:         true,
        message:         'Registration successful',
        newUser:         true,
        customerId:      user._id.toString(),
        userId:          user._id.toString(),
        profileComplete: false,
        user: {
          _id:                   user._id,
          phone:                 user.phone,
          name:                  user.name,
          role:                  user.role,
          isDriver:              user.isDriver,
          vehicleType:           user.vehicleType || null,
          documentStatus:        user.documentStatus,
          referralCode:          user.referralCode || null,
          driverReferralCode:    user.driverReferralCode || null,
          coins:                 user.coins || 0,
          welcomeCouponAssigned: user.welcomeCouponAssigned || false,
                  referrerName:          user.referrerName || null,
                  referrerPhone:         user.referrerPhone || null,
        },
        sessionInfo: { deviceId, loginAt: user.lastLoginAt },
      });
    }

    // ── EXISTING USER ─────────────────────────────────────────────────────────
    console.log(`👤 Existing user: ${user._id} | referredBy: ${user.referredBy || 'none'}`);

    if (user.firebaseUid !== firebaseUid) {
      user.firebaseUid = firebaseUid;
    }

    // 🔥 Ensure role consistency for existing users logging into driver app.
    // Without this, stale role='customer' can push approved drivers back
    // into onboarding after logout/login.
    const requestedRole = (role === 'driver' || role === 'customer')
      ? role
      : (user.isDriver ? 'driver' : 'customer');

    if (requestedRole === 'driver') {
      if (user.role !== 'driver') {
        console.log(`🔧 Promoting existing user role to driver: ${user._id}`);
        user.role = 'driver';
      }

      if (user.isDriver !== true) {
        console.log(`🔧 Marking existing user as isDriver=true: ${user._id}`);
        user.isDriver = true;
      }
    }

    await user.save();

    // ── Session management ────────────────────────────────────────────────────
    const sessionResult = await SessionManager.handleLogin(
      phoneKey,
      deviceId,
      fcmToken || user.currentFcmToken || '',
      req.io,
      requestedRole,
      ipAddress,
      userAgent
    ).catch((e) => {
      console.error('❌ Session management failed:', e.message);
      return { success: false };
    });

    if (sessionResult?.forcedLogout) {
      console.log(`⚠️ Forced logout on device ${sessionResult.oldDeviceId}`);
    }

    // ── Late referral: user reinstalled with referral link but not yet referred ─
    if (
      referralCode &&
      referralCode.trim().length >= 4 &&
      (user.role === 'customer' || user.role === 'driver') &&
      !user.referredBy &&
      !user.driverReferredBy
    ) {
      console.log(`🎯 Late referral attempt: ${referralCode.trim()} → ${user._id}`);
      recordReferralSignup(user._id, referralCode.trim(), user.role)
        .then((r) => {
          if (r.success) {
            console.log(`✅ Late referral recorded: ${referralCode} → ${user._id}`);
          } else {
            console.warn(`⚠️ Late referral not recorded: ${r.message}`);
          }
        })
        .catch((e) => console.warn('⚠️ Late referral error:', e.message));
    } else if ((user.role === 'customer' || user.role === 'driver') && !user.referredBy && !user.driverReferredBy && (!referralCode || referralCode.trim().length < 4)) {
      console.log(`ℹ️ Late referral skipped: no referralCode in request for ${user._id}`);
    }

    // ── Lazy referral code ────────────────────────────────────────────────────
    if (user.role === 'customer' && !user.referralCode) {
      ensureReferralCode(user._id, 'customer').catch(() => {});
    }

    if (user.role === 'driver' && !user.driverReferralCode) {
      ensureReferralCode(user._id, 'driver').catch(() => {});
    }

    // ── Profile completion ────────────────────────────────────────────────────
    const profileComplete = !!(
      user.name &&
      user.name !== 'New User' &&
      user.name !== user.phone &&
      user.gender
    );

    return res.json({
      success:         true,
      message:         'Login successful',
      newUser:         false,
      customerId:      user._id.toString(),
      userId:          user._id.toString(),
      profileComplete,
      docsApproved:    user.documentStatus === 'approved',
      user: {
        _id:                   user._id,
        phone:                 user.phone,
        name:                  user.name,
        email:                 user.email,
        gender:                user.gender,
        role:                  user.role,
        isDriver:              user.isDriver,
        vehicleType:           user.vehicleType || null,
        documentStatus:        user.documentStatus,
        referralCode:          user.referralCode || null,
        driverReferralCode:    user.driverReferralCode || null,
        coins:                 user.coins || 0,
        welcomeCouponAssigned: user.welcomeCouponAssigned || false,
      },
      sessionInfo: {
        deviceId,
        loginAt:      user.lastLoginAt,
        forcedLogout: sessionResult?.forcedLogout,
        oldDeviceId:  sessionResult?.oldDeviceId,
      },
    });

  } catch (error) {
    console.error('❌ Firebase sync error:', error);
    res.status(500).json({
      success: false,
      error:   'Firebase sync failed',
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
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }

    const result = await SessionManager.handleLogout(phone, reason || 'user_logout');

    if (result.success) {
      res.json({ success: true, message: 'Logged out successfully' });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('❌ Logout error:', error);
    res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

/* ================================
   🔄 REFRESH FCM TOKEN ENDPOINT
================================= */
router.post('/refresh-fcm-token', async (req, res) => {
  try {
    const { phone, fcmToken } = req.body;

    if (!phone || !fcmToken) {
      return res.status(400).json({ success: false, error: 'Phone and FCM token required' });
    }

    const result = await SessionManager.refreshFcmToken(phone, fcmToken);
    res.json(result);
  } catch (error) {
    console.error('❌ FCM token refresh error:', error);
    res.status(500).json({ success: false, error: 'Token refresh failed' });
  }
});

/* ================================
   🔍 CHECK SESSION STATUS ENDPOINT
================================= */
router.get('/session-status/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const status = await SessionManager.getSessionStatus(phone);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('❌ Session status error:', error);
    res.status(500).json({ success: false, error: 'Failed to get session status' });
  }
});

/* ================================
   📊 GET SESSION HISTORY
================================= */
router.get('/session-history/:phone', async (req, res) => {
  try {
    const { phone }      = req.params;
    const { limit = 10 } = req.query;

    const user = await User.findOne({ phone }).select('previousSessions');
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const sessions = user.previousSessions
      .sort((a, b) => b.loginAt - a.loginAt)
      .slice(0, parseInt(limit));

    res.json({ success: true, sessions, total: user.previousSessions.length });
  } catch (error) {
    console.error('❌ Session history error:', error);
    res.status(500).json({ success: false, error: 'Failed to get session history' });
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
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const beforeCount = user.previousSessions.length;
    user.cleanOldSessions();
    await user.save();
    const afterCount = user.previousSessions.length;

    res.json({
      success:   true,
      message:   'Old sessions cleaned',
      removed:   beforeCount - afterCount,
      remaining: afterCount,
    });
  } catch (error) {
    console.error('❌ Clean sessions error:', error);
    res.status(500).json({ success: false, error: 'Failed to clean sessions' });
  }
});

export default router;