// src/models/CustomerBanner.js
import mongoose from "mongoose";

const customerBannerSchema = new mongoose.Schema(
  {
    // Banner image URL
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },

    // Optional title overlay
    title: {
      type: String,
      trim: true,
      default: null,
    },

    // Optional description
    description: {
      type: String,
      trim: true,
      default: null,
    },

    // Banner type
    type: {
      type: String,
      enum: ["promotion", "announcement", "offer", "event"],
      default: "promotion",
    },

    // Banner date (for today/yesterday logic)
    date: {
      type: String, // Format: "YYYY-MM-DD"
      required: true,
      index: true,
    },

    // Click action (deep link)
    actionUrl: {
      type: String,
      trim: true,
      default: null,
    },

    // Display order (lower = first)
    order: {
      type: Number,
      default: 0,
    },

    // Active status
    isActive: {
      type: Boolean,
      default: true,
    },

    // Target audience
    target: {
      type: String,
      enum: ["all", "customer", "driver"],
      default: "customer",
    },
  },
  { timestamps: true }
);

// Compound index for efficient queries
customerBannerSchema.index({ date: -1, isActive: 1, target: 1 });
customerBannerSchema.index({ isActive: 1, target: 1, order: 1 });

const CustomerBanner = mongoose.model("CustomerBanner", customerBannerSchema);

export default CustomerBanner;