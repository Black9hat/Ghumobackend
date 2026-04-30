// src/models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    // 📞 Basic Info
    // 🔥 FIXED: phone is no longer unique globally — only phone+role combination is unique
    // This allows same phone number to have SEPARATE accounts for driver and customer
    phone: {
      type: String,
      required: true,
      index: true, // Add index for faster queries but remove unique constraint
    },
    name: {
      type: String,
      required: true,
    },
    gender: String,
    email: String,
    dateOfBirth: String,
    emergencyContact: String,

    // 🔑 Role system
    role: {
      type: String,
      enum: ["customer", "driver"],
      default: "customer",
    },

    /* ================================
       🎁 REWARD SYSTEM (CUSTOMER)
    ================================= */
    coins: {
      type: Number,
      default: 0,
      min: 0,
    },
    hasRedeemableDiscount: {
      type: Boolean,
      default: false,
    },
    totalCoinsEarned: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalCoinsRedeemed: {
      type: Number,
      default: 0,
      min: 0,
    },

    /* ================================
       🎟️ REFERRAL SYSTEM
    ================================= */
    // Unique shareable code
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      uppercase: true,
      index: true,
    },

    // Driver referral code is stored separately so driver rewards can
    // remain isolated from customer referral state.
    driverReferralCode: {
      type: String,
      unique: true,
      sparse: true,
      uppercase: true,
      index: true,
    },

    // Who referred this user
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    driverReferredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Total lifetime successful referrals across all cycles
    successfulReferrals: {
      type: Number,
      default: 0,
      min: 0,
    },

    driverSuccessfulReferrals: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Whether any referral reward has ever been claimed
    referralRewardClaimed: {
      type: Boolean,
      default: false,
    },

    driverReferralRewardClaimed: {
      type: Boolean,
      default: false,
    },

    // How many full milestone cycles completed (0-indexed)
    referralCycleCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    driverReferralCycleCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Milestone reached — waiting for user to tap "Claim"
    referralRewardPendingClaim: {
      type: Boolean,
      default: false,
      index: true,
    },

    driverReferralRewardPendingClaim: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Coins queued for next claim
    referralCoinsBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    driverReferralAmountBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Pre-created coupon code (inactive until claimed)
    referralCouponCode: {
      type: String,
      default: null,
    },

    driverReferralCouponCode: {
      type: String,
      default: null,
    },

    // Progress within current cycle (resets after each claim)
    referralProgress: {
      type: Number,
      default: 0,
      min: 0,
    },

    driverReferralProgress: {
      type: Number,
      default: 0,
      min: 0,
    },

    /* ================================
       🎁 WELCOME COUPON
    ================================= */
    welcomeCouponAssigned: {
      type: Boolean,
      default: false,
    },
    welcomeCouponUsed: {
      type: Boolean,
      default: false,
    },

    /* ================================
       🚗 DRIVER FIELDS
    ================================= */
    isDriver: {
      type: Boolean,
      default: false,
      index: true,
    },
    vehicleType: {
      type: String,
      enum: ["bike", "auto", "car", "premium", "xl"],
      default: null,
      index: true,
    },
    city: String,

    /* ================================
       📍 GEOLOCATION + TRACKING
    ================================= */
    location: {
      type: {
        type: String,
        enum: ["Point"],
        required: true,
        default: "Point",
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    locationSequence: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },
    lastLocationUpdate: {
      type: Date,
      default: null,
      index: true,
    },
    isOnline: {
      type: Boolean,
      default: false,
      index: true,
    },
    currentTripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
      index: true,
    },
    isBusy: {
      type: Boolean,
      default: false,
      index: true,
    },
    canReceiveNewRequests: {
      type: Boolean,
      default: false,
    },

    /* ================================
       💰 CASH COLLECTION
    ================================= */
    awaitingCashCollection: {
      type: Boolean,
      default: false,
      index: true,
    },

    /* ================================
       🔌 SOCKET REALTIME
    ================================= */
    socketId: {
      type: String,
      default: null,
    },

    /* ================================
       🧡 GO TO DESTINATION MODE
    ================================= */
    goToDestination: {
      enabled: {
        type: Boolean,
        default: false,
        index: true,
      },
      location: {
        type: {
          type: String,
          enum: ["Point"],
          default: "Point",
        },
        coordinates: {
          type: [Number],
          default: [0, 0],
        },
      },
      address: {
        type: String,
        default: null,
      },
      enabledAt: {
        type: Date,
        default: null,
      },
      disabledAt: {
        type: Date,
        default: null,
      },
    },

    /* ================================
       🏠 GO TO DESTINATION SAVED LOCATIONS
    ================================= */
    goToDestinationLocations: [
      {
        _id: mongoose.Schema.Types.ObjectId,
        name: {
          type: String,
          required: true,
        },
        category: {
          type: String,
          enum: ["Home", "Office", "Hotel", "Gym", "Other"],
          default: "Other",
        },
        location: {
          type: {
            type: String,
            enum: ["Point"],
            default: "Point",
          },
          coordinates: {
            type: [Number],
            required: true,
          },
        },
        address: String,
        isActive: {
          type: Boolean,
          default: false,
          index: true,
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
        updatedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    /* ================================
       ⭐ DRIVER PROFILE
    ================================= */
    rating: {
      type: Number,
      default: 4.8,
      min: 0,
      max: 5,
    },
    vehicleBrand: String,
    vehicleNumber: String,
    vehicleModel: {
      // e.g. "Swift", "Honda City", "Ertiga" — set during onboarding
      type: String,
      default: null,
      trim: true,
    },

    // 🪑 Seat count — only for car/xl (4 or 6)
    // NOTE: No enum here — Mongoose Number enums reject null; validation is done in the controller
    seats: {
      type: Number,
      default: null,
    },
    photoUrl: String,
    profilePhotoUrl: String,

    /* ================================
       🚫 DRIVER STATUS / MODERATION
    ================================= */
    isBlocked: {
      type: Boolean,
      default: false,
      index: true,
    },
    isSuspended: {
      type: Boolean,
      default: false,
      index: true,
    },
    strikes: {
      type: Number,
      default: 0,
      min: 0,
    },
    deviceId: {
      type: String,
      default: null,
    },

    /* ================================
       📄 VERIFICATION DOCUMENTS
    ================================= */
    documentStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    firebaseUid: {
      type: String,
      unique: true,
      sparse: true,
    },

    /* ================================
       🔔 NOTIFICATIONS
    ================================= */
    fcmToken: String,

    /* ================================
       ⏱️ RIDE TIMESTAMPS
    ================================= */
    lastTripAcceptedAt: Date,
    lastTripCompletedAt: Date,
    lastTripCancelledAt: Date,
    lastCashCollectedAt: Date,
    lastDisconnectedAt: Date,

    /* ================================
       💰 INCENTIVE SYSTEM (DRIVER)
    ================================= */
    totalCoinsCollected: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalIncentiveEarned: {
      type: Number,
      default: 0.0,
      min: 0,
    },
    totalRidesCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastRideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
    },
    lastIncentiveAwardedAt: Date,
    lastWithdrawal: Date,
    wallet: {
      type: Number,
      default: 0.0,
      min: 0,
    },

    /* ================================
       � DRIVER PAYMENT DETAILS (UPI for Withdrawals)
    ================================= */
    driverPaymentDetails: {
      upiId: {
        type: String,
        default: null,
        trim: true,
        sparse: true,
        // e.g. "driver@okhdfcbank"
      },
      upiVerified: {
        type: Boolean,
        default: false,
      },
      savedAt: {
        type: Date,
        default: null,
      },
      verifiedAt: {
        type: Date,
        default: null,
      },
      lastUsedAt: {
        type: Date,
        default: null,
      },
    },

    /* ================================
       �🔐 MULTI-DEVICE SESSION MANAGEMENT (ROLE-BASED)
    ================================= */
    // 🔥 ROLE-BASED SESSION CONTROL: Separate sessions per role
    sessionsByRole: {
      customer: {
        deviceId: { type: String, default: null },
        socketId: { type: String, default: null },
        fcmToken: { type: String, default: null },
        loginAt: { type: Date, default: null },
        isActive: { type: Boolean, default: false },
      },
      driver: {
        deviceId: { type: String, default: null },
        socketId: { type: String, default: null },
        fcmToken: { type: String, default: null },
        loginAt: { type: Date, default: null },
        isActive: { type: Boolean, default: false },
      },
    },

    // Legacy fields (kept for backward compatibility)
    currentDeviceId: {
      type: String,
      default: null,
      index: true,
    },
    currentFcmToken: {
      type: String,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    sessionActive: {
      type: Boolean,
      default: false,
      index: true,
    },

    /* ================================
       📊 SESSION HISTORY
    ================================= */
    previousSessions: [
      {
        deviceId: { type: String, required: true },
        fcmToken: { type: String },
        loginAt:  { type: Date, required: true },
        logoutAt: { type: Date },
        reason: {
          type: String,
          enum: ["user_logout", "force_logout", "token_expired", "app_update"],
          default: "user_logout",
        },
        ipAddress: String,
        userAgent: String,
        // 🔥 ROLE-BASED SESSION CONTROL
        role: {
          type: String,
          enum: ["customer", "driver"],
          default: "customer",
        },
      },
    ],
  },
  {
    timestamps: true,
    minimize: false,
  }
);

/* ================================
   📌 INDEXES
================================ */
// 🔥 FIXED: Compound unique index on phone + role to allow separate accounts per role
userSchema.index({ phone: 1, role: 1 }, { unique: true });
userSchema.index({ location: "2dsphere" });
userSchema.index({ "goToDestination.location": "2dsphere" });
userSchema.index({
  isDriver: 1, isOnline: 1, isBusy: 1,
  vehicleType: 1, location: "2dsphere",
});
userSchema.index({
  isDriver: 1, isOnline: 1, isBusy: 1, vehicleType: 1,
  "goToDestination.enabled": 1,
  "goToDestination.location": "2dsphere",
});
userSchema.index({ isDriver: 1, currentTripId: 1 });
userSchema.index({
  awaitingCashCollection: 1,
  currentTripId: 1,
  lastTripCompletedAt: 1,
});
userSchema.index({ awaitingCashCollection: 1, lastTripCompletedAt: 1 });
userSchema.index({ role: 1, coins: 1, hasRedeemableDiscount: 1 });
userSchema.index({
  isDriver: 1, isOnline: 1,
  locationSequence: 1, lastLocationUpdate: 1,
});
userSchema.index({ isOnline: 1, lastLocationUpdate: 1 });
userSchema.index({ phone: 1, sessionActive: 1 });
userSchema.index({ currentDeviceId: 1 });
// Referral indexes
userSchema.index({ referralCode: 1 });
userSchema.index({ driverReferralCode: 1 });
userSchema.index({ referredBy: 1 });
userSchema.index({ driverReferredBy: 1 });
userSchema.index({ referralRewardPendingClaim: 1 });
userSchema.index({ driverReferralRewardPendingClaim: 1 });

/* ================================
   📝 SCHEMA METHODS
================================ */
userSchema.methods.cleanOldSessions = function () {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  this.previousSessions = this.previousSessions.filter(
    (s) => s.loginAt > thirtyDaysAgo
  );
};

userSchema.methods.getActiveSessionInfo = function () {
  return {
    deviceId: this.currentDeviceId,
    loginAt:  this.lastLoginAt,
    active:   this.sessionActive,
  };
};

/* ================================
   🔄 VIRTUALS
================================ */
userSchema.virtual("hasActiveSessionOnOtherDevice").get(function () {
  return this.sessionActive && this.currentDeviceId != null;
});

const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;