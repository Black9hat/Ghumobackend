//src/controllers/adminController.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import mongoose from "mongoose";

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from "child_process";

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

const resolveDocumentFilePath = (storedPath) => {
  if (!storedPath || typeof storedPath !== "string") return null;

  let cleanPath = storedPath.replace(/\\/g, "/").trim();
  const uploadsIndex = cleanPath.indexOf("uploads/");

  // Treat URL-like app paths (/uploads/...) as workspace-relative, not OS-root absolute.
  if (uploadsIndex !== -1) {
    return path.join(process.cwd(), cleanPath.substring(uploadsIndex));
  }

  if (path.isAbsolute(cleanPath)) {
    return cleanPath;
  }

  // On non-Windows hosts, values like "E:/..." are not platform-absolute.
  // Resolve them against cwd so downstream sendFile/get stream receives absolute paths.
  if (/^[A-Za-z]:[\\/]/.test(cleanPath)) {
    return path.resolve(cleanPath);
  }

  return path.join(process.cwd(), "uploads", "documents", path.basename(cleanPath));
};

const resolveExistingDocumentFilePath = (storedPath) => {
  if (!storedPath || typeof storedPath !== "string") return null;

  const candidates = [];
  const normalized = storedPath.replace(/\\/g, "/").trim();

  const primary = resolveDocumentFilePath(normalized);
  if (primary) candidates.push(primary);

  // Handle full URL values and strip query/hash if present.
  try {
    if (/^https?:\/\//i.test(normalized)) {
      const parsedUrl = new URL(normalized);
      const pathname = (parsedUrl.pathname || "").replace(/\\/g, "/");
      const uploadsIndex = pathname.indexOf("uploads/");
      if (uploadsIndex !== -1) {
        candidates.push(path.join(process.cwd(), pathname.substring(uploadsIndex)));
      }
    }
  } catch {
    // Ignore URL parse errors and continue with fallback candidates.
  }

  // Common upload fallback locations by filename.
  const fileName = path.basename(normalized.split("?")[0].split("#")[0]);
  if (fileName) {
    candidates.push(path.join(process.cwd(), "uploads", "documents", fileName));
    candidates.push(path.join(process.cwd(), "uploads", fileName));
  }

  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
  return uniqueCandidates.find((p) => fs.existsSync(p)) || null;
};

const findDocumentFileForDoc = async (doc) => {
  if (!doc) return null;

  // 1) Try the currently stored path first.
  const direct = resolveExistingDocumentFilePath(doc.url);
  if (direct) return direct;

  // 2) If we have permanent folder, try to match docType_side.* there.
  const folder = doc.docPath;
  if (folder && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
    const expectedPrefix = `${(doc.docType || "document").toLowerCase()}_${
      (doc.side || "front").toLowerCase()
    }`;

    const folderFiles = fs.readdirSync(folder).filter((f) => {
      const full = path.join(folder, f);
      return fs.existsSync(full) && fs.statSync(full).isFile();
    });

    const exactPrefixFile = folderFiles.find(
      (f) => f.toLowerCase().startsWith(expectedPrefix.toLowerCase() + ".")
    );
    if (exactPrefixFile) {
      const recovered = path.join(folder, exactPrefixFile);
      await DriverDoc.updateOne({ _id: doc._id }, { $set: { url: recovered } });
      return recovered;
    }

    // Fallback by side (for legacy naming).
    const sideToken = `_${(doc.side || "front").toLowerCase()}`;
    const sideFile = folderFiles.find((f) =>
      f.toLowerCase().includes(sideToken)
    );
    if (sideFile) {
      const recovered = path.join(folder, sideFile);
      await DriverDoc.updateOne({ _id: doc._id }, { $set: { url: recovered } });
      return recovered;
    }
  }

  return null;
};

const resolveAdminSaveBasePath = (rawPath) => {
  const normalized = String(rawPath || "").trim();
  const isRenderRuntime = !!process.env.RENDER || process.env.NODE_ENV === "production";

  // In Render/production, use server-controlled storage path instead of trusting client OS paths.
  if (isRenderRuntime) {
    const configuredBase = String(process.env.DRIVER_DOCS_BASE_PATH || "").trim();
    const defaultBase = path.join(process.cwd(), "storage", "driverdocs");
    return path.resolve(configuredBase || defaultBase);
  }

  if (!normalized) return null;

  const isWindowsStyleDrivePath = /^[A-Za-z]:[\\/]/.test(normalized);
  const isWindowsRuntime = process.platform === "win32";

  if (!isWindowsRuntime && isWindowsStyleDrivePath) {
    throw new Error(
      `Invalid saveFolderPath for ${process.platform}: "${normalized}". Use a Linux absolute path (e.g. /data/driverdocs) or run backend on Windows for drive-letter paths.`
    );
  }

  return path.resolve(normalized);
};

const getFallbackDocsBasePath = () => path.resolve(path.join(process.cwd(), "storage", "driverdocs"));

