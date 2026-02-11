// models/HelpRequest.js
// MongoDB model for customer support requests

import mongoose from 'mongoose';

const helpRequestSchema = new mongoose.Schema(
  {
   customerId: {
  type: String,
  required: true
},
    customerName: {
      type: String,
      trim: true,
    },
    customerPhone: {
      type: String,
      trim: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'in-progress', 'resolved', 'closed'],
      default: 'pending',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
    },
    assignedTo: {
      type: String,
      trim: true,
    },
    response: {
      type: String,
      trim: true,
    },
    resolvedAt: {
      type: Date,
    },
    // Track request metadata
    category: {
      type: String,
      enum: ['technical', 'billing', 'general', 'complaint', 'feedback'],
      default: 'general',
    },
    source: {
      type: String,
      enum: ['app', 'web', 'email', 'phone'],
      default: 'app',
    },
  },
  {
    timestamps: true,
  }
);

// Index for faster queries
helpRequestSchema.index({ customerId: 1, status: 1 });
helpRequestSchema.index({ status: 1, priority: 1 });
helpRequestSchema.index({ createdAt: -1 });

// Automatically set resolvedAt when status changes to 'resolved'
helpRequestSchema.pre('save', function (next) {
  if (this.isModified('status') && this.status === 'resolved' && !this.resolvedAt) {
    this.resolvedAt = new Date();
  }
  next();
});

const HelpRequest = mongoose.model('HelpRequest', helpRequestSchema);

export default HelpRequest;