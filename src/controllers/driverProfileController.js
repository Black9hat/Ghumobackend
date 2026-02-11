import cloudinary from "../utils/cloudinary.js";
import streamifier from "streamifier";
import User from "../models/User.js";
import DriverDoc from "../models/DriverDoc.js";
import { recomputeDriverDocumentStatus } from "./documentController.js";

/**
 * @desc    Upload driver's profile photo (treated as a document)
 * @route   POST /api/driver/uploadProfilePhoto
 * @access  Private (Driver)
 */
export const uploadDriverProfilePhoto = async (req, res) => {
  try {
    // 🔐 Firebase UID (AUTH ONLY)
    const firebaseUid =
      req.user?.uid || req.user?.id || req.user?.sub || null;

    if (!firebaseUid) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No image file uploaded" });
    }

    // 👤 Find user using Firebase UID
    const user = await User.findOne({ firebaseUid });

    if (!user) {
      return res.status(404).json({ message: "Driver not found" });
    }

    // ✅ THIS IS THE KEY FIX
    const userId = user._id; // MongoDB ObjectId
    const vehicleType = (user.vehicleType || "bike").toLowerCase();

    // ☁️ Upload to Cloudinary
    const uploadToCloudinary = (buffer) =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "driver_profiles",
            public_id: `profile_${userId}_${Date.now()}`, // better than firebaseUid
            overwrite: true,
          },
          (error, result) => {
            if (result) resolve(result);
            else reject(error);
          }
        );
        streamifier.createReadStream(buffer).pipe(stream);
      });

    const result = await uploadToCloudinary(req.file.buffer);
    const profilePhotoUrl = result.secure_url;

    // 🧾 Update user profile photo
    user.profilePhotoUrl = profilePhotoUrl;
    await user.save();

    // 📄 Create / Update DriverDoc (USE MongoDB userId)
    let profileDoc = await DriverDoc.findOne({
      userId: userId,          // ✅ FIXED
      docType: "profile",
    });

    if (profileDoc) {
      profileDoc.url = profilePhotoUrl;
      profileDoc.status = "pending";
      profileDoc.remarks = "";
      profileDoc.imageDeleted = false;
      profileDoc.updatedAt = new Date();
      await profileDoc.save();
    } else {
      profileDoc = await DriverDoc.create({
        userId: userId,        // ✅ FIXED
        docType: "profile",
        side: "front",
        url: profilePhotoUrl,
        status: "pending",
        remarks: "",
        extractedData: {},
        vehicleType,
      });
    }

    // 🔁 Recompute status using MongoDB ID
    await recomputeDriverDocumentStatus(userId);

    // 🔄 Fetch updated driver
    const updatedDriver = await User.findById(userId)
      .select(
        "_id firebaseUid documentStatus isVerified vehicleType profilePhotoUrl"
      )
      .lean();

    return res.status(200).json({
      success: true,
      message: "Profile photo uploaded and sent for verification",
      profilePhotoUrl,
      document: profileDoc,
      driver: updatedDriver,
    });
  } catch (error) {
    console.error("❌ uploadDriverProfilePhoto error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while uploading profile photo",
      error: error.message,
    });
  }
};