const ensureDirectoryWritable = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.accessSync(dirPath, fs.constants.W_OK);
};

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
    // ──── UPDATED getAllDrivers select ────
    const drivers = await User.find({ isDriver: true })
      .select("name email phone vehicleType seats vehicleModel profilePhotoUrl photo profilePic driverPhoto avatar isBlocked isSuspended isOnline strikes vehicleNumber vehicleBrand rating deviceId documentStatus isVerified createdAt");

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

      // ──── UPDATED driver map return object ────
      return {
        _id: d._id,
        name: d.name,
        email: d.email,
        phone: d.phone,
        vehicleType: d.vehicleType,
        seats: d.seats ?? null,         // ✅ seat count for car/xl
        vehicleModel: d.vehicleModel || null, // ✅ e.g. "Swift", "Honda City"
        vehicleNumber: d.vehicleNumber,
        vehicleBrand: d.vehicleBrand,
        profilePhotoUrl: finalPhotoUrl,
        isBlocked: d.isBlocked || false,
        isSuspended: d.isSuspended || false,
        isOnline: d.isOnline || false,
        strikes: d.strikes || 0,
        rating: d.rating,
        deviceId: d.deviceId,
        documentStatus: d.documentStatus,
        isVerified: d.isVerified,
        createdAt: d.createdAt,
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

// ──── NEW: suspendDriver ────
export const suspendDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    const driver = await User.findByIdAndUpdate(
      driverId,
      { isSuspended: true, $inc: { strikes: 1 } },
      { new: true }
    );
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });
    res.status(200).json({ success: true, message: 'Driver suspended successfully.', strikes: driver.strikes });
  } catch (err) {
    console.error('❌ Error suspending driver:', err);
    res.status(500).json({ success: false, message: 'Error suspending driver.' });
  }
};

// ──── NEW: approveDriver ────
export const approveDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    const driver = await User.findByIdAndUpdate(
      driverId,
      { isSuspended: false, isBlocked: false, documentStatus: 'approved', isVerified: true },
      { new: true }
    );
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });
    res.status(200).json({ success: true, message: 'Driver approved successfully.' });
  } catch (err) {
    console.error('❌ Error approving driver:', err);
    res.status(500).json({ success: false, message: 'Error approving driver.' });
  }
};

