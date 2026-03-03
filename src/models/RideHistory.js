// models/rideHistory.js
import mongoose from 'mongoose';

const rideHistorySchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    index: true, // ✅ Add index for faster queries
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
  timestamps: true, // ✅ Adds createdAt and updatedAt
});

export default mongoose.model('RideHistory', rideHistorySchema);