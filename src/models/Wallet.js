// models/Wallet.js - ENHANCED WALLET MODEL with Plan Tracking

import mongoose from 'mongoose';

// ════════════════════════════════════════════════════════════════════
// TRANSACTION SCHEMA - Tracks all wallet changes
// ════════════════════════════════════════════════════════════════════
const transactionSchema = new mongoose.Schema(
  {
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trip',
      sparse: true,
    },

    type: {
      type: String,
      enum: ['credit', 'debit', 'commission', 'plan_purchase'],
      required: true,
      index: true,
      // credit: ride earnings
      // debit: wallet withdrawal
      // commission: commission payment to platform
      // plan_purchase: driver bought a plan
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
      description: 'Main transaction amount',
    },

    description: {
      type: String,
      required: true,
      trim: true,
      // e.g., "Ride earnings", "Wallet withdrawal", "Plan purchase"
    },

    // ════════════════════════════════════════════════════════════════════
    // PAYMENT GATEWAY TRACKING
    // ════════════════════════════════════════════════════════════════════
    razorpayPaymentId: {
      type: String,
      sparse: true,
      index: true,
    },

    razorpayOrderId: {
      type: String,
      sparse: true,
      index: true,
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
      index: true,
    },

    // ════════════════════════════════════════════════════════════════════
    // ✨ NEW: PLAN TRACKING & EARNING BREAKDOWN
    // ════════════════════════════════════════════════════════════════════
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      sparse: true,
      description: 'Which plan was used for this earning',
    },

    driverPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DriverPlan',
      sparse: true,
      description: 'Reference to the driver\'s active plan',
    },

    planApplied: {
      type: Boolean,
      default: false,
      description: 'Was a plan applied to this transaction?',
    },

    planName: {
      type: String,
      sparse: true,
      description: 'Name of plan applied (snapshot for history)',
    },

    planCommissionRate: {
      type: Number,
      sparse: true,
      min: 0,
      max: 100,
      description: 'Commission % from plan (snapshot)',
    },

    planBonusMultiplier: {
      type: Number,
      sparse: true,
      min: 1.0,
      description: 'Bonus multiplier from plan (snapshot)',
    },

    // ════════════════════════════════════════════════════════════════════
    // ✨ NEW: DETAILED EARNING BREAKDOWN (For ride transactions)
    // ════════════════════════════════════════════════════════════════════
    originalFare: {
      type: Number,
      sparse: true,
      min: 0,
      description: 'Original ride fare before any deductions',
    },

    commissionDeducted: {
      type: Number,
      sparse: true,
      min: 0,
      description: 'Commission deducted from fare',
    },

    planBonus: {
      type: Number,
      sparse: true,
      default: 0,
      description: 'Bonus earned from active plan',
    },

    finalEarning: {
      type: Number,
      sparse: true,
      min: 0,
      description: 'Final amount driver gets: originalFare - commission + planBonus',
    },

    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    _id: true,
    timestamps: false,
  }
);

// ════════════════════════════════════════════════════════════════════
// MAIN WALLET SCHEMA
// ════════════════════════════════════════════════════════════════════
const walletSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    // ════════════════════════════════════════════════════════════════════
    // BALANCE TRACKING
    // ════════════════════════════════════════════════════════════════════
    availableBalance: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Money driver can withdraw',
    },

    balance: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Current wallet balance',
    },

    totalEarnings: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Total earned from rides',
    },

    totalCommission: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Total commission paid',
    },

    pendingAmount: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Pending commission payment',
    },

    // ════════════════════════════════════════════════════════════════════
    // ✨ NEW: PLAN-RELATED TRACKING
    // ════════════════════════════════════════════════════════════════════
    totalPlanBonusEarned: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Total bonus earned from active plans',
    },

    // ════════════════════════════════════════════════════════════════════
    // TRANSACTIONS
    // ════════════════════════════════════════════════════════════════════
    transactions: [transactionSchema],

    lastUpdated: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// ════════════════════════════════════════════════════════════════════
// INDEXES FOR PERFORMANCE
// ════════════════════════════════════════════════════════════════════

walletSchema.index({ driverId: 1 });
walletSchema.index({ 'transactions.tripId': 1 });
walletSchema.index({ 'transactions.createdAt': -1 });
walletSchema.index({ 'transactions.status': 1 });
walletSchema.index({ 'transactions.type': 1 });

// ✨ NEW: Plan-related indexes
walletSchema.index({ 'transactions.planApplied': 1 });
walletSchema.index({ 'transactions.planId': 1 });
walletSchema.index({ 'transactions.driverPlanId': 1 });

walletSchema.index({ availableBalance: -1 });
walletSchema.index({ totalEarnings: -1 });
walletSchema.index({ totalPlanBonusEarned: -1 });

