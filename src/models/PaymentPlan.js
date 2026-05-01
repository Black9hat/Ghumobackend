// src/models/PaymentPlan.js - Plan Purchase Payment Tracking

import mongoose from 'mongoose';

/**
 * PaymentPlan tracks all payment transactions for driver plan purchases
 * Separate from Wallet transactions to maintain clean separation of concerns
 */
const paymentPlanSchema = new mongoose.Schema(
  {
    // ════════════════════════════════════════════════════════════════════
    // RELATIONSHIPS
    // ════════════════════════════════════════════════════════════════════
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      required: true,
      index: true,
    },

    driverPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DriverPlan',
      sparse: true,
      index: true,
      description: 'Reference to activated DriverPlan after successful payment',
    },

    // ════════════════════════════════════════════════════════════════════
    // RAZORPAY INTEGRATION
    // ════════════════════════════════════════════════════════════════════
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      description: 'Unique order ID from Razorpay',
    },

    razorpayPaymentId: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
      description: 'Payment ID from Razorpay (set after payment)',
    },

    razorpaySignature: {
      type: String,
      sparse: true,
      description: 'Signature from Razorpay webhook for verification',
    },

    // ════════════════════════════════════════════════════════════════════
    // PAYMENT DETAILS
    // ════════════════════════════════════════════════════════════════════
    amount: {
      type: Number,
      required: true,
      min: 0,
      description: 'Purchase amount in INR',
    },

    currency: {
      type: String,
      default: 'INR',
      enum: ['INR', 'USD', 'GBP'],
    },

    paymentStatus: {
      type: String,
      enum: ['pending', 'authorized', 'captured', 'completed', 'failed', 'refunded'],
      default: 'pending',
      index: true,
      description: 'Status of payment transaction',
    },

    paymentMethod: {
      type: String,
      enum: ['upi', 'card', 'netbanking', 'wallet', 'cash', 'razorpay', 'unknown'],
      sparse: true,
      description: 'Payment method used by driver',
    },

    // ════════════════════════════════════════════════════════════════════
    // PLAN DETAILS (Snapshot at time of purchase)
    // ════════════════════════════════════════════════════════════════════
    planName: {
      type: String,
      required: true,
      description: 'Plan name (snapshot)',
    },

    planPrice: {
      type: Number,
      required: true,
      description: 'Price at time of purchase',
    },

    planDurationDays: {
      type: Number,
      required: true,
      description: 'Duration of plan in days',
    },

    // ════════════════════════════════════════════════════════════════════
    // PROCESSING STATUS
    // ════════════════════════════════════════════════════════════════════
    webhookProcessed: {
      type: Boolean,
      default: false,
      description: 'Has webhook been processed?',
    },

    webhookProcessedAt: {
      type: Date,
      sparse: true,
      description: 'When webhook was processed',
    },

    processedCount: {
      type: Number,
      default: 0,
      description: 'How many times this payment was processed (for idempotency)',
    },

    // ════════════════════════════════════════════════════════════════════
    // ERROR TRACKING
    // ════════════════════════════════════════════════════════════════════
    errorDetails: {
      code: String,
      message: String,
      timestamp: Date,
    },

    // ════════════════════════════════════════════════════════════════════
    // TIMESTAMPS
    // ════════════════════════════════════════════════════════════════════
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    initiatedAt: {
      type: Date,
      description: 'When order was created',
    },

    authorizedAt: {
      type: Date,
      sparse: true,
      description: 'When payment was authorized',
    },

    capturedAt: {
      type: Date,
      sparse: true,
      description: 'When payment was captured',
    },

    completedAt: {
      type: Date,
      sparse: true,
      description: 'When payment processing completed',
    },

    // ════════════════════════════════════════════════════════════════════
    // AUDIT
    // ════════════════════════════════════════════════════════════════════
    ipAddress: String,
    userAgent: String,

    metadata: mongoose.Schema.Types.Mixed,
  },
  {
    timestamps: true,
    collection: 'payment_plans',
  }
);

// ════════════════════════════════════════════════════════════════════
// INDEXES
// ════════════════════════════════════════════════════════════════════

