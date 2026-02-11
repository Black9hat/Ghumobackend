// src/models/ReassignmentLog.js

import mongoose from 'mongoose';

const reassignmentLogSchema = new mongoose.Schema({
  tripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
    required: true,
  },
  previousDriver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  newDriver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reason: {
    type: String,
    enum: ['timeout', 'rejected', 'manual_override'],
  },
  reassignedAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model('ReassignmentLog', reassignmentLogSchema);
