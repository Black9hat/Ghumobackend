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
import { uploadBanner } from "../middlewares/multer.js";

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

  // TEST
  testImageAccess,
} from "../controllers/adminController.js";

// ✅ NEW: Import offers functions
import {
  getOffers,
  deleteOffer,
} from "../controllers/notificationController.js";

const router = express.Router();

// ✅ HELPER: Get base URL for Railway deployment
const getBaseUrl = (req) => {
  // Priority 1: Railway environment variable
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  
  // Priority 2: BACKEND_URL from .env
  if (process.env.BACKEND_URL) {
    return process.env.BACKEND_URL;
  }
  
  // Priority 3: Fallback to request headers (development)
  return `${req.protocol}://${req.get("host")}`;
};

/* ================================
   📁 MULTER CONFIG FOR CUSTOMER BANNERS
================================ */
const customerBannerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/customer-banners";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `customer-banner-${uniqueSuffix}${ext}`);
  },
});

const uploadCustomerBanner = multer({
  storage: customerBannerStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed!"));
  },
});

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
================================ */
router.post("/send-fcm", verifyAdminToken, sendPushToUsers);
router.post("/send-fcm/individual", verifyAdminToken, sendPushToIndividual);

/* ================================
   🖼 BANNER UPLOAD (ADMIN - DRIVER)
================================ */
router.post(
  "/notifications/upload-banner",
  verifyAdminToken,
  uploadBanner.single("banner"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No banner file uploaded",
        });
      }

      const filePath = req.file.path.replace(/\\/g, "/");
      
      // ✅ FIX: Use absolute URL for Railway deployment
      const baseUrl = getBaseUrl(req);
      const url = `${baseUrl}/${filePath}`;

      console.log(`✅ Driver banner uploaded: ${url}`);
      console.log(`   Base URL: ${baseUrl}`);
      console.log(`   File path: ${filePath}`);

      return res.status(200).json({
        success: true,
        message: "Banner uploaded successfully",
        url,
        path: filePath,
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

// 🗑🗑 Clear all notifications for user
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
   🎁 OFFERS MANAGEMENT (NEW)
================================ */

// Get latest 5 offers for a specific role
// Usage: GET /api/admin/offers?role=customer or /api/admin/offers?role=driver
router.get("/offers", getOffers);

// Delete a specific offer (admin only)
// Usage: DELETE /api/admin/offers/:id
router.delete("/offers/:id", verifyAdminToken, deleteOffer);

/* ================================
   🛍️ CUSTOMER BANNERS (ADMIN)
================================ */

// 📤 Upload customer banner image
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

      const filePath = req.file.path.replace(/\\/g, "/");
      const baseUrl = getBaseUrl(req);
      const imageUrl = `${baseUrl}/${filePath}`;

      console.log(`✅ Customer image uploaded: ${imageUrl}`);

      res.status(200).json({
        success: true,
        message: "Image uploaded successfully",
        imageUrl,
        path: filePath,
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

// 📤 Create customer banner
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
    console.log(`   Image URL: ${imageUrl}`);

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

// 📋 Get all customer banners (admin)
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

// 🔍 Get single customer banner
router.get("/customer-banners/:bannerId", verifyAdminToken, async (req, res) => {
  try {
    const { bannerId } = req.params;

    const banner = await CustomerBanner.findById(bannerId).lean();

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    res.status(200).json({
      success: true,
      banner,
    });
  } catch (err) {
    console.error("❌ Error fetching customer banner:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// 🔄 Update customer banner (PATCH)
router.patch("/customer-banners/:bannerId", verifyAdminToken, async (req, res) => {
  try {
    const { bannerId } = req.params;
    const updates = req.body;

    // Remove undefined fields
    Object.keys(updates).forEach((key) => {
      if (updates[key] === undefined) {
        delete updates[key];
      }
    });

    const banner = await CustomerBanner.findByIdAndUpdate(
      bannerId,
      { ...updates, updatedAt: new Date() },
      { new: true, runValidators: true }
    );

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    console.log(`✅ Customer banner updated: ${bannerId}`);

    res.status(200).json({
      success: true,
      message: "Banner updated successfully",
      banner,
    });
  } catch (err) {
    console.error("❌ Error updating customer banner:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// 🔄 Toggle customer banner status (PUT)
router.put("/customer-banners/:bannerId/toggle", verifyAdminToken, async (req, res) => {
  try {
    const { bannerId } = req.params;

    const banner = await CustomerBanner.findById(bannerId);

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    banner.isActive = !banner.isActive;
    await banner.save();

    console.log(`✅ Customer banner toggled: ${bannerId} -> ${banner.isActive ? "Active" : "Inactive"}`);

    res.status(200).json({
      success: true,
      message: `Banner ${banner.isActive ? "activated" : "deactivated"} successfully`,
      banner,
    });
  } catch (err) {
    console.error("❌ Error toggling customer banner:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// 🗑 Delete customer banner
router.delete("/customer-banners/:bannerId", verifyAdminToken, async (req, res) => {
  try {
    const { bannerId } = req.params;

    const banner = await CustomerBanner.findById(bannerId);

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    // Optionally delete the image file from server
    if (banner.imageUrl && banner.imageUrl.includes("/uploads")) {
      // Extract file path from URL
      const urlParts = banner.imageUrl.split('/uploads/');
      if (urlParts.length > 1) {
        const imagePath = `uploads/${urlParts[1]}`;
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
          console.log(`🗑️ Deleted image file: ${imagePath}`);
        }
      }
    }

    await CustomerBanner.findByIdAndDelete(bannerId);

    console.log(`✅ Customer banner deleted: ${bannerId}`);

    res.status(200).json({
      success: true,
      message: "Banner deleted successfully",
    });
  } catch (err) {
    console.error("❌ Error deleting customer banner:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// 📊 Get customer banner stats
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
    res.status(500).json({
      success: false,
      message: err.message,
    });
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

export default router;
