// src/models/Wallet.js
import mongoose from 'mongoose';

// ═══════════════════════════════════════════════════════════════════
// TRANSACTION SUB-SCHEMA
// ═══════════════════════════════════════════════════════════════════
const transactionSchema = new mongoose.Schema(
  {
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trip',
    },
    type: {
      type: String,
      enum: ['credit', 'debit', 'commission'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    // ─── Razorpay fields (only on online payments) ───────────────
    razorpayPaymentId: {
      type: String,
      default: null,
    },
    razorpayOrderId: {
      type: String,
      default: null,
    },
    paymentMethod: {
      type: String,
      enum: ['upi', 'card', 'netbanking', 'wallet', 'cash', 'unknown'],
      default: 'unknown',
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'completed',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

// ═══════════════════════════════════════════════════════════════════
// WALLET SCHEMA
// ═══════════════════════════════════════════════════════════════════
const walletSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    availableBalance: { type: Number, default: 0, min: 0 },

    // balance mirrors availableBalance (legacy field — kept for old code)
    balance: { type: Number, default: 0, min: 0 },

    totalEarnings:   { type: Number, default: 0, min: 0 },
    totalCommission: { type: Number, default: 0, min: 0 },

    // pendingAmount = commission owed to platform (cash trips)
    // Driver collected cash but hasn't paid commission yet
    pendingAmount: { type: Number, default: 0, min: 0 },

    transactions: [transactionSchema],

    // ─── Cash trip dedup ─────────────────────────────────────────
    // Stores tripIds for which cash commission was already processed.
    // Secondary guard after trip.walletUpdated. Prevents double-debit
    // if driver taps "confirm" twice.
    processedTripIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trip',
      }
    ],

    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ═══════════════════════════════════════════════════════════════════
// INDEXES
// ═══════════════════════════════════════════════════════════════════

walletSchema.index({ driverId: 1 });
walletSchema.index({ 'transactions.tripId': 1 });
walletSchema.index({ 'transactions.createdAt': -1 });
walletSchema.index({ 'transactions.status': 1 });
walletSchema.index({ 'transactions.type': 1 });
walletSchema.index({ availableBalance: -1 });
walletSchema.index({ totalEarnings: -1 });
walletSchema.index({ processedTripIds: 1 });

// ✅ NOTE: The compound unique index on { driverId, transactions.razorpayPaymentId }
// has been intentionally REMOVED. MongoDB cannot enforce subdocument array uniqueness
// reliably — it caused E11000 errors on any wallet with multiple cash transactions
// (which have no razorpayPaymentId). Dedup is handled by:
//   1. trip.walletUpdated flag (primary)
//   2. processedTripIds array (cash dedup)
//   3. Application-level razorpayPaymentId check inside transactions (online payments)

// ═══════════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════════

walletSchema.pre('save', function (next) {
  this.lastUpdated = new Date();
  // Keep balance in sync with availableBalance
  this.balance = this.availableBalance;
  next();
});

walletSchema.pre('findOneAndUpdate', function (next) {
  this.set({ lastUpdated: new Date() });
  next();
});

// ═══════════════════════════════════════════════════════════════════
// STATIC HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Find or create wallet for a driver.
 * Safe to call inside or outside a session.
 */
walletSchema.statics.findOrCreate = async function (driverId, session = null) {
  const query = this.findOne({ driverId });
  if (session) query.session(session);
  let wallet = await query;

  if (!wallet) {
    wallet = new this({
      driverId,
      availableBalance: 0,
      balance: 0,
      totalEarnings: 0,
      totalCommission: 0,
      pendingAmount: 0,
      transactions: [],
      processedTripIds: [],
    });
    if (session) {
      await wallet.save({ session });
    } else {
      await wallet.save();
    }
  }

  return wallet;
};

/**
 * Check if a tripId has already been processed (cash dedup).
 */
walletSchema.methods.isTripProcessed = function (tripId) {
  return this.processedTripIds.some(
    (id) => id.toString() === tripId.toString()
  );
};

/**
 * Check if a razorpayPaymentId has already been recorded (online dedup).
 */
walletSchema.methods.isPaymentProcessed = function (paymentId) {
  if (!paymentId) return false;
  return this.transactions.some(
    (t) => t.razorpayPaymentId === paymentId && t.status === 'completed'
  );
};

// ═══════════════════════════════════════════════════════════════════
// VIRTUALS
// ═══════════════════════════════════════════════════════════════════

walletSchema.virtual('transactionCount').get(function () {
  return this.transactions ? this.transactions.length : 0;
});

walletSchema.virtual('netEarnings').get(function () {
  return (this.totalEarnings || 0) - (this.totalCommission || 0);
});

walletSchema.set('toJSON',   { virtuals: true });
walletSchema.set('toObject', { virtuals: true });

export default mongoose.model('Wallet', walletSchema);