// routes/promotionRoutes.js
import express from 'express';

// ✅ Reuse the configured Cloudinary multer instance from multer.js
//    Avoids duplicate CloudinaryStorage setup and the v2/root import confusion
import { uploadBannerToCloudinary } from '../middlewares/multer.js';

import { verifyAdminToken } from '../middlewares/adminAuth.js';
import {
  uploadPromotion,
  getAllPromotions,
  getActivePromotions,
  getActiveDriverPromotions,
  getCustomerStartupBanner,
  getDriverStartupBanner,
  togglePromotionStatus,
  toggleStartupBanner,
  deletePromotion,
  updatePromotionOrder,
  trackPromotionClick,
} from '../controllers/promotionController.js';

const router = express.Router();

// Alias so the route definitions below stay unchanged
const upload = uploadBannerToCloudinary;

// =====================================================
// Admin Routes (Protected)
// =====================================================
router.post('/admin/promotions/upload', verifyAdminToken, upload.single('image'), uploadPromotion);
router.get('/admin/promotions', verifyAdminToken, getAllPromotions);
router.put('/admin/promotions/:id/toggle', verifyAdminToken, togglePromotionStatus);
router.put('/admin/promotions/:id/toggle-startup-banner', verifyAdminToken, toggleStartupBanner);
router.put('/admin/promotions/:id/order', verifyAdminToken, updatePromotionOrder);
router.delete('/admin/promotions/:id', verifyAdminToken, deletePromotion);

// =====================================================
// Customer Routes (Public)
// =====================================================
router.get('/promotions/active', getActivePromotions);
router.get('/promotions/startup-banner', getCustomerStartupBanner);
router.post('/promotions/:id/click', trackPromotionClick);

// =====================================================
// Driver Routes (Public)
// =====================================================
router.get('/promotions/active/driver', getActiveDriverPromotions);
router.get('/promotions/startup-banner/driver', getDriverStartupBanner);

export default router;