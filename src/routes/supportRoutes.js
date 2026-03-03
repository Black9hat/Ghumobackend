// routes/supportRoutes.js
import express from "express";

import {
  createSupportRequest,
  handleAutoChatResponse,
  getActiveSupportRequests,
  sendAdminMessage,
  resolveSupportRequest,
  getChatHistory,
  sendUserMessage,
  getIssueTypes,
  getSupportAnalytics,

  // DRIVER TICKET APIs
  createDriverTicket,
  getDriverActiveTickets,  // ✅ ADD THIS IMPORT
  getDriverTickets,
  sendDriverTicketMessage,
  resolveDriverTicket
} from '../controllers/supportController.js';

import { verifyAdminToken } from '../middlewares/adminAuth.js';
import { authenticateUser } from '../middlewares/auth.js';

const router = express.Router();

// ==========================================
// 🧑‍💼 USER ROUTES (Customer / Driver)
// ==========================================

/**
 * Create support request (with auto-chat or direct)
 * POST /api/support/request
 * 
 * Body: {
 *   tripId: string,
 *   issueType: string,
 *   userId: string,
 *   userType: 'customer' | 'driver',
 *   isSOS?: boolean,
 *   sosDetails?: { location, timestamp }
 * }
 */
router.post('/request', createSupportRequest);

/**
 * Respond to auto-chat
 * POST /api/support/auto-chat/respond
 * 
 * Body: {
 *   supportRequestId: string,
 *   selectedOption: string,
 *   currentStep: number
 * }
 */
router.post('/auto-chat/respond', handleAutoChatResponse);

/**
 * Send message to admin
 * POST /api/support/message
 * Requires authentication
 * 
 * Body: {
 *   supportRequestId: string,
 *   message: string
 * }
 */
router.post('/message', authenticateUser, sendUserMessage);

/**
 * Get chat history for a support request
 * GET /api/support/:supportRequestId/chat
 * Requires authentication
 */
router.get('/:supportRequestId/chat', authenticateUser, getChatHistory);

/**
 * Get available issue types
 * GET /api/support/issue-types
 */
router.get('/issue-types', getIssueTypes);

// ==========================================
// 🎫 DRIVER TICKET ROUTES (For Drivers)
// ==========================================

/**
 * Create driver support ticket
 * POST /api/support/driver/ticket
 * 
 * Body: {
 *   driverId: string,
 *   issueType: string,
 *   message: string
 * }
 */
router.post('/driver/ticket', createDriverTicket);

/**
 * ✅ NEW: Get driver's active tickets
 * GET /api/support/driver/my-tickets/:driverId
 */
router.get('/driver/my-tickets/:driverId', getDriverActiveTickets);

// ==========================================
// 👨‍💼 ADMIN ROUTES
// ==========================================

/**
 * Get all active support requests
 * GET /api/support/admin/active
 * 
 * Query params:
 *   status?: 'pending' | 'in_progress' | 'resolved'
 *   priority?: 'low' | 'medium' | 'high' | 'critical'
 */
router.get('/admin/active', verifyAdminToken, getActiveSupportRequests);

/**
 * Get all driver tickets (Admin)
 * GET /api/support/driver/tickets
 */
router.get('/driver/tickets', verifyAdminToken, getDriverTickets);

/**
 * Send message to driver ticket
 * POST /api/support/driver/ticket/:ticketId/message
 */
router.post('/driver/ticket/:ticketId/message', verifyAdminToken, sendDriverTicketMessage);

/**
 * Resolve driver ticket
 * POST /api/support/driver/ticket/:ticketId/resolve
 */
router.post('/driver/ticket/:ticketId/resolve', verifyAdminToken, resolveDriverTicket);

/**
 * Send admin message
 * POST /api/support/admin/message
 * 
 * Body: {
 *   supportRequestId: string,
 *   message: string,
 *   adminId: string
 * }
 */
router.post('/admin/message', verifyAdminToken, sendAdminMessage);

/**
 * Resolve support request
 * POST /api/support/admin/resolve
 * 
 * Body: {
 *   supportRequestId: string,
 *   resolutionNotes: string,
 *   adminId: string
 * }
 */
router.post('/admin/resolve', verifyAdminToken, resolveSupportRequest);

/**
 * Get support analytics
 * GET /api/support/admin/analytics
 */
router.get('/admin/analytics', verifyAdminToken, getSupportAnalytics);

/**
 * Get chat history (admin view)
 * GET /api/support/admin/:supportRequestId/chat
 */
router.get('/admin/:supportRequestId/chat', verifyAdminToken, getChatHistory);

export default router;