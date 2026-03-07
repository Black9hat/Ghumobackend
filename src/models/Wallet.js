// models/Wallet.js - WALLET MODEL
import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema(
  {
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trip'
    },
    type: {
      type: String,
      enum: ['credit', 'debit', 'commission'],
      required: true
    },
    amount: {
      type: Number,
      required: true,
      min: 0
    },
    description: {
      type: String,
      required: true,
      trim: true
    },
    razorpayPaymentId: {
      type: String,
      sparse: true,
      index: true
    },
    razorpayOrderId: {
      type: String,
      sparse: true,
      index: true
    },
    paymentMethod: {
      type: String,
      enum: ['upi', 'card', 'netbanking', 'wallet', 'cash', 'unknown'],
      default: 'unknown'
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'completed'
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    _id: true,
    timestamps: false
  }
);

const walletSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    availableBalance: {
      type: Number,
      default: 0,
      min: 0
    },
    balance: {
      type: Number,
      default: 0,
      min: 0
    },
    totalEarnings: {
      type: Number,
      default: 0,
      min: 0
    },
    totalCommission: {
      type: Number,
      default: 0,
      min: 0
    },
    pendingAmount: {
      type: Number,
      default: 0,
      min: 0
    },
    transactions: [transactionSchema],
    lastUpdated: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

// Indexes
walletSchema.index({ driverId: 1 });
walletSchema.index({ 'transactions.tripId': 1 });
// ✅ UNIQUE sparse index — DB-level guarantee: same paymentId can never be written twice
// sparse + partialFilter excludes transactions without razorpayPaymentId (cash trips etc.)
walletSchema.index(
  { driverId: 1, 'transactions.razorpayPaymentId': 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      'transactions.razorpayPaymentId': { $exists: true, $type: 'string' }
    },
    name: 'unique_razorpay_payment_per_driver'
  }
);
walletSchema.index({ 'transactions.createdAt': -1 });
walletSchema.index({ 'transactions.status': 1 });
walletSchema.index({ 'transactions.type': 1 });
walletSchema.index({ availableBalance: -1 });
walletSchema.index({ totalEarnings: -1 });

// Update lastUpdated on save
walletSchema.pre('save', function (next) {
  this.lastUpdated = new Date();
  next();
});

walletSchema.pre('findOneAndUpdate', function (next) {
  this.set({ lastUpdated: new Date() });
  next();
});

// Virtuals
walletSchema.virtual('transactionCount').get(function () {
  return this.transactions ? this.transactions.length : 0;
});

walletSchema.virtual('netEarnings').get(function () {
  return (this.totalEarnings || 0) - (this.totalCommission || 0);
});

walletSchema.set('toJSON', { virtuals: true });
walletSchema.set('toObject', { virtuals: true });

export default mongoose.model('Wallet', walletSchema);