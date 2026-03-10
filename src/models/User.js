// src/models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    // 📞 Basic Info
    phone: {
      type: String,
      required: true,
      unique: true,
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
    referralCode: {
      type: String,
      unique: true,
      sparse: true,       // allows null without unique-conflict
      uppercase: true,
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // How many of this user's referrals have completed their first ride
    successfulReferrals: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Set to true once the 5-referral reward has been issued
    referralRewardClaimed: {
      type: Boolean,
      default: false,
    },

    /* ================================
       🎁 WELCOME COUPON
    ================================= */
    welcomeCouponAssigned: {
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
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },

    // Sequence ordering for socket gps
    locationSequence: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },

    // last GPS timestamp
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
       🧡 GO TO DESTINATION MODE (DRIVER)
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
          type: [Number], // [longitude, latitude]
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
    photoUrl: String,
    profilePhotoUrl: String,

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
       🔐 MULTI-DEVICE SESSION MANAGEMENT
    ================================= */
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
       📊 SESSION HISTORY (for audit trail)
    ================================= */
    previousSessions: [
      {
        deviceId: {
          type: String,
          required: true,
        },
        fcmToken: {
          type: String,
        },
        loginAt: {
          type: Date,
          required: true,
        },
        logoutAt: {
          type: Date,
        },
        reason: {
          type: String,
          enum: ["user_logout", "force_logout", "token_expired", "app_update"],
          default: "user_logout",
        },
        ipAddress: String,
        userAgent: String,
      },
    ],
  },
  {
    timestamps: true,
    minimize: false,
  }
);

/* ================================
   📌 INDEXES FOR PERFORMANCE
================================ */

// Primary location index
userSchema.index({ location: "2dsphere" });

// 🧡 GO TO DESTINATION INDEX
userSchema.index({ "goToDestination.location": "2dsphere" });

// Driver search compound index
userSchema.index({
  isDriver: 1,
  isOnline: 1,
  isBusy: 1,
  vehicleType: 1,
  location: "2dsphere",
});

// Destination mode compound index
userSchema.index({
  isDriver: 1,
  isOnline: 1,
  isBusy: 1,
  vehicleType: 1,
  "goToDestination.enabled": 1,
  "goToDestination.location": "2dsphere",
});

userSchema.index({ isDriver: 1, currentTripId: 1 });

userSchema.index({
  awaitingCashCollection: 1,
  currentTripId: 1,
  lastTripCompletedAt: 1,
});

userSchema.index({
  awaitingCashCollection: 1,
  lastTripCompletedAt: 1,
});

// Customer reward targeting
userSchema.index({
  role: 1,
  coins: 1,
  hasRedeemableDiscount: 1,
});

// GPS performance
userSchema.index({
  isDriver: 1,
  isOnline: 1,
  locationSequence: 1,
  lastLocationUpdate: 1,
});

// Stale location detection
userSchema.index({
  isOnline: 1,
  lastLocationUpdate: 1,
});

// 🔐 SESSION MANAGEMENT INDEXES
userSchema.index({ phone: 1, sessionActive: 1 });
userSchema.index({ currentDeviceId: 1 });

/* ================================
   📝 SCHEMA METHODS
================================ */

// 🧹 METHOD: Clean old sessions (run periodically)
userSchema.methods.cleanOldSessions = function () {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  this.previousSessions = this.previousSessions.filter(
    (session) => session.loginAt > thirtyDaysAgo
  );
};

// 🔍 METHOD: Get active session info
userSchema.methods.getActiveSessionInfo = function () {
  return {
    deviceId: this.currentDeviceId,
    loginAt: this.lastLoginAt,
    active: this.sessionActive,
  };
};

/* ================================
   🔄 VIRTUAL PROPERTIES
================================ */

// ⚠️ VIRTUAL: Has active session on different device
userSchema.virtual("hasActiveSessionOnOtherDevice").get(function () {
  return this.sessionActive && this.currentDeviceId != null;
});

const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
