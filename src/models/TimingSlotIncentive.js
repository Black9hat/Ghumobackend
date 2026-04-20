// src/models/TimingSlotIncentive.js
// Time-based incentive model supporting multiple timing slots per day
// Each timing slot can have multiple milestone tiers (e.g., 2 rides @ ₹30, 5 rides @ ₹30, 10 rides @ ₹40)

import mongoose from 'mongoose';

// Individual milestone tier within a timing slot
const milestoneTierSchema = new mongoose.Schema({
  ridesTarget: {
    type: Number,
    required: true,
    min: 1
  },
  reward: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false });

// Timing slot containing multiple milestone tiers
const timingSlotSchema = new mongoose.Schema({
  timeLabel: {
    type: String,
    required: true,
    // e.g., "06:00 AM - 11:59 AM", "12:00 PM - 05:59 PM"
  },
  startHour: {
    type: Number,
    required: true,
    min: 0,
    max: 23
  },
  endHour: {
    type: Number,
    required: true,
    min: 0,
    max: 23
  },
  milestones: {
    type: [milestoneTierSchema],
    required: true,
    default: []
  }
}, { _id: false });

// Main schema for daily timing slot incentives
const timingSlotIncentiveSchema = new mongoose.Schema({
  date: {
    type: String, // Format: "YYYY-MM-DD"
    required: true,
    index: true
  },
  timingSlots: {
    type: [timingSlotSchema],
    default: [
      {
        timeLabel: '06:00 AM - 11:59 AM',
        startHour: 6,
        endHour: 11,
        milestones: [
          { ridesTarget: 2, reward: 30 },
          { ridesTarget: 5, reward: 30 },
          { ridesTarget: 10, reward: 40 }
        ]
      },
      {
        timeLabel: '12:00 PM - 05:59 PM',
        startHour: 12,
        endHour: 17,
        milestones: [
          { ridesTarget: 2, reward: 30 },
          { ridesTarget: 5, reward: 30 },
          { ridesTarget: 10, reward: 40 }
        ]
      },
      {
        timeLabel: '06:00 PM - 11:59 PM',
        startHour: 18,
        endHour: 23,
        milestones: [
          { ridesTarget: 2, reward: 30 },
          { ridesTarget: 5, reward: 30 },
          { ridesTarget: 10, reward: 40 }
        ]
      }
    ]
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  }
}, {
  timestamps: true
});

// Ensure unique date constraint
timingSlotIncentiveSchema.index({ date: 1, isActive: 1 });

const TimingSlotIncentive = mongoose.model('TimingSlotIncentive', timingSlotIncentiveSchema);

export default TimingSlotIncentive;
