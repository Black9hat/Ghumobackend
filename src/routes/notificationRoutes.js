// src/routes/notificationRoutes.js
// Driver-facing notification routes (registered under /api/notifications)
// These are called by DriverNotificationService in the Flutter driver app.

import express from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import {
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllNotifications,
  getOffers,
} from '../controllers/notificationController.js';

const router = express.Router();

// All routes require a logged-in user (driver or customer)

// GET  /api/notifications        — fetch paginated notifications
router.get('/', protect, getUserNotifications);

// GET  /api/notifications/offers — fetch latest 5 promotion offers
router.get('/offers', protect, getOffers);

// PATCH /api/notifications/:notificationId/read — mark one as read
router.patch('/:notificationId/read', protect, markAsRead);

// PATCH /api/notifications/read-all — mark all as read
router.patch('/read-all', protect, markAllAsRead);

// DELETE /api/notifications/clear-all — clear all notifications
router.delete('/clear-all', protect, clearAllNotifications);

// DELETE /api/notifications/:notificationId — delete one notification
router.delete('/:notificationId', protect, deleteNotification);

export default router;