// routes/webhookRoutes.js
// Mounted in server.js as: app.use('/api/webhook', webhookRoutes)
// MUST be mounted BEFORE express.json() — needs raw body for Razorpay signature

import express from 'express';
import { handleRazorpayWebhook, testWebhook } from '../controllers/webhookController.js';

const router = express.Router();

// POST /api/webhook/razorpay  ← exact URL to set in Razorpay dashboard
router.post(
  '/razorpay',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    // Convert raw buffer to parsed object for handler
    if (Buffer.isBuffer(req.body)) {
      try {
        req.rawBody = req.body; // keep raw for signature check
        req.body = JSON.parse(req.body.toString());
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid JSON body' });
      }
    }
    next();
  },
  handleRazorpayWebhook
);

// POST /api/webhook/test  ← dev testing only
router.post('/test', testWebhook);

export default router;