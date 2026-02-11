// models/HelpSettings.js
// MongoDB model for storing help/support contact settings

import mongoose from 'mongoose';

const helpSettingsSchema = new mongoose.Schema(
  {
    supportPhone: {
      type: String,
      required: true,
      trim: true,
    },
    supportEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    whatsappNumber: {
      type: String,
      required: true,
      trim: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Ensure only one settings document exists (singleton pattern)
helpSettingsSchema.statics.getSingleton = async function () {
  let settings = await this.findOne();
  if (!settings) {
    // Create default settings if none exist
    settings = await this.create({
      supportPhone: '+917337298393',
      supportEmail: 'support@yourapp.com',
      whatsappNumber: '917337298393',
      enabled: true,
    });
  }
  return settings;
};

const HelpSettings = mongoose.model('HelpSettings', helpSettingsSchema);

export default HelpSettings;