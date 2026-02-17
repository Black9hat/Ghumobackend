// src/controllers/notificationController.js
import Trip from "../models/Trip.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { sendToDriver, sendToCustomer } from "../utils/fcmSender.js";

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

    // ================= DRIVER =================
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

      // ✅ SAVE TO DB
      await createNotification({
        userId: driver._id,
        role: "driver",
        title,
        body,
        type: "trip",
        data: { tripId: tripId.toString() },
      });

      // ✅ SEND FCM
      if (driver.fcmToken) {
        await sendToDriver(driver.fcmToken, {
          notificationType: "TRIP_REQUEST",
          tripId: trip._id.toString(),
          pickup: trip.pickup,
          drop: trip.drop,
          vehicleType: trip.vehicleType,
          fare: trip.fare,
        });
      }
    }

    // ================= CUSTOMER =================
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

      // ✅ SAVE TO DB
      await createNotification({
        userId: customer._id,
        role: "customer",
        title,
        body,
        type: "trip",
        data: { tripId: tripId.toString() },
      });

      // ✅ SEND FCM
      if (customer.fcmToken) {
        await sendToCustomer(customer.fcmToken, title, body, {
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
 * 📢 Admin broadcast notification (to all users of a type)
 */
const sendBroadcastNotification = async (req, res) => {
  try {
    const { title, body, role, imageUrl, ctaText, ctaRoute } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: "Title and body are required",
      });
    }

    let query = {};
    if (role === "driver") {
      query = { isDriver: true };
    } else if (role === "customer") {
      query = { isDriver: { $ne: true } };
    }
    // If role is undefined or "all", query is empty (all users)

    const users = await User.find(query).select("_id fcmToken isDriver name");

    let successCount = 0;
    let failCount = 0;

    for (const user of users) {
      const userRole = user.isDriver ? "driver" : "customer";

      // ✅ SAVE TO DB
      await createNotification({
        userId: user._id,
        role: userRole,
        title,
        body,
        type: "general",
        imageUrl,
        ctaText,
        ctaRoute,
      });

      // ✅ SEND FCM
      if (user.fcmToken) {
        try {
          if (user.isDriver) {
            await sendToDriver(user.fcmToken, {
              notificationType: "ADMIN_NOTIFICATION",
              title,
              body,
              imageUrl: imageUrl || "",
            });
          } else {
            await sendToCustomer(user.fcmToken, title, body, {
              type: "general",
              imageUrl: imageUrl || "",
            });
          }
          successCount++;
        } catch (fcmErr) {
          console.error(`FCM failed for ${user._id}:`, fcmErr.message);
          failCount++;
        }
      }
    }

    console.log(`📢 Broadcast sent: ${successCount} success, ${failCount} failed`);

    res.status(200).json({
      success: true,
      message: `Notification sent to ${successCount} users`,
      data: {
        total: users.length,
        success: successCount,
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
 */
const sendIndividualNotification = async (req, res) => {
  try {
    const { title, body, userId, imageUrl, ctaText, ctaRoute } = req.body;

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

    // ✅ SAVE TO DB
    await createNotification({
      userId: user._id,
      role: userRole,
      title,
      body,
      type: "general",
      imageUrl,
      ctaText,
      ctaRoute,
    });

    // ✅ SEND FCM
    let fcmResult = { success: false };
    if (user.fcmToken) {
      if (user.isDriver) {
        fcmResult = await sendToDriver(user.fcmToken, {
          notificationType: "ADMIN_NOTIFICATION",
          title,
          body,
        });
      } else {
        fcmResult = await sendToCustomer(user.fcmToken, title, body, {
          type: "general",
        });
      }
    }

    res.status(200).json({
      success: true,
      message: `Notification sent to ${user.name || userId}`,
      fcmDelivered: fcmResult.success,
    });
  } catch (err) {
    console.error("❌ sendIndividualNotification error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 📥 Get user notifications (for both driver and customer)
 */
const getUserNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 20, unreadOnly = false } = req.query;

    const query = { userId };
    if (unreadOnly === "true") {
      query.isRead = false;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const unreadCount = await Notification.countDocuments({
      userId,
      isRead: false,
    });

    const total = await Notification.countDocuments({ userId });

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
 * 🎁 NEW: Get latest 5 offers for a specific role
 */
const getOffers = async (req, res) => {
  try {
    const { role } = req.query;

    // Validate role parameter
    if (!role || !["customer", "driver"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Valid role parameter (customer or driver) is required",
      });
    }

    console.log(`🎁 Fetching offers for role: ${role}`);

    // Fetch latest 5 promotion notifications for the specified role
    const offers = await Notification.find({
      type: "promotion",
      role: role,
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    console.log(`✅ Found ${offers.length} offers for ${role}`);

    res.status(200).json({
      success: true,
      offers,
      count: offers.length,
    });
  } catch (err) {
    console.error("❌ getOffers error:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

/**
 * 🗑️ NEW: Delete a specific offer (admin only)
 */
const deleteOffer = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Offer ID is required",
      });
    }

    console.log(`🗑️ Deleting offer: ${id}`);

    // Delete the notification (offer)
    const deletedOffer = await Notification.findByIdAndDelete(id);

    if (!deletedOffer) {
      return res.status(404).json({
        success: false,
        message: "Offer not found",
      });
    }

    console.log(`✅ Offer deleted successfully: ${id}`);

    res.status(200).json({
      success: true,
      message: "Offer deleted successfully",
      deletedOffer,
    });
  } catch (err) {
    console.error("❌ deleteOffer error:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
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
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    res.status(200).json({ success: true, notification });
  } catch (err) {
    console.error("❌ markAsRead error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 👍👍 Mark all notifications as read
 */
const markAllAsRead = async (req, res) => {
  try {
    const userId = req.user._id;

    await Notification.updateMany(
      { userId, isRead: false },
      { isRead: true }
    );

    res.status(200).json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (err) {
    console.error("❌ markAllAsRead error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 🗑️ Delete notification
 */
const deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const userId = req.user._id;

    const notification = await Notification.findOneAndDelete({
      _id: notificationId,
      userId,
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Notification deleted",
    });
  } catch (err) {
    console.error("❌ deleteNotification error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 🗑️🗑️ Clear all notifications
 */
const clearAllNotifications = async (req, res) => {
  try {
    const userId = req.user._id;

    await Notification.deleteMany({ userId });

    res.status(200).json({
      success: true,
      message: "All notifications cleared",
    });
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

    // ✅ SAVE
    await createNotification({
      userId: driver._id,
      role: "driver",
      title: "Trip Reassigned",
      body: "You have been reassigned to a trip.",
      type: "trip",
      data: { tripId: tripId.toString() },
    });

    // ✅ FCM
    if (driver.fcmToken) {
      await sendToDriver(driver.fcmToken, {
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
  getOffers,          // ✅ NEW: Get offers
  deleteOffer,        // ✅ NEW: Delete offer
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllNotifications,
  sendReassignmentNotification,
};
