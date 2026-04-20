// src/models/Offer.js
// Stores promotion offers created by admin.
// ONE offer document = visible to ALL matching users (customer/driver/all).
// Max 5 active offers at a time (enforced in controller).

import mongoose from 'mongoose';

const offerSchema = new mongoose.Schema(
  {
    title:    { type: String, required: true, trim: true },
    body:     { type: String, required: true, trim: true },
    imageUrl: { type: String, default: null },

    // 'customer' | 'driver' | 'all'
    role: {
      type:    String,
      enum:    ['customer', 'driver', 'all'],
      default: 'all',
      index:   true,
    },

    // Whether this offer is still visible to users
    isActive: { type: Boolean, default: true, index: true },

    // When this offer expires (optional — null = never expires)
    expiresAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

offerSchema.index({ isActive: 1, createdAt: -1 });
offerSchema.index({ role: 1, isActive: 1 });

export default mongoose.model('Offer', offerSchema);