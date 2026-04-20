// src/models/CoinTransaction.js
// ─────────────────────────────────────────────────────────────────────────────
// Tracks every coin earn / spend event for a customer.
// Used by the coins wallet page and admin dashboards.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const coinTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trip',
      default: null,
    },
    coinsEarned: {
      // Positive = earn, Negative = spend/redeem
      type: Number,
      required: true,
    },
    type: {
      type: String,
      enum: ['earn', 'spend', 'referral_reward', 'admin_grant'],
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    // Snapshot of balance AFTER this transaction
    balanceAfter: {
      type: Number,
      default: 0,
    },
    // Breakdown details for earn transactions
    breakdown: {
      baseCoins: { type: Number, default: 0 },
      distanceBonus: { type: Number, default: 0 },
      vehicleBonus: { type: Number, default: 0 },
      randomBonus: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
  }
);

coinTransactionSchema.index({ userId: 1, createdAt: -1 });
coinTransactionSchema.index({ tripId: 1 });
coinTransactionSchema.index({ type: 1 });

export default mongoose.model('CoinTransaction', coinTransactionSchema);
