// routes/userRoutes.js

import express from "express";
import User from "../models/User.js";

import {
  createUser,
  getUser,
  updateUser,
  deleteUser,
  getUserById,
} from "../controllers/userController.js";

const router = express.Router();

/**
 * 🔥 Update FCM Token
 * POST /api/user/update-fcm
 */
router.post("/update-fcm", async (req, res) => {
  try {
    const { phone, fcmToken, driverId } = req.body;

    console.log('');
    console.log('📱 ═══════════════════════════════════════════════════════════════');
    console.log('📱 FCM TOKEN UPDATE REQUEST');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`   Driver ID: ${driverId || 'not provided'}`);
    console.log(`   Phone: ${phone || 'not provided'}`);
    console.log(`   Token: ${fcmToken ? fcmToken.substring(0, 40) + '...' : 'not provided'}`);
    console.log('═══════════════════════════════════════════════════════════════');

    // ✅ Validate - need either phone OR driverId
    if (!phone && !driverId) {
      console.log('❌ Missing phone and driverId');
      return res.status(400).json({
        success: false,
        message: "Phone or driverId is required"
      });
    }

    if (!fcmToken) {
      console.log('❌ Missing fcmToken');
      return res.status(400).json({
        success: false,
        message: "FCM token is required"
      });
    }

    let user = null;

    // ✅ Find user by driverId first
    if (driverId) {
      try {
        user = await User.findById(driverId);
        if (user) {
          console.log(`   ✅ Found user by driverId: ${user.name}`);
        }
      } catch (e) {
        console.log(`   ⚠️ Invalid driverId format: ${e.message}`);
      }
    }
    
    // ✅ If not found, try by phone
    if (!user && phone) {
      const phoneKey = phone.replace(/^\+91/, "").replace(/^91/, "");
      user = await User.findOne({ phone: phoneKey });
      if (user) {
        console.log(`   ✅ Found user by phone: ${user.name}`);
      }
    }

    if (!user) {
      console.log('❌ User not found');
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // ✅ Update FCM token
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      {
        $set: {
          fcmToken: fcmToken,
          fcmTokenUpdatedAt: new Date()
        }
      },
      { new: true }
    );

    console.log(`✅ FCM token saved for ${updatedUser.name} (${updatedUser._id})`);
    console.log('📱 ═══════════════════════════════════════════════════════════════');
    console.log('');

    res.status(200).json({
      success: true,
      message: "FCM token updated successfully",
      userId: updatedUser._id,
      name: updatedUser.name
    });

  } catch (error) {
    console.error("❌ Update FCM token error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update FCM token",
      error: error.message
    });
  }
});

/**
 * 🗑️ Delete FCM Token (on logout)
 * POST /api/user/delete-fcm
 */
router.post("/delete-fcm", async (req, res) => {
  try {
    const { driverId, phone } = req.body;

    console.log('');
    console.log('🗑️ ═══════════════════════════════════════════════════════════════');
    console.log('🗑️ FCM TOKEN DELETE REQUEST');
    console.log(`   Driver ID: ${driverId || 'not provided'}`);
    console.log(`   Phone: ${phone || 'not provided'}`);
    console.log('═══════════════════════════════════════════════════════════════');

    if (!driverId && !phone) {
      return res.status(400).json({
        success: false,
        message: "driverId or phone is required"
      });
    }

    let user = null;

    if (driverId) {
      try {
        user = await User.findById(driverId);
      } catch (e) {
        console.log(`   ⚠️ Invalid driverId: ${e.message}`);
      }
    }

    if (!user && phone) {
      const phoneKey = phone.replace(/^\+91/, "").replace(/^91/, "");
      user = await User.findOne({ phone: phoneKey });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // ✅ Remove FCM token
    await User.findByIdAndUpdate(user._id, {
      $unset: { fcmToken: "" },
      $set: { fcmTokenDeletedAt: new Date() }
    });

    console.log(`✅ FCM token deleted for ${user.name} (${user._id})`);
    console.log('🗑️ ═══════════════════════════════════════════════════════════════');
    console.log('');

    res.status(200).json({
      success: true,
      message: "FCM token deleted successfully"
    });

  } catch (error) {
    console.error("❌ Delete FCM token error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete FCM token",
      error: error.message
    });
  }
});

/**
 * 🧪 Test FCM Token Status
 * GET /api/user/fcm-status/:driverId
 */
router.get("/fcm-status/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;

    const user = await User.findById(driverId)
      .select('name phone fcmToken fcmTokenUpdatedAt isOnline socketId')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    res.json({
      success: true,
      name: user.name,
      phone: user.phone,
      hasFcmToken: !!user.fcmToken,
      fcmTokenPreview: user.fcmToken ? user.fcmToken.substring(0, 30) + '...' : null,
      fcmTokenUpdatedAt: user.fcmTokenUpdatedAt,
      isOnline: user.isOnline,
      hasSocket: !!user.socketId
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Create user
 * POST /api/user
 */
router.post("/", createUser);

/**
 * Get user by MongoDB Id
 * GET /api/user/id/:id
 */
router.get("/id/:id", getUserById);

/**
 * Get user by phone
 * GET /api/user/:phone
 */
router.get("/:phone", getUser);

/**
 * Update user
 * PUT /api/user/:phone
 */
router.put("/:phone", updateUser);

/**
 * Delete user
 * DELETE /api/user/:phone
 */
router.delete("/:phone", deleteUser);

export default router;