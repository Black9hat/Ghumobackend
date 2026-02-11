// src/models/Standby.js
import mongoose from 'mongoose';

const standbySchema = new mongoose.Schema({
  tripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
    required: true,
    unique: true,
  },
  driverQueue: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  currentIndex: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

const Standby = mongoose.model('Standby', standbySchema);
export default Standby;