// ──── NEW: rejectDriver ────
export const rejectDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    const driver = await User.findByIdAndUpdate(
      driverId,
      { isSuspended: false, isBlocked: true, documentStatus: 'rejected', isVerified: false },
      { new: true }
    );
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });
    res.status(200).json({ success: true, message: 'Driver rejected successfully.' });
  } catch (err) {
    console.error('❌ Error rejecting driver:', err);
    res.status(500).json({ success: false, message: 'Error rejecting driver.' });
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
    
    // 🔥 FIX: Prevent double-sending to the same token
    const processedTokens = new Set();
    let successCount = 0;
    let fcmSuccessCount = 0;

    for (const user of users) {
      try {
        // 🛡️ Skip if token already processed in this run
        if (user.fcmToken) {
          if (processedTokens.has(user.fcmToken)) {
            console.log(`🛡️ Skipping duplicate token for user ${user._id}`);
            continue;
          }
          processedTokens.add(user.fcmToken);
        }

        await createAndSendNotification({
          user,
          title,
          body,
          type,
          imageUrl: imageUrl || null,
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

    // ✅ CASE 2: Local upload (both relative and absolute paths)
    let cleanPath = document.url.replace(/\\/g, "/");
    
    // Check if it's an absolute path (e.g., D:/DriverDocuments/...)
    let fullPath;
    if (path.isAbsolute(cleanPath) || cleanPath.includes(":")) {
      // Absolute path - use as-is
      fullPath = cleanPath;
    } else {
      // Relative path - resolve from current working directory
      if (!cleanPath.startsWith("uploads/")) {
        cleanPath = `uploads/${path.basename(cleanPath)}`;
      }
      fullPath = path.join(process.cwd(), cleanPath);
    }

    console.log(`📸 Attempting to serve document: docId=${docId}, path=${fullPath}`);

    if (!fs.existsSync(fullPath)) {
      console.warn(`❌ Document file not found at: ${fullPath}`);
      return res.status(404).json({ error: "Local image not found" });
    }

    // Set appropriate content type
    const ext = path.extname(fullPath).toLowerCase();
    const contentTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".pdf": "application/pdf",
    };
    
    const contentType = contentTypes[ext] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    
    console.log(`✅ Serving document: ${fullPath} (${contentType})`);
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
    
    // Path resolution for both relative and absolute paths
    let cleanPath = document.url.replace(/\\/g, "/");
    
    let fullFilePath;
    if (path.isAbsolute(cleanPath) || cleanPath.includes(":")) {
      // Absolute path - use as-is
      fullFilePath = cleanPath;
    } else {
      // Relative path - resolve from current working directory
      const uploadsIndex = cleanPath.indexOf('uploads/');
      if (uploadsIndex !== -1) {
        cleanPath = cleanPath.substring(uploadsIndex);
      } else if (!cleanPath.startsWith('uploads/')) {
        cleanPath = `uploads/${path.basename(cleanPath)}`;
      }
      fullFilePath = path.join(process.cwd(), cleanPath);
    }
    
    console.log(`📍 Resolved file path: ${fullFilePath}`);
    
    if (!fs.existsSync(fullFilePath)) {
      console.warn(`❌ File not found: ${fullFilePath}`);
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

    // Get driver info to include in response
    const driver = await User.findById(driverId).select("phone vehicleType").lean();

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

    // ✅ Compute folder path for response
    let folderPath = null;
    if (driver && driver.phone && driver.vehicleType) {
      const sanitizedPhone = (driver.phone || "").replace(/[^0-9+]/g, "") || "unknown";
      const vehicleType = (driver.vehicleType || "").toLowerCase() || "other";
      folderPath = `D:/DriverDocuments/${sanitizedPhone}_${vehicleType}/`;
    }

    res.status(200).json({
      message: "Documents retrieved successfully.",
      docs: docsWithImageUrl,
      folderPath: folderPath,
      phoneNumber: driver?.phone,
      vehicleType: driver?.vehicleType,
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

// ✅ ENHANCED: Verify/Approve Document with File Movement to Custom Folder Path
export const verifyDriverDocument = async (req, res) => {
  try {
    const { docId } = req.params;
    const { status, remarks, extractedData, saveFolderPath } = req.body;
    const normalizedSaveFolderPath = String(saveFolderPath || "").trim();
    const isApprovedStatus = status === "approved" || status === "verified";
    const isRenderRuntime = !!process.env.RENDER || process.env.NODE_ENV === "production";

    if (!["approved", "rejected", "verified"].includes(status)) {
      return res.status(400).json({ message: "Invalid status." });
    }

    // Get document first
    const doc = await DriverDoc.findById(docId);
    if (!doc) {
      return res.status(404).json({ message: "Document not found." });
    }

    // Get driver info for file path construction
    const driver = await User.findById(doc.userId).select("phone vehicleType").lean();
    if (!driver) {
      return res.status(404).json({ message: "Driver not found." });
    }

    const updates = { status, remarks };
    let actualSavedFolder = null;
    if (extractedData && typeof extractedData === "object") {
      updates.extractedData = extractedData;
    }

    const normalizedDocType = String(doc.docType || "")
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const isProfileDocumentType = [
      "profile",
      "profile_photo",
      "profilephoto",
      "profile_picture",
      "profilepicture",
      "selfie",
      "photo",
    ].includes(normalizedDocType);

    if (isApprovedStatus && isProfileDocumentType) {
      // Profile photos are approve/reject only. Do not move/copy into custom folders.
      updates.approvedAt = new Date();
      updates.approvedBy = "admin";
    }

    // 🔄 IF APPROVED/VERIFIED: Move files to custom save folder path
    const shouldMoveToStorage =
      isApprovedStatus && !isProfileDocumentType && doc.url && (isRenderRuntime || !!normalizedSaveFolderPath);

    if (shouldMoveToStorage) {
      try {
        const baseSavePath = resolveAdminSaveBasePath(normalizedSaveFolderPath);
        const sanitizedPhone = (driver.phone || "").replace(/[^0-9+]/g, "") || "unknown";
        const vehicleType = (driver.vehicleType || "").toLowerCase() || "other";
        
        // Create permanent storage directory based on admin's selected path: {saveFolderPath}/{mobile}_{vehicleType}/
        let permStorageDir = path.join(
          baseSavePath,
          `${sanitizedPhone}_${vehicleType}`
        );
        
        console.log(`📁 Using custom save folder: ${permStorageDir}`);

        // Ensure destination is writable. If configured production path is not writable,
        // fallback to app-local storage so approval flow continues.
        try {
          ensureDirectoryWritable(permStorageDir);
        } catch (dirErr) {
          if (dirErr?.code !== "EACCES") {
            throw dirErr;
          }

          const fallbackBasePath = getFallbackDocsBasePath();
          const fallbackDir = path.join(
            fallbackBasePath,
            `${sanitizedPhone}_${vehicleType}`
          );

          console.warn(
            `⚠️ Save path not writable (${permStorageDir}). Falling back to: ${fallbackDir}`
          );

          ensureDirectoryWritable(fallbackDir);
          permStorageDir = fallbackDir;
        }

        actualSavedFolder = permStorageDir;
        console.log(`📁 Final save folder: ${permStorageDir}`);

        // Build destination first so we can safely recover if source was already moved.
        const docType = (doc.docType || "document").toLowerCase();
        const side = doc.side ? doc.side.toLowerCase() : "single";
        const inferredExt = path.extname(doc.url || "") || ".jpg";
        const newFileName = `${docType}_${side}${inferredExt}`;
        const destPath = path.join(permStorageDir, newFileName);

        // Resolve source file path from stored URL/path.
        const sourcePath = resolveExistingDocumentFilePath(doc.url);
        if (!sourcePath) {
          if (fs.existsSync(destPath)) {
            console.warn(`⚠️ Source missing but destination already exists, reusing: ${destPath}`);
            updates.url = destPath;
            updates.docPath = permStorageDir;
            updates.approvedAt = new Date();
            updates.approvedBy = "admin";
            const updatedDoc = await DriverDoc.findByIdAndUpdate(docId, updates, {
              new: true,
            });

            if (!updatedDoc) {
              return res.status(404).json({ message: "Document not found." });
            }

            if (updatedDoc.userId) {
              await recomputeDriverDocumentStatus(updatedDoc.userId.toString());
            }

            const updatedUser = updatedDoc.userId
              ? await User.findById(updatedDoc.userId)
                  .select("_id name phone documentStatus isVerified vehicleType")
                  .lean()
              : null;

            return res.status(200).json({
              message: `Document ${status} successfully.`,
              document: updatedDoc,
              driver: updatedUser,
              savedFolder: actualSavedFolder,
            });
          }

          throw new Error(`Source file not found for stored path: ${doc.url}`);
        }

        const fileExt = path.extname(sourcePath) || inferredExt;
        const normalizedDestPath = path.join(permStorageDir, `${docType}_${side}${fileExt}`);

        console.log(`📋 Processing document: ${docType} (${side}) → ${path.basename(normalizedDestPath)}`);

        // Use copy semantics so batch-verify does not break when two records share same source file.
        if (path.resolve(sourcePath) !== path.resolve(normalizedDestPath)) {
          fs.copyFileSync(sourcePath, normalizedDestPath);
          console.log(`✅ Copied document to custom folder: ${normalizedDestPath}`);
        } else {
          console.log(`ℹ️ Source already at destination: ${normalizedDestPath}`);
        }

        // ✅ Update document record with new path and approval info
        updates.url = normalizedDestPath;
        updates.docPath = permStorageDir;
        updates.approvedAt = new Date();
        updates.approvedBy = "admin"; // Can be enhanced to include actual admin name from token
      } catch (fileErr) {
        console.error("❌ Error moving document to custom folder:", fileErr);
        return res.status(500).json({
          message: "Failed to move approved document to selected folder",
          error: fileErr.message,
          docId,
        });
      }
    } else if (isApprovedStatus && doc.url && !normalizedSaveFolderPath) {
      // ⚠️ Approved/verified without custom folder path - just mark status without moving
      console.warn("⚠️ Document approved/verified without custom save folder path");
      updates.approvedAt = new Date();
      updates.approvedBy = "admin";
    }

    const updatedDoc = await DriverDoc.findByIdAndUpdate(docId, updates, {
      new: true,
    });

    if (!updatedDoc) {
      return res.status(404).json({ message: "Document not found." });
    }

    // ✅ Recompute driver document status
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
      savedFolder: actualSavedFolder,
    });
  } catch (err) {
    console.error("❌ Error updating document status:", err);
    return res.status(500).json({ message: "Server error while verifying document." });
  }
};

const getDriverSavedFolderPath = async (driver) => {
  const sanitizedPhone = (driver.phone || "").replace(/[^0-9+]/g, "") || "unknown";
  const vehicleType = (driver.vehicleType || "").toLowerCase() || "other";

  // Prefer the folder actually used during approval/verification.
  const latestDocWithPath = await DriverDoc.findOne({
    userId: driver._id,
    docPath: { $exists: true, $nin: [null, ""] },
    status: { $in: ["verified", "approved"] },
  })
    .sort({ updatedAt: -1 })
    .select("docPath")
    .lean();

  if (latestDocWithPath?.docPath) {
    return latestDocWithPath.docPath;
  }

  // Backward-compatible fallback for old records.
  return `D:/DriverDocuments/${sanitizedPhone}_${vehicleType}`;
};

const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findDriverByMobile = async (mobile, selectFields) => {
  const raw = String(mobile || "").trim();
  const digits = raw.replace(/\D/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;

  const exactCandidates = Array.from(
    new Set(
      [
        raw,
        digits,
        last10,
        `+${digits}`,
        `+91${last10}`,
        `91${last10}`,
      ].filter(Boolean)
    )
  );

  let driver = await User.findOne({ phone: { $in: exactCandidates } })
    .select(selectFields)
    .lean();

  if (!driver && last10.length === 10) {
    const suffixRegex = new RegExp(`${escapeRegex(last10)}$`);
    driver = await User.findOne({ phone: { $regex: suffixRegex } })
      .select(selectFields)
      .lean();
  }

  return driver;
};

export const selectSaveFolder = async (_req, res) => {
  try {
    if (process.platform !== "win32") {
      return res.status(400).json({
        success: false,
        message: "Folder picker is supported only on Windows server",
      });
    }

    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Select base folder for approved documents'",
      "$dialog.ShowNewFolderButton = $true",
      "$result = $dialog.ShowDialog()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  Write-Output $dialog.SelectedPath",
      "}",
    ].join("; ");

    const selectedPath = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: false,
      }
    )
      .toString()
      .trim();

    if (!selectedPath) {
      return res.status(200).json({
        success: false,
        cancelled: true,
        message: "Folder selection cancelled",
      });
    }

    return res.status(200).json({
      success: true,
      selectedPath,
    });
  } catch (err) {
    console.error("❌ Error selecting save folder:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to open folder picker",
      error: err.message,
    });
  }
};

// ✅ NEW: Selective Rejection - Delete ONLY specific document type
export const rejectSpecificDocument = async (req, res) => {
  try {
    const { driverId, docType } = req.params;
    const { remarks } = req.body || {};

    if (!driverId || !docType) {
      return res.status(400).json({ 
        message: "driverId and docType are required" 
      });
    }

    const docTypeNormalized = docType.toLowerCase().trim();

    // Validate driverId is ObjectId
    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({ message: "Invalid driver ID" });
    }

    const userId = new mongoose.Types.ObjectId(driverId);

    // Find document(s) of this type for the driver
    const docsToReject = await DriverDoc.find({
      userId: userId,
      docType: docTypeNormalized,
      imageDeleted: { $ne: true },
    });

    if (docsToReject.length === 0) {
      return res.status(404).json({ 
        message: `No documents of type "${docType}" found for this driver` 
      });
    }

    const rejectedDocs = [];
    let deletedCount = 0;

    // Process each document (usually just 1 per type, but handle multiple)
    for (const doc of docsToReject) {
      try {
        // Delete file from temp/uploads folder
        if (doc.url) {
          let filePath = doc.url.replace(/\\/g, "/");
          
          // Resolve absolute path
          if (!path.isAbsolute(filePath)) {
            if (filePath.startsWith("uploads/")) {
              filePath = path.join(process.cwd(), filePath);
            } else {
              filePath = path.join(process.cwd(), "uploads", "documents", path.basename(filePath));
            }
          }

          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Deleted ${docType} file: ${filePath}`);
            deletedCount++;
          } else {
            console.warn(`⚠️ File not found for deletion: ${filePath}`);
          }
        }

        // Mark document as rejected in database
        doc.status = "rejected";
        doc.remarks = remarks || `Document rejected: ${docType}`;
        doc.imageDeleted = true;
        doc.imageDeletedAt = new Date();
        await doc.save();

        rejectedDocs.push({
          _id: doc._id,
          docType: doc.docType,
          side: doc.side,
          status: doc.status,
        });

        console.log(`✅ Marked ${docType} as rejected in DB`);
      } catch (err) {
        console.error(`❌ Error processing ${docType} document:`, err);
      }
    }

    // Recompute driver document status
    await recomputeDriverDocumentStatus(userId.toString());

    const updatedDriver = await User.findById(userId)
      .select("_id name phone documentStatus isVerified vehicleType")
      .lean();

    return res.status(200).json({
      success: true,
      message: `Successfully rejected ${docType} document(s)`,
      rejectedDocuments: rejectedDocs,
      filesDeleted: deletedCount,
      driver: updatedDriver,
    });
  } catch (err) {
    console.error("❌ Error rejecting specific document:", err);
    return res.status(500).json({ 
      message: "Server error while rejecting document",
      error: err.message 
    });
  }
};

// ✅ NEW: Download all driver documents as ZIP
export const downloadAllDriverDocuments = async (req, res) => {
  try {
    const { mobile } = req.params;

    if (!mobile) {
      return res.status(400).json({ message: "Mobile number is required" });
    }

    // Find driver by mobile (supports +91 and formatted variants)
    const driver = await findDriverByMobile(mobile, "_id name phone vehicleType");

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    // Find all documents for this driver (non-deleted)
    const documents = await DriverDoc.find({
      userId: driver._id,
      imageDeleted: { $ne: true },
      url: { $exists: true, $ne: null },
    }).lean();

    if (documents.length === 0) {
      return res.status(404).json({ message: "No documents found for this driver" });
    }

    // Collect all file paths (handle both absolute and relative)
    const filePaths = [];
    for (const doc of documents) {
      if (doc.url || doc.docPath) {
        const fullPath = await findDocumentFileForDoc(doc);
        
        if (fullPath && fs.existsSync(fullPath)) {
          filePaths.push({
            path: fullPath,
            name: `${doc.docType}${doc.side ? "_" + doc.side : ""}${path.extname(fullPath)}`,
          });
          console.log(`✅ Added to ZIP: ${filePaths[filePaths.length - 1].name} (${fullPath})`);
        } else {
          console.warn(`⚠️ Skipping missing file for doc ${doc._id}: url=${doc.url}, docPath=${doc.docPath}`);
        }
      }
    }

    if (filePaths.length === 0) {
      return res.status(404).json({ message: "No document files found on storage" });
    }

    // Set response headers for download
    const fileName = `${mobile}_documents_${Date.now()}.zip`;
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    // Use archiver to create ZIP
    try {
      const archiver = require("archiver");
      const archive = archiver("zip", { zlib: { level: 9 } });

      archive.on("error", (err) => {
        console.error("❌ Archive error:", err);
        res.status(500).json({ message: "Error creating archive" });
      });

      archive.pipe(res);

      for (const file of filePaths) {
        const stream = fs.createReadStream(file.path);
        archive.append(stream, { name: file.name });
      }

      await archive.finalize();
      console.log(`📦 ZIP created: ${fileName} (${filePaths.length} files)`);
    } catch (err) {
      // Fallback: if archiver not available and only one file, send it directly
      if (filePaths.length === 1) {
        console.log("⚠️ Archiver not available, sending single file");
        const ext = path.extname(filePaths[0].path).toLowerCase();
        const contentTypes = {
          ".pdf": "application/pdf",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".png": "image/png",
        };
        res.setHeader("Content-Type", contentTypes[ext] || "application/octet-stream");
        const absoluteFilePath = path.resolve(filePaths[0].path);
        res.sendFile(absoluteFilePath);
      } else {
        return res.status(500).json({ 
          message: "Archiver not installed. Install with: npm install archiver" 
        });
      }
    }
  } catch (err) {
    console.error("❌ Error downloading documents:", err);
    return res.status(500).json({ message: "Server error while downloading documents" });
  }
};

// ✅ NEW: Download single document file
export const downloadSingleDocument = async (req, res) => {
  try {
    const { docId } = req.params;

    if (!docId) {
      return res.status(400).json({ message: "Document ID is required" });
    }

    // Validate docId is ObjectId
    if (!mongoose.Types.ObjectId.isValid(docId)) {
      return res.status(400).json({ message: "Invalid document ID" });
    }

    const doc = await DriverDoc.findById(docId).lean();

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (!doc.url) {
      return res.status(404).json({ message: "Document file not found" });
    }

    const filePath = await findDocumentFileForDoc(doc);
    
    console.log(`📥 Downloading document: docId=${docId}, path=${filePath}, exists=${filePath ? fs.existsSync(filePath) : false}`);

    if (!filePath || !fs.existsSync(filePath)) {
      console.warn(`❌ File not found at: ${filePath}`);
      return res.status(404).json({ message: "Document file not found on storage" });
    }

    // Get file extension and set proper content-type
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".pdf": "application/pdf",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";
    
    // Construct download filename
    const downloadFileName = `${doc.docType}${doc.side ? "_" + doc.side : ""}${ext}`;
    
    // Set response headers
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName}"`);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    
    const fileSize = fs.statSync(filePath).size;
    console.log(`✅ Serving file: ${downloadFileName} (${contentType}, ${fileSize} bytes)`);

    // Send file
    const absoluteFilePath = path.resolve(filePath);

    return res.sendFile(absoluteFilePath, (err) => {
      if (err) {
        console.error("❌ Download error:", err);
      } else {
        console.log(`📥 Successfully downloaded: ${downloadFileName}`);
      }
    });
  } catch (err) {
    console.error("❌ Error downloading document:", err);
    return res.status(500).json({ message: "Server error while downloading document" });
  }
};

// ✅ NEW: Get List of Saved Documents by Mobile Number
export const getSavedDocuments = async (req, res) => {
  try {
    const { mobile } = req.params;

    if (!mobile) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required"
      });
    }

    // Find the driver to get vehicle type
    const driver = await findDriverByMobile(mobile, "_id phone vehicleType name");

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found"
      });
    }

    const vehicleType = (driver.vehicleType || "").toLowerCase() || "other";
    const folderPath = await getDriverSavedFolderPath(driver);

    console.log(`📂 Listing saved documents for: ${mobile} → ${folderPath}`);

    // Check if folder exists
    if (!fs.existsSync(folderPath)) {
      console.log(`⚠️ Folder not found: ${folderPath}`);
      return res.status(200).json({
        success: true,
        message: "No saved documents found",
        folderPath: folderPath,
        vehicleType: vehicleType,
        files: [],
        totalFiles: 0
      });
    }

    // Read all files in the folder
    const files = fs.readdirSync(folderPath);
    
    // Build file list with metadata
    const fileList = files
      .filter(file => {
        // Exclude directories
        const fullPath = path.join(folderPath, file);
        return fs.statSync(fullPath).isFile();
      })
      .map(file => {
        const fullPath = path.join(folderPath, file);
        const stats = fs.statSync(fullPath);
        const ext = path.extname(file).toLowerCase();
        
        // Determine file type
        let type = "file";
        if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
          type = "image";
        } else if ([".pdf"].includes(ext)) {
          type = "pdf";
        }

        return {
          name: file,
          size: stats.size,
          type: type,
          ext: ext,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`✅ Found ${fileList.length} files in ${folderPath}`);

    return res.status(200).json({
      success: true,
      message: `Found ${fileList.length} saved document(s)`,
      folderPath: folderPath,
      vehicleType: vehicleType,
      driverName: driver.name,
      driverPhone: driver.phone,
      files: fileList,
      totalFiles: fileList.length
    });
  } catch (err) {
    console.error("❌ Error listing saved documents:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while listing documents",
      error: err.message
    });
  }
};

