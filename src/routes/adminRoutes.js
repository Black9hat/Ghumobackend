// src/routes/adminRoutes.js
import express from "express";
import { verifyAdminToken } from "../middlewares/adminAuth.js";
import { protect } from "../middlewares/authMiddleware.js";
import User from "../models/User.js";
import Trip from "../models/Trip.js";
import CustomerBanner from "../models/CustomerBanner.js";
import Notification from "../models/Notification.js";
import multer from "multer";
import path from "path";
import fs from "fs";

// 📁 Multer Banner Upload
import { uploadBanner, uploadBannerToCloudinary, uploadNotificationToCloudinary, uploadToCloudinary } from "../middlewares/multer.js";

import {
  // Dashboard
  getDashboardStats,
  getDocumentImage,
  getDocumentImageBase64,
  // Auth
  adminLogin,
  getActiveSupportTrips,
  // Trips
  manualAssignDriver,
  getTripDetails,
  getAllTrips,
  markTripCompleted,
  cancelTrip,

  // Users
  getAllDrivers,
  getAllCustomers,
  blockCustomer,
  unblockCustomer,
  blockDriver,
  unblockDriver,

  // Push Notification
  sendPushToUsers,
  sendPushToIndividual,

  // Notifications
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,

  // Fare Rates
  getAllFareRates,
  updateFareRate,
  createFareRate,
  deleteFareRate,

  // Documents
  getDriverDocuments,
  verifyDriverDocument,
  getPendingDocuments,
  getDocumentById,
  deleteDriverDocumentImage,
  getDriversWithDocStatus,
  getActionableDriverDocuments,
  rejectSpecificDocument,
  downloadAllDriverDocuments,
  downloadSingleDocument,
  getSavedDocuments,
  downloadSavedDocument,
  selectSaveFolder,
  suspendDriver, approveDriver, rejectDriver,

  // Commission & Incentive Settings
  getCommissionSettings,
  updateCommissionSettings,
  broadcastCurrentConfig,
  getIncentiveSettings,
  updateIncentiveSettings,

  // TEST
  testImageAccess,

  // Vehicle type admin override
  adminUpdateDriverVehicleType,
} from "../controllers/adminController.js";

// ✅ Import notification controller functions
import {
  getOffers,
  deleteOffer,
  sendBroadcastNotification,
  sendIndividualNotification,
  getAllOffersAdmin,
} from "../controllers/notificationController.js";

const router = express.Router();

// ✅ HELPER: Get base URL for Railway deployment
const getBaseUrl = (req) => {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (process.env.BACKEND_URL) {
    return process.env.BACKEND_URL;
  }
  return `${req.protocol}://${req.get("host")}`;
};

/* ================================
   📁 MULTER CONFIG FOR CUSTOMER BANNERS
================================ */
const uploadCustomerBanner = uploadNotificationToCloudinary;

/* ================================
   🧪 TEST ENDPOINT(S)
================================ */
router.get("/test-images", testImageAccess);
router.get("/document-image/:docId", verifyAdminToken, getDocumentImage);
router.get("/document-image-base64/:docId", verifyAdminToken, getDocumentImageBase64);

/* ================================
   🟡 ADMIN AUTH
================================ */
router.post("/login", adminLogin);
router.put("/driver/suspend/:driverId", verifyAdminToken, suspendDriver);
router.put("/driver/approve/:driverId", verifyAdminToken, approveDriver);
router.put("/driver/reject/:driverId", verifyAdminToken, rejectDriver);

/* ================================
   🟢 DASHBOARD
================================ */
router.get("/stats", verifyAdminToken, getDashboardStats);

/* ================================
   💰 FARE RATES
================================ */
router.get("/fare/rates", verifyAdminToken, getAllFareRates);
router.put("/fare/update/:id", verifyAdminToken, updateFareRate);
router.post("/fare/create", verifyAdminToken, createFareRate);
router.delete("/fare/delete/:id", verifyAdminToken, deleteFareRate);

