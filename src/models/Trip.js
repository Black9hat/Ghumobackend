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
    discountApplied: { type: Number, default: 0 },
    coinsUsed: { type: Number, default: 0 },

    otp: String,

    acceptedAt: Date,
    rideStartTime: Date,
    completedAt: Date,

    // 💰 PAYMENT LOCK
    payment: {
      collected: { type: Boolean, default: false },
      collectedAt: Date,
      method: {
        type: String,
        enum: ["Cash", "Online", "Wallet"],
        default: "Cash",
      },
    },
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
  },
  { timestamps: true }
);

// Geo indexes
TripSchema.index({ "pickup.coordinates": "2dsphere" });
TripSchema.index({ "drop.coordinates": "2dsphere" });

export default mongoose.model("Trip", TripSchema);