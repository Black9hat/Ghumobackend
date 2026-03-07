// src/models/Trip.js
import mongoose from "mongoose";

const TripSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    assignedDriver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // ═══════════════════════════════════════════════════════════════
    // STATUS — single source of truth
    // ═══════════════════════════════════════════════════════════════
    status: {
      type: String,
      enum: [
        "requested",
        "driver_assigned",
        "driver_going_to_pickup",
        "driver_at_pickup",
        "ride_started",
        "completed",
        "cancelled",
        "timeout",
      ],
      default: "requested",
      index: true,
    },

    // ═══════════════════════════════════════════════════════════════
    // VERSION — optimistic locking for race conditions
    // Incremented on every state change.
    // ═══════════════════════════════════════════════════════════════
    version: {
      type: Number,
      default: 0,
    },

    // ═══════════════════════════════════════════════════════════════
    // IDEMPOTENCY KEY — prevents duplicate trip creation
    // Flutter sends a UUID. Unique sparse index = one trip per key.
    // ═══════════════════════════════════════════════════════════════
    idempotencyKey: {
      type: String,
      sparse: true,
    },

    type: {
      type: String,
      enum: ["short", "parcel", "long"],
      required: true,
    },

    vehicleType: {
      type: String,
      required: true,
    },

    pickup: {
      type:        { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
      address:     String,
    },

    drop: {
      type:        { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
      address:     String,
    },

    distance: Number,
    duration: Number,

    // ═══════════════════════════════════════════════════════════════
    // FARES
    // ═══════════════════════════════════════════════════════════════
    fare: {
      type: Number,
      required: true,
      min: 0,
    },

    originalFare:    Number,
    finalFare:       { type: Number, default: null },   // set atomically on completion
    discountApplied: { type: Number, default: 0 },
    coinsUsed:       { type: Number, default: 0 },

    otp:           String,
    acceptedAt:    Date,
    rideStartTime: Date,
    completedAt:   Date,

    // ═══════════════════════════════════════════════════════════════
    // PAYMENT FIELDS
    // ═══════════════════════════════════════════════════════════════

    paymentStatus: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "refunded"],
      default: "pending",
      index: true,
    },

    paymentMethod: {
      type: String,
      enum: ["cash", "direct", "upi", "card", "netbanking", "wallet", "Cash", "Online", "Wallet"],
      default: null,
    },

    paymentCollected:   { type: Boolean, default: false, index: true },
    paymentCompletedAt: { type: Date,    default: null },
    paidAmount:         { type: Number,  default: null },
    razorpayPaymentId:  { type: String,  default: null, sparse: true },
    razorpayOrderId:    { type: String,  default: null, sparse: true },

    // ═══════════════════════════════════════════════════════════════
    // WALLET UPDATED — MASTER IDEMPOTENCY FLAG  ★ CRITICAL ★
    //
    // Set true ATOMICALLY when driver wallet is credited.
    // EVERY code path that credits the wallet MUST:
    //   1. Check walletUpdated first → return early if true
    //   2. Set walletUpdated=true inside the SAME transaction as wallet write
    //
    // This is the single guarantee preventing double-credit.
    // ═══════════════════════════════════════════════════════════════
    walletUpdated:   { type: Boolean, default: false, index: true },
    walletUpdatedAt: { type: Date,    default: null },

    // ═══════════════════════════════════════════════════════════════
    // LEGACY PAYMENT LOCK (kept for socketHandler backward compat)
    // ═══════════════════════════════════════════════════════════════
    payment: {
      collected:   { type: Boolean, default: false },
      collectedAt: Date,
      method: {
        type:    String,
        enum:    ["Cash", "Online", "Wallet"],
        default: "Cash",
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // SEARCH RETRY
    // ═══════════════════════════════════════════════════════════════
    retryCount:      { type: Number, default: 0 },
    lastBroadcastAt: { type: Date,   default: null },

    // ═══════════════════════════════════════════════════════════════
    // CANCELLATION
    // ═══════════════════════════════════════════════════════════════
    cancelledBy:        { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    cancellationReason: String,
    cancelledAt:        Date,

    // ═══════════════════════════════════════════════════════════════
    // MISC
    // ═══════════════════════════════════════════════════════════════
    sosActivated:   { type: Boolean, default: false },
    sosActivatedAt: Date,

    supportRequested:   { type: Boolean, default: false },
    supportReason:      String,
    supportRequestedAt: Date,

    lastDriverHeartbeat: Date,

    parcelDetails: mongoose.Schema.Types.Mixed,
    isSameDay:     Boolean,
    returnTrip:    Boolean,
    tripDays:      Number,
  },
  { timestamps: true }
);

// ═══════════════════════════════════════════════════════════════════
// INDEXES
// ═══════════════════════════════════════════════════════════════════

TripSchema.index({ "pickup.coordinates": "2dsphere" });
TripSchema.index({ "drop.coordinates":   "2dsphere" });

// Unique sparse — one trip per client idempotency key
TripSchema.index(
  { idempotencyKey: 1 },
  { unique: true, sparse: true, name: "unique_idempotency_key" }
);

// Partial index — active trips only (avoids scanning completed/cancelled)
TripSchema.index(
  { customerId: 1, status: 1 },
  {
    partialFilterExpression: {
      status: { $in: ["requested", "driver_assigned", "driver_going_to_pickup", "driver_at_pickup", "ride_started"] }
    },
    name: "active_trips_by_customer"
  }
);

TripSchema.index({ walletUpdated: 1, status: 1 });
TripSchema.index({ assignedDriver: 1, status: 1 });

export default mongoose.model("Trip", TripSchema);