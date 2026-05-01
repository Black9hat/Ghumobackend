// models/AutoChatConfig.js
import mongoose from 'mongoose';

const autoChatConfigSchema = new mongoose.Schema({
  issueType: {
    type: String,
    required: true,
    unique: true
  },
  userType: {
    type: String,
    enum: ['customer', 'driver', 'both'],
    default: 'both'
  },
  enabled: {
    type: Boolean,
    default: true
  },
  flow: [{
    step: Number,
    type: {
      type: String,
      enum: ['message', 'options', 'input', 'action']
    },
    message: String,
    options: [{
      text: String,
      value: String,
      nextStep: Number,
      resolves: Boolean
    }],
    condition: String,
    autoResolveOn: [String]
  }],
  escalationTriggers: [String],
  avgResolutionTime: Number
}, {
  timestamps: true
});

export const AutoChatConfig = mongoose.model('AutoChatConfig', autoChatConfigSchema);