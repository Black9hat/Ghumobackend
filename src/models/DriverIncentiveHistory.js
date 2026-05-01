// src/models/DriverIncentiveHistory.js
import mongoose from 'mongoose';

const driverIncentiveHistorySchema = new mongoose.Schema({
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  date: {
    type: String, // Format: "YYYY-MM-DD"
    required: true,
    index: true
  },
  ridesCompleted: {
    type: Number,
    default: 0
  },
  incentiveEarned: {
    type: Number,
    default: 0
  },
  slabMatched: {
    type: Number, // The ride count of the matched slab (e.g., 10, 13, 15)
    default: null
  },
  isPaid: {
    type: Boolean,
    default: false
  },
  paidAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Compound index for efficient lookups
driverIncentiveHistorySchema.index({ driverId: 1, date: 1 }, { unique: true });

const DriverIncentiveHistory = mongoose.model('DriverIncentiveHistory', driverIncentiveHistorySchema);

export default DriverIncentiveHistory;