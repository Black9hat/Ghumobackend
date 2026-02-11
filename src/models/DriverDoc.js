// models/DriverDoc.js
import mongoose from "mongoose";

const driverDocSchema = new mongoose.Schema(
  {
    // 🔑 Which driver this belongs to (Firebase UID - stored as String)
   userId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "User",
  required: true,
  index: true,
},

    // 📄 Aadhaar / PAN / DL / RC / Profile etc.
    docType: { 
      type: String, 
      required: true, 
      trim: true,
      lowercase: true  // ✅ Auto-lowercase for consistency
    },

    // 🌓 Front or Back image side (or single for profile)
    side: { 
      type: String, 
      enum: ["front", "back"], 
      default: "front" 
    },

    // 🚗 For RC or DL mapping (bike/auto/car)
    vehicleType: { 
      type: String, 
      trim: true,
      lowercase: true  // ✅ Auto-lowercase for consistency
    },

    // 🖼 Local path or cloud storage URL
    url: { 
      type: String, 
      default: null, 
      trim: true 
    },

    // 🛂 Verification pipeline
    status: {
      type: String,
      enum: ["pending", "verified", "rejected", "approved"],
      default: "pending",
      index: true
    },

    // 🗒 Admin feedback
    remarks: { 
      type: String, 
      default: "" 
    },

    // 🧠 OCR — allow structured JSON or text
    extractedData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // 🧹 Soft-delete tracking for image cleanup
    imageDeleted: { 
      type: Boolean, 
      default: false 
    },
    imageDeletedAt: { 
      type: Date 
    },

    // ♻ Driver requested re-verification
    resendRequestedAt: { 
      type: Date, 
      default: null 
    },
    
    resendCount: { 
      type: Number, 
      default: 0 
    },
  },
  { timestamps: true }
);

// 🚀 Useful indexes
driverDocSchema.index({ userId: 1, docType: 1 });
driverDocSchema.index({ userId: 1, vehicleType: 1 });
driverDocSchema.index({ userId: 1, docType: 1, side: 1 });
driverDocSchema.index({ status: 1 });
driverDocSchema.index({ resendRequestedAt: -1 });

const DriverDoc =
  mongoose.models.DriverDoc || mongoose.model("DriverDoc", driverDocSchema);

export default DriverDoc;