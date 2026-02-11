//src/controllers/adminController.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import mongoose from "mongoose";

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Trip from "../models/Trip.js";
import User from "../models/User.js";
import Rate from "../models/Rate.js";
import DriverDoc from "../models/DriverDoc.js";
import Notification from "../models/Notification.js";
// ✅ USE SAFE FCM HELPER
import { sendFCMNotification } from "../utils/fcmHelper.js";
import { verifyAdminToken } from "../middlewares/adminAuth.js";
import { recomputeDriverDocumentStatus } from "./documentController.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// ======================================================================
// 🛡️ WHITELIST: Only these fields can be set/updated for Rates
// ======================================================================
const ALLOWED_RATE_FIELDS = [
  // Core fare components
  "baseFare",
  "perKm",
  "perMin",
  "minFare",
  
  // Multipliers (admin-controlled)
  "manualSurge",
  "peakMultiplier",
  "nightMultiplier",
  
  // Platform fees
  "platformFee",
  "platformFeePercent",
  "gstPercent",
  
  // Rate identity
  "vehicleType",
  "city",
  "state",
  "category",
  
  // Driver incentives (separate from fare)
  "perRideIncentive",
  "perRideCoins",
  
  // Optional extras
  "baseFareDistanceKm",
  "isActive",
];

// ======================================================================
// 💰 Fare Rates (SECURED with Field Whitelist)
// ======================================================================
export const getAllFareRates = async (req, res) => {
  try {
    const rates = await Rate.find({}).sort({ state: 1, city: 1, vehicleType: 1 });
    res.status(200).json({ message: "Fare rates fetched successfully", rates });
  } catch (err) {
    console.error("❌ Error fetching fare rates:", err);
    res.status(500).json({ message: "Server error while fetching fare rates." });
  }
};

// ✅ SECURED: Whitelist protection for updates
export const updateFareRate = async (req, res) => {
  try {
    const { id } = req.params;

    // ─────────────────────────────────────────────────────
    // 🛡️ WHITELIST FILTER: Only allow approved fields
    // ─────────────────────────────────────────────────────
    const updates = {};
    for (const key of ALLOWED_RATE_FIELDS) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    // Log any blocked fields (security audit)
    const blockedFields = Object.keys(req.body).filter(
      (key) => !ALLOWED_RATE_FIELDS.includes(key)
    );
    if (blockedFields.length > 0) {
      console.warn(`⚠️ BLOCKED FIELDS in updateFareRate:`, blockedFields);
    }

    // ─────────────────────────────────────────────────────
    // ✅ VALIDATION: Ensure no negative values
    // ─────────────────────────────────────────────────────
    if (updates.baseFare !== undefined && updates.baseFare < 0) {
      return res.status(400).json({ message: "baseFare cannot be negative." });
    }
    if (updates.perKm !== undefined && updates.perKm < 0) {
      return res.status(400).json({ message: "perKm cannot be negative." });
    }
    if (updates.perMin !== undefined && updates.perMin < 0) {
      return res.status(400).json({ message: "perMin cannot be negative." });
    }
    if (updates.minFare !== undefined && updates.minFare < 0) {
      return res.status(400).json({ message: "minFare cannot be negative." });
    }

    // Validate multipliers are reasonable (0.5 to 5.0)
    if (updates.manualSurge !== undefined) {
      if (updates.manualSurge < 0.5 || updates.manualSurge > 5) {
        return res.status(400).json({ message: "manualSurge must be between 0.5 and 5." });
      }
    }
    if (updates.peakMultiplier !== undefined) {
      if (updates.peakMultiplier < 0.5 || updates.peakMultiplier > 3) {
        return res.status(400).json({ message: "peakMultiplier must be between 0.5 and 3." });
      }
    }
    if (updates.nightMultiplier !== undefined) {
      if (updates.nightMultiplier < 0.5 || updates.nightMultiplier > 3) {
        return res.status(400).json({ message: "nightMultiplier must be between 0.5 and 3." });
      }
    }

    // ─────────────────────────────────────────────────────
    // 💾 UPDATE DATABASE
    // ─────────────────────────────────────────────────────
    const rate = await Rate.findByIdAndUpdate(id, updates, { 
      new: true, 
      runValidators: true 
    });

    if (!rate) {
      return res.status(404).json({ message: "Rate not found." });
    }

    console.log(`✅ Rate updated: ${rate.city} - ${rate.vehicleType}`);
    console.log(`   Updated fields:`, Object.keys(updates));

    res.status(200).json({ 
      message: "Fare rate updated successfully", 
      rate,
      updatedFields: Object.keys(updates),
    });
  } catch (err) {
    console.error("❌ Error updating fare rate:", err);
    res.status(500).json({ message: "Server error while updating fare rate." });
  }
};

