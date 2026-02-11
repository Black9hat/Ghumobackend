// socket/supportSocketHandler.js
import SupportRequest from '../models/SupportRequest.js';
import { SupportChat } from '../models/SupportChat.js';
import Trip from '../models/Trip.js';

/**
 * Initialize support-related socket events
 */
export const initSupportSockets = (io, socket) => {
  
  // ==========================================
  // 🆘 SOS EMERGENCY
  // ==========================================
  socket.on('support:sos', async (data) => {
    try {
      const { tripId, userId, userType, location } = data;

      console.log('');
      console.log('🚨'.repeat(40));
      console.log('🚨 SOS EMERGENCY ACTIVATED');
      console.log(`   User: ${userId} (${userType})`);
      console.log(`   Trip: ${tripId}`);
      console.log('🚨'.repeat(40));

      const trip = await Trip.findById(tripId)
        .populate('customerId', 'name phone socketId')
        .populate('assignedDriver', 'name phone vehicleNumber');

      if (!trip) {
        socket.emit('support:sos_failed', { message: 'Trip not found' });
        return;
      }

      const supportRequest = await SupportRequest.create({
        tripId,
        requestedBy: userId,
        requestedByType: userType,
        issueType: 'sos_emergency',
        priority: 'critical',
        status: 'in_progress',
        isSOS: true,
        sosDetails: {
          location: {
            type: 'Point',
            coordinates: [location.lng, location.lat]
          },
          timestamp: new Date()
        }
      });

      await Trip.findByIdAndUpdate(tripId, {
        supportRequested: true,
        supportReason: 'SOS Emergency',
        sosActivated: true,
        sosActivatedAt: new Date()
      });

      // 🚨 NOTIFY ADMIN IMMEDIATELY
      io.to('admin-room').emit('admin:sos_emergency', {
        supportRequestId: supportRequest._id,
        tripId: trip._id.toString(),
        priority: 'CRITICAL',
        emergency: true,
        timestamp: new Date().toISOString(),
        location,
        trip: {
          status: trip.status,
          customer: {
            _id: trip.customerId._id,
            name: trip.customerId.name,
            phone: trip.customerId.phone
          },
          driver: trip.assignedDriver ? {
            _id: trip.assignedDriver._id,
            name: trip.assignedDriver.name,
            phone: trip.assignedDriver.phone,
            vehicleNumber: trip.assignedDriver.vehicleNumber
          } : null,
          pickup: trip.pickup,
          drop: trip.drop
        }
      });

      socket.emit('support:sos_activated', {
        supportRequestId: supportRequest._id,
        message: '🚨 Emergency support activated. Admin has been notified immediately.',
        adminNotified: true
      });

      console.log('✅ SOS request created and admin notified');

    } catch (error) {
      console.error('❌ support:sos error:', error);
      socket.emit('support:sos_failed', { message: error.message });
    }
  });

  // ==========================================
  // 💬 REAL-TIME SUPPORT CHAT
  // ==========================================
  
  /**
   * Join support chat room
   */
  socket.on('support:join_chat', async (data) => {
    try {
      const { supportRequestId, userId } = data;
      
      const roomName = `support_${supportRequestId}`;
      socket.join(roomName);
      
      console.log(`👤 User ${userId} joined support chat: ${supportRequestId}`);
      console.log(`   Socket ID: ${socket.id}`);
      console.log(`   Room: ${roomName}`);
      
      // Notify others in room
      socket.to(roomName).emit('support:user_joined', {
        userId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ support:join_chat error:', error);
    }
  });

  /**
   * Send support message (from customer/driver)
   */
  socket.on('support:send_message', async (data) => {
    try {
      const { supportRequestId, message, senderId, senderType } = data;

      console.log('');
      console.log('💬 '.repeat(30));
      console.log('💬 CUSTOMER/DRIVER MESSAGE');
      console.log(`   Support Request: ${supportRequestId}`);
      console.log(`   Sender: ${senderId} (${senderType})`);
      console.log(`   Message: ${message}`);

      const supportRequest = await SupportRequest.findById(supportRequestId);
      
      if (!supportRequest) {
        socket.emit('support:error', { message: 'Support request not found' });
        return;
      }

      // Save message to database
      const chatMessage = await SupportChat.create({
        supportRequestId,
        tripId: supportRequest.tripId,
        senderId,
        senderType,
        message,
        messageType: 'text'
      });

      const roomName = `support_${supportRequestId}`;
      
      console.log(`📡 Broadcasting to room: ${roomName}`);
      
      // 🔥 IMPORTANT: Broadcast to EVERYONE in the room (including admin)
      io.to(roomName).emit('support:chat_message', {
        _id: chatMessage._id,
        supportRequestId,
        senderId,
        senderType,
        message,
        timestamp: chatMessage.createdAt,
        createdAt: chatMessage.createdAt
      });

      // Also notify admin room specifically
      io.to('admin-room').emit('admin:support_message', {
        supportRequestId,
        message,
        from: senderType,
        timestamp: new Date().toISOString()
      });

      console.log('✅ Message broadcasted successfully');

      socket.emit('support:message_sent', { 
        success: true,
        messageId: chatMessage._id
      });

    } catch (error) {
      console.error('❌ support:send_message error:', error);
      socket.emit('support:error', { message: error.message });
    }
  });

  /**
   * Typing indicator
   */
  socket.on('support:typing', (data) => {
    try {
      const { supportRequestId, userId, senderType, isTyping } = data;
      
      const roomName = `support_${supportRequestId}`;
      
      socket.to(roomName).emit('support:typing_status', {
        userId,
        senderType,
        isTyping,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ support:typing error:', error);
    }
  });

  /**
   * Mark messages as read
   */
  socket.on('support:mark_read', async (data) => {
    try {
      const { supportRequestId, userId } = data;

      await SupportChat.updateMany(
        {
          supportRequestId,
          senderId: { $ne: userId }
        },
        {
          $addToSet: {
            readBy: {
              userId,
              readAt: new Date()
            }
          }
        }
      );

      const roomName = `support_${supportRequestId}`;
      
      socket.to(roomName).emit('support:messages_read', {
        userId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ support:mark_read error:', error);
    }
  });

  /**
   * Leave support chat
   */
  socket.on('support:leave_chat', (data) => {
    try {
      const { supportRequestId, userId } = data;
      
      const roomName = `support_${supportRequestId}`;
      socket.leave(roomName);
      
      socket.to(roomName).emit('support:user_left', {
        userId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ support:leave_chat error:', error);
    }
  });

  // ==========================================
  // 📱 ADMIN SUPPORT ACTIONS
  // ==========================================

  /**
   * Admin joins support request
   */
  socket.on('admin:join_support', async (data) => {
    try {
      const { supportRequestId, adminId } = data;
      
      const roomName = `support_${supportRequestId}`;
      socket.join(roomName);
      
      console.log('');
      console.log('👨‍💼 '.repeat(30));
      console.log('👨‍💼 ADMIN JOINED SUPPORT');
      console.log(`   Support Request: ${supportRequestId}`);
      console.log(`   Admin ID: ${adminId}`);
      console.log(`   Socket ID: ${socket.id}`);
      console.log(`   Room: ${roomName}`);
      
      // Update support request status
      await SupportRequest.findByIdAndUpdate(supportRequestId, {
        status: 'in_progress'
      });
      
      // 🔥 IMPORTANT: Notify customer/driver that admin joined
      io.to(roomName).emit('support:admin_joined', {
        message: 'Support admin has joined the chat',
        timestamp: new Date().toISOString()
      });

      console.log('✅ Admin joined and customer notified');

    } catch (error) {
      console.error('❌ admin:join_support error:', error);
    }
  });

  /**
   * Admin resolves support
   */
  socket.on('admin:resolve_support', async (data) => {
    try {
      const { supportRequestId, resolutionNotes, adminId } = data;

      console.log('✅ Admin resolving support:', supportRequestId);

      const supportRequest = await SupportRequest.findByIdAndUpdate(
        supportRequestId,
        {
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNotes
        },
        { new: true }
      ).populate('requestedBy', 'socketId');

      // Update trip
      await Trip.findByIdAndUpdate(supportRequest.tripId, {
        supportRequested: false,
        supportResolved: true
      });

      const roomName = `support_${supportRequestId}`;

      // Notify user in support room
      io.to(roomName).emit('support:resolved', {
        message: 'Your issue has been resolved by our support team.',
        notes: resolutionNotes,
        timestamp: new Date().toISOString()
      });

      // Notify admin room
      io.to('admin-room').emit('admin:support_resolved', {
        supportRequestId,
        timestamp: new Date().toISOString()
      });

      socket.emit('admin:resolve_success', {
        success: true,
        supportRequestId
      });

      console.log('✅ Support resolved and notifications sent');

    } catch (error) {
      console.error('❌ admin:resolve_support error:', error);
      socket.emit('admin:resolve_failed', { message: error.message });
    }
  });

  /**
   * Get unread support count (for admin badge)
   */
  socket.on('admin:get_unread_support', async () => {
    try {
      const unreadCount = await SupportRequest.countDocuments({
        status: { $in: ['pending', 'in_progress'] }
      });

      const sosCount = await SupportRequest.countDocuments({
        status: { $in: ['pending', 'in_progress'] },
        isSOS: true
      });

      socket.emit('admin:unread_support_count', {
        total: unreadCount,
        sos: sosCount,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ admin:get_unread_support error:', error);
    }
  });

};

// ==========================================
// 🔔 SUPPORT NOTIFICATION HELPERS
// ==========================================

/**
 * Notify admin of new support request
 */
/**
 * Notify admin of new support request
 */
export const notifyAdminNewSupport = (io, supportRequest, trip) => {
  io.to('admin-room').emit('admin:support_request', {
    supportRequestId: supportRequest._id,
    tripId: trip._id.toString(),
    issueType: supportRequest.issueType,
    priority: supportRequest.priority,
    isSOS: supportRequest.isSOS,
    timestamp: new Date().toISOString(),
    trip: {
      status: trip.status,
      customer: trip.customerId ? {
        name: trip.customerId.name,
        phone: trip.customerId.phone
      } : null,
      driver: trip.assignedDriver ? {
        name: trip.assignedDriver.name,
        phone: trip.assignedDriver.phone,
        vehicleNumber: trip.assignedDriver.vehicleNumber
      } : null,
      pickup: trip.pickup,
      drop: trip.drop
    }
  });
};

/**
 * Send auto-chat message to user
 */
export const sendAutoChatMessage = (io, userId, socketId, message, options) => {
  if (socketId) {
    io.to(socketId).emit('support:auto_chat_message', {
      message,
      options,
      canEscalate: true,
      timestamp: new Date().toISOString()
    });
  }
};
