// routes/webhookRoutes.js - RAZORPAY WEBHOOK ROUTES
import express from 'express';
import { handleRazorpayWebhook, testWebhook } from '../controllers/webhookController.js';

const router = express.Router();

// ✅ Razorpay webhook endpoint
// IMPORTANT: This endpoint should NOT use bodyParser.json()
// It needs raw body for signature verification
router.post('/razorpay', express.raw({ type: 'application/json' }), (req, res, next) => {
  // Convert raw buffer back to JSON for processing
  if (req.body instanceof Buffer) {
    req.body = JSON.parse(req.body.toString());
  }
  next();
}, handleRazorpayWebhook);

// ✅ Test webhook endpoint (for development)
router.post('/test', testWebhook);

export default router;

/* 
HOW TO ADD TO MAIN SERVER FILE (server.js or app.js):

import webhookRoutes from './routes/webhookRoutes.js';

// Add BEFORE general bodyParser middleware
app.use('/api/webhook', webhookRoutes);

// Then add your general middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
*/