// Driver payment history
paymentPlanSchema.index({ driverId: 1, createdAt: -1 });

// Order status tracking
paymentPlanSchema.index({ razorpayOrderId: 1, paymentStatus: 1 });

// Payment tracking
paymentPlanSchema.index({ razorpayPaymentId: 1, paymentStatus: 1 });

// Plan analytics
paymentPlanSchema.index({ planId: 1, paymentStatus: 1 });

// Find pending/failed payments
paymentPlanSchema.index({ paymentStatus: 1, createdAt: -1 });

// Find unprocessed webhooks
paymentPlanSchema.index({ webhookProcessed: 1, paymentStatus: 1 });

// ════════════════════════════════════════════════════════════════════
// VIRTUAL PROPERTIES
// ════════════════════════════════════════════════════════════════════

/**
 * Check if payment is completed
 */
paymentPlanSchema.virtual('isCompleted').get(function () {
  return this.paymentStatus === 'captured' || this.paymentStatus === 'completed';
});

/**
 * Check if payment failed
 */
paymentPlanSchema.virtual('isFailed').get(function () {
  return this.paymentStatus === 'failed' || this.paymentStatus === 'refunded';
});

/**
 * Get payment age in seconds
 */
paymentPlanSchema.virtual('ageInSeconds').get(function () {
  return Math.floor((Date.now() - this.createdAt.getTime()) / 1000);
});

/**
 * Check if payment is stale (> 24 hours)
 */
paymentPlanSchema.virtual('isStale').get(function () {
  return this.ageInSeconds > 24 * 60 * 60;
});

paymentPlanSchema.set('toJSON', { virtuals: true });
paymentPlanSchema.set('toObject', { virtuals: true });

// ════════════════════════════════════════════════════════════════════
// SCHEMA METHODS
// ════════════════════════════════════════════════════════════════════

/**
 * Mark payment as authorized (from webhook)
 */
paymentPlanSchema.methods.markAuthorized = async function (paymentId) {
  this.razorpayPaymentId = paymentId;
  this.paymentStatus = 'authorized';
  this.authorizedAt = new Date();
  return this.save();
};

/**
 * Mark payment as captured (from webhook)
 */
paymentPlanSchema.methods.markCaptured = async function (paymentId, signature = null) {
  this.razorpayPaymentId = paymentId;
  this.razorpaySignature = signature;
  this.paymentStatus = 'captured';
  this.capturedAt = new Date();
  return this.save();
};

/**
 * Mark payment as completed and link to DriverPlan
 */
paymentPlanSchema.methods.markCompleted = async function (driverPlanId) {
  this.paymentStatus = 'completed';
  this.completedAt = new Date();
  this.driverPlanId = driverPlanId;
  this.webhookProcessed = true;
  this.webhookProcessedAt = new Date();
  return this.save();
};

/**
 * Mark payment as failed
 */
paymentPlanSchema.methods.markFailed = async function (errorCode, errorMessage) {
  this.paymentStatus = 'failed';
  this.errorDetails = {
    code: errorCode,
    message: errorMessage,
    timestamp: new Date(),
  };
  return this.save();
};

/**
 * Increment process count (for idempotency tracking)
 */
paymentPlanSchema.methods.incrementProcessCount = async function () {
  this.processedCount += 1;
  return this.save();
};

/**
 * Get payment summary for driver
 */
paymentPlanSchema.methods.getSummary = function () {
  return {
    _id: this._id,
    planName: this.planName,
    amount: this.amount,
    status: this.paymentStatus,
    createdAt: this.createdAt,
    completedAt: this.completedAt,
    daysValid: this.planDurationDays,
  };
};

/**
 * Static: Find by order ID with transactional support
 */
paymentPlanSchema.statics.findByOrderId = async function (orderId, session = null) {
  const query = this.findOne({ razorpayOrderId: orderId });
  if (session) query.session(session);
  return query;
};

/**
 * Static: Find driver's recent payment attempts
 */
paymentPlanSchema.statics.getDriverPaymentHistory = async function (driverId, limit = 10) {
  return this.find({ driverId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('planName amount paymentStatus createdAt completedAt');
};

export default mongoose.model('PaymentPlan', paymentPlanSchema);