// ✅ NEW: Download Saved Document by Filename
export const downloadSavedDocument = async (req, res) => {
  try {
    const { mobile, filename } = req.params;

    if (!mobile || !filename) {
      return res.status(400).json({
        success: false,
        message: "Mobile number and filename are required"
      });
    }

    // Security: prevent directory traversal
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return res.status(400).json({
        success: false,
        message: "Invalid filename"
      });
    }

    // Find the driver to get vehicle type
    const driver = await findDriverByMobile(mobile, "_id phone vehicleType");

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found"
      });
    }

    const folderPath = await getDriverSavedFolderPath(driver);
    const filePath = path.join(folderPath, filename);

    console.log(`📥 Download request: ${mobile} → ${filename}`);
    console.log(`   Full path: ${filePath}`);

    // Security: ensure file is within the folder
    const resolvedFolderPath = path.resolve(folderPath);
    const resolvedFilePath = path.resolve(filePath);
    
    if (!resolvedFilePath.startsWith(resolvedFolderPath)) {
      return res.status(400).json({
        success: false,
        message: "Invalid file path"
      });
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.warn(`❌ File not found: ${filePath}`);
      return res.status(404).json({
        success: false,
        message: "File not found"
      });
    }

    // Verify it's a file, not a directory
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return res.status(400).json({
        success: false,
        message: "Path is not a file"
      });
    }

    // Determine content type
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".pdf": "application/pdf",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";

    // Set response headers
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    console.log(`✅ Serving file: ${filename} (${contentType}, ${stats.size} bytes)`);

    // Send file
    return res.sendFile(filePath, (err) => {
      if (err) {
        console.error("❌ Download error:", err);
      } else {
        console.log(`📥 Successfully downloaded: ${filename}`);
      }
    });
  } catch (err) {
    console.error("❌ Error downloading saved document:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while downloading document",
      error: err.message
    });
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
// � COMMISSION SETTINGS (Real-time, DB-driven)
// ======================================================================
import CommissionSetting from "../models/CommissionSetting.js";

