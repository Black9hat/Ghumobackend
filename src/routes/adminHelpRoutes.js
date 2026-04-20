// routes/adminHelpRoutes.js
// Admin routes for managing help/support settings and requests

import express from 'express';
const router = express.Router();
import HelpSettings from '../models/HelpSettings.js';
import HelpRequest from '../models/HelpRequest.js';
import User from '../models/User.js'; // Your customer model

// ════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE (assuming you have admin auth middleware)
// ════════════════════════════════════════════════════════════════════════════

// Replace with your actual admin auth middleware
const requireAdminAuth = (req, res, next) => {
  // Example: Check if user is admin
  // const isAdmin = req.user && req.user.role === 'admin';
  // if (!isAdmin) {
  //   return res.status(403).json({ success: false, error: 'Unauthorized' });
  // }
  next();
};

// ════════════════════════════════════════════════════════════════════════════
// HELP SETTINGS ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/help/settings - Get help settings
router.get('/help/settings', requireAdminAuth, async (req, res) => {
  try {
    const settings = await HelpSettings.getSingleton();
    
    res.json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error('❌ Error fetching help settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch help settings',
    });
  }
});

// PUT /api/admin/help/settings - Update help settings
router.put('/help/settings', requireAdminAuth, async (req, res) => {
  try {
    const { supportPhone, supportEmail, whatsappNumber, enabled } = req.body;

    // Validate inputs
    if (!supportPhone || !supportEmail || !whatsappNumber) {
      return res.status(400).json({
        success: false,
        error: 'All contact fields are required',
      });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(supportEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format',
      });
    }

    // Get existing settings (singleton)
    let settings = await HelpSettings.getSingleton();

    // Update settings
    settings.supportPhone = supportPhone;
    settings.supportEmail = supportEmail;
    settings.whatsappNumber = whatsappNumber;
    settings.enabled = enabled !== undefined ? enabled : true;

    await settings.save();

    console.log('✅ Help settings updated:', settings);

    res.json({
      success: true,
      settings,
      message: 'Help settings updated successfully',
    });
  } catch (error) {
    console.error('❌ Error updating help settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update help settings',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// HELP REQUESTS ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/help/requests - Get all help requests
router.get('/help/requests', requireAdminAuth, async (req, res) => {
  try {
    const { status, priority, search, limit = 100, skip = 0 } = req.query;

    // Build query filter
    const filter = {};
    if (status && status !== 'all') {
      filter.status = status;
    }
    if (priority) {
      filter.priority = priority;
    }
    if (search) {
      filter.$or = [
        { subject: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { customerName: { $regex: search, $options: 'i' } },
      ];
    }

    const requests = await HelpRequest.find(filter)
      .populate('customerId', 'name phone email')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    // Enrich with customer data
    const enrichedRequests = requests.map((request) => ({
      ...request.toObject(),
      customerName: request.customerId?.name || request.customerName || 'Unknown',
      customerPhone: request.customerId?.phone || request.customerPhone || null,
    }));

    res.json({
      success: true,
      requests: enrichedRequests,
      count: enrichedRequests.length,
    });
  } catch (error) {
    console.error('❌ Error fetching help requests:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch help requests',
    });
  }
});

// GET /api/admin/help/requests/:id - Get single help request
router.get('/help/requests/:id', requireAdminAuth, async (req, res) => {
  try {
    const request = await HelpRequest.findById(req.params.id)
      .populate('customerId', 'name phone email');

    if (!request) {
      return res.status(404).json({
        success: false,
        error: 'Help request not found',
      });
    }

    res.json({
      success: true,
      request: {
        ...request.toObject(),
        customerName: request.customerId?.name || request.customerName || 'Unknown',
        customerPhone: request.customerId?.phone || request.customerPhone || null,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching help request:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch help request',
    });
  }
});

// PUT /api/admin/help/requests/:id - Update help request
router.put('/help/requests/:id', requireAdminAuth, async (req, res) => {
  try {
    const { response, status, priority, assignedTo } = req.body;

    const request = await HelpRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({
        success: false,
        error: 'Help request not found',
      });
    }

    // Update fields
    if (response !== undefined) request.response = response;
    if (status) request.status = status;
    if (priority) request.priority = priority;
    if (assignedTo !== undefined) request.assignedTo = assignedTo;

    // Auto-set resolvedAt if status changes to resolved
    if (status === 'resolved' && !request.resolvedAt) {
      request.resolvedAt = new Date();
    }

    await request.save();

    // TODO: Send notification to customer (email/push notification)
    // await sendCustomerNotification(request);

    console.log(`✅ Help request ${request._id} updated`);

    res.json({
      success: true,
      request,
      message: 'Help request updated successfully',
    });
  } catch (error) {
    console.error('❌ Error updating help request:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update help request',
    });
  }
});

// DELETE /api/admin/help/requests/:id - Delete help request
router.delete('/help/requests/:id', requireAdminAuth, async (req, res) => {
  try {
    const request = await HelpRequest.findByIdAndDelete(req.params.id);

    if (!request) {
      return res.status(404).json({
        success: false,
        error: 'Help request not found',
      });
    }

    console.log(`✅ Help request ${req.params.id} deleted`);

    res.json({
      success: true,
      message: 'Help request deleted successfully',
    });
  } catch (error) {
    console.error('❌ Error deleting help request:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete help request',
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// STATISTICS ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/help/stats - Get help request statistics
router.get('/help/stats', requireAdminAuth, async (req, res) => {
  try {
    const [
      totalRequests,
      pendingRequests,
      inProgressRequests,
      resolvedRequests,
      avgResponseTime,
    ] = await Promise.all([
      HelpRequest.countDocuments(),
      HelpRequest.countDocuments({ status: 'pending' }),
      HelpRequest.countDocuments({ status: 'in-progress' }),
      HelpRequest.countDocuments({ status: 'resolved' }),
      calculateAverageResponseTime(),
    ]);

    res.json({
      success: true,
      stats: {
        totalRequests,
        pendingRequests,
        inProgressRequests,
        resolvedRequests,
        averageResponseTime: avgResponseTime,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
    });
  }
});

// Helper function to calculate average response time
async function calculateAverageResponseTime() {
  try {
    const resolvedRequests = await HelpRequest.find({
      status: 'resolved',
      resolvedAt: { $exists: true },
    }).select('createdAt resolvedAt');

    if (resolvedRequests.length === 0) return 0;

    const totalHours = resolvedRequests.reduce((sum, request) => {
      const hours = (request.resolvedAt - request.createdAt) / (1000 * 60 * 60);
      return sum + hours;
    }, 0);

    return Math.round(totalHours / resolvedRequests.length);
  } catch (error) {
    console.error('Error calculating average response time:', error);
    return 0;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORT ROUTES
// ════════════════════════════════════════════════════════════════════════════

export default router;