// ✅ UNIQUE sparse index — DB-level guarantee: same paymentId can never be written twice
walletSchema.index(
  { driverId: 1, 'transactions.razorpayPaymentId': 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      'transactions.razorpayPaymentId': { $exists: true, $type: 'string' },
    },
    name: 'unique_razorpay_payment_per_driver',
  }
);

// ════════════════════════════════════════════════════════════════════
// HOOKS
// ════════════════════════════════════════════════════════════════════

// Update lastUpdated on save
walletSchema.pre('save', function (next) {
  this.lastUpdated = new Date();
  next();
});

walletSchema.pre('findOneAndUpdate', function (next) {
  this.set({ lastUpdated: new Date() });
  next();
});

// ════════════════════════════════════════════════════════════════════
// VIRTUAL PROPERTIES
// ════════════════════════════════════════════════════════════════════

walletSchema.virtual('transactionCount').get(function () {
  return this.transactions ? this.transactions.length : 0;
});

walletSchema.virtual('netEarnings').get(function () {
  return (this.totalEarnings || 0) - (this.totalCommission || 0);
});

/**
 * Calculate earnings from rides with plans applied
 */
walletSchema.virtual('totalEarningsWithPlans').get(function () {
  if (!this.transactions) return 0;
  return this.transactions
    .filter((t) => t.planApplied && t.type === 'credit')
    .reduce((sum, t) => sum + (t.finalEarning || 0), 0);
});

/**
 * Get total rides completed
 */
walletSchema.virtual('totalRidesCompleted').get(function () {
  if (!this.transactions) return 0;
  return this.transactions.filter((t) => t.type === 'credit').length;
});

/**
 * Get rides benefited from plans
 */
walletSchema.virtual('ridesWithPlanBenefit').get(function () {
  if (!this.transactions) return 0;
  return this.transactions.filter((t) => t.planApplied && t.type === 'credit').length;
});

walletSchema.set('toJSON', { virtuals: true });
walletSchema.set('toObject', { virtuals: true });

// ════════════════════════════════════════════════════════════════════
// SCHEMA METHODS
// ════════════════════════════════════════════════════════════════════

/**
 * Add transaction with plan details
 */
walletSchema.methods.addPlanEarning = async function (
  tripId,
  originalFare,
  commissionDeducted,
  planBonus,
  finalEarning,
  planDetails
) {
  this.transactions.push({
    tripId,
    type: 'credit',
    amount: finalEarning,
    description: `Ride earnings: ₹${originalFare} (Plan: ${planDetails?.planName || 'Basic'})`,
    planApplied: true,
    planId: planDetails?.planId,
    driverPlanId: planDetails?.driverPlanId,
    planName: planDetails?.planName,
    planCommissionRate: planDetails?.commissionRate,
    planBonusMultiplier: planDetails?.bonusMultiplier,
    originalFare,
    commissionDeducted,
    planBonus,
    finalEarning,
    status: 'completed',
    createdAt: new Date(),
  });

  // Update totals
  this.totalEarnings += finalEarning;
  this.totalPlanBonusEarned += planBonus;
  this.availableBalance += finalEarning;

  return this.save();
};

/**
 * Add transaction for plan purchase
 */
walletSchema.methods.addPlanPurchaseTransaction = async function (planName, amount, orderId) {
  this.transactions.push({
    type: 'plan_purchase',
    amount,
    description: `Plan purchase: ${planName}`,
    razorpayOrderId: orderId,
    status: 'completed',
    createdAt: new Date(),
  });

  return this.save();
};

/**
 * Get transaction history with filters
 */
walletSchema.methods.getTransactionHistory = function (options = {}) {
  const { type = null, limit = 50, skip = 0 } = options;

  let filtered = this.transactions;

  if (type) {
    filtered = filtered.filter((t) => t.type === type);
  }

  return {
    total: filtered.length,
    transactions: filtered.slice(skip, skip + limit),
  };
};

/**
 * Get earnings breakdown
 */
walletSchema.methods.getEarningsBreakdown = function () {
  const rideTransactions = this.transactions.filter((t) => t.type === 'credit');

  const withPlan = rideTransactions.filter((t) => t.planApplied);
  const withoutPlan = rideTransactions.filter((t) => !t.planApplied);

  return {
    totalRides: rideTransactions.length,
    ridesWithPlan: withPlan.length,
    ridesWithoutPlan: withoutPlan.length,
    earningsWithPlan: withPlan.reduce((sum, t) => sum + (t.finalEarning || 0), 0),
    earningsWithoutPlan: withoutPlan.reduce((sum, t) => sum + (t.finalEarning || 0), 0),
    totalPlanBonus: this.totalPlanBonusEarned,
    averageEarningPerRide: rideTransactions.length > 0
      ? Math.round((this.totalEarnings / rideTransactions.length) * 100) / 100
      : 0,
  };
};

export default mongoose.model('Wallet', walletSchema);