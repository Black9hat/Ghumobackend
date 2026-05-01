// src/models/ChatMessage.js
import mongoose from 'mongoose';

const chatMessageSchema = new mongoose.Schema({
  tripId: {
    type: String,
    required: true,
    index: true
  },
  senderId: {
    type: String,
    required: true
  },
  receiverId: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true,
    maxlength: 1000
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  read: {
    type: Boolean,
    default: false
  },
  // Optional: Store sender/receiver names for easier querying
  senderName: {
    type: String,
    default: ''
  },
  receiverName: {
    type: String,
    default: ''
  }
}, {
  timestamps: true // Adds createdAt and updatedAt automatically
});

// Compound indexes for better query performance
chatMessageSchema.index({ tripId: 1, timestamp: 1 });
chatMessageSchema.index({ receiverId: 1, read: 1 });
chatMessageSchema.index({ senderId: 1, timestamp: -1 });

// Virtual to get formatted timestamp
chatMessageSchema.virtual('formattedTimestamp').get(function() {
  return this.timestamp.toISOString();
});

// Method to mark message as read
chatMessageSchema.methods.markAsRead = async function() {
  this.read = true;
  return this.save();
};

// Static method to get unread count for a user
chatMessageSchema.statics.getUnreadCount = async function(userId) {
  return this.countDocuments({
    receiverId: userId,
    read: false
  });
};

// Static method to mark all messages in a trip as read
chatMessageSchema.statics.markTripMessagesAsRead = async function(tripId, userId) {
  return this.updateMany(
    { 
      tripId, 
      receiverId: userId,
      read: false 
    },
    { 
      $set: { read: true } 
    }
  );
};

// Static method to get chat history
chatMessageSchema.statics.getChatHistory = async function(tripId, limit = 100) {
  return this.find({ tripId })
    .sort({ timestamp: 1 })
    .limit(limit)
    .lean();
};

// Clean up old messages (optional)
chatMessageSchema.statics.deleteOldMessages = async function(daysOld = 90) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  
  return this.deleteMany({
    timestamp: { $lt: cutoffDate }
  });
};

const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

export default ChatMessage;