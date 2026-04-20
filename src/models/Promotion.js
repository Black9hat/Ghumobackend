// models/Promotion.js
import mongoose from 'mongoose';

const promotionSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  imageUrl: {
    type: String,
    required: true,
  },
  imagePath: {
    type: String, // Cloudinary public_id for deletion
  },
  target: {
    type: [String],
    enum: ['customer', 'driver'],
    default: ['customer', 'driver'], // Show to both by default
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  // ✅ NEW: Startup Banner Feature
  isStartupBanner: {
    type: Boolean,
    default: false, // Regular promotion by default
  },
  order: {
    type: Number,
    default: 0,
  },
  viewCount: {
    type: Number,
    default: 0,
  },
  clickCount: {
    type: Number,
    default: 0,
  },
}, { timestamps: true });

// ✅ Index for faster queries
promotionSchema.index({ isActive: 1, target: 1, isStartupBanner: 1 });

export default mongoose.model('Promotion', promotionSchema);