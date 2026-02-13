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
// SUBMIT HELP REQUEST (UPDATED WITH ACCOUNT DELETION SUPPORT)
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
      // Account deletion specific fields
      deletionType,
      scheduledDeletionDate,
      deletionReason,
      dataExportRequested = false,
    } = req.body;

    console.log('📥 Received help request:', {
      customerId,
      subject,
      category,
      priority,
      deletionType,
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
    const validCategories = ['technical', 'billing', 'general', 'complaint', 'feedback', 'account-deletion'];
    if (!validCategories.includes(category)) {
      console.log(`⚠️ Invalid category "${category}", defaulting to "general"`);
      category = 'general';
    }

    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (!validPriorities.includes(priority)) {
      console.log(`⚠️ Invalid priority "${priority}", defaulting to "medium"`);
      priority = 'medium';
    }

    // ✅ VALIDATE ACCOUNT DELETION SPECIFIC FIELDS
    if (category === 'account-deletion') {
      // Auto-set priority to urgent for account deletion
      priority = 'urgent';

      const validDeletionTypes = ['immediate', 'scheduled', 'with-export'];
      if (!deletionType || !validDeletionTypes.includes(deletionType)) {
        console.log('❌ Invalid deletion type for account deletion request');
        return res.status(400).json({
          success: false,
          error: 'Valid deletion type is required for account deletion requests (immediate, scheduled, or with-export)',
        });
      }

      // Validate scheduled deletion date if type is 'scheduled'
      if (deletionType === 'scheduled') {
        if (!scheduledDeletionDate) {
          return res.status(400).json({
            success: false,
            error: 'Scheduled deletion date is required for scheduled deletion requests',
          });
        }

        const schedDate = new Date(scheduledDeletionDate);
        const today = new Date();
        
        if (schedDate <= today) {
          return res.status(400).json({
            success: false,
            error: 'Scheduled deletion date must be in the future',
          });
        }
      }
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
    const requestData = {
      customerId,
      customerName: customerName || null,
      customerPhone: customerPhone || null,
      subject: subject.trim(),
      description: description.trim(),
      category,
      priority,
      status: 'pending',
      source: 'app',
    };

    // Add account deletion specific fields if applicable
    if (category === 'account-deletion') {
      requestData.deletionType = deletionType;
      requestData.dataExportRequested = dataExportRequested || deletionType === 'with-export';
      requestData.dataExportCompleted = false;
      
      if (deletionType === 'scheduled' && scheduledDeletionDate) {
        requestData.scheduledDeletionDate = new Date(scheduledDeletionDate);
      }
      
      if (deletionReason) {
        requestData.deletionReason = deletionReason.trim();
      }
    }

    const helpRequest = await HelpRequest.create(requestData);

    console.log('✅ Help request created:', helpRequest._id);

    // TODO: Send notification to admin
    // await notifyAdminNewRequest(helpRequest);
    
    // For account deletion requests, send special notification
    // if (category === 'account-deletion') {
    //   await notifyAdminUrgentDeletion(helpRequest);
    // }

    res.status(201).json({
      success: true,
      request: helpRequest,
      message: category === 'account-deletion' 
        ? 'Your account deletion request has been submitted. Our team will review it and contact you within 24 hours.'
        : 'Your support request has been submitted successfully! We will get back to you within 24 hours.',
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
    const { status, category, limit = 20 } = req.query;

    console.log('📥 Fetching requests for customer:', customerId);

    // Build query
    const filter = { customerId };
    if (status && status !== 'all') {
      filter.status = status;
    }
    if (category && category !== 'all') {
      filter.category = category;
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
// CANCEL DELETION REQUEST (NEW)
// ════════════════════════════════════════════════════════════════════════════

// PUT /api/help/request/:id/cancel-deletion - Cancel account deletion request
router.put('/request/:id/cancel-deletion', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const request = await HelpRequest.findById(id);

    if (!request) {
      return res.status(404).json({
        success: false,
        error: 'Request not found',
      });
    }

    // Verify it's an account deletion request
    if (request.category !== 'account-deletion') {
      return res.status(400).json({
        success: false,
        error: 'This is not an account deletion request',
      });
    }

    // Verify request belongs to customer
    // if (request.customerId.toString() !== req.user?.id?.toString()) {
    //   return res.status(403).json({
    //     success: false,
    //     error: 'Unauthorized access',
    //   });
    // }

    // Check if already resolved/closed
    if (request.status === 'resolved' || request.status === 'closed') {
      return res.status(400).json({
        success: false,
        error: 'This request has already been processed and cannot be cancelled',
      });
    }

    // Update status to closed
    request.status = 'closed';
    request.response = (request.response || '') + '\n\nCANCELLED BY CUSTOMER';
    await request.save();

    console.log(`✅ Account deletion request ${id} cancelled by customer`);

    res.json({
      success: true,
      request,
      message: 'Your account deletion request has been cancelled successfully',
    });
  } catch (error) {
    console.error('❌ Error cancelling deletion request:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel deletion request',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// EXPORT ROUTES
// ════════════════════════════════════════════════════════════════════════════

export default router;
