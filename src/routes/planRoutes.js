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

// Admin routes  → verified via JWT (adminAuth)
import { verifyAdminToken } from '../middlewares/adminAuth.js';

// Driver routes → verified via Firebase token (auth)
import { authenticateUser as driverProtect } from '../middlewares/auth.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// ADMIN — Plan templates
// ═══════════════════════════════════════════════════════════════════

// NOTE: /analytics must come BEFORE /:planId so Express doesn't treat
// the literal string "analytics" as a planId parameter.
router.get(
  '/admin/plans/analytics',
  verifyAdminToken,
  getPlanAnalytics
);

router
  .route('/admin/plans')
  .get(verifyAdminToken, getPlans)
  .post(verifyAdminToken, createPlan);

router
  .route('/admin/plans/:planId')
  .get(verifyAdminToken, getPlanById)
  .put(verifyAdminToken, updatePlan)
  .delete(verifyAdminToken, deletePlan);

// ═══════════════════════════════════════════════════════════════════
// ADMIN — Drivers with plans
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/drivers/plans
router.get(
  '/admin/drivers/plans',
  verifyAdminToken,
  getDriversWithPlans
);

// POST /api/admin/drivers/:driverId/assign-plan
router.post(
  '/admin/drivers/:driverId/assign-plan',
  verifyAdminToken,
  assignPlanToDriver
);

// PUT /api/admin/drivers/:driverId/plans/:driverPlanId
router.put(
  '/admin/drivers/:driverId/plans/:driverPlanId',
  verifyAdminToken,
  updateDriverPlan
);

// POST /api/admin/drivers/:driverId/plans/:driverPlanId/deactivate
router.post(
  '/admin/drivers/:driverId/plans/:driverPlanId/deactivate',
  verifyAdminToken,
  deactivateDriverPlan
);

// ═══════════════════════════════════════════════════════════════════
// DRIVER — Self-service plan endpoints (Firebase token)
// ═══════════════════════════════════════════════════════════════════

router.get('/driver/plans/available', driverProtect, getAvailablePlans);
router.get('/driver/plan/current',    driverProtect, getCurrentPlan);
router.get('/driver/plan/history',    driverProtect, getPlanHistory);

export default router;