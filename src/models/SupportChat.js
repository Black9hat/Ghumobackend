import mongoose from 'mongoose';

const supportChatSchema = new mongoose.Schema(
  {
    supportRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportRequest',
      required: true,
      index: true,
    },

    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trip',
      required: true,
    },

    // ✅ OPTIONAL senderId (required only for customer/driver)
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false, // 🔥 IMPORTANT
    },

    // ✅ senderType decides validation
    senderType: {
      type: String,
      enum: ['customer', 'driver', 'admin', 'system'],
      required: true,
    },

    message: {
      type: String,
      required: true,
      trim: true,
    },

    messageType: {
      type: String,
      enum: ['text', 'action', 'system', 'location', 'image'],
      default: 'text',
    },

    metadata: {
      action: String,
      options: [String],
      locationData: {
        lat: Number,
        lng: Number,
      },
    },

    readBy: [
      {
        userId: mongoose.Schema.Types.ObjectId,
        readAt: Date,
      },
    ],
  },
  { timestamps: true }
);

/**
 * ✅ Conditional validation
 * senderId REQUIRED only for customer & driver
 */
supportChatSchema.pre('validate', function (next) {
  if (
    (this.senderType === 'customer' || this.senderType === 'driver') &&
    !this.senderId
  ) {
    return next(
      new Error('senderId is required for customer and driver messages')
    );
  }
  next();
});

supportChatSchema.index({ supportRequestId: 1, createdAt: 1 });
supportChatSchema.index({ tripId: 1, createdAt: 1 });

export const SupportChat = mongoose.model('SupportChat', supportChatSchema);
