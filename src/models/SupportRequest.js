// models/SupportRequest.js
import mongoose from 'mongoose';

const supportRequestSchema = new mongoose.Schema({
  tripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
    required: true,
    index: true
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  requestedByType: {
    type: String,
    enum: ['customer', 'driver'],
    required: true
  },
  issueType: {
    type: String,
    enum: [
      'driver_late',
      'pickup_location',
      'drop_location',
      'driver_not_moving',
      'fare_confusion',
      'cancel_ride',
      'customer_not_responding',
      'customer_delay',
      'payment_issue',
      'app_issue',
      'sos_emergency',
      'other'
    ],
    required: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'resolved', 'escalated', 'auto_resolved'],
    default: 'pending'
  },
  autoChatAttempted: {
    type: Boolean,
    default: false
  },
  autoChatResolved: {
    type: Boolean,
    default: false
  },
  autoChatTranscript: [{
    sender: String, // 'system' or 'user'
    message: String,
    timestamp: Date,
    action: String // button clicked, etc.
  }],
  adminNotes: String,
  resolvedAt: Date,
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false  // 🔥 ADD THIS LINE

  },
  resolutionNotes: String,
  isSOS: {
    type: Boolean,
    default: false
  },
  sosDetails: {
    location: {
      type: {
        type: String,
        default: 'Point'
      },
      coordinates: [Number]
    },
    timestamp: Date,
    deviceInfo: String
  }
}, {
  timestamps: true
});

// Index for admin queries
supportRequestSchema.index({ status: 1, createdAt: -1 });
supportRequestSchema.index({ tripId: 1, status: 1 });
supportRequestSchema.index({ priority: 1, status: 1 });

export default mongoose.model('SupportRequest', supportRequestSchema);