/* ================================
   💳 COMMISSION & INCENTIVE SETTINGS
================================ */
router.get("/commission/settings", verifyAdminToken, getCommissionSettings);
router.put("/commission/settings/:vehicleType", verifyAdminToken, updateCommissionSettings);
router.post("/commission/broadcast", verifyAdminToken, broadcastCurrentConfig);
router.get("/commission/incentives", verifyAdminToken, getIncentiveSettings);
router.put("/commission/incentives", verifyAdminToken, updateIncentiveSettings);

/* ================================
   🧑 CUSTOMERS
================================ */
router.get("/customers", verifyAdminToken, getAllCustomers);
router.put("/customer/block/:customerId", verifyAdminToken, blockCustomer);
router.put("/customer/unblock/:customerId", verifyAdminToken, unblockCustomer);

router.get("/driver/:driverId", async (req, res) => {
  try {
    const driver = await User.findById(req.params.driverId).select(
      "name phone vehicleType rating profilePhoto"
    );
    res.json({ success: true, driver });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Driver recent trips
router.get("/driver-trips/:driverId", async (req, res) => {
  try {
    const trips = await Trip.find({
      assignedDriver: req.params.driverId,
    })
      .sort({ createdAt: -1 })
      .limit(10);
    res.json({ success: true, trips });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ================================
   🚖 DRIVERS
================================ */
router.get("/drivers", verifyAdminToken, getAllDrivers);
router.put("/driver/block/:driverId", verifyAdminToken, blockDriver);
router.put("/driver/vehicle-type/:driverId", verifyAdminToken, adminUpdateDriverVehicleType);
router.put("/driver/unblock/:driverId", verifyAdminToken, unblockDriver);

/* ================================
   🚘 TRIPS MGMT
================================ */
router.get("/trips", verifyAdminToken, getAllTrips);
router.post("/manual-assign", verifyAdminToken, manualAssignDriver);
router.get("/trip/:tripId", verifyAdminToken, getTripDetails);
router.put("/trip/:tripId/complete", verifyAdminToken, markTripCompleted);
router.put("/trip/:tripId/cancel", verifyAdminToken, cancelTrip);
router.get("/support/active", verifyAdminToken, getActiveSupportTrips);

/* ================================
   📨 PUSH NOTIFICATIONS (ADMIN)
   ✅ FIX: Added alias routes that Notifications.tsx actually calls:
      POST /api/admin/send-fcm              → broadcast
      POST /api/admin/send-fcm/individual   → individual (existing)
      POST /api/admin/send-individual-notification → individual (alias for TSX)
================================ */
// Broadcast — called by Notifications.tsx as POST /api/admin/send-fcm
router.post("/send-fcm", verifyAdminToken, sendBroadcastNotification);

// Individual — old route kept for compatibility
router.post("/send-fcm/individual", verifyAdminToken, sendIndividualNotification);

// ✅ Individual alias — Notifications.tsx calls /api/admin/send-individual-notification
router.post("/send-individual-notification", verifyAdminToken, sendIndividualNotification);

/* ================================
   🖼 BANNER UPLOAD (ADMIN - DRIVER)
================================ */
router.post(
  "/notifications/upload-banner",
  verifyAdminToken,
  uploadBannerToCloudinary.single("banner"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No banner file uploaded",
        });
      }

      const url = req.file.path; // Cloudinary URL

      console.log(`✅ Driver banner uploaded: ${url}`);

      return res.status(200).json({
        success: true,
        message: "Banner uploaded successfully",
        url,
        cloudinary_id: req.file.filename,
      });
    } catch (err) {
      console.error("❌ Banner upload error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to upload banner image",
      });
    }
  }
);

/* ================================
   🔔 NOTIFICATIONS FOR USER (DRIVER/CUSTOMER)
================================ */
router.get("/notifications/user", protect, getUserNotifications);
router.put("/notifications/:notificationId/read", protect, markNotificationAsRead);
router.put("/notifications/user/read-all", protect, markAllNotificationsAsRead);
router.delete("/notifications/:notificationId", protect, deleteNotification);

router.delete("/notifications/user/clear-all", protect, async (req, res) => {
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
});

/* ================================
   🎁 OFFERS MANAGEMENT
   ✅ FIX: Added /offers/all for admin panel (Notifications.tsx fetches this)
================================ */

// ✅ Admin view — all unique promotion offers across all users
// Notifications.tsx calls GET /api/admin/offers/all
router.get("/offers/all", verifyAdminToken, getAllOffersAdmin);

// ✅ User's own offers (requires user auth)
router.get("/offers", protect, getOffers);

// ✅ Delete offer for ALL users (admin only)
router.delete("/offers/:id", verifyAdminToken, deleteOffer);

/* ================================
   🛍️ IMAGE UPLOAD FOR NOTIFICATIONS
   ✅ Notifications.tsx calls POST /api/admin/upload-image
================================ */
router.post(
  "/upload-image",
  verifyAdminToken,
  uploadCustomerBanner.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No image file uploaded",
        });
      }

      // ✅ multer now uses memoryStorage — manually upload buffer to Cloudinary
      const result = await uploadToCloudinary(req.file.buffer, "notifications");
      const imageUrl = result.secure_url;

      console.log(`✅ Notification image uploaded: ${imageUrl}`);

      res.status(200).json({
        success: true,
        message: "Image uploaded successfully",
        imageUrl,
        cloudinary_id: result.public_id,
      });
    } catch (err) {
      console.error("❌ Error uploading image:", err);
      res.status(500).json({
        success: false,
        message: err.message || "Failed to upload image",
      });
    }
  }
);