// ✅ GET all commission configurations
export const getCommissionSettings = async (req, res) => {
  try {
    console.log(`\n📋 FETCHING COMMISSION SETTINGS`);
    const settings = await CommissionSetting.find({ isActive: true })
      .sort({ vehicleType: 1, city: 1 })
      .lean();

    console.log(`✅ Found ${settings.length} commission settings`);
    if (settings.length > 0) {
      settings.forEach((s) => {
        console.log(`   📍 ${s.vehicleType}/${s.city}: ${s.commissionPercent}%`);
      });
    }

    res.status(200).json({
      success: true,
      message: "Commission settings fetched successfully",
      data: settings,
      count: settings.length,
    });
  } catch (err) {
    console.error("❌ getCommissionSettings error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while fetching commission settings",
      error: err.message,
    });
  }
};

// ✅ UPDATE commission settings + broadcast to drivers immediately
export const updateCommissionSettings = async (req, res) => {
  try {
    const { vehicleType, city = "all", ...updates } = req.body;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`💰 UPDATING COMMISSION: ${vehicleType} / ${city}`);
    console.log(`${"=".repeat(60)}`);
    console.log(`   Commission: ${updates.commissionPercent}%`);
    console.log(`   Platform Fee (Flat): ₹${updates.platformFeeFlat}`);
    console.log(`   Platform Fee (%): ${updates.platformFeePercent}%`);
    console.log(`   Per-Ride Incentive: ₹${updates.perRideIncentive}`);
    console.log(`   Per-Ride Coins: ${updates.perRideCoins}`);

    // Validate percentages
    if (
      updates.commissionPercent !== undefined &&
      (updates.commissionPercent < 0 || updates.commissionPercent > 100)
    ) {
      return res.status(400).json({
        success: false,
        message: "Commission percent must be between 0 and 100",
      });
    }

    if (
      updates.platformFeePercent !== undefined &&
      (updates.platformFeePercent < 0 || updates.platformFeePercent > 100)
    ) {
      return res.status(400).json({
        success: false,
        message: "Platform fee percent must be between 0 and 100",
      });
    }

    // ✅ ATOMIC upsert: Insert if doesn't exist, update if does
    const setting = await CommissionSetting.findOneAndUpdate(
      { vehicleType, city: city.toLowerCase() },
      {
        ...updates,
        city: city.toLowerCase(),
        updatedByAdmin: req.user?.email || "admin",
        changeNote: updates.changeNote || `Updated ${new Date().toISOString()}`,
      },
      { 
        upsert: true, 
        new: true, 
        runValidators: true,
      }
    );

    console.log(`✅ Saved to DB successfully`);
    console.log(`${"=".repeat(60)}\n`);

    // 🔥 BROADCAST to all online drivers immediately
    await broadcastConfigToDrivers(req.app.get("io"));

    res.status(200).json({
      success: true,
      message: "Commission settings updated and broadcasted to drivers",
      data: setting,
    });
  } catch (err) {
    console.error("❌ updateCommissionSettings error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while updating commission settings",
      error: err.message,
    });
  }
};

