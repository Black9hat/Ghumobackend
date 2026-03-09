// src/routes/planRoutes.js - ENHANCED with Plan Purchase Routes
//
// Route map
// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — Plan templates
//    GET    /api/admin/plans                           → getPlans
//    POST   /api/admin/plans                           → createPlan
//    GET    /api/admin/plans/analytics                 → getPlanAnalytics
//    GET    /api/admin/plans/:planId                   → getPlanById
//    PUT    /api/admin/plans/:planId                   → updatePlan
//    DELETE /api/admin/plans/:planId                   → deletePlan
//
//  ADMIN — Drivers with plans
//    GET    /api/admin/drivers/plans                   → getDriversWithPlans
//    POST   /api/admin/drivers/:driverId/assign-plan   → assignPlanToDriver
//    PUT    /api/admin/drivers/:driverId/plans/:id     → updateDriverPlan
//    POST   /api/admin/drivers/:driverId/plans/:id/deactivate → deactivateDriverPlan
//
//  ✨ NEW: ADMIN — Plan Purchase Analytics
//    GET    /api/admin/plans/:planId/purchases         → getPlanPurchaseHistory
//    GET    /api/admin/plans/stats/revenue             → getPlanRevenueStats
//
//  DRIVER app - Plan Management
//    GET    /api/driver/plans/available                → getAvailablePlans
//    GET    /api/driver/plan/current                   → getCurrentPlan
//    GET    /api/driver/plan/history                   → getPlanHistory
//
//  ✨ NEW: DRIVER app - Plan Purchase
//    POST   /api/driver/plans/:planId/create-order     → createRazorpayPlanOrder
//    POST   /api/driver/plans/:planId/verify-payment   → verifyPlanPayment
//    POST   /api/driver/plan/current/deactivate        → deactivateCurrentPlan
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import {
  // ── Plan template CRUD ──
  createPlan,
  getPlans,
  getPlanById,
  updatePlan,
  deletePlan,

  // ── Driver plan management (admin) ──
  assignPlanToDriver,
  updateDriverPlan,
  deactivateDriverPlan,
  getDriversWithPlans,

  // ── Driver-facing ──
  getAvailablePlans,
  getCurrentPlan,
  getPlanHistory,

  // ── Analytics ──
  getPlanAnalytics,
} from '../controllers/planController.js';

// ✨ NEW: Plan payment handlers
import {
  createRazorpayPlanOrder,
  verifyPlanPayment,
  deactivateCurrentPlan,
  getPlanPurchaseHistory,
  getPlanRevenueStats,
} from '../controllers/planPaymentController.js';

// ── Admin middleware ──
import { verifyAdminToken } from '../middlewares/adminAuth.js';

// ── Driver middleware ──
import { authenticateUser as driverProtect } from '../middlewares/auth.js';

const router = express.Router();

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — Plan templates
// ════════════════════════════════════════════════════════════════════════════

// NOTE: /analytics must come BEFORE /:planId
router.get('/admin/plans/analytics', verifyAdminToken, getPlanAnalytics);

router
  .route('/admin/plans')
  .get(verifyAdminToken, getPlans)
  .post(verifyAdminToken, createPlan);

router
  .route('/admin/plans/:planId')
  .get(verifyAdminToken, getPlanById)
  .put(verifyAdminToken, updatePlan)
  .delete(verifyAdminToken, deletePlan);

// ════════════════════════════════════════════════════════════════════════════
// ✨ NEW: ADMIN — Plan Purchase Analytics
// ════════════════════════════════════════════════════════════════════════════

// NOTE: Must come BEFORE /:planId routes
router.get('/admin/plans/stats/revenue', verifyAdminToken, getPlanRevenueStats);

// GET /api/admin/plans/:planId/purchases
router.get('/admin/plans/:planId/purchases', verifyAdminToken, getPlanPurchaseHistory);

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — Drivers with plans
// ════════════════════════════════════════════════════════════════════════════

router.get('/admin/drivers/plans', verifyAdminToken, getDriversWithPlans);

router.post('/admin/drivers/:driverId/assign-plan', verifyAdminToken, assignPlanToDriver);

router.put(
  '/admin/drivers/:driverId/plans/:driverPlanId',
  verifyAdminToken,
  updateDriverPlan
);

router.post(
  '/admin/drivers/:driverId/plans/:driverPlanId/deactivate',
  verifyAdminToken,
  deactivateDriverPlan
);

// ════════════════════════════════════════════════════════════════════════════
// ✨ NEW: DRIVER — Plan Purchase (Razorpay)
// ════════════════════════════════════════════════════════════════════════════

// POST /api/driver/plans/:planId/create-order
// Create a Razorpay order for plan purchase
router.post(
  '/driver/plans/:planId/create-order',
  driverProtect,
  createRazorpayPlanOrder
);

// POST /api/driver/plans/:planId/verify-payment
// Verify payment and activate plan
router.post(
  '/driver/plans/:planId/verify-payment',
  driverProtect,
  verifyPlanPayment
);

// ════════════════════════════════════════════════════════════════════════════
// DRIVER — Self-service plan endpoints (Firebase token)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/driver/plans/available
// List all available plans for purchase
router.get('/driver/plans/available', driverProtect, getAvailablePlans);

// GET /api/driver/plan/current
// Get current active plan (if any)
router.get('/driver/plan/current', driverProtect, getCurrentPlan);

// GET /api/driver/plan/history
// Get all past plans (for reference)
router.get('/driver/plan/history', driverProtect, getPlanHistory);

// ✨ NEW: POST /api/driver/plan/current/deactivate
// Manually deactivate current plan
router.post('/driver/plan/current/deactivate', driverProtect, deactivateCurrentPlan);

export default router;