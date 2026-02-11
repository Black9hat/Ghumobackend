// models/Wallet.js - SECURE WALLET MODEL WITH PAYMENT TRACKING
import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  tripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
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
    required: true
  },
  // ✅ Payment tracking fields
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
    enum: ['upi', 'card', 'netbanking', 'wallet', 'unknown'],
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
}, {
  _id: true,
  timestamps: false
});

const walletSchema = new mongoose.Schema({
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
}, {
  timestamps: true
});

// Indexes for faster queries
walletSchema.index({ driverId: 1 });
walletSchema.index({ 'transactions.tripId': 1 });
walletSchema.index({ 'transactions.razorpayPaymentId': 1 });
walletSchema.index({ 'transactions.razorpayOrderId': 1 });
walletSchema.index({ 'transactions.createdAt': -1 });
walletSchema.index({ 'transactions.status': 1 });

// Update lastUpdated on save
walletSchema.pre('save', function(next) {
  this.lastUpdated = new Date();
  next();
});

// Update lastUpdated on findOneAndUpdate
walletSchema.pre('findOneAndUpdate', function(next) {
  this.set({ lastUpdated: new Date() });
  next();
});

export default mongoose.model('Wallet', walletSchema);