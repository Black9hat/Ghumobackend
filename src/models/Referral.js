// models/Referral.js
// ─────────────────────────────────────────────────────────────────────────────
// Tracks every referral relationship:
//   referrerId → referred user → whether first ride is completed → reward given
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const referralSchema = new mongoose.Schema({
  // The user who shared their code
  referrerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // The new user who signed up with the code
  referredUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,        // a user can only be referred once
    index: true,
  },
  referralCode: {
    type: String,
    required: true,
    uppercase: true,
  },
  // Lifecycle flags
  firstRideCompleted: {
    type: Boolean,
    default: false,
  },
  firstRideTripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
    default: null,
  },
  firstRideCompletedAt: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

referralSchema.index({ referrerId: 1, firstRideCompleted: 1 });

const Referral = mongoose.model('Referral', referralSchema);
export default Referral;
