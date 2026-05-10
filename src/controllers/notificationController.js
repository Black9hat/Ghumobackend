// src/controllers/notificationController.js
import Trip from "../models/Trip.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { sendToDriver, sendToCustomer } from "../utils/fcmSender.js";

/**
 * 🔥 FIX: Get the best available FCM token for a user.
 * Customer app saves token to currentFcmToken (legacy field).
 * Driver app saves to both fcmToken AND currentFcmToken.
 * Always check both fields — use whichever is non-empty.
 */
const getEffectiveFcmToken = (user) => {
  return user.fcmToken || user.currentFcmToken || null;
};

/**
 * 📢 Save notification in DB (COMMON)
 */
const createNotification = async ({
  userId,
  role,
  title,
  body,
  type = "general",
  data = {},
  imageUrl = null,
  ctaText = null,
  ctaRoute = null,
}) => {
  try {
    const notification = await Notification.create({
      userId,
      role,
      title,
      body,
      type,
      data,
      imageUrl,
      ctaText,
      ctaRoute,
    });
    return notification;
  } catch (err) {
    console.error("❌ Failed to save notification:", err.message);
    return null;
  }
};

/**
 * 🚗 Sends trip-related notifications
 */
const sendTripNotification = async (to, type, tripId) => {
  try {
    const trip = await Trip.findById(tripId);
    if (!trip) return;

    if (to === "driver") {
      const driver = await User.findById(trip.assignedDriver);
      if (!driver) return;

      let title = "";
      let body = "";

      if (type === "new_request") {
        title = "New Trip Request";
        body = "You have a new trip request.";
      } else if (type === "reassigned") {
        title = "Trip Reassigned";
        body = "You have been reassigned to a trip.";
      }

      await createNotification({
        userId: driver._id,
        role: "driver",
        title,
        body,
        type: "trip",
        data: { tripId: tripId.toString() },
      });

      const token = getEffectiveFcmToken(driver);
      if (token) {
        await sendToDriver(token, {
          notificationType: "TRIP_REQUEST",
          tripId: trip._id.toString(),
          pickup: trip.pickup,
          drop: trip.drop,
          vehicleType: trip.vehicleType,
          fare: trip.fare,
        });
      }
    }

    if (to === "customer") {
      const customer = await User.findById(trip.customerId);
      if (!customer) return;

      let title = "";
      let body = "";

      if (type === "accepted") {
        title = "Driver Confirmed";
        body = "Your driver has accepted the trip.";
      } else if (type === "cancelled") {
        title = "Trip Cancelled";
        body = "Your trip has been cancelled.";
      } else if (type === "arrived") {
        title = "Driver Arrived";
        body = "Your driver has arrived at the pickup location.";
      } else if (type === "started") {
        title = "Trip Started";
        body = "Your trip has started. Enjoy your ride!";
      } else if (type === "completed") {
        title = "Trip Completed";
        body = "Your trip has been completed. Thank you for riding with us!";
      }

      await createNotification({
        userId: customer._id,
        role: "customer",
        title,
        body,
        type: "trip",
        data: { tripId: tripId.toString() },
      });

      const token = getEffectiveFcmToken(customer);
      if (token) {
        await sendToCustomer(token, title, body, {
          tripId: trip._id.toString(),
          type: "trip",
        });
      }
    }
  } catch (err) {
    console.error("❌ Error in sendTripNotification:", err);
  }
};

/**
 * 📢 Admin broadcast notification (to all users of a role)
 * Called by: POST /api/admin/send-fcm
 *
 * 🔥 FIX 1: Use getEffectiveFcmToken() — checks both fcmToken AND currentFcmToken.
 *    Customer users only have currentFcmToken; using fcmToken alone finds nothing.
 *
 * 🔥 FIX 2: Role query uses isDriver (reliable) not role field (may be stale).
 *
 * 🔥 FIX 3: sendToDriver with ADMIN_NOTIFICATION adds notification block
 *    so image shows on Android even when app is killed.
 */