// ✅ SECURED: Whitelist protection for creation
export const createFareRate = async (req, res) => {
  try {
    // ─────────────────────────────────────────────────────
    // 🛡️ WHITELIST FILTER: Only allow approved fields
    // ─────────────────────────────────────────────────────
    const clean = {};
    for (const key of ALLOWED_RATE_FIELDS) {
      if (req.body[key] !== undefined) {
        clean[key] = req.body[key];
      }
    }

    // Log any blocked fields (security audit)
    const blockedFields = Object.keys(req.body).filter(
      (key) => !ALLOWED_RATE_FIELDS.includes(key)
    );
    if (blockedFields.length > 0) {
      console.warn(`⚠️ BLOCKED FIELDS in createFareRate:`, blockedFields);
    }

    // ─────────────────────────────────────────────────────
    // ✅ REQUIRED FIELDS CHECK
    // ─────────────────────────────────────────────────────
    const requiredFields = ["vehicleType", "city", "state", "category"];
    const missingFields = requiredFields.filter((field) => !clean[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({ 
        message: `Missing required fields: ${missingFields.join(", ")}` 
      });
    }

    // ─────────────────────────────────────────────────────
    // ✅ VALIDATION: Ensure no negative values
    // ─────────────────────────────────────────────────────
    if (clean.baseFare !== undefined && clean.baseFare < 0) {
      return res.status(400).json({ message: "baseFare cannot be negative." });
    }
    if (clean.perKm !== undefined && clean.perKm < 0) {
      return res.status(400).json({ message: "perKm cannot be negative." });
    }
    if (clean.perMin !== undefined && clean.perMin < 0) {
      return res.status(400).json({ message: "perMin cannot be negative." });
    }
    if (clean.minFare !== undefined && clean.minFare < 0) {
      return res.status(400).json({ message: "minFare cannot be negative." });
    }

    // ─────────────────────────────────────────────────────
    // 💾 CREATE IN DATABASE
    // ─────────────────────────────────────────────────────
    const rate = await Rate.create(clean);

    console.log(`✅ New rate created: ${rate.city} - ${rate.vehicleType}`);

    res.status(201).json({ 
      message: "New fare rate added successfully", 
      rate 
    });
  } catch (err) {
    console.error("❌ Error creating new fare rate:", err);
    
    // Handle duplicate key error
    if (err.code === 11000) {
      return res.status(400).json({ 
        message: "Rate already exists for this vehicle type and location." 
      });
    }
    
    res.status(500).json({ message: "Server error while creating rate." });
  }
};

export const deleteFareRate = async (req, res) => {
  try {
    const { id } = req.params;
    const rate = await Rate.findByIdAndDelete(id);
    if (!rate) return res.status(404).json({ message: "Rate not found." });

    console.log(`🗑️ Rate deleted: ${rate.city} - ${rate.vehicleType}`);

    res.status(200).json({ message: "Fare rate deleted successfully" });
  } catch (err) {
    console.error("❌ Error deleting fare rate:", err);
    res.status(500).json({ message: "Server error while deleting fare rate." });
  }
};

// ======================================================================
// 📊 Dashboard Stats
// ======================================================================
export const getDashboardStats = async (req, res) => {
  try {
    const totalTrips = await Trip.countDocuments();
    const completedTrips = await Trip.countDocuments({ status: "completed" });
    const ongoingTrips = await Trip.countDocuments({ status: "ongoing" });
    const cancelledTrips = await Trip.countDocuments({ status: "cancelled" });

    const totalUsers = await User.countDocuments();
    const totalDrivers = await User.countDocuments({ isDriver: true });
    const totalCustomers = await User.countDocuments({ isDriver: false });

    const pendingDocs = await DriverDoc.countDocuments({ status: "pending" });
    const verifiedDocs = await DriverDoc.countDocuments({ status: "verified" });
    const rejectedDocs = await DriverDoc.countDocuments({ status: "rejected" });

    res.status(200).json({
      message: "Dashboard stats fetched successfully",
      stats: {
        trips: {
          total: totalTrips,
          completed: completedTrips,
          ongoing: ongoingTrips,
          cancelled: cancelledTrips,
        },
        users: {
          total: totalUsers,
          drivers: totalDrivers,
          customers: totalCustomers,
        },
        documents: {
          pending: pendingDocs,
          verified: verifiedDocs,
          rejected: rejectedDocs,
        },
      },
    });
  } catch (err) {
    console.error("❌ Dashboard stats error:", err);
    res.status(500).json({ message: "Server error while fetching stats." });
  }
};

// ======================================================================
// 👥 Users: Drivers & Customers
// ======================================================================
export const getAllDrivers = async (req, res) => {
  try {
    const drivers = await User.find({ isDriver: true })
      .select(
        "name email phone vehicleType profilePhotoUrl photo profilePic driverPhoto avatar isBlocked"
      );

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const formattedDrivers = drivers.map((d) => {
      const rawPhoto =
        d.profilePhotoUrl ||
        d.photo ||
        d.profilePic ||
        d.driverPhoto ||
        d.avatar ||
        null;

      let finalPhotoUrl = null;

      if (rawPhoto) {
        if (rawPhoto.startsWith("http")) {
          finalPhotoUrl = rawPhoto;
        } else {
          finalPhotoUrl = `${baseUrl}/${rawPhoto.replace(/\\/g, "/")}`;
        }
      }

      return {
        _id: d._id,
        name: d.name,
        email: d.email,
        phone: d.phone,
        vehicleType: d.vehicleType,
        profilePhotoUrl: finalPhotoUrl,
        isBlocked: d.isBlocked,
      };
    });

    res.status(200).json({ drivers: formattedDrivers });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const getAllCustomers = async (req, res) => {
  try {
    const customers = await User.find({ isDriver: false }).select("-password");
    res.status(200).json({ message: "Customers fetched successfully", customers });
  } catch (err) {
    console.error("❌ Error fetching customers:", err);
    res.status(500).json({ message: "Server error while fetching customers." });
  }
};

export const blockDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    await User.findByIdAndUpdate(driverId, { isBlocked: true });
    res.status(200).json({ message: "Driver blocked successfully." });
  } catch (err) {
    console.error("❌ Error blocking driver:", err);
    res.status(500).json({ message: "Error blocking driver." });
  }
};

export const unblockDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    await User.findByIdAndUpdate(driverId, { isBlocked: false });
    res.status(200).json({ message: "Driver unblocked successfully." });
  } catch (err) {
    console.error("❌ Error unblocking driver:", err);
    res.status(500).json({ message: "Error unblocking driver." });
  }
};

