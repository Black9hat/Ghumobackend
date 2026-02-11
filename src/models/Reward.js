// models/Reward.js
import mongoose from 'mongoose';

const rewardSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',   // ✅ Must match your User model name
    required: true,
    index: true,
  },
  tripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
  },
  coins: {
    type: Number,
    required: true,
  },
  type: {
    type: String,
    enum: ['earned', 'redeemed'],
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Reward = mongoose.model('Reward', rewardSchema);
export default Reward;