/* ================================
   🛍️ CUSTOMER BANNERS (ADMIN)
================================ */
router.post("/customer-banners", verifyAdminToken, async (req, res) => {
  try {
    const { imageUrl, title, description, type, actionUrl, date, target } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        message: "Image URL is required",
      });
    }

    const bannerDate = date || new Date().toISOString().split("T")[0];

    const banner = await CustomerBanner.create({
      imageUrl,
      title: title || null,
      description: description || null,
      type: type || "promotion",
      actionUrl: actionUrl || null,
      date: bannerDate,
      target: target || "customer",
      isActive: true,
    });

    console.log(`✅ Customer banner created: ${banner._id} for date ${bannerDate}`);

    res.status(201).json({
      success: true,
      message: "Banner created successfully",
      banner,
    });
  } catch (err) {
    console.error("❌ Error creating customer banner:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

router.get("/customer-banners", verifyAdminToken, async (req, res) => {
  try {
    const { date, target, isActive } = req.query;

    const query = {};
    if (date) query.date = date;
    if (target) query.target = target;
    if (isActive !== undefined) query.isActive = isActive === "true";

    const banners = await CustomerBanner.find(query)
      .sort({ date: -1, order: 1, createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      banners,
      count: banners.length,
    });
  } catch (err) {
    console.error("❌ Error fetching customer banners:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

router.get("/customer-banners/:bannerId", verifyAdminToken, async (req, res) => {
  try {
    const banner = await CustomerBanner.findById(req.params.bannerId).lean();
    if (!banner) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }
    res.status(200).json({ success: true, banner });
  } catch (err) {
    console.error("❌ Error fetching customer banner:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/customer-banners/:bannerId", verifyAdminToken, async (req, res) => {
  try {
    const updates = req.body;
    Object.keys(updates).forEach((key) => {
      if (updates[key] === undefined) delete updates[key];
    });

    const banner = await CustomerBanner.findByIdAndUpdate(
      req.params.bannerId,
      { ...updates, updatedAt: new Date() },
      { new: true, runValidators: true }
    );

    if (!banner) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }

    res.status(200).json({ success: true, message: "Banner updated successfully", banner });
  } catch (err) {
    console.error("❌ Error updating customer banner:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/customer-banners/:bannerId/toggle", verifyAdminToken, async (req, res) => {
  try {
    const banner = await CustomerBanner.findById(req.params.bannerId);
    if (!banner) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }

    banner.isActive = !banner.isActive;
    await banner.save();

    res.status(200).json({
      success: true,
      message: `Banner ${banner.isActive ? "activated" : "deactivated"} successfully`,
      banner,
    });
  } catch (err) {
    console.error("❌ Error toggling customer banner:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/customer-banners/:bannerId", verifyAdminToken, async (req, res) => {
  try {
    const banner = await CustomerBanner.findById(req.params.bannerId);
    if (!banner) {
      return res.status(404).json({ success: false, message: "Banner not found" });
    }

    if (banner.imageUrl && banner.imageUrl.includes("/uploads")) {
      const urlParts = banner.imageUrl.split("/uploads/");
      if (urlParts.length > 1) {
        const imagePath = `uploads/${urlParts[1]}`;
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
          console.log(`🗑️ Deleted image file: ${imagePath}`);
        }
      }
    }

    await CustomerBanner.findByIdAndDelete(req.params.bannerId);

    res.status(200).json({ success: true, message: "Banner deleted successfully" });
  } catch (err) {
    console.error("❌ Error deleting customer banner:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/customer-banners-stats", verifyAdminToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

    const [totalBanners, activeBanners, todayBanners, yesterdayBanners] = await Promise.all([
      CustomerBanner.countDocuments(),
      CustomerBanner.countDocuments({ isActive: true }),
      CustomerBanner.countDocuments({ date: today, isActive: true }),
      CustomerBanner.countDocuments({ date: yesterday, isActive: true }),
    ]);

    res.status(200).json({
      success: true,
      stats: {
        total: totalBanners,
        active: activeBanners,
        inactive: totalBanners - activeBanners,
        today: todayBanners,
        yesterday: yesterdayBanners,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching banner stats:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ================================
   📄 DOCUMENTS (ADMIN PANEL)
================================ */
router.get("/documents/pending", verifyAdminToken, getPendingDocuments);
router.get("/documents/:driverId", verifyAdminToken, getDriverDocuments);
router.get("/document/:docId", verifyAdminToken, getDocumentById);
router.put("/verifyDocument/:docId", verifyAdminToken, verifyDriverDocument);
router.get("/drivers/with-doc-status", verifyAdminToken, getDriversWithDocStatus);
router.get(
  "/documents/:driverId/actionable",
  verifyAdminToken,
  getActionableDriverDocuments
);
router.delete("/document/:docId/image", verifyAdminToken, deleteDriverDocumentImage);

/* ================================
   📄 DOCUMENTS - ENHANCED (APPROVAL/REJECTION/DOWNLOAD)
================================ */
// ✅ NEW: Selective document rejection - delete only specific doc type
router.delete("/document/:driverId/:docType/reject", verifyAdminToken, rejectSpecificDocument);

// ✅ NEW: Download all driver documents as ZIP
router.get("/download-documents/:mobile", verifyAdminToken, downloadAllDriverDocuments);

// ✅ NEW: Download single document
router.get("/download-single/:docId", verifyAdminToken, downloadSingleDocument);

// ✅ NEW: List saved documents by mobile number
router.get("/saved-documents/:mobile", verifyAdminToken, getSavedDocuments);

// ✅ NEW: Download individual saved document by filename
router.get("/saved-documents/:mobile/:filename", verifyAdminToken, downloadSavedDocument);

// ✅ NEW: Open native folder picker (Windows) for approved document base path
router.get("/select-save-folder", verifyAdminToken, selectSaveFolder);

export default router;