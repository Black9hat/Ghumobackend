// src/routes/planRoutes.js
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
//  ADMIN — Drivers with plans  ← THIS is what the frontend calls
//    GET    /api/admin/drivers/plans                   → getDriversWithPlans
//    POST   /api/admin/drivers/:driverId/assign-plan   → assignPlanToDriver
//    PUT    /api/admin/drivers/:driverId/plans/:id     → updateDriverPlan
//    POST   /api/admin/drivers/:driverId/plans/:id/deactivate → deactivateDriverPlan
//
//  DRIVER app
//    GET    /api/driver/plans/available                → getAvailablePlans
//    GET    /api/driver/plan/current                   → getCurrentPlan
//    GET    /api/driver/plan/history                   → getPlanHistory
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import {
  // Plan template CRUD
  createPlan,
  getPlans,
  getPlanById,
  updatePlan,
  deletePlan,

  // Driver plan management
  assignPlanToDriver,
  updateDriverPlan,
  deactivateDriverPlan,
  getDriversWithPlans,

  // Driver-facing
  getAvailablePlans,
  getCurrentPlan,
  getPlanHistory,

  // Analytics
  getPlanAnalytics,
} from '../controllers/planController.js';

// Import your existing auth middleware — adjust path if needed
import { authenticateUser as protect } from '../middlewares/auth.js';
import { verifyAdminToken as adminOnly } from '../middleware/adminAuth.js';
const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// ADMIN — Plan templates
// ═══════════════════════════════════════════════════════════════════

// NOTE: /analytics must come BEFORE /:planId so Express doesn't treat
// the literal string "analytics" as a planId parameter.
router.get(
  '/admin/plans/analytics',
  protect,
  adminOnly,
  getPlanAnalytics
);

router
  .route('/admin/plans')
  .get(protect, adminOnly, getPlans)
  .post(protect, adminOnly, createPlan);

router
  .route('/admin/plans/:planId')
  .get(protect, adminOnly, getPlanById)
  .put(protect, adminOnly, updatePlan)
  .delete(protect, adminOnly, deletePlan);

// ═══════════════════════════════════════════════════════════════════
// ADMIN — Drivers with plans
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/drivers/plans  ← the route the frontend actually fetches
router.get(
  '/admin/drivers/plans',
  protect,
  adminOnly,
  getDriversWithPlans
);

// POST /api/admin/drivers/:driverId/assign-plan
router.post(
  '/admin/drivers/:driverId/assign-plan',
  protect,
  adminOnly,
  assignPlanToDriver
);

// PUT  /api/admin/drivers/:driverId/plans/:driverPlanId
router.put(
  '/admin/drivers/:driverId/plans/:driverPlanId',
  protect,
  adminOnly,
  updateDriverPlan
);

// POST /api/admin/drivers/:driverId/plans/:driverPlanId/deactivate
router.post(
  '/admin/drivers/:driverId/plans/:driverPlanId/deactivate',
  protect,
  adminOnly,
  deactivateDriverPlan
);

// ═══════════════════════════════════════════════════════════════════
// DRIVER — Self-service plan endpoints
// ═══════════════════════════════════════════════════════════════════

router.get('/driver/plans/available', protect, getAvailablePlans);
router.get('/driver/plan/current',    protect, getCurrentPlan);
router.get('/driver/plan/history',    protect, getPlanHistory);

export default router;