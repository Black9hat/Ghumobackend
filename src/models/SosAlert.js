// src/models/SosAlert.js
import mongoose from "mongoose";

// ── Sub-schema: a single GPS point in the location trail ─────────────────────
const locationPointSchema = new mongoose.Schema(
  {
    lat:       { type: Number, required: true },
    lng:       { type: Number, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Sub-schema: one entry in the status audit trail ───────────────────────────
const statusEntrySchema = new mongoose.Schema(
  {
    status:    { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Main SosAlert schema ───────────────────────────────────────────────────────
const sosAlertSchema = new mongoose.Schema(
  {
    // ── Parties involved ─────────────────────────────────────────────────────
    customerId: {
      type: String,
      required: true,
    },
    customerName: {
      type: String,
      default: "",
    },
    customerPhone: {
      type: String,
      default: "",
    },
    driverName: {
      type: String,
      default: "",
    },
    driverPhone: {
      type: String,
      default: "",
    },

    // ── Vehicle details (auto-filled from DB — never trusted from frontend body) ─
    vehicleNumber: {
      type: String,
      default: "",
    },
    vehicleType: {
      type: String,
      default: "",
    },

    // ── Trip reference ────────────────────────────────────────────────────────
    tripId: {
      type: String,
      required: true,
    },

    // ── Current location (latest known position — overwritten on each update) ─
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },

    // ── Full customer location trail ──────────────────────────────────────────
    // Append-only via $push + $slice: -100 — never overwrite, capped at 100 points
    // Critical for police/legal investigation trail
    locationHistory: [locationPointSchema],

    // ── Driver live location ─────────────────────────────────────────────────
    // Updated separately via socket — admin sees both markers on map
    driverLocation: {
      lat:       { type: Number, default: null },
      lng:       { type: Number, default: null },
      updatedAt: { type: Date,   default: null },
    },

    // ── Alert lifecycle ───────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["ACTIVE", "RESOLVED"],
      default: "ACTIVE",
    },

    sosType: {
      type: String,
      default: "TRIPLE_TAP",
    },

    // HIGH = red-highlight in admin UI; NORMAL = standard display
    priority: {
      type: String,
      enum: ["HIGH", "NORMAL"],
      default: "HIGH",
    },

    // Admin marks "police have been contacted"
    isEscalated: {
      type: Boolean,
      default: false,
    },

    // ── Full status audit trail ───────────────────────────────────────────────
    // Automatically appended on every status transition:
    //   ACTIVE (on create) → ESCALATED (optional) → RESOLVED
    // Useful for investigations, legal review, admin reporting
    statusHistory: [statusEntrySchema],

    // ── Resolution metadata ───────────────────────────────────────────────────
    resolvedAt: {
      type: Date,
      default: null,
    },
    resolvedBy: {
      type: String, // admin ID or admin name
      default: null,
    },
  },
  {
    timestamps: true, // auto-manages createdAt + updatedAt
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
sosAlertSchema.index({ tripId: 1 });             // fast trip lookups
sosAlertSchema.index({ status: 1 });             // fast active-alert list queries
sosAlertSchema.index({ customerId: 1 });         // fast per-user queries
sosAlertSchema.index({ createdAt: -1 });         // rate-limit check (latest per trip)
sosAlertSchema.index({ tripId: 1, status: 1 });  // compound — duplicate-active check

const SosAlert = mongoose.model("SosAlert", sosAlertSchema);

export default SosAlert;