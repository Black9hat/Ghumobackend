// models/PaymentTransaction.js - PAYMENT TRACKING FOR IDEMPOTENCY
// Prevents double crediting and tracks all payment attempts

import mongoose from 'mongoose';

const paymentTransactionSchema = new mongoose.Schema(
  {
    // ═══════════════════════════════════════════════════════════════════
    // PRIMARY IDENTIFIERS (for idempotency checks)
    // ═══════════════════════════════════════════════════════════════════
    
    razorpayOrderId: {
      type: String,
      sparse: true,
      index: true,
      trim: true,
      description: 'Razorpay Order ID - primary key for idempotency'
    },

    razorpayPaymentId: {
      type: String,
      sparse: true,
      index: true,
      trim: true,
      description: 'Razorpay Payment ID - secondary idempotency key'
    },

    // ═══════════════════════════════════════════════════════════════════
    // TRIP & PARTICIPANTS
    // ═══════════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════════
    // AMOUNT BREAKDOWN
    // ═══════════════════════════════════════════════════════════════════

    amount: {
      type: Number,
      required: true,
      min: 0,
      description: 'Total amount charged to customer (in ₹)'
    },

    driverAmount: {
      type: Number,
      required: true,
      min: 0,
      description: 'Amount credited to driver wallet (in ₹)'
    },

    commission: {
      type: Number,
      required: true,
      min: 0,
      description: 'App commission amount (in ₹)'
    },

    // ═══════════════════════════════════════════════════════════════════
    // PAYMENT METHOD & STATUS
    // ═══════════════════════════════════════════════════════════════════

    paymentMethod: {
      type: String,
      enum: ['upi', 'card', 'netbanking', 'wallet', 'cash', 'unknown'],
      default: 'unknown',
      index: true
    },

    paymentStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded', 'cancelled'],
      default: 'pending',
      index: true,
      description: 'Payment processing status'
    },

    webhookStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'na'],
      default: 'pending',
      index: true,
      description: 'Webhook confirmation status (na = not applicable for cash)'
    },

    // ═══════════════════════════════════════════════════════════════════
    // TIMESTAMPS
    // ═══════════════════════════════════════════════════════════════════

    createdAt: {
      type: Date,
      default: Date.now,
      index: true
    },

    completedAt: {
      type: Date,
      sparse: true,
      index: true,
      description: 'When payment was actually completed'
    },

    webhookReceivedAt: {
      type: Date,
      sparse: true,
      description: 'When Razorpay webhook was received'
    },

    // ═══════════════════════════════════════════════════════════════════
    // IDEMPOTENCY & AUDIT TRAIL
    // ═══════════════════════════════════════════════════════════════════

    processedCount: {
      type: Number,
      default: 0,
      description: 'How many times this payment was processed (should be 1)'
    },

    processedByApi: {
      type: Boolean,
      default: false,
      description: 'Was this processed by verify endpoint?'
    },

    processedByWebhook: {
      type: Boolean,
      default: false,
      description: 'Was this processed by webhook endpoint?'
    },

    // ═══════════════════════════════════════════════════════════════════
    // SECURITY & FRAUD DETECTION
    // ═══════════════════════════════════════════════════════════════════

    ipAddress: {
      type: String,
      sparse: true,
      description: 'IP address of payment initiator'
    },

    deviceFingerprint: {
      type: String,
      sparse: true,
      description: 'Device fingerprint (user agent)'
    },

    fraudScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      description: 'Fraud detection score (0-100)'
    },

    flaggedForReview: {
      type: Boolean,
      default: false,
      index: true,
      description: 'Flagged by fraud detection system'
    },

    // ═══════════════════════════════════════════════════════════════════
    // ADDITIONAL METADATA
    // ═══════════════════════════════════════════════════════════════════

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      sparse: true,
      description: 'Additional data (notes, etc.)'
    },

    refundDetails: {
      type: {
        refundId: String,
        refundAmount: Number,
        refundReason: String,
        refundedAt: Date
      },
      sparse: true,
      description: 'Refund details if payment was refunded'
    },

    errorDetails: {
      type: {
        code: String,
        message: String,
        description: String
      },
      sparse: true,
      description: 'Error details if payment failed'
    }
  },
  {
    timestamps: true,
    collection: 'payment_transactions'
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// INDEXES FOR PERFORMANCE & QUERIES
// ═══════════════════════════════════════════════════════════════════════════

// Quick lookup by payment IDs
paymentTransactionSchema.index({ razorpayOrderId: 1, razorpayPaymentId: 1 });

// Find all payments for a trip
paymentTransactionSchema.index({ tripId: 1, paymentStatus: 1 });

// Find payments by driver
paymentTransactionSchema.index({ driverId: 1, createdAt: -1 });

// Find payments by customer
paymentTransactionSchema.index({ customerId: 1, createdAt: -1 });

// Find pending/completed payments
paymentTransactionSchema.index({ paymentStatus: 1, createdAt: -1 });

// Find flagged payments
paymentTransactionSchema.index({ flaggedForReview: 1, createdAt: -1 });

// Find by webhook status
paymentTransactionSchema.index({ webhookStatus: 1 });

// Compound index for analytics
paymentTransactionSchema.index({
  driverId: 1,
  paymentStatus: 1,
  createdAt: -1
});

// ═══════════════════════════════════════════════════════════════════════════
// PRE-SAVE MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

paymentTransactionSchema.pre('save', function (next) {
  // Ensure amount breakdown adds up
  if (this.driverAmount + this.commission !== this.amount) {
    console.warn('⚠️ Amount mismatch:', {
      total: this.amount,
      driver: this.driverAmount,
      commission: this.commission
    });
  }

  // Ensure no negative amounts
  if (this.amount < 0 || this.driverAmount < 0 || this.commission < 0) {
    return next(new Error('Negative amounts not allowed'));
  }

  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// VIRTUAL PROPERTIES
// ═══════════════════════════════════════════════════════════════════════════

paymentTransactionSchema.virtual('isCompleted').get(function() {
  return this.paymentStatus === 'completed';
});

paymentTransactionSchema.virtual('isProcessedMultipleTimes').get(function() {
  return this.processedCount > 1;
});

paymentTransactionSchema.virtual('daysOld').get(function() {
  const days = (Date.now() - this.createdAt.getTime()) / (1000 * 60 * 60 * 24);
  return Math.floor(days);
});

// ═══════════════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if this payment has already been processed
 * Used for idempotency verification
 */
paymentTransactionSchema.methods.isAlreadyProcessed = function() {
  return (
    this.paymentStatus === 'completed' &&
    this.completedAt !== null &&
    this.processedCount >= 1
  );
};

/**
 * Mark as processed by API verification endpoint
 */
paymentTransactionSchema.methods.markProcessedByApi = function() {
  this.processedByApi = true;
  this.processedCount += 1;
  this.completedAt = new Date();
  this.paymentStatus = 'completed';
};

/**
 * Mark as processed by webhook endpoint
 */
paymentTransactionSchema.methods.markProcessedByWebhook = function() {
  this.processedByWebhook = true;
  this.webhookStatus = 'completed';
  this.webhookReceivedAt = new Date();
};

/**
 * Calculate fraud score based on payment details
 */
paymentTransactionSchema.methods.calculateFraudScore = function() {
  let score = 0;

  // Unusual amount
  if (this.amount > 5000) score += 10;
  if (this.amount > 10000) score += 15;

  // Multiple payments in short time (checked separately)

  // New device
  if (!this.deviceFingerprint) score += 5;

  // VPN/Proxy IP (would need IP checking service)

  this.fraudScore = Math.min(score, 100);
  if (this.fraudScore > 50) {
    this.flaggedForReview = true;
  }

  return this.fraudScore;
};

// ═══════════════════════════════════════════════════════════════════════════
// STATIC METHODS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find payment by order ID (idempotency check)
 */
paymentTransactionSchema.statics.findByOrderId = function(orderId) {
  return this.findOne({ razorpayOrderId: orderId });
};

/**
 * Find payment by payment ID (idempotency check)
 */
paymentTransactionSchema.statics.findByPaymentId = function(paymentId) {
  return this.findOne({ razorpayPaymentId: paymentId });
};

/**
 * Check if payment is already completed
 */
paymentTransactionSchema.statics.isPaymentAlreadyCompleted = async function(
  paymentId
) {
  const payment = await this.findOne({
    razorpayPaymentId: paymentId,
    paymentStatus: 'completed'
  });
  return !!payment;
};

/**
 * Get payment analytics for driver
 */
paymentTransactionSchema.statics.getDriverStats = async function(driverId) {
  const stats = await this.aggregate([
    { $match: { driverId: mongoose.Types.ObjectId(driverId) } },
    {
      $group: {
        _id: '$paymentMethod',
        totalAmount: { $sum: '$driverAmount' },
        count: { $sum: 1 },
        avgAmount: { $avg: '$driverAmount' }
      }
    }
  ]);
  return stats;
};

/**
 * Get flagged payments for admin review
 */
paymentTransactionSchema.statics.getFlaggedPayments = function(limit = 20) {
  return this.find({ flaggedForReview: true })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('driverId', 'name phone')
    .populate('customerId', 'name phone');
};

// ═══════════════════════════════════════════════════════════════════════════
// QUERY HELPERS
// ═══════════════════════════════════════════════════════════════════════════

paymentTransactionSchema.query.completed = function() {
  return this.where({ paymentStatus: 'completed' });
};

paymentTransactionSchema.query.pending = function() {
  return this.where({ paymentStatus: 'pending' });
};

paymentTransactionSchema.query.failed = function() {
  return this.where({ paymentStatus: 'failed' });
};

paymentTransactionSchema.query.byDriver = function(driverId) {
  return this.where({ driverId });
};

paymentTransactionSchema.query.byTrip = function(tripId) {
  return this.where({ tripId });
};

paymentTransactionSchema.query.recentFirst = function() {
  return this.sort({ createdAt: -1 });
};

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export default mongoose.model('PaymentTransaction', paymentTransactionSchema);