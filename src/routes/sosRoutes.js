// src/routes/sosRoutes.js
import express from "express";
import {
  triggerSos,
  updateSosLocation,
  updateDriverLocation,
  resolveSos,
  escalateSos,
  getActiveSosAlerts,
  getSosById,
} from "../controllers/sosController.js";

// ── Auth middleware ────────────────────────────────────────────────────────────
// protect      → Firebase JWT verification (sets req.user with MongoDB _id)
// verifyAdminToken → checks x-admin-token header (existing admin auth pattern)
import { protect } from "../middlewares/authMiddleware.js";
import { verifyAdminToken } from "../middlewares/adminAuth.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER / DRIVER ROUTES  (Firebase JWT required)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/sos/trigger
 * Customer triggers SOS (triple tap).
 * customerId pulled from auth token — body value is ignored.
 * Ownership of tripId is verified against DB before any write.
 * Body: { tripId, lat, lng, sosType? }
 */
router.post("/trigger", protect, triggerSos);

/**
 * POST /api/sos/location-update
 * Customer sends live location while SOS is active.
 * Appends to locationHistory (capped at 100 pts) + updates current location snapshot.
 * Body: { trip_id, lat, lng }
 */
router.post("/location-update", protect, updateSosLocation);

/**
 * POST /api/sos/driver-location
 * Driver sends live location while SOS is active.
 * Stored in driverLocation — admin sees customer + driver markers side-by-side.
 * Body: { trip_id, lat, lng }
 */
router.post("/driver-location", protect, updateDriverLocation);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES  (x-admin-token header required — matches existing project pattern)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/sos/active
 * All ACTIVE SOS alerts, newest-first.
 * Used by admin dashboard on load + as missed-event recovery
 * (if admin opens dashboard after socket event was already emitted).
 * Header: x-admin-token: <token>
 */
router.get("/active", verifyAdminToken, getActiveSosAlerts);

/**
 * GET /api/sos/:id
 * Full detail of one alert — includes locationHistory, statusHistory, driverLocation.
 * Header: x-admin-token: <token>
 */
router.get("/:id", verifyAdminToken, getSosById);

/**
 * POST /api/sos/resolve
 * Admin resolves an active SOS alert.
 * Appends RESOLVED to statusHistory + emits SOS_RESOLVED to admin-room.
 * Header: x-admin-token: <token>
 * Body: { sos_id, resolvedBy? }
 */
router.post("/resolve", verifyAdminToken, resolveSos);

/**
 * POST /api/sos/escalate
 * Admin marks police as contacted (isEscalated: true).
 * Appends ESCALATED to statusHistory + emits SOS_ESCALATED to admin-room.
 * Header: x-admin-token: <token>
 * Body: { sos_id }
 */
router.post("/escalate", verifyAdminToken, escalateSos);

export default router;