// src/routes/customerBannerRoutes.js
import express from "express";
import CustomerBanner from "../models/CustomerBanner.js";
import { protect } from "../middlewares/authMiddleware.js";

const router = express.Router();

/**
 * 📱 GET /api/customer/banners - Get banners for customer app
 * Returns today's and yesterday's banners for the Offers tab
 */
router.get("/", protect, async (req, res) => {
  try {
    // Get today and yesterday dates
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayStr = today.toISOString().split("T")[0];
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    // Fetch today's banners
    const todayBanners = await CustomerBanner.find({
      date: todayStr,
      isActive: true,
      target: { $in: ["all", "customer"] },
    })
      .sort({ order: 1, createdAt: -1 })
      .lean();

    // Fetch yesterday's banners
    const yesterdayBanners = await CustomerBanner.find({
      date: yesterdayStr,
      isActive: true,
      target: { $in: ["all", "customer"] },
    })
      .sort({ order: 1, createdAt: -1 })
      .lean();

    console.log(`📱 Customer banners fetched: ${todayBanners.length} today, ${yesterdayBanners.length} yesterday`);

    res.status(200).json({
      success: true,
      data: {
        todayOffers: todayBanners.map((b) => b.imageUrl),
        yesterdayOffers: yesterdayBanners.map((b) => b.imageUrl),
        todayBanners: todayBanners,
        yesterdayBanners: yesterdayBanners,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching customer banners:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch banners",
    });
  }
});

/**
 * 📱 GET /api/customer/banners/active - Get all active banners (recent 7 days)
 */
router.get("/active", protect, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];

    const banners = await CustomerBanner.find({
      date: { $gte: sevenDaysAgoStr },
      isActive: true,
      target: { $in: ["all", "customer"] },
    })
      .sort({ date: -1, order: 1 })
      .lean();

    res.status(200).json({
      success: true,
      banners,
      count: banners.length,
    });
  } catch (err) {
    console.error("❌ Error fetching active banners:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch banners",
    });
  }
});

/**
 * 📱 GET /api/customer/banners/by-date/:date - Get banners for specific date
 */
router.get("/by-date/:date", protect, async (req, res) => {
  try {
    const { date } = req.params;

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Use YYYY-MM-DD",
      });
    }

    const banners = await CustomerBanner.find({
      date,
      isActive: true,
      target: { $in: ["all", "customer"] },
    })
      .sort({ order: 1, createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      banners,
      count: banners.length,
    });
  } catch (err) {
    console.error("❌ Error fetching banners by date:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch banners",
    });
  }
});

export default router;