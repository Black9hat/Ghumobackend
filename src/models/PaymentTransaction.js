
// models/PaymentTransaction.js

import mongoose from 'mongoose';

const paymentTransactionSchema = new mongoose.Schema(
  {
    // ═══════════════════════════════════════════════════════════════
    // IDEMPOTENCY KEYS - Prevent double processing
    // ═══════════════════════════════════════════════════════════════
    
    idempotencyKey: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      description: 'Unique key per payment attempt (tripId + timestamp)'
    },

    razorpayOrderId: {
      type: String,
      sparse: true,
      index: true
    },

    razorpayPaymentId: {
      type: String,
      sparse: true,
      unique: true,
      index: true
    },

    // ═══════════════════════════════════════════════════════════════
    // TRIP & PARTICIPANTS
    // ═══════════════════════════════════════════════════════════════

    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trip',
      required: true,
      index: true
    },

    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    // ═══════════════════════════════════════════════════════════════
    // AMOUNTS (all in Rupees)
    // ═══════════════════════════════════════════════════════════════

    amount: {
      type: Number,
      required: true,
      min: 0,
      description: 'Total fare amount'
    },

    driverAmount: {
      type: Number,
      required: true,
      min: 0,
      description: 'Amount driver receives (after commission)'
    },

    commission: {
      type: Number,
      required: true,
      min: 0,
      description: 'Platform commission'
    },

    commissionRate: {
      type: Number,
      default: 0.20,
      description: 'Commission rate (e.g., 0.20 = 20%)'
    },

    // ═══════════════════════════════════════════════════════════════
    // PAYMENT INFO
    // ═══════════════════════════════════════════════════════════════

    paymentMethod: {
      type: String,
      enum: ['direct', 'cash', 'upi', 'card', 'netbanking', 'wallet'],
      required: true,
      index: true
    },

    paymentStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled'],
      default: 'pending',
      index: true
    },

    // For webhook idempotency
    webhookProcessed: {
      type: Boolean,
      default: false
    },

    apiProcessed: {
      type: Boolean,
      default: false
    },

    // ═══════════════════════════════════════════════════════════════
    // TIMESTAMPS
    // ═══════════════════════════════════════════════════════════════

    createdAt: {
      type: Date,
      default: Date.now,
      index: true
    },

    completedAt: {
      type: Date,
      sparse: true
    },

    webhookReceivedAt: {
      type: Date,
      sparse: true
    },

    // ═══════════════════════════════════════════════════════════════
    // AUDIT
    // ═══════════════════════════════════════════════════════════════

    processedCount: {
      type: Number,
      default: 0
    },

    ipAddress: String,
    userAgent: String,

    errorDetails: {
      code: String,
      message: String,
      timestamp: Date
    },

    metadata: mongoose.Schema.Types.Mixed
  },
  {
    timestamps: true,
    collection: 'payment_transactions'
  }
);

// Compound indexes for performance
paymentTransactionSchema.index({ tripId: 1, paymentStatus: 1 });
paymentTransactionSchema.index({ driverId: 1, createdAt: -1 });
paymentTransactionSchema.index({ razorpayOrderId: 1, paymentStatus: 1 });

// Check if already completed
paymentTransactionSchema.methods.isCompleted = function() {
  return this.paymentStatus === 'completed' && this.completedAt !== null;
};

// Static: Find by order ID with lock
paymentTransactionSchema.statics.findByOrderIdForUpdate = async function(orderId, session) {
  return this.findOneAndUpdate(
    { razorpayOrderId: orderId },
    { $set: { lastAccessedAt: new Date() } },
    { session, new: true }
  );
};

export default mongoose.model('PaymentTransaction', paymentTransactionSchema);