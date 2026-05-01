// src/models/Notification.js
import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["driver", "customer"],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      default: "",
      trim: true,
    },
    type: {
      type: String,
      enum: ["general", "trip", "promotion", "alert", "system", "payment", "support"],
      default: "general",
    },
    imageUrl: {
      type: String,
      default: null,
    },
    ctaText: {
      type: String,
      default: null,
    },
    ctaRoute: {
      type: String,
      default: null,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

// Indexes for faster queries
notificationSchema.index({ userId: 1, role: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1 });

const Notification =
  mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);

export default Notification;