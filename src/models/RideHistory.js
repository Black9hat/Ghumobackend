// models/rideHistory.js
import mongoose from 'mongoose';

const rideHistorySchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    index: true,
  },
  pickupLocation: {
    type: String,
    required: true,
  },
  dropLocation: {
    type: String,
    required: true,
  },
  vehicleType: {
    type: String,
    required: true,
  },
  fare: {
    type: Number,
    required: true,
  },
  // 🪙 Coin discount tracking (NEW)
  originalFare: {
    type: Number,
    default: 0,
  },
  discountApplied: {
    type: Number,
    default: 0,
  },
  coinsUsed: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['Completed', 'Cancelled', 'Ongoing'],
    default: 'Completed',
  },
  driver: {
    name: String,
    phone: String,
    vehicleNumber: String,
  },
  dateTime: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

export default mongoose.model('RideHistory', rideHistorySchema);
