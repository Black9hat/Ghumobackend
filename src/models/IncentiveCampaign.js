// src/models/IncentiveCampaign.js
import mongoose from 'mongoose';

const slabSchema = new mongoose.Schema({
  rides: {
    type: Number,
    required: true,
    min: 1
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false });

const incentiveCampaignSchema = new mongoose.Schema({
  date: {
    type: String, // Format: "YYYY-MM-DD"
    required: true,
    unique: true,
    index: true
  },
  slabs: {
    type: [slabSchema],
    default: [
      { rides: 10, amount: 100 },
      { rides: 13, amount: 150 },
      { rides: 15, amount: 200 }
    ]
  },
  images: {
    type: [String], // Array of image URLs
    default: []
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Sort slabs by rides ascending before save
incentiveCampaignSchema.pre('save', function(next) {
  if (this.slabs && this.slabs.length > 0) {
    this.slabs.sort((a, b) => a.rides - b.rides);
  }
  next();
});

const IncentiveCampaign = mongoose.model('IncentiveCampaign', incentiveCampaignSchema);

export default IncentiveCampaign;