// ✅ BROADCAST current config to all online drivers
export const broadcastCurrentConfig = async (req, res) => {
  try {
    const io = req.app.get("io");
    if (!io) {
      return res.status(500).json({
        success: false,
        message: "Socket.IO not initialized",
      });
    }

    await broadcastConfigToDrivers(io);

    res.status(200).json({
      success: true,
      message: "Config broadcasted to all online drivers",
    });
  } catch (err) {
    console.error("❌ broadcastCurrentConfig error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while broadcasting config",
      error: err.message,
    });
  }
};

// ✅ HELPER: Broadcast config to all drivers in driver-room
export const broadcastConfigToDrivers = async (io) => {
  try {
    // Fetch all active commission settings
    const settings = await CommissionSetting.find({ isActive: true }).lean();

    // Build config update payload
    const configUpdate = {
      type: "config_update",
      timestamp: new Date(),
      settings,
    };

    console.log(
      `📡 Broadcasting config:updated to driver-room...`
    );

    // 🔥 Emit to all drivers in driver-room
    io.to("driver-room").emit("config:updated", configUpdate);

    console.log(`✅ Broadcast complete`);
  } catch (err) {
    console.error("❌ broadcastConfigToDrivers error:", err);
  }
};

// ======================================================================
// 🎯 INCENTIVE SETTINGS (Global per-ride incentives)
// ======================================================================

