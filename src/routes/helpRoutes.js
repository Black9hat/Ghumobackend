// routes/helpRoutes.js
// Customer-facing routes for help/support functionality

import express from 'express';
const router = express.Router();
import HelpSettings from '../models/HelpSettings.js';
import HelpRequest from '../models/HelpRequest.js';

// ════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE (assuming you have customer auth middleware)
// ════════════════════════════════════════════════════════════════════════════

// Replace with your actual customer auth middleware if needed
const requireAuth = (req, res, next) => {
  // Example: Check if customer is authenticated
  // if (!req.customerId) {
  //   return res.status(401).json({ success: false, error: 'Unauthorized' });
  // }
  next();
};

// ════════════════════════════════════════════════════════════════════════════
// GET CONTACT SETTINGS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/help/settings - Get support contact information (PUBLIC)
router.get('/settings', async (req, res) => {
  try {
    const settings = await HelpSettings.getSingleton();

    // Only return public fields
    res.json({
      success: true,
      settings: {
        supportPhone: settings.supportPhone,
        supportEmail: settings.supportEmail,
        whatsappNumber: settings.whatsappNumber,
        enabled: settings.enabled,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching help settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch help settings',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SUBMIT HELP REQUEST (UPDATED WITH BETTER VALIDATION)
// ════════════════════════════════════════════════════════════════════════════

// POST /api/help/request - Submit a help request
router.post('/request', async (req, res) => {
  try {
    let {
      customerId,
      subject,
      description,
      category = 'general',
      priority = 'medium',
      customerName,
      customerPhone,
    } = req.body;

    console.log('📥 Received help request:', {
      customerId,
      subject,
      description,
      category,
      priority,
    });

    // ✅ TRY TO GET CUSTOMER ID FROM DIFFERENT SOURCES
    // 1. From request body
    if (!customerId) {
      // 2. Try to get from authenticated user (if middleware sets req.user)
      customerId = req.user?.customerId || req.user?._id || req.user?.id;
      console.log('🔍 Got customerId from auth:', customerId);
    }

    // ✅ VALIDATE INPUTS
    if (!customerId) {
      console.log('❌ No customer ID provided');
      return res.status(400).json({
        success: false,
        error: 'Customer ID is required. Please log in and try again.',
      });
    }

    if (!subject || subject.trim().length === 0) {
      console.log('❌ No subject provided');
      return res.status(400).json({
        success: false,
        error: 'Subject is required',
      });
    }

    if (!description || description.trim().length === 0) {
      console.log('❌ No description provided');
      return res.status(400).json({
        success: false,
        error: 'Description is required',
      });
    }

    // ✅ VALIDATE ENUM VALUES
    const validCategories = ['technical', 'billing', 'general', 'complaint', 'feedback'];
    if (!validCategories.includes(category)) {
      console.log(`⚠️ Invalid category "${category}", defaulting to "general"`);
      category = 'general';
    }

    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (!validPriorities.includes(priority)) {
      console.log(`⚠️ Invalid priority "${priority}", defaulting to "medium"`);
      priority = 'medium';
    }

    // Optional: Fetch customer details to enrich the request
    // Uncomment if you have a Customer model
    // try {
    //   const customer = await User.findById(customerId);
    //   if (customer) {
    //     customerName = customerName || customer.name;
    //     customerPhone = customerPhone || customer.phone;
    //   }
    // } catch (err) {
    //   console.log('⚠️ Could not fetch customer details:', err.message);
    // }

    // ✅ CREATE HELP REQUEST
    const helpRequest = await HelpRequest.create({
      customerId,
      customerName: customerName || null,
      customerPhone: customerPhone || null,
      subject: subject.trim(),
      description: description.trim(),
      category,
      priority,
      status: 'pending',
      source: 'app',
    });

    console.log('✅ Help request created:', helpRequest._id);

    // TODO: Send notification to admin
    // await notifyAdminNewRequest(helpRequest);

    res.status(201).json({
      success: true,
      request: helpRequest,
      message: 'Your support request has been submitted successfully! We will get back to you within 24 hours.',
    });
  } catch (error) {
    console.error('❌ Error creating help request:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        error: `Validation failed: ${messages.join(', ')}`,
      });
    }

    // Handle cast errors (invalid ObjectId)
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid customer ID format',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to submit help request. Please try again.',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET CUSTOMER'S HELP REQUESTS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/help/requests/:customerId - Get help requests for a customer
router.get('/requests/:customerId', requireAuth, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { status, limit = 20 } = req.query;

    console.log('📥 Fetching requests for customer:', customerId);

    // Build query
    const filter = { customerId };
    if (status && status !== 'all') {
      filter.status = status;
    }

    const requests = await HelpRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    console.log(`✅ Found ${requests.length} requests`);

    res.json({
      success: true,
      requests,
      count: requests.length,
    });
  } catch (error) {
    console.error('❌ Error fetching customer requests:', error);

    // Handle cast errors (invalid ObjectId)
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid customer ID format',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to fetch your requests',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET SINGLE REQUEST DETAILS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/help/request/:id - Get single help request
router.get('/request/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    console.log('📥 Fetching request:', id);

    const request = await HelpRequest.findById(id);

    if (!request) {
      console.log('❌ Request not found');
      return res.status(404).json({
        success: false,
        error: 'Request not found',
      });
    }

    // Verify the request belongs to the customer (optional security check)
    // if (request.customerId.toString() !== req.user?.id?.toString()) {
    //   console.log('❌ Unauthorized access attempt');
    //   return res.status(403).json({
    //     success: false,
    //     error: 'Unauthorized access',
    //   });
    // }

    console.log('✅ Request found');

    res.json({
      success: true,
      request,
    });
  } catch (error) {
    console.error('❌ Error fetching request:', error);

    // Handle cast errors (invalid ObjectId)
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid request ID format',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to fetch request',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// EXPORT ROUTES
// ════════════════════════════════════════════════════════════════════════════

export default router;