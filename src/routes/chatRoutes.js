// src/routes/chatRoutes.js
import express from 'express';
import ChatMessage from '../models/ChatMessage.js';

const router = express.Router();

// GET /api/chat/history/:tripId - Get chat history for a trip
router.get('/history/:tripId', async (req, res) => {
  try {
    const { tripId } = req.params;
    
    console.log(`📨 Fetching chat history for trip: ${tripId}`);
    
    const messages = await ChatMessage.find({ tripId })
      .sort({ timestamp: 1 })
      .limit(100) // Limit to last 100 messages
      .lean();
    
    console.log(`✅ Found ${messages.length} messages`);
    
    res.json({
      success: true,
      messages: messages.map(msg => ({
        senderId: msg.senderId,
        receiverId: msg.receiverId,
        message: msg.message,
        timestamp: msg.timestamp.toISOString(),
        read: msg.read
      }))
    });
  } catch (error) {
    console.error('❌ Error fetching chat history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chat history',
      error: error.message
    });
  }
});

// POST /api/chat/send - Send a new message
router.post('/send', async (req, res) => {
  try {
    const { tripId, senderId, receiverId, message } = req.body;
    
    if (!tripId || !senderId || !receiverId || !message) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: tripId, senderId, receiverId, message'
      });
    }
    
    console.log(`📤 Saving message for trip ${tripId} from ${senderId} to ${receiverId}`);
    
    const chatMessage = new ChatMessage({
      tripId,
      senderId,
      receiverId,
      message,
      timestamp: new Date()
    });
    
    await chatMessage.save();
    
    console.log(`✅ Message saved successfully`);
    
    // Emit to socket if io is available
    if (req.io) {
      req.io.to(`chat_${tripId}`).emit('chat:new_message', {
        tripId,
        senderId,
        receiverId,
        message,
        timestamp: chatMessage.timestamp.toISOString()
      });
    }
    
    res.json({
      success: true,
      message: {
        senderId: chatMessage.senderId,
        receiverId: chatMessage.receiverId,
        message: chatMessage.message,
        timestamp: chatMessage.timestamp.toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Error saving message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save message',
      error: error.message
    });
  }
});

// POST /api/chat/mark-read/:tripId - Mark messages as read
router.post('/mark-read/:tripId', async (req, res) => {
  try {
    const { tripId } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required'
      });
    }
    
    const result = await ChatMessage.updateMany(
      { 
        tripId, 
        receiverId: userId,
        read: false 
      },
      { 
        $set: { read: true } 
      }
    );
    
    console.log(`✅ Marked ${result.modifiedCount} messages as read for user ${userId}`);
    
    res.json({
      success: true,
      message: 'Messages marked as read',
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error('❌ Error marking messages as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark messages as read',
      error: error.message
    });
  }
});

// GET /api/chat/unread/:userId - Get unread message count
router.get('/unread/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const unreadCount = await ChatMessage.countDocuments({
      receiverId: userId,
      read: false
    });
    
    // Get count per trip
    const unreadByTrip = await ChatMessage.aggregate([
      {
        $match: {
          receiverId: userId,
          read: false
        }
      },
      {
        $group: {
          _id: '$tripId',
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      unreadCount,
      unreadByTrip: unreadByTrip.map(item => ({
        tripId: item._id,
        count: item.count
      }))
    });
  } catch (error) {
    console.error('❌ Error fetching unread count:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unread count',
      error: error.message
    });
  }
});

// DELETE /api/chat/:tripId - Delete all messages for a trip (optional cleanup)
router.delete('/:tripId', async (req, res) => {
  try {
    const { tripId } = req.params;
    
    const result = await ChatMessage.deleteMany({ tripId });
    
    console.log(`🗑️ Deleted ${result.deletedCount} messages for trip ${tripId}`);
    
    res.json({
      success: true,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('❌ Error deleting messages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete messages',
      error: error.message
    });
  }
});

// GET /api/chat/trips/:userId - Get all trips with messages for a user
router.get('/trips/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const trips = await ChatMessage.aggregate([
      {
        $match: {
          $or: [
            { senderId: userId },
            { receiverId: userId }
          ]
        }
      },
      {
        $sort: { timestamp: -1 }
      },
      {
        $group: {
          _id: '$tripId',
          lastMessage: { $first: '$message' },
          lastTimestamp: { $first: '$timestamp' },
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$receiverId', userId] },
                  { $eq: ['$read', false] }
                ]},
                1,
                0
              ]
            }
          }
        }
      },
      {
        $sort: { lastTimestamp: -1 }
      }
    ]);
    
    res.json({
      success: true,
      trips: trips.map(trip => ({
        tripId: trip._id,
        lastMessage: trip.lastMessage,
        lastTimestamp: trip.lastTimestamp,
        unreadCount: trip.unreadCount
      }))
    });
  } catch (error) {
    console.error('❌ Error fetching user trips:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trips',
      error: error.message
    });
  }
});

export default router;