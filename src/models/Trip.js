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
    // 🔐 SINGLE SOURCE OF TRUTH
    status: {
      type: String,
      enum: [
        "requested",
        "driver_assigned",
        "driver_going_to_pickup",
        "driver_at_pickup",
        "ride_started",
        "awaiting_payment",  // ✅ Driver completed ride, waiting for cash confirmation
        "completed",
        "cancelled",
        "timeout",
      ],
      default: "requested",
      index: true,
    },
    // 🔢 Version for race-condition protection
    version: {
      type: Number,
      default: 1,
    },
    // 🆔 Idempotency
    idempotencyKey: {
      type: String,
      index: true,
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
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
      address: String,
    },
    drop: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
      address: String,
    },
    distance: Number,
    duration: Number,
    fare: {
      type: Number,
      required: true,
      min: 0,
    },
    originalFare: Number,
    finalFare: Number,                          // ✅ Set when ride ends
    discountApplied: { type: Number, default: 0 },
    coinsUsed: { type: Number, default: 0 },
    otp: String,
    acceptedAt: Date,
    rideStartTime: Date,
    rideEndTime: Date,                          // ✅ Set when driver clicks Complete Ride
    completedAt: Date,
    // 💰 PAYMENT LOCK (online payments)
    payment: {
      collected: { type: Boolean, default: false },
      collectedAt: Date,
      method: {
        type: String,
        enum: ["Cash", "Online", "Wallet"],
        default: "Cash",
      },
    },
    // 💵 CASH PAYMENT FIELDS (set by confirmCashCollection)
    paymentCollected: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    paymentMethod: {
      type: String,
      enum: ["cash", "online", "wallet", "Cash", "Online", "Wallet"],
    },
    paidAmount: Number,
    paymentCompletedAt: Date,
    /* ================================
       🔁 SEARCH RETRY CONTROL
    ================================= */
    retryCount: {
      type: Number,
      default: 0,
    },
    lastBroadcastAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    cancellationReason: String,
    cancelledAt: Date,
    sosActivated: { type: Boolean, default: false },
    sosActivatedAt: Date,
    lastDriverHeartbeat: Date,
    // Support
    supportRequested: { type: Boolean, default: false },
    supportReason: String,
    supportRequestedAt: Date,
  },
  { timestamps: true }
);
// Geo indexes
TripSchema.index({ "pickup.coordinates": "2dsphere" });
TripSchema.index({ "drop.coordinates": "2dsphere" });
export default mongoose.model("Trip", TripSchema);