// ✅ GET global incentive settings
export const getIncentiveSettings = async (req, res) => {
  try {
    // Fetch 'global' incentive doc
    const incentive = await CommissionSetting.findOne({
      vehicleType: "all",
      city: "all",
    })
      .select("perRideIncentive perRideCoins isActive updatedAt")
      .lean();

    res.status(200).json({
      success: true,
      data: incentive || {
        perRideIncentive: 0,
        perRideCoins: 0,
        isActive: true,
      },
    });
  } catch (err) {
    console.error("❌ getIncentiveSettings error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while fetching incentive settings",
      error: err.message,
    });
  }
};

// ✅ UPDATE global incentive settings + broadcast
export const updateIncentiveSettings = async (req, res) => {
  try {
    const { perRideIncentive, perRideCoins } = req.body;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🎯 UPDATING INCENTIVE SETTINGS (GLOBAL)`);
    console.log(`${"=".repeat(60)}`);
    console.log(`   Per-Ride Incentive: ₹${perRideIncentive}`);
    console.log(`   Per-Ride Coins: ${perRideCoins}`);

    // Update ALL rows with these values (apply globally)
    await CommissionSetting.updateMany(
      {},
      {
        perRideIncentive,
        perRideCoins,
        updatedByAdmin: req.user?.email || "admin",
      },
      { runValidators: true }
    );

    console.log(`✅ Updated all commission settings`);
    console.log(`${"=".repeat(60)}\n`);

    // 🔥 BROADCAST immediately
    await broadcastConfigToDrivers(req.app.get("io"));

    res.status(200).json({
      success: true,
      message: "Incentive settings updated globally and broadcasted",
      data: { perRideIncentive, perRideCoins },
    });
  } catch (err) {
    console.error("❌ updateIncentiveSettings error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while updating incentive settings",
      error: err.message,
    });
  }
};

// ======================================================================
// �🔐 Admin Login
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

/* =====================================================
   ADMIN: UPDATE DRIVER VEHICLE TYPE
   Only for 4-seat cars: toggles between "car" / "premium"
   6-seat (xl) cannot be overridden via this endpoint
===================================================== */
export const adminUpdateDriverVehicleType = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { vehicleType } = req.body;

    const allowed = ["car", "premium"];
    if (!allowed.includes(vehicleType)) {
      return res.status(400).json({
        success: false,
        message: "Admin can only set vehicleType to 'car' or 'premium'",
      });
    }

    const driver = await User.findById(driverId);
    if (!driver || !driver.isDriver) {
      return res.status(404).json({ success: false, message: "Driver not found" });
    }

    // Block override for 6-seat vehicles — those are always xl
    if (driver.seats === 6) {
      return res.status(400).json({
        success: false,
        message: "6-seat vehicles are automatically XL. Cannot override vehicleType.",
      });
    }

    driver.vehicleType = vehicleType;
    await driver.save();

    console.log(`✅ Admin set vehicleType=${vehicleType} for driver ${driverId}`);
    return res.status(200).json({
      success: true,
      message: `Vehicle type updated to ${vehicleType}`,
      driver: {
        _id: driver._id,
        name: driver.name,
        vehicleType: driver.vehicleType,
        seats: driver.seats,
      },
    });
  } catch (err) {
    console.error("❌ adminUpdateDriverVehicleType error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};