const sendBroadcastNotification = async (req, res) => {
  try {
    const { title, body, role, imageUrl, ctaText, ctaRoute, type = "general" } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: "Title and body are required",
      });
    }

    // ✅ Role query using isDriver (canonical field, always set correctly)
    let query = {};
    if (role === "driver") {
      query = { isDriver: true };
    } else if (role === "customer") {
      query = { isDriver: false };
    }
    // role === "all" or undefined → no filter → send to everyone

    console.log(`\n${"=".repeat(60)}`);
    console.log(`📢 BROADCAST NOTIFICATION`);
    console.log(`   Role: ${role || "all"}`);
    console.log(`   Title: ${title}`);
    console.log(`   Image: ${imageUrl || "none"}`);
    console.log(`${"=".repeat(60)}`);

    // ✅ Fetch both token fields so we can use whichever is populated
    const users = await User.find(query).select("_id fcmToken currentFcmToken isDriver name");

    let successCount = 0;
    let failCount = 0;
    let noTokenCount = 0;
    const processedTokens = new Set();

    for (const user of users) {
      // 🔥 FIX: Use either fcmToken OR currentFcmToken — whichever exists
      const effectiveToken = getEffectiveFcmToken(user);

      // 🛡️ Deduplicate by token
      if (effectiveToken) {
        if (processedTokens.has(effectiveToken)) {
          console.log(`🛡️ Skipping duplicate token for user ${user._id}`);
          continue;
        }
        processedTokens.add(effectiveToken);
      }

      const userRole = user.isDriver ? "driver" : "customer";

      // ✅ Save to DB
      await createNotification({
        userId: user._id,
        role: userRole,
        title,
        body,
        type,
        imageUrl: imageUrl || null,
        ctaText,
        ctaRoute,
      });

      // ✅ Send FCM only if user has a token
      if (effectiveToken) {
        try {
          if (user.isDriver) {
            // sendToDriver with ADMIN_NOTIFICATION adds notification block
            // → image shows in system tray even when app is killed
            await sendToDriver(effectiveToken, {
              notificationType: "ADMIN_NOTIFICATION",
              title,
              body,
              imageUrl: imageUrl || null,
            });
          } else {
            // sendToCustomer already has notification block + imageUrl support
            await sendToCustomer(effectiveToken, title, body, {
              type,
              imageUrl: imageUrl || null,
            });
          }
          successCount++;
          console.log(`✅ Sent to ${userRole} ${user._id} (${user.name})`);
        } catch (fcmErr) {
          console.error(`❌ FCM failed for ${user._id}:`, fcmErr.message);
          failCount++;
        }
      } else {
        noTokenCount++;
        console.log(`⚠️ No FCM token for user ${user._id} (${user.name || "unknown"})`);
      }
    }

    console.log(`\n✅ Broadcast complete:`);
    console.log(`   Total users: ${users.length}`);
    console.log(`   FCM sent: ${successCount}`);
    console.log(`   No token: ${noTokenCount}`);
    console.log(`   Failed: ${failCount}`);
    console.log(`${"=".repeat(60)}\n`);

    res.status(200).json({
      success: true,
      message: `Notification sent to ${successCount} users`,
      data: {
        total: users.length,
        success: successCount,
        noToken: noTokenCount,
        failed: failCount,
      },
    });
  } catch (err) {
    console.error("❌ sendBroadcastNotification error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 💬 Admin individual notification (to specific user)
 * Called by: POST /api/admin/send-individual-notification
 *
 * 🔥 FIX: Use getEffectiveFcmToken() for same reason as broadcast.
 */
const sendIndividualNotification = async (req, res) => {
  try {
    const { title, body, userId, imageUrl, ctaText, ctaRoute, type = "general" } = req.body;

    if (!title || !body || !userId) {
      return res.status(400).json({
        success: false,
        message: "Title, body, and userId are required",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const userRole = user.isDriver ? "driver" : "customer";
    const effectiveToken = getEffectiveFcmToken(user);

    console.log(`\n📨 INDIVIDUAL NOTIFICATION`);
    console.log(`   User: ${user.name} (${userRole})`);
    console.log(`   Token source: ${user.fcmToken ? "fcmToken" : user.currentFcmToken ? "currentFcmToken" : "NONE"}`);
    console.log(`   Image: ${imageUrl || "none"}`);

    await createNotification({
      userId: user._id,
      role: userRole,
      title,
      body,
      type,
      imageUrl: imageUrl || null,
      ctaText,
      ctaRoute,
    });

    let fcmResult = { success: false };
    if (effectiveToken) {
      if (user.isDriver) {
        fcmResult = await sendToDriver(effectiveToken, {
          notificationType: "ADMIN_NOTIFICATION",
          title,
          body,
          imageUrl: imageUrl || null,
        });
      } else {
        fcmResult = await sendToCustomer(effectiveToken, title, body, {
          type,
          imageUrl: imageUrl || null,
        });
      }
    } else {
      console.log(`⚠️ No FCM token for user ${userId}`);
    }

    res.status(200).json({
      success: true,
      message: `Notification sent to ${user.name || userId}`,
      fcmDelivered: fcmResult.success,
      tokenFound: !!effectiveToken,
    });
  } catch (err) {
    console.error("❌ sendIndividualNotification error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 📥 Get user notifications
 */
const getUserNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 20, unreadOnly = false } = req.query;

    const userRole = req.user.isDriver ? "driver" : "customer";
    const query = { userId, role: userRole };

    if (unreadOnly === "true") {
      query.isRead = false;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const unreadCount = await Notification.countDocuments({
      userId,
      role: userRole,
      isRead: false,
    });

    const total = await Notification.countDocuments({ userId, role: userRole });

    res.status(200).json({
      success: true,
      notifications,
      unreadCount,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("❌ getUserNotifications error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 🎁 Get latest 5 offers for the logged-in user
 */
const getOffers = async (req, res) => {
  try {
    const userId = req.user._id;
    const userRole = req.user.isDriver ? "driver" : "customer";

    const offers = await Notification.find({
      userId,
      role: userRole,
      type: "promotion",
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    res.status(200).json({
      success: true,
      offers,
      count: offers.length,
    });
  } catch (err) {
    console.error("❌ getOffers error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 🎁 Admin: Get all unique promotion offers
 */
const getAllOffersAdmin = async (req, res) => {
  try {
    const offers = await Notification.aggregate([
      { $match: { type: "promotion" } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { title: "$title", body: "$body", imageUrl: "$imageUrl" },
          _docId: { $first: "$_id" },
          title: { $first: "$title" },
          body: { $first: "$body" },
          imageUrl: { $first: "$imageUrl" },
          role: { $first: "$role" },
          createdAt: { $first: "$createdAt" },
          recipientCount: { $sum: 1 },
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: 50 },
      {
        $project: {
          _id: "$_docId",
          title: 1,
          body: 1,
          imageUrl: 1,
          role: 1,
          createdAt: 1,
          recipientCount: 1,
        },
      },
    ]);

    res.status(200).json({ success: true, offers, count: offers.length });
  } catch (err) {
    console.error("❌ getAllOffersAdmin error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 🗑️ Admin delete offer (removes for all users)
 */
const deleteOffer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: "Offer ID is required" });

    const offer = await Notification.findById(id);
    if (!offer) return res.status(404).json({ success: false, message: "Offer not found" });

    const deleteResult = await Notification.deleteMany({
      title: offer.title,
      body: offer.body,
      imageUrl: offer.imageUrl,
      type: "promotion",
    });

    res.status(200).json({
      success: true,
      message: `Offer deleted (${deleteResult.deletedCount} instances removed)`,
      deletedCount: deleteResult.deletedCount,
    });
  } catch (err) {
    console.error("❌ deleteOffer error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 👍 Mark notification as read
 */
const markAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const userId = req.user._id;

    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, userId },
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, notification });
  } catch (err) {
    console.error("❌ markAsRead error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 👍👍 Mark all as read
 */
const markAllAsRead = async (req, res) => {
  try {
    const userId = req.user._id;
    const userRole = req.user.isDriver ? "driver" : "customer";

    await Notification.updateMany(
      { userId, role: userRole, isRead: false },
      { isRead: true }
    );

    res.status(200).json({ success: true, message: "All notifications marked as read" });
  } catch (err) {
    console.error("❌ markAllAsRead error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 🗑️ Delete one notification (user's own)
 */
const deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const userId = req.user._id;

    const notification = await Notification.findOneAndDelete({ _id: notificationId, userId });

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (err) {
    console.error("❌ deleteNotification error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 🗑️🗑️ Clear all notifications for current user
 */
const clearAllNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    const userRole = req.user.isDriver ? "driver" : "customer";

    await Notification.deleteMany({ userId, role: userRole });

    res.status(200).json({ success: true, message: "All notifications cleared" });
  } catch (err) {
    console.error("❌ clearAllNotifications error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 🔄 Reassignment notification
 */
const sendReassignmentNotification = async (driverId, tripId) => {
  try {
    const driver = await User.findById(driverId);
    if (!driver) return;

    await createNotification({
      userId: driver._id,
      role: "driver",
      title: "Trip Reassigned",
      body: "You have been reassigned to a trip.",
      type: "trip",
      data: { tripId: tripId.toString() },
    });

    const token = getEffectiveFcmToken(driver);
    if (token) {
      await sendToDriver(token, {
        notificationType: "TRIP_REASSIGNED",
        title: "Trip Reassigned",
        body: "You have been reassigned to a trip.",
        tripId: tripId.toString(),
      });
    }
  } catch (err) {
    console.error("❌ sendReassignmentNotification error:", err);
  }
};

export {
  createNotification,
  sendTripNotification,
  sendBroadcastNotification,
  sendIndividualNotification,
  getUserNotifications,
  getOffers,
  getAllOffersAdmin,
  deleteOffer,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllNotifications,
  sendReassignmentNotification,
};