// models/WithdrawalRequest.js
// ═══════════════════════════════════════════════════════════════════════════
// Tracks every driver withdrawal attempt — ensures idempotency and auditability
// Status lifecycle: pending → processing → completed | failed | reversed
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

const withdrawalRequestSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    upiId: {
      type: String,
      required: true,
      trim: true,
      // Snapshot of UPI at time of withdrawal — important if driver changes UPI later
    },

    // Client-generated unique request id for production-safe idempotency.
    clientRequestId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    // ── Razorpay Payout Tracking ──────────────────────────────────────────────
    razorpayPayoutId: {
      type: String,
      sparse: true,
      index: true,
      // e.g. "pout_AbCdEfGhIjKlMn"
    },

    razorpayFundAccountId: {
      type: String,
      sparse: true,
      // Fund account created on Razorpay for this driver's UPI
    },

    razorpayContactId: {
      type: String,
      sparse: true,
      // Contact created on Razorpay for this driver
    },

    // ── Status ────────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'reversed'],
      default: 'pending',
      index: true,
    },

    processingMode: {
      type: String,
      enum: ['auto', 'manual', 'simulation'],
      default: 'auto',
      index: true,
    },

    failureReason: {
      type: String,
      default: null,
      // Human-readable reason from Razorpay or our own validation
    },

    paymentReferenceId: {
      type: String,
      default: null,
      trim: true,
      index: true,
      // Unique per completed withdrawal to prevent duplicate reference reuse
      sparse: true,
    },

    paymentProofImageUrl: {
      type: String,
      default: null,
      trim: true,
    },

    manualPaymentNotes: {
      type: String,
      default: null,
      trim: true,
    },

    processedByAdminId: {
      type: String,
      default: null,
      trim: true,
    },

    processedByAdminEmail: {
      type: String,
      default: null,
      trim: true,
    },

    // ── Idempotency ───────────────────────────────────────────────────────────
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      // Format: "wd_<driverId>_<timestamp>"
    },

    // ── Webhook Events ────────────────────────────────────────────────────────
    webhookEvents: [
      {
        event: String,                   // e.g. "payout.processed"
        receivedAt: { type: Date, default: Date.now },
        rawPayload: mongoose.Schema.Types.Mixed,
      },
    ],

    // ── Timestamps ────────────────────────────────────────────────────────────
    initiatedAt: {
      type: Date,
      default: Date.now,
    },

    processedAt: {
      type: Date,
      default: null,
    },

    // Hard finality lock: once true, admin settle/reject actions must not run again.
    settlementFinalized: {
      type: Boolean,
      default: false,
      index: true,
    },

    finalizedAt: {
      type: Date,
      default: null,
    },

    // ── Metadata ─────────────────────────────────────────────────────────────
    ipAddress: String,
    userAgent: String,

    // Was balance already debited? Used to prevent refund-on-non-debited balance
    balanceDebited: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// ── Compound indexes ──────────────────────────────────────────────────────────
withdrawalRequestSchema.index({ driverId: 1, status: 1 });
withdrawalRequestSchema.index({ driverId: 1, initiatedAt: -1 });
withdrawalRequestSchema.index({ razorpayPayoutId: 1 }, { sparse: true });
withdrawalRequestSchema.index(
  { driverId: 1, clientRequestId: 1 },
  {
    unique: true,
    name: 'uniq_driver_client_request_id',
    partialFilterExpression: { clientRequestId: { $type: 'string' } },
  }
);

// ── Prevent concurrent duplicate withdrawals ──────────────────────────────────
// This catches the case where a driver taps withdraw twice very quickly
withdrawalRequestSchema.index(
  { driverId: 1, status: 1, initiatedAt: 1 },
  { name: 'prevent_concurrent_withdrawals' }
);

// Unique payment reference ID for completed/finalized settlements
withdrawalRequestSchema.index(
  { paymentReferenceId: 1 },
  {
    unique: true,
    name: 'uniq_payment_reference_id',
    partialFilterExpression: {
      paymentReferenceId: { $type: 'string' },
      settlementFinalized: true,
    },
  }
);

const WithdrawalRequest =
  mongoose.models.WithdrawalRequest ||
  mongoose.model('WithdrawalRequest', withdrawalRequestSchema);

export default WithdrawalRequest;