export const blockCustomer = async (req, res) => {
  try {
    const { customerId } = req.params;
    await User.findByIdAndUpdate(customerId, { isBlocked: true });
    res.status(200).json({ message: "Customer blocked successfully." });
  } catch (err) {
    console.error("❌ Error blocking customer:", err);
    res.status(500).json({ message: "Error blocking customer." });
  }
};

export const unblockCustomer = async (req, res) => {
  try {
    const { customerId } = req.params;
    await User.findByIdAndUpdate(customerId, { isBlocked: false });
    res.status(200).json({ message: "Customer unblocked successfully." });
  } catch (err) {
    console.error("❌ Error unblocking customer:", err);
    res.status(500).json({ message: "Error unblocking customer." });
  }
};

// ======================================================================
// 🚘 Trips
// ======================================================================
export const getAllTrips = async (req, res) => {
  try {
    const trips = await Trip.find({})
      .populate("customerId", "name phone")
      .populate("assignedDriver", "name phone")
      .sort({ createdAt: -1 });
    res.status(200).json({ message: "Trips fetched successfully", trips });
  } catch (err) {
    console.error("❌ Error fetching trips:", err);
    res.status(500).json({ message: "Server error while fetching trips." });
  }
};

export const getTripDetails = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findById(tripId).lean();
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const customer = await User.findById(trip.customerId).lean();
    const driver = trip.assignedDriver ? await User.findById(trip.assignedDriver).lean() : null;

    res.status(200).json({
      trip,
      customer: customer
        ? { name: customer.name, phone: customer.phone, address: customer.address || "N/A" }
        : null,
      driver: driver
        ? { name: driver.name, phone: driver.phone, license: driver.license || "N/A" }
        : null,
    });
  } catch (err) {
    console.error("❌ Trip detail fetch error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const getActiveSupportTrips = async (req, res) => {
  try {
    console.log('');
    console.log('📋 FETCHING ACTIVE SUPPORT TRIPS');
    console.log('='.repeat(50));
    
    const trips = await Trip.find({
      supportRequested: true
    })
      .populate('customerId', 'name phone')
      .populate('assignedDriver', 'name phone vehicleNumber rating location')
      .sort({ supportRequestedAt: -1, updatedAt: -1 })
      .lean();

    console.log(`✅ Found ${trips.length} trips with support requested`);
    
    if (trips.length > 0) {
      console.log('\n📊 Support Trips:');
      trips.forEach((trip, index) => {
        console.log(`\n${index + 1}. Trip ${trip._id}`);
        console.log(`   Status: ${trip.status}`);
        console.log(`   Customer: ${trip.customerId?.name || 'N/A'}`);
        console.log(`   Driver: ${trip.assignedDriver?.name || 'N/A'}`);
        console.log(`   Reason: ${trip.supportReason || 'N/A'}`);
      });
    }
    
    console.log('='.repeat(50));
    console.log('');

    res.json({ 
      success: true,
      trips,
      count: trips.length 
    });

  } catch (err) {
    console.error('🔥 getActiveSupportTrips error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Server error',
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
};

export const manualAssignDriver = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const driver = await User.findById(driverId);
    if (!driver || !driver.isDriver) {
      return res.status(404).json({ message: "Driver not found or invalid" });
    }

    trip.assignedDriver = driverId;
    trip.status = "assigned";
    await trip.save();

    if (driver.fcmToken) {
      await sendFCMNotification({
        userId: driver._id,
        token: driver.fcmToken,
        title: "New Trip Assigned",
        body: "You have a new trip assignment",
        type: "trip",
        data: { tripId: trip._id.toString() },
      });
    }

    res.status(200).json({ message: "Driver assigned successfully", trip });
  } catch (err) {
    console.error("❌ Manual assign error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const markTripCompleted = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { status: "completed" },
      { new: true }
    );
    if (!trip) return res.status(404).json({ message: "Trip not found" });
    res.status(200).json({ message: "Trip marked as completed", trip });
  } catch (err) {
    console.error("❌ Error marking trip completed:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const cancelTrip = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findByIdAndUpdate(
      tripId,
      { status: "cancelled" },
      { new: true }
    );
    if (!trip) return res.status(404).json({ message: "Trip not found" });
    res.status(200).json({ message: "Trip cancelled successfully", trip });
  } catch (err) {
    console.error("❌ Error cancelling trip:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================================================================
// 📨 Push Notifications (WITH STORAGE)
// ======================================================================
export const sendPushToUsers = async (req, res) => {
  try {
    const { title, body, role, type = "general", imageUrl } = req.body;  // ✅ Added imageUrl

    if (!role) {
      return res.status(400).json({ message: "role is required" });
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`📨 SENDING PUSH NOTIFICATIONS`);
    console.log(`${"=".repeat(60)}`);
    console.log(`   Title: ${title}`);
    console.log(`   Body: ${body}`);
    console.log(`   Role: ${role}`);
    console.log(`   Image: ${imageUrl || 'none'}`);  // ✅ Log image
    console.log(`${"=".repeat(60)}`);

    const users = await User.find(
      role === "driver" ? { isDriver: true } : { isDriver: false }
    );

    let successCount = 0;
    let fcmSuccessCount = 0;

    for (const user of users) {
      try {
        await createAndSendNotification({
          user,
          title,
          body,
          type,
          imageUrl: imageUrl || null,  // ✅ Pass image
        });
        successCount++;
        if (user.fcmToken) fcmSuccessCount++;
      } catch (err) {
        console.error(`❌ Failed for user ${user._id}:`, err.message);
      }
    }

    console.log(`\n✅ COMPLETE: ${successCount} saved, ${fcmSuccessCount} FCM sent\n`);

    res.json({
      success: true,
      message: `Saved + sent to ${successCount} users`,
      details: {
        total: users.length,
        dbSuccess: successCount,
        fcmSuccess: fcmSuccessCount,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Notification failed" });
  }
};


// ======================================================================
// 🔔 Notification Management
// ======================================================================
export const getUserNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.isDriver ? "driver" : "customer";

    console.log("🔔 Fetch notifications:", {
      userId: userId.toString(),
      role,
    });

    const { limit = 50, page = 1 } = req.query;

    const notifications = await Notification.find({
      userId,
      role,
    })
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    const unreadCount = await Notification.countDocuments({
      userId,
      role,
      isRead: false,
    });

    res.status(200).json({
      notifications,
      unreadCount,
    });
  } catch (err) {
    console.error("❌ Error fetching notifications:", err);
    res.status(500).json({
      message: "Server error while fetching notifications.",
    });
  }
};

// Mark notification as read
export const markNotificationAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    const notification = await Notification.findByIdAndUpdate(
      notificationId,
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.status(200).json({ 
      message: "Notification marked as read", 
      notification 
    });
  } catch (err) {
    console.error("❌ Error marking notification as read:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const markAllNotificationsAsRead = async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.isDriver ? "driver" : "customer";

    await Notification.updateMany(
      { userId, role, isRead: false },
      { isRead: true }
    );

    res.status(200).json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("❌ Error marking all as read:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Delete notification
export const deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    const notification = await Notification.findByIdAndDelete(notificationId);
    
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.status(200).json({ message: "Notification deleted successfully" });
  } catch (err) {
    console.error("❌ Error deleting notification:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const createAndSendNotification = async ({
  user,
  title,
  body,
  type = "general",
  imageUrl = null,  // ✅ Added imageUrl parameter
  ctaText = null,
  ctaRoute = null,
  data = {},
}) => {
  // ✅ Save notification with image
  const notification = await Notification.create({
    userId: user._id,
    role: user.isDriver ? "driver" : "customer",
    title,
    body,
    type,
    imageUrl,  // ✅ Save image
    ctaText,
    ctaRoute,
    data,
    isRead: false,
  });

  // ✅ Send FCM with image
  if (user.fcmToken) {
    await sendFCMNotification({
      userId: user._id,
      token: user.fcmToken,
      title,
      body,
      type,
      imageUrl,  // ✅ Pass image to FCM
      data: {
        notificationId: notification._id.toString(),
        type,
        ctaRoute: ctaRoute ?? "",
        imageUrl: imageUrl ?? "",
        ...data,
      },
    });
  }

  return notification;
};

export const sendPushToIndividual = async (req, res) => {
  try {
    const { userId, title, body, type = "general", imageUrl } = req.body;  // ✅ Added imageUrl

    if (!userId || !title || !body) {
      return res.status(400).json({
        message: "userId, title and body are required",
      });
    }

    console.log(`\n📨 SENDING INDIVIDUAL NOTIFICATION`);
    console.log(`   User ID: ${userId}`);
    console.log(`   Title: ${title}`);
    console.log(`   Image: ${imageUrl || 'none'}`);  // ✅ Log image

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // ✅ Save notification with image
    await Notification.create({
      userId: user._id,
      role: user.isDriver ? "driver" : "customer",
      title,
      body,
      type,
      imageUrl: imageUrl || null,  // ✅ Save image
      isRead: false,
    });

    // ✅ Send FCM with image
    if (user.fcmToken) {
      await sendFCMNotification({
        userId: user._id,
        token: user.fcmToken,
        title,
        body,
        type,
        imageUrl: imageUrl || null,  // ✅ Pass image to FCM
      });
    }

    res.status(200).json({
      message: "Notification sent to individual user successfully",
    });
  } catch (err) {
    console.error("❌ sendPushToIndividual error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================================================================
// 📄 Documents
// ======================================================================
export const getPendingDocuments = async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const documents = await DriverDoc.find({ status: "pending" })
      .sort({ createdAt: 1 })
      .lean();

    // ✅ FIX: Get user IDs (MongoDB _id)
    const userIds = [...new Set(documents.map((d) => d.userId.toString()))];

    // ✅ FIX: Find users by MongoDB _id
    const users = await User.find({ _id: { $in: userIds } })
      .select("_id name phone email vehicleType")
      .lean();

    // ✅ FIX: Build map using MongoDB _id
    const userMap = {};
    for (const user of users) {
      userMap[user._id.toString()] = user;
    }

    const docsWithImageUrl = documents.map((doc) => {
      const rawPath = doc.url?.replace(/\\/g, "/") || null;
      let fullUrl = null;
      
      if (rawPath) {
        if (rawPath.startsWith("http")) {
          fullUrl = rawPath;
        } else {
          let cleanPath = rawPath;
          const uploadsIndex = cleanPath.indexOf("uploads/");
          if (uploadsIndex !== -1) {
            cleanPath = cleanPath.substring(uploadsIndex);
          } else if (!cleanPath.startsWith("uploads/")) {
            cleanPath = `uploads/${path.basename(cleanPath)}`;
          }
          fullUrl = `${baseUrl}/${cleanPath}`;
        }
      }

      // ✅ FIX: Look up user by MongoDB _id
      const userInfo = userMap[doc.userId.toString()] || null;

      return {
        ...doc,
        imageUrl: fullUrl,
        driverName: userInfo?.name || null,
        driverPhone: userInfo?.phone || null,
        driverEmail: userInfo?.email || null,
      };
    });

    res.status(200).json({
      message: "Pending documents fetched successfully.",
      documents: docsWithImageUrl,
      count: docsWithImageUrl.length,
    });
  } catch (err) {
    console.error("❌ Error fetching pending documents:", err);
    res.status(500).json({ message: "Server error." });
  }
};

// ============================================
// 🔥 IMAGE PROXY - Serves images with proper headers
// ============================================
export const getDocumentImage = async (req, res) => {
  try {
    const { docId } = req.params;

    const document = await DriverDoc.findById(docId).lean();
    if (!document || document.imageDeleted || !document.url) {
      return res.status(404).json({ error: "Image not found" });
    }

    // ✅ CASE 1: Cloudinary image → REDIRECT
    if (document.url.startsWith("http")) {
      return res.redirect(document.url);
    }

    // ✅ CASE 2: Local upload
    let cleanPath = document.url.replace(/\\/g, "/");
    if (!cleanPath.startsWith("uploads/")) {
      cleanPath = `uploads/${path.basename(cleanPath)}`;
    }

    const fullPath = path.join(process.cwd(), cleanPath);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "Local image not found" });
    }

    return res.sendFile(fullPath);
  } catch (err) {
    console.error("❌ getDocumentImage error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Helper function to send image file
const sendImageFile = (res, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  
  const contentType = contentTypes[ext] || "image/jpeg";
  
  console.log(`✅ Sending image: ${filePath}`);
  console.log(`   Content-Type: ${contentType}`);
  console.log(`   File size: ${fs.statSync(filePath).size} bytes`);
  
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  return res.sendFile(path.resolve(filePath));
};

// ============================================
// 🔥 GET DOCUMENT IMAGE AS BASE64
// ============================================
export const getDocumentImageBase64 = async (req, res) => {
  try {
    const { docId } = req.params;
    
    console.log(`📷 Base64 request for document: ${docId}`);
    
    const document = await DriverDoc.findById(docId).lean();
    
    if (!document) {
      return res.status(404).json({ success: false, error: "Document not found" });
    }
    
    if (document.imageDeleted || !document.url) {
      return res.status(404).json({ success: false, error: "No image available" });
    }
    
    // Same path resolution
    let cleanPath = document.url.replace(/\\/g, "/");
    const uploadsIndex = cleanPath.indexOf('uploads/');
    if (uploadsIndex !== -1) {
      cleanPath = cleanPath.substring(uploadsIndex);
    } else if (!cleanPath.startsWith('uploads/')) {
      cleanPath = `uploads/${path.basename(cleanPath)}`;
    }
    
    const fullFilePath = path.join(process.cwd(), cleanPath);
    
    if (!fs.existsSync(fullFilePath)) {
      return res.status(404).json({ success: false, error: "Image file not found" });
    }
    
    // Read file and convert to base64
    const imageBuffer = fs.readFileSync(fullFilePath);
    const ext = path.extname(fullFilePath).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    const base64 = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
    
    console.log(`✅ Base64 generated, size: ${base64.length} chars`);
    
    return res.json({ success: true, base64 });
    
  } catch (error) {
    console.error("❌ Error serving base64 image:", error);
    return res.status(500).json({ success: false, error: "Failed to serve image" });
  }
};

// =====================================================
// 🧪 TEST ENDPOINT
// =====================================================
export const testImageAccess = async (req, res) => {
  try {
    const uploadsDir = path.join(process.cwd(), 'uploads');
    
    console.log('🧪 Testing image access...');
    console.log('📁 Uploads directory:', uploadsDir);
    
    if (!fs.existsSync(uploadsDir)) {
      return res.status(404).json({
        error: 'Uploads directory does not exist',
        path: uploadsDir,
        cwd: process.cwd()
      });
    }
    
    const files = fs.readdirSync(uploadsDir);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    
    const fileDetails = files.map(file => {
      const filePath = path.join(uploadsDir, file);
      const stats = fs.statSync(filePath);
      
      return {
        filename: file,
        relativePath: `uploads/${file}`,
        fullPath: filePath,
        url: `${baseUrl}/uploads/${file}`,
        size: stats.size,
        sizeKB: Math.round(stats.size / 1024),
        created: stats.birthtime,
        modified: stats.mtime
      };
    });
    
    res.status(200).json({
      success: true,
      message: 'Upload directory accessible',
      uploadsDir,
      baseUrl,
      totalFiles: files.length,
      files: fileDetails
    });
  } catch (err) {
    console.error('❌ Test endpoint error:', err);
    res.status(500).json({
      error: 'Error accessing uploads directory',
      message: err.message,
      stack: err.stack
    });
  }
};

// ======================================================================
// 📄 OPTIMIZED: Get Drivers with Document Status (Skip Verified Docs)
// ======================================================================
export const getDriversWithDocStatus = async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    console.log(`\n🌐 Base URL for images: ${baseUrl}`);

    // Get all drivers
    const drivers = await User.find({ isDriver: true })
      .select("name email phone vehicleType documentStatus isVerified profilePhotoUrl isBlocked")
      .lean();

    const result = {
      pending: [],
      rejected: [],
      verified: [],
    };

    for (const driver of drivers) {
      const driverData = {
        _id: driver._id,
        name: driver.name || "Unnamed Driver",
        email: driver.email || "No email",
        phone: driver.phone || null,
        vehicleType: driver.vehicleType || null,
        documentStatus: driver.documentStatus || "pending",
        isVerified: driver.isVerified || false,
        isBlocked: driver.isBlocked || false,
      };

      // ✅ Add profile photo URL
      if (driver.profilePhotoUrl) {
        let photoUrl = driver.profilePhotoUrl;
        if (!photoUrl.startsWith('http')) {
          let cleanPath = photoUrl.replace(/\\/g, "/");
          const uploadsIndex = cleanPath.indexOf("uploads/");
          if (uploadsIndex !== -1) {
            cleanPath = cleanPath.substring(uploadsIndex);
          } else if (!cleanPath.startsWith("uploads/")) {
            cleanPath = `uploads/${path.basename(cleanPath)}`;
          }
          photoUrl = `${baseUrl}/${cleanPath}`;
        }
        driverData.profilePhotoUrl = photoUrl;
      }

      // ✅ VERIFIED DRIVERS - Don't fetch documents at all
      if (driver.documentStatus === "approved" && driver.isVerified === true) {
        // ✅ Query by MongoDB _id
        const docCount = await DriverDoc.countDocuments({
          userId: driver._id,
          imageDeleted: { $ne: true },
        });

        result.verified.push({
          ...driverData,
          isFullyVerified: true,
          totalDocs: docCount,
          documents: [],
        });
        continue;
      }

      // ✅ NON-VERIFIED DRIVERS - Fetch only pending + rejected docs
      // ✅ Query by MongoDB _id
      const docs = await DriverDoc.find({
        userId: driver._id,
        status: { $in: ["pending", "rejected"] },
        imageDeleted: { $ne: true },
      }).lean();

      console.log(`📋 Driver ${driver.name}: found ${docs.length} pending/rejected docs`);

      // If no pending/rejected docs, check if all are verified
      if (docs.length === 0) {
        const allDocsCount = await DriverDoc.countDocuments({
          userId: driver._id,
          imageDeleted: { $ne: true },
        });

        if (allDocsCount > 0) {
          result.verified.push({
            ...driverData,
            isFullyVerified: true,
            totalDocs: allDocsCount,
            documents: [],
          });
        }
        continue;
      }

      // Add image URLs to documents
      const docsWithUrls = docs.map((doc) => {
        let imageUrl = null;
        
        if (doc.url) {
          let cleanPath = doc.url.replace(/\\/g, "/");
          
          const uploadsIndex = cleanPath.indexOf("uploads/");
          if (uploadsIndex !== -1) {
            cleanPath = cleanPath.substring(uploadsIndex);
          } else if (!cleanPath.startsWith("uploads/")) {
            const filename = path.basename(cleanPath);
            cleanPath = `uploads/${filename}`;
          }
          
          imageUrl = `${baseUrl}/${cleanPath}`;
        }

        return {
          ...doc,
          imageUrl,
        };
      });

      const hasPending = docsWithUrls.some((d) => d.status === "pending");
      const hasRejected = docsWithUrls.some((d) => d.status === "rejected");

      const driverWithDocs = {
        ...driverData,
        documents: docsWithUrls,
      };

      if (hasRejected) {
        result.rejected.push(driverWithDocs);
      } else if (hasPending) {
        result.pending.push(driverWithDocs);
      }
    }

    console.log(`\n✅ Final counts:`);
    console.log(`   Pending: ${result.pending.length} drivers`);
    console.log(`   Rejected: ${result.rejected.length} drivers`);
    console.log(`   Verified: ${result.verified.length} drivers`);

    res.status(200).json({
      success: true,
      message: "Drivers with document status fetched",
      data: result,
      counts: {
        pending: result.pending.length,
        rejected: result.rejected.length,
        verified: result.verified.length,
      },
    });
  } catch (err) {
    console.error("❌ Error in getDriversWithDocStatus:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

/**
 * @desc    Get documents for a specific driver - OPTIMIZED
 * @route   GET /api/admin/documents/:driverId/actionable
 */
export const getActionableDriverDocuments = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { status } = req.query;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    // ✅ FIX: Validate MongoDB ID
    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({ message: "Invalid driver ID" });
    }

    // ✅ FIX: Query directly by MongoDB _id
    const query = {
      userId: driverId,
      imageDeleted: { $ne: true },
    };

    if (status && ["pending", "rejected"].includes(status)) {
      query.status = status;
    } else {
      query.status = { $in: ["pending", "rejected"] };
    }

    const documents = await DriverDoc.find(query).lean();

    const docsWithUrls = documents.map((doc) => {
      let imageUrl = null;
      if (doc.url) {
        let cleanPath = doc.url.replace(/\\/g, "/");
        const uploadsIndex = cleanPath.indexOf("uploads/");
        if (uploadsIndex !== -1) {
          cleanPath = cleanPath.substring(uploadsIndex);
        } else if (!cleanPath.startsWith("uploads/")) {
          cleanPath = `uploads/${path.basename(cleanPath)}`;
        }
        imageUrl = `${baseUrl}/${cleanPath}`;
      }
      return { ...doc, imageUrl };
    });

    res.status(200).json({
      success: true,
      docs: docsWithUrls,
      count: docsWithUrls.length,
    });
  } catch (err) {
    console.error("❌ Error fetching actionable documents:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// ✅ FIXED getDriverDocuments - Uses MongoDB _id directly
export const getDriverDocuments = async (req, res) => {
  try {
    const { driverId } = req.params;
    
    // ✅ Get base URL dynamically from request
    const protocol = req.protocol; // http or https
    const host = req.get("host");  // domain:port or ngrok URL
    const baseUrl = `${protocol}://${host}`;

    console.log(`\n📋 Fetching documents for driver: ${driverId}`);
    console.log(`🌐 Base URL: ${baseUrl}`);

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({ message: "Invalid driver ID" });
    }

    const documents = await DriverDoc.find({
      userId: driverId,
      imageDeleted: { $ne: true },
    }).lean();

    console.log(`📄 Found ${documents.length} documents`);

    const docsWithImageUrl = documents.map((doc) => {
      let imageUrl = null;
      
      if (doc.url) {
        if (doc.url.startsWith('http')) {
          // ✅ Already a complete URL (Cloudinary)
          imageUrl = doc.url;
        } else {
          // ✅ Build COMPLETE URL for local files
          // IMPORTANT: Include /api in the path
          imageUrl = `${baseUrl}/api/admin/document-image/${doc._id}`;
        }
      }

      console.log(`  📄 ${doc.docType} (${doc.side}): ${imageUrl}`);

      return {
        ...doc,
        imageUrl, // ✅ This is now a COMPLETE URL
      };
    });

    res.status(200).json({
      message: "Documents retrieved successfully.",
      docs: docsWithImageUrl,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

export const getDocumentById = async (req, res) => {
  try {
    const { docId } = req.params;
    const document = await DriverDoc.findById(docId).lean();
    
    if (!document) {
      return res.status(404).json({ message: "Document not found." });
    }

    // ✅ FIX: Find user by MongoDB _id
    const user = await User.findById(document.userId)
      .select("name email phone")
      .lean();

    res.status(200).json({ 
      message: "Document details fetched successfully.", 
      document: {
        ...document,
        driver: user
      }
    });
  } catch (err) {
    console.error("❌ Error fetching document by ID:", err);
    res.status(500).json({ message: "Server error." });
  }
};

export const verifyDriverDocument = async (req, res) => {
  try {
    const { docId } = req.params;
    const { status, remarks, extractedData } = req.body;

    if (!["approved", "rejected", "verified"].includes(status)) {
      return res.status(400).json({ message: "Invalid status." });
    }

    const updates = { status, remarks };
    if (extractedData && typeof extractedData === "object") {
      updates.extractedData = extractedData;
    }

    const updatedDoc = await DriverDoc.findByIdAndUpdate(docId, updates, {
      new: true,
    });

    if (!updatedDoc) {
      return res.status(404).json({ message: "Document not found." });
    }

    // ✅ CORRECT: updatedDoc.userId is MongoDB _id now
    if (updatedDoc.userId) {
      await recomputeDriverDocumentStatus(updatedDoc.userId.toString());
    }

    // Fetch updated user
    const updatedUser = updatedDoc.userId
      ? await User.findById(updatedDoc.userId)
          .select("_id name phone documentStatus isVerified vehicleType")
          .lean()
      : null;

    return res.status(200).json({
      message: `Document ${status} successfully.`,
      document: updatedDoc,
      driver: updatedUser,
    });
  } catch (err) {
    console.error("❌ Error updating document status:", err);
    return res.status(500).json({ message: "Server error while verifying document." });
  }
};

// Delete document image to free backend space
export const deleteDriverDocumentImage = async (req, res) => {
  try {
    const { docId } = req.params;
    const doc = await DriverDoc.findById(docId);
    if (!doc) return res.status(404).json({ message: "Document not found." });
    if (!doc.url) return res.status(400).json({ message: "No image stored for this document." });

    let filePath = doc.url.replace(/\\/g, "/");
    const uploadsIndex = filePath.indexOf("uploads/");
    if (uploadsIndex !== -1)
      filePath = path.join(process.cwd(), filePath.substring(uploadsIndex));
    else filePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Deleted file: ${filePath}`);
    } else console.warn(`⚠️ File not found: ${filePath}`);

    doc.url = null;
    doc.imageDeleted = true;
    doc.imageDeletedAt = new Date();
    await doc.save();

    res.status(200).json({ message: "Document image deleted and DB updated.", doc });
  } catch (err) {
    console.error("❌ Error deleting document image:", err);
    res.status(500).json({ message: "Server error while deleting document image.", error: err.message });
  }
};

// ======================================================================
// 🔐 Admin Login
// ======================================================================
export const adminLogin = async (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ email, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1d" });
    return res.status(200).json({ token });
  } else {
    return res.status(401).json({ message: "Invalid email or password." });
  }
};