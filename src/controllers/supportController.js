// controllers/supportController.js
import SupportRequest from '../models/SupportRequest.js';
import { SupportChat } from '../models/SupportChat.js';
import { AutoChatConfig } from '../models/AutoChatConfig.js';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';
import DriverTicket from '../models/DriverTicket.js';

// 🤖 AUTO CHAT FLOWS - Predefined responses
const AUTO_CHAT_FLOWS = {
  driver_late: {
    customer: [
      {
        step: 1,
        message: "We understand you're waiting. Your driver is on the way. Would you like to:",
        options: [
          { text: "See driver's ETA", value: "eta", nextStep: 2 },
          { text: "Call driver", value: "call", nextStep: 3 },
          { text: "Still need help", value: "escalate", resolves: false }
        ]
      },
      {
        step: 2,
        message: "Your driver is approximately {eta} minutes away. Please wait a moment.",
        options: [
          { text: "Okay, I'll wait", value: "resolved", resolves: true },
          { text: "Still need help", value: "escalate", resolves: false }
        ]
      },
      {
        step: 3,
        message: "Tap the call button in your ride screen to contact your driver directly.",
        options: [
          { text: "Got it", value: "resolved", resolves: true },
          { text: "Talk to support", value: "escalate", resolves: false }
        ]
      }
    ]
  },
  
  pickup_location: {
    customer: [
      {
        step: 1,
        message: "Having trouble with pickup location?",
        options: [
          { text: "Move pin on map", value: "move_pin", nextStep: 2 },
          { text: "Share exact location", value: "location", nextStep: 3 },
          { text: "Call driver", value: "call", nextStep: 4 }
        ]
      },
      {
        step: 2,
        message: "Please drag the pickup pin to your exact location on the map and confirm.",
        options: [
          { text: "Done", value: "resolved", resolves: true },
          { text: "Need more help", value: "escalate", resolves: false }
        ]
      },
      {
        step: 3,
        message: "Please share your exact location with the driver via call or message.",
        options: [
          { text: "Okay", value: "resolved", resolves: true },
          { text: "Talk to support", value: "escalate", resolves: false }
        ]
      },
      {
        step: 4,
        message: "Tap the call button to contact your driver and share your location.",
        options: [
          { text: "Got it", value: "resolved", resolves: true },
          { text: "Still need help", value: "escalate", resolves: false }
        ]
      }
    ]
  },

  customer_not_responding: {
    driver: [
      {
        step: 1,
        message: "Customer not responding? Here's what you can do:",
        options: [
          { text: "Call customer again", value: "call", nextStep: 2 },
          { text: "Wait 2 more minutes", value: "wait", nextStep: 3 },
          { text: "Cancel with fee", value: "cancel", nextStep: 4 }
        ]
      },
      {
        step: 2,
        message: "Tap the call button to try reaching the customer again.",
        options: [
          { text: "Customer responded", value: "resolved", resolves: true },
          { text: "Still not responding", value: "escalate", resolves: false }
        ]
      },
      {
        step: 3,
        message: "Please wait at the pickup location. Customer will be notified.",
        options: [
          { text: "Customer arrived", value: "resolved", resolves: true },
          { text: "Still waiting", value: "escalate", resolves: false }
        ]
      },
      {
        step: 4,
        message: "You can cancel the ride with a cancellation fee. Are you sure?",
        options: [
          { text: "Yes, cancel", value: "escalate", resolves: false },
          { text: "No, wait more", value: "wait", nextStep: 3 }
        ]
      }
    ]
  },

  sos_emergency: {
    both: [
      {
        step: 1,
        message: "🚨 EMERGENCY SUPPORT ACTIVATED. Admin has been notified immediately. Stay on the line.",
        options: [
          { text: "I'm safe now", value: "safe", resolves: true },
          { text: "Still need help", value: "escalate", resolves: false }
        ]
      }
    ]
  }
};

/**
 * 🚨 CREATE SUPPORT REQUEST (Auto-chat or Direct)
 */
export const createSupportRequest = async (req, res) => {
  try {
    const { tripId, issueType, userId, userType, isSOS, sosDetails } = req.body;

    console.log('');
    console.log('🆘 '.repeat(35));
    console.log('🆘 CREATE SUPPORT REQUEST');
    console.log(`   Trip: ${tripId}`);
    console.log(`   Issue: ${issueType}`);
    console.log(`   User: ${userType}`);
    console.log(`   UserId: ${userId}`);
    console.log(`   SOS: ${isSOS || false}`);
    console.log('🆘 '.repeat(35));

    // Validate trip exists
    const trip = await Trip.findById(tripId)
      .populate('customerId', 'name phone socketId')
      .populate('assignedDriver', 'name phone socketId vehicleNumber rating location');

    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    // 🔥 FIX: Determine the actual userId from the trip if not provided or empty
    let actualUserId = userId;

    // Auto-detect if not provided
    if (!actualUserId || actualUserId === '' || actualUserId === 'undefined') {
      if (userType === 'customer' && trip.customerId?._id) {
        actualUserId = trip.customerId._id.toString();
      } else if (userType === 'driver' && trip.assignedDriver?._id) {
        actualUserId = trip.assignedDriver._id.toString();
      }
    }

    // If still ObjectId for any reason, convert
    if (actualUserId && typeof actualUserId !== 'string') {
      actualUserId = actualUserId.toString();
    }

    console.log(`✅ Normalized userId: ${actualUserId}`);

    // Validate the userId is a valid ObjectId
    if (!actualUserId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid user ID format' 
      });
    }

    // Check if support already exists for this trip
    const existingSupport = await SupportRequest.findOne({
      tripId,
      status: { $in: ['pending', 'in_progress'] }
    });

    if (existingSupport && !isSOS) {
      return res.json({
        success: true,
        message: 'Support request already exists',
        supportRequestId: existingSupport._id,
        autoChatAttempted: existingSupport.autoChatAttempted
      });
    }

    // Priority logic
    let priority = 'medium';
    if (isSOS) priority = 'critical';
    else if (['payment_issue', 'fare_confusion'].includes(issueType)) priority = 'high';
    else if (['driver_late', 'pickup_location'].includes(issueType)) priority = 'low';

    // Create support request with the validated userId
    const supportRequest = await SupportRequest.create({
      tripId,
      requestedBy: actualUserId,
      requestedByType: userType,
      issueType,
      priority,
      status: 'pending',
      isSOS: isSOS || false,
      sosDetails: isSOS ? sosDetails : undefined,
      autoChatAttempted: false
    });

    // Update trip
    await Trip.findByIdAndUpdate(tripId, {
      supportRequested: true,
      supportReason: issueType,
      supportRequestedAt: new Date()
    });

    console.log(`✅ Support request created: ${supportRequest._id}`);

    // 🤖 AUTO CHAT LOGIC (if not SOS)
    if (!isSOS && AUTO_CHAT_FLOWS[issueType]) {
      console.log('🤖 Starting auto-chat flow...');
      
      supportRequest.autoChatAttempted = true;
      await supportRequest.save();

      const flow = AUTO_CHAT_FLOWS[issueType][userType] || AUTO_CHAT_FLOWS[issueType].both;
      
      if (flow && flow.length > 0) {
        // Send first auto message
        const firstStep = flow[0];
        
        // Save to transcript
        supportRequest.autoChatTranscript.push({
          sender: 'system',
          message: firstStep.message,
          timestamp: new Date(),
          options: firstStep.options?.map(o => o.text)
        });
        await supportRequest.save();

        // Save to chat
        await SupportChat.create({
          supportRequestId: supportRequest._id,
          tripId,
          senderId: actualUserId,
          senderType: 'system',
          message: firstStep.message,
          messageType: firstStep.options ? 'action' : 'text',
          metadata: {
            options: firstStep.options?.map(o => o.text)
          }
        });

        // Emit to user
        const user = userType === 'customer' ? trip.customerId : trip.assignedDriver;
        if (user?.socketId && io) {
          io.to(user.socketId).emit('support:auto_chat_started', {
            supportRequestId: supportRequest._id,
            message: firstStep.message,
            options: firstStep.options,
            canEscalate: true,
            step: 1
          });
          console.log(`📤 Emitted auto_chat_started to user ${actualUserId}`);
        }

        return res.json({
          success: true,
          supportRequestId: supportRequest._id,
          autoChatStarted: true,
          message: firstStep.message,
          options: firstStep.options
        });
      }
    }

    // 🚨 SOS or no auto-chat - notify admin immediately
    console.log('🚨 Notifying admin immediately...');
    
    if (io) {
      io.to('admin-room').emit('admin:support_request', {
        supportRequestId: supportRequest._id,
        tripId: trip._id.toString(),
        issueType,
        priority,
        isSOS: isSOS || false,
        timestamp: new Date().toISOString(),
        trip: {
          _id: trip._id,
          status: trip.status,
          supportReason: issueType,
          createdAt: trip.createdAt,
          customerId: trip.customerId ? {
            _id: trip.customerId._id,
            name: trip.customerId.name,
            phone: trip.customerId.phone
          } : null,
          assignedDriver: trip.assignedDriver ? {
            _id: trip.assignedDriver._id,
            name: trip.assignedDriver.name,
            phone: trip.assignedDriver.phone,
            vehicleNumber: trip.assignedDriver.vehicleNumber,
            rating: trip.assignedDriver.rating,
            location: trip.assignedDriver.location
          } : null,
          pickup: trip.pickup,
          drop: trip.drop
        }
      });
      console.log('✅ Admin notified via socket');
    }

    res.json({
      success: true,
      supportRequestId: supportRequest._id,
      priority,
      adminNotified: true,
      autoChatStarted: false
    });

  } catch (error) {
    console.error('❌ createSupportRequest error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 💬 AUTO CHAT RESPONSE (User selects option)
 */
export const handleAutoChatResponse = async (req, res) => {
  try {
    const { supportRequestId, selectedOption, currentStep } = req.body;

    console.log('🤖 Auto-chat response:', { supportRequestId, selectedOption, currentStep });

    const supportRequest = await SupportRequest.findById(supportRequestId)
      .populate('tripId')
      .populate('requestedBy', 'socketId');

    if (!supportRequest) {
      return res.status(404).json({ success: false, message: 'Support request not found' });
    }

    // Save user's choice to transcript
    supportRequest.autoChatTranscript.push({
      sender: 'user',
      message: selectedOption,
      timestamp: new Date(),
      action: selectedOption
    });

    // Get flow
    const flow = AUTO_CHAT_FLOWS[supportRequest.issueType]?.[supportRequest.requestedByType];
    
    if (!flow) {
      return res.json({ success: false, message: 'Flow not found' });
    }

    // Find selected option details
    const currentStepData = flow.find(s => s.step === currentStep);
    const selectedOptionData = currentStepData?.options?.find(o => o.value === selectedOption);

    // Check if resolved
    if (selectedOptionData?.resolves) {
      supportRequest.status = 'auto_resolved';
      supportRequest.autoChatResolved = true;
      supportRequest.resolvedAt = new Date();
      await supportRequest.save();

      // Update trip
      await Trip.findByIdAndUpdate(supportRequest.tripId, {
        supportRequested: false,
        supportResolved: true
      });

      if (supportRequest.requestedBy.socketId && io) {
        io.to(supportRequest.requestedBy.socketId).emit('support:resolved', {
          message: 'Your issue has been resolved! Have a great ride! 🎉'
        });
      }

      console.log('✅ Auto-resolved successfully');

      return res.json({
        success: true,
        resolved: true,
        message: 'Issue resolved successfully'
      });
    }

    // Escalate to admin
    if (selectedOption === 'escalate' || !selectedOptionData?.nextStep) {
      supportRequest.status = 'in_progress';
      await supportRequest.save();

      const trip = await Trip.findById(supportRequest.tripId)
        .populate('customerId', 'name phone')
        .populate('assignedDriver', 'name phone vehicleNumber rating location');

      if (io) {
        io.to('admin-room').emit('admin:support_escalated', {
          supportRequestId: supportRequest._id,
          tripId: trip._id.toString(),
          issueType: supportRequest.issueType,
          autoChatTranscript: supportRequest.autoChatTranscript,
          trip: {
            _id: trip._id,
            status: trip.status,
            supportReason: supportRequest.issueType,
            createdAt: trip.createdAt,
            customerId: trip.customerId,
            assignedDriver: trip.assignedDriver,
            pickup: trip.pickup,
            drop: trip.drop
          }
        });
        console.log('📈 Escalated to admin');
      }

      return res.json({
        success: true,
        escalated: true,
        message: 'Connecting you with support...'
      });
    }

    // Continue to next step
    const nextStep = flow.find(s => s.step === selectedOptionData.nextStep);
    
    if (nextStep) {
      supportRequest.autoChatTranscript.push({
        sender: 'system',
        message: nextStep.message,
        timestamp: new Date()
      });
      await supportRequest.save();

      if (supportRequest.requestedBy.socketId && io) {
        io.to(supportRequest.requestedBy.socketId).emit('support:auto_chat_message', {
          message: nextStep.message,
          options: nextStep.options,
          step: nextStep.step
        });
      }

      return res.json({
        success: true,
        message: nextStep.message,
        options: nextStep.options,
        step: nextStep.step
      });
    }

    res.json({ success: false, message: 'No next step found' });

  } catch (error) {
    console.error('❌ handleAutoChatResponse error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 📋 GET ACTIVE SUPPORT REQUESTS (Admin)
 */
export const getActiveSupportRequests = async (req, res) => {
  try {
    const { status, priority } = req.query;

    console.log('📋 Fetching active support requests...');

    const query = {
      status: status || { $in: ['pending', 'in_progress'] }
    };

    if (priority) query.priority = priority;

    const requests = await SupportRequest.find(query)
      .populate('tripId')
      .populate('requestedBy', 'name phone')
      .populate({
        path: 'tripId',
        populate: [
          { path: 'customerId', select: 'name phone socketId' },
          { path: 'assignedDriver', select: 'name phone vehicleNumber rating location socketId' }
        ]
      })
      .sort({ priority: -1, createdAt: -1 })
      .lean();

    console.log(`✅ Found ${requests.length} active support requests`);

    // Transform to match frontend expectations
    const transformedRequests = requests.map(req => {
      const trip = req.tripId;
      return {
        _id: trip?._id || req._id,
        supportRequestId: req._id,
        status: trip?.status || 'unknown',
        supportReason: req.issueType,
        issueType: req.issueType,
        priority: req.priority,
        isSOS: req.isSOS,
        autoChatAttempted: req.autoChatAttempted,
        autoChatTranscript: req.autoChatTranscript,
        createdAt: req.createdAt,
        customerId: trip?.customerId || {},
        assignedDriver: trip?.assignedDriver || null,
        pickup: trip?.pickup || {},
        drop: trip?.drop || {}
      };
    });

    res.json({
      success: true,
      count: transformedRequests.length,
      requests: transformedRequests
    });

  } catch (error) {
    console.error('❌ getActiveSupportRequests error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 💬 SEND ADMIN MESSAGE - FIXED WITH PROPER BROADCASTING
 */
export const sendAdminMessage = async (req, res) => {
  try {
    const { supportRequestId, message } = req.body;

    if (!supportRequestId || !message) {
      return res.status(400).json({
        success: false,
        message: 'supportRequestId and message are required',
      });
    }

    console.log('');
    console.log('📨 '.repeat(30));
    console.log('📨 ADMIN SENDING MESSAGE');
    console.log(`   Support Request: ${supportRequestId}`);
    console.log(`   Message: ${message}`);

    // 🔍 Find support request
    const supportRequest = await SupportRequest.findById(supportRequestId);

    if (!supportRequest) {
      return res.status(404).json({
        success: false,
        message: 'Support request not found',
      });
    }

    // ✅ ADMIN MESSAGE (NO senderId)
    const chat = await SupportChat.create({
      supportRequestId: supportRequest._id,
      tripId: supportRequest.tripId,
      senderType: 'admin',
      senderId: null,
      message,
      messageType: 'text',
    });

    const roomName = `support_${supportRequestId}`;
    
    console.log(`📡 Broadcasting admin message to room: ${roomName}`);

    // 🔥 CRITICAL: Broadcast to support room (where customer is listening)
    if (io) {
      io.to(roomName).emit('support:chat_message', {
        _id: chat._id,
        supportRequestId: chat.supportRequestId,
        senderType: 'admin',
        message: chat.message,
        timestamp: chat.createdAt,
        createdAt: chat.createdAt
      });
      
      console.log('✅ Admin message broadcasted to customer');
    }

    res.json({
      success: true,
      message: 'Admin message sent',
      chat: {
        _id: chat._id,
        senderType: chat.senderType,
        message: chat.message,
        createdAt: chat.createdAt
      },
    });
  } catch (err) {
    console.error('❌ sendAdminMessage error:', err);

    res.status(500).json({
      success: false,
      message: 'Failed to send admin message',
    });
  }
};

/**
 * 💬 SEND USER MESSAGE (Customer/Driver)
 */
export const sendUserMessage = async (req, res) => {
  try {
    const { supportRequestId, message } = req.body;
    const userId = req.user._id;

    const supportRequest = await SupportRequest.findById(supportRequestId);
    
    if (!supportRequest) {
      return res.status(404).json({ success: false, message: 'Support request not found' });
    }

    // Save message
    await SupportChat.create({
      supportRequestId,
      tripId: supportRequest.tripId,
      senderId: userId,
      senderType: supportRequest.requestedByType,
      message
    });

    // Notify admin
    if (io) {
      io.to('admin-room').emit('admin:support_message', {
        supportRequestId,
        message,
        from: supportRequest.requestedByType,
        timestamp: new Date().toISOString()
      });
    }

    res.json({ success: true });

  } catch (error) {
    console.error('❌ sendUserMessage error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 📜 GET CHAT HISTORY
 */
export const getChatHistory = async (req, res) => {
  try {
    const { supportRequestId } = req.params;

    console.log('📜 Fetching chat history for:', supportRequestId);

    const messages = await SupportChat.find({ supportRequestId })
      .sort({ createdAt: 1 })
      .populate('senderId', 'name')
      .lean();

    console.log(`✅ Found ${messages.length} messages`);

    res.json({
      success: true,
      messages
    });

  } catch (error) {
    console.error('❌ getChatHistory error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ RESOLVE SUPPORT REQUEST - FIXED
 */
export const resolveSupportRequest = async (req, res) => {
  try {
    const { supportRequestId, resolutionNotes, adminId } = req.body;

    console.log('✅ Resolving support request:', supportRequestId);

    // 🔥 FIX: Don't save adminId to resolvedBy if it's not a valid ObjectId
    const updateData = {
      status: 'resolved',
      resolvedAt: new Date(),
      resolutionNotes
    };

    // Only add resolvedBy if adminId is a valid ObjectId format
    if (adminId && adminId.match(/^[0-9a-fA-F]{24}$/)) {
      updateData.resolvedBy = adminId;
    }

    const supportRequest = await SupportRequest.findByIdAndUpdate(
      supportRequestId,
      updateData,
      { new: true }
    ).populate('requestedBy', 'socketId');

    if (!supportRequest) {
      return res.status(404).json({ success: false, message: 'Support request not found' });
    }

    // Update trip
    await Trip.findByIdAndUpdate(supportRequest.tripId, {
      supportRequested: false,
      supportResolved: true
    });

    // Notify user
    if (supportRequest.requestedBy.socketId && io) {
      io.to(supportRequest.requestedBy.socketId).emit('support:resolved', {
        message: 'Your issue has been resolved by our support team.',
        notes: resolutionNotes
      });
    }

    console.log('✅ Support request resolved');

    res.json({ success: true, message: 'Support request resolved' });

  } catch (error) {
    console.error('❌ resolveSupportRequest error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 📊 GET SUPPORT ANALYTICS
 */
export const getSupportAnalytics = async (req, res) => {
  try {
    const totalRequests = await SupportRequest.countDocuments();
    const autoResolved = await SupportRequest.countDocuments({ status: 'auto_resolved' });
    const manualResolved = await SupportRequest.countDocuments({ 
      status: 'resolved',
      autoChatResolved: false
    });
    const pending = await SupportRequest.countDocuments({ 
      status: { $in: ['pending', 'in_progress'] }
    });

    const autoResolveRate = totalRequests > 0 
      ? ((autoResolved / totalRequests) * 100).toFixed(1)
      : 0;

    // Most common issues
    const issueStats = await SupportRequest.aggregate([
      {
        $group: {
          _id: '$issueType',
          count: { $sum: 1 },
          autoResolvedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'auto_resolved'] }, 1, 0] }
          }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Average resolution time
    const avgResolutionTime = await SupportRequest.aggregate([
      {
        $match: {
          status: { $in: ['resolved', 'auto_resolved'] },
          resolvedAt: { $exists: true }
        }
      },
      {
        $project: {
          resolutionTime: {
            $subtract: ['$resolvedAt', '$createdAt']
          }
        }
      },
      {
        $group: {
          _id: null,
          avgTime: { $avg: '$resolutionTime' }
        }
      }
    ]);

    res.json({
      success: true,
      analytics: {
        total: totalRequests,
        autoResolved,
        manualResolved,
        pending,
        autoResolveRate: `${autoResolveRate}%`,
        avgResolutionTime: avgResolutionTime[0]?.avgTime 
          ? `${Math.round(avgResolutionTime[0].avgTime / 60000)} minutes`
          : 'N/A',
        topIssues: issueStats
      }
    });

  } catch (error) {
    console.error('❌ getSupportAnalytics error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 📋 GET ISSUE TYPES
 */
export const getIssueTypes = async (req, res) => {
  try {
    const issueTypes = {
      customer: [
        { value: 'driver_late', label: 'Driver is late', hasAutoChat: true },
        { value: 'pickup_location', label: 'Pickup location issue', hasAutoChat: true },
        { value: 'drop_location', label: 'Drop location issue', hasAutoChat: false },
        { value: 'driver_not_moving', label: 'Driver not moving', hasAutoChat: false },
        { value: 'fare_confusion', label: 'Fare confusion', hasAutoChat: false },
        { value: 'cancel_ride', label: 'Cancel ride', hasAutoChat: false },
        { value: 'sos_emergency', label: '🚨 Emergency', hasAutoChat: false },
        { value: 'other', label: 'Other issue', hasAutoChat: false }
      ],
      driver: [
        { value: 'customer_not_responding', label: 'Customer not responding', hasAutoChat: true },
        { value: 'pickup_location', label: 'Pickup location wrong', hasAutoChat: true },
        { value: 'customer_delay', label: 'Customer delay', hasAutoChat: false },
        { value: 'payment_issue', label: 'Payment issue', hasAutoChat: false },
        { value: 'app_issue', label: 'App issue', hasAutoChat: false },
        { value: 'sos_emergency', label: '🚨 Emergency', hasAutoChat: false },
        { value: 'other', label: 'Other issue', hasAutoChat: false }
      ]
    };

    res.json({ success: true, issueTypes });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================
// 🎫 DRIVER TICKET FUNCTIONS
// ============================================

/**
 * 🎫 CREATE DRIVER TICKET - WITH DUPLICATE PREVENTION
 */
export const createDriverTicket = async (req, res) => {
  try {
    const { driverId, issueType, message } = req.body;

    console.log('🎫 Creating driver ticket:', { driverId, issueType });

    // Validate driver exists
    const driver = await User.findById(driverId).select('name phone');
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    // Normalize issue type
    const issueTypeMap = {
      "Documents Issue": "documents_issue",
      "Payment Issue": "payment_issue",
      "Ride Issue": "trip_issue",
      "Technical Issue": "app_issue",
      "Account Issue": "account_issue",
      "Wallet Issue": "wallet_issue",
      "Commission Issue": "commission_issue",
      "Other": "other"
    };

    const normalizedIssueType = issueTypeMap[issueType] || issueType?.toLowerCase().replace(/\s+/g, '_');

    // ✅ DUPLICATE CHECK: Check for existing active ticket with same issue type
    const existingTicket = await DriverTicket.findOne({
      driverId,
      status: { $in: ['pending', 'in_progress'] }
    }).sort({ createdAt: -1 });

    if (existingTicket) {
      const existingNormalized = existingTicket.issueType.toLowerCase().replace(/\s+/g, '_').replace(/issue/g, '').trim();
      const newNormalized = normalizedIssueType.toLowerCase().replace(/\s+/g, '_').replace(/issue/g, '').trim();
      
      if (existingNormalized === newNormalized) {
        return res.status(400).json({
          success: false,
          message: 'You already have an active ticket for this issue',
          existingTicket: {
            _id: existingTicket._id,
            issueType: existingTicket.issueType,
            createdAt: existingTicket.createdAt,
            status: existingTicket.status
          }
        });
      }
    }

    // Determine priority based on issue type
    let priority = 'medium';
    if (['payment_issue', 'wallet_issue'].includes(normalizedIssueType)) {
      priority = 'high';
    } else if (['app_issue', 'trip_issue'].includes(normalizedIssueType)) {
      priority = 'medium';
    } else {
      priority = 'low';
    }

    // Create ticket
    const ticket = await DriverTicket.create({
      driverId,
      driverName: driver.name,
      driverPhone: driver.phone,
      issueType: normalizedIssueType,
      message,
      priority,
      status: 'pending'
    });

    console.log(`✅ Driver ticket created: ${ticket._id}`);

    // Notify admin via socket
    if (io) {
      io.to('admin-room').emit('admin:driver_ticket', {
        ticket: {
          _id: ticket._id,
          driverId: ticket.driverId,
          driverName: ticket.driverName,
          driverPhone: ticket.driverPhone,
          issueType: ticket.issueType,
          message: ticket.message,
          priority: ticket.priority,
          status: ticket.status,
          createdAt: ticket.createdAt
        },
        timestamp: new Date().toISOString()
      });
      console.log('✅ Admin notified of new driver ticket');
    }

    res.json({
      success: true,
      message: 'Ticket submitted successfully. Our team will contact you soon.',
      ticketId: ticket._id
    });

  } catch (error) {
    console.error('❌ createDriverTicket error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ NEW: GET DRIVER'S ACTIVE TICKETS
 */
export const getDriverActiveTickets = async (req, res) => {
  try {
    const { driverId } = req.params;

    console.log('📋 Fetching active tickets for driver:', driverId);

    const tickets = await DriverTicket.find({
      driverId,
      status: { $in: ['pending', 'in_progress'] }
    })
      .select('_id issueType status priority createdAt')
      .sort({ createdAt: -1 })
      .lean();

    console.log(`✅ Found ${tickets.length} active tickets`);

    res.json({
      success: true,
      tickets
    });

  } catch (error) {
    console.error('❌ getDriverActiveTickets error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 📋 GET ALL DRIVER TICKETS (Admin)
 */
export const getDriverTickets = async (req, res) => {
  try {
    const { status } = req.query;

    console.log('📋 Fetching driver tickets...');

    const query = status ? { status } : { status: { $in: ['pending', 'in_progress'] } };

    const tickets = await DriverTicket.find(query)
      .select("_id driverId driverName driverPhone issueType message priority status createdAt")
      .sort({ priority: -1, createdAt: -1 })
      .lean();

    console.log(`✅ Found ${tickets.length} driver tickets`);

    res.json({
      success: true,
      count: tickets.length,
      tickets
    });

  } catch (error) {
    console.error('❌ getDriverTickets error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 💬 SEND MESSAGE TO DRIVER TICKET
 */
export const sendDriverTicketMessage = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { message } = req.body;

    console.log('💬 Admin sending message to ticket:', ticketId);

    const ticket = await DriverTicket.findById(ticketId);
    
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Update ticket status to in_progress if pending
    if (ticket.status === 'pending') {
      ticket.status = 'in_progress';
      await ticket.save();
    }

    // Add message to ticket (you can create a separate DriverTicketMessage model if needed)
    // For now, we'll store in adminNotes
    ticket.adminNotes = (ticket.adminNotes || '') + `\n[${new Date().toLocaleString()}] ${message}`;
    await ticket.save();

    res.json({
      success: true,
      message: 'Message sent to driver'
    });

  } catch (error) {
    console.error('❌ sendDriverTicketMessage error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ RESOLVE DRIVER TICKET
 */
/**
 * ✅ RESOLVE DRIVER TICKET - Using Socket (No FCM needed!)
 */
export const resolveDriverTicket = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { resolutionNotes } = req.body;

    console.log('✅ Resolving driver ticket:', ticketId);

    const ticket = await DriverTicket.findByIdAndUpdate(
      ticketId,
      {
        status: 'resolved',
        resolvedAt: new Date(),
        adminNotes: resolutionNotes
      },
      { new: true }
    );

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // 🔔 Notify driver via SOCKET (works when app is open)
    const driver = await User.findById(ticket.driverId).select('socketId');
    if (driver?.socketId && io) {
      io.to(driver.socketId).emit('driver:ticket_resolved', {
        ticketId: ticket._id.toString(),
        message: 'Your support ticket has been resolved by our team.',
        timestamp: new Date().toISOString()
      });
      console.log('✅ Driver notified via socket');
    }

    res.json({
      success: true,
      message: 'Ticket resolved successfully'
    });

  } catch (error) {
    console.error('❌ resolveDriverTicket error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};