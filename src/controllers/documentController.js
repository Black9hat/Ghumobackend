// src/controllers/documentController.js
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import mongoose from "mongoose";
import DriverDoc from "../models/DriverDoc.js";
import requiredDocs from "../utils/requiredDocs.js";
import User from "../models/User.js";
import cloudinary from "../utils/cloudinary.js";
import streamifier from "streamifier";
import { extractTextFromImage, parseDocumentData } from "../services/ocrService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("📄 documentController loaded");

// ============================================================================
// HELPER: Recompute Driver Document Status (FIXED - Uses MongoDB _id)
// ============================================================================

export const recomputeDriverDocumentStatus = async (userId) => {
  try {
    if (!userId) {
      console.warn("⚠️ recomputeDriverDocumentStatus: userId is null");
      return;
    }

    // Convert to ObjectId if string
    const userObjectId = typeof userId === 'string' 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;

    const driver = await User.findById(userObjectId).lean();

    if (!driver) {
      console.warn("⚠️ User not found for userId:", userId);
      return;
    }

    const vehicleType = (driver.vehicleType || "").toString().trim().toLowerCase();

    if (!vehicleType) {
      console.warn("⚠️ User has no vehicleType:", userId);
      return;
    }

    const requiredForVehicle = (requiredDocs[vehicleType] || []).map((d) =>
      d.toString().toLowerCase()
    );

    if (requiredForVehicle.length === 0) {
      console.log("ℹ️ No requiredDocs for vehicleType:", vehicleType);
      return;
    }

    // ✅ FIX: Find documents using MongoDB _id
    const docs = await DriverDoc.find({
      userId: userObjectId,
      imageDeleted: { $ne: true },
    }).lean();

    console.log("📋 Found", docs.length, "documents for userId:", userId);

    // Build map by docType
    const docsByType = new Map();

    for (const d of docs) {
      const type = (d.docType || "").toString().toLowerCase();
      if (!type) continue;

      if (!docsByType.has(type)) {
        docsByType.set(type, []);
      }
      docsByType.get(type).push(d);
    }

    let allRequiredUploaded = true;
    let allApproved = true;
    let anyRejected = false;

    for (const docType of requiredForVehicle) {
      const list = docsByType.get(docType) || [];

      if (list.length === 0) {
        allRequiredUploaded = false;
        allApproved = false;
        console.log("📋 Missing:", docType);
        continue;
      }

      for (const d of list) {
        const s = (d.status || "pending").toString().toLowerCase();

        if (s === "rejected") {
          anyRejected = true;
          allApproved = false;
        } else if (s !== "approved" && s !== "verified") {
          allApproved = false;
        }
      }
    }

    let newStatus = "pending";
    let isVerified = false;

    if (allRequiredUploaded && allApproved) {
      newStatus = "approved";
      isVerified = true;
    } else if (anyRejected) {
      newStatus = "rejected";
    }

    // ✅ FIX: Update using MongoDB _id
    await User.updateOne(
      { _id: userObjectId },
      { documentStatus: newStatus, isVerified: isVerified }
    );

    console.log(
      "✅ Status updated → userId:",
      userId,
      "status:",
      newStatus,
      "isVerified:",
      isVerified
    );
  } catch (err) {
    console.error("❌ recomputeDriverDocumentStatus error:", err);
  }
};

// ============================================================================
// GET DRIVER PROFILE (FIXED - Uses MongoDB _id)
// ============================================================================

export const getDriverProfile = async (req, res) => {
  try {
    // ✅ FIX: Use req.user._id directly
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const userId = req.user._id;
    console.log("📋 Getting profile for userId:", userId);

    // Recompute status using MongoDB _id
    await recomputeDriverDocumentStatus(userId);

    const driver = await User.findById(userId).lean();

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    console.log("✅ Found driver:", driver.name || driver.phone);

    res.status(200).json({
      driver: {
        _id: driver._id,
        firebaseUid: driver.firebaseUid, // Still return for reference, but not used for docs
        name: driver.name || "",
        phone: driver.phone || "",
        email: driver.email || null,
        photoUrl: driver.profilePhotoUrl || driver.photoUrl || null,
        vehicleType: driver.vehicleType || "",
        vehicleNumber: driver.vehicleNumber || null,
        rating: driver.rating || 4.8,
        totalRidesCompleted: driver.totalRidesCompleted || 0,
        documentStatus: driver.documentStatus || "pending",
        role: driver.role || "customer",
        isDriver: driver.isDriver || false,
        isVerified: driver.isVerified || false,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching profile:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ============================================================================
// UPLOAD DRIVER DOCUMENT (FIXED - Uses MongoDB _id)
// ============================================================================

export const uploadDriverDocument = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded." });
    }

    const userId = req.user._id;
    console.log("📄 Upload request from userId:", userId);

    const file = req.file;
    let { docType, vehicleType, extractedData, docSide } = req.body || {};

    // Parse extractedData from client
    let parsedExtracted = {};
    try {
      if (typeof extractedData === "string" && extractedData.trim() !== "") {
        parsedExtracted = JSON.parse(extractedData);
      } else if (typeof extractedData === "object" && extractedData !== null) {
        parsedExtracted = extractedData;
      }
    } catch (e) {
      console.warn("⚠️ extractedData parse failed");
    }

    const docTypeNormalized = (docType || "").toString().trim().toLowerCase();
    const vehicleTypeNormalized = (vehicleType || "").toString().trim().toLowerCase();
    const side = (docSide || "front").toString().trim().toLowerCase();

    if (!docTypeNormalized || !vehicleTypeNormalized) {
      return res.status(400).json({ message: "docType and vehicleType are required." });
    }

    // Validate docType
    const allowedDocs = (requiredDocs[vehicleTypeNormalized] || []).map((d) =>
      d.toLowerCase()
    );

    if (
      allowedDocs.length > 0 &&
      !allowedDocs.includes(docTypeNormalized) &&
      docTypeNormalized !== "profile"
    ) {
      return res.status(400).json({
        message: `Invalid docType '${docType}' for vehicleType '${vehicleType}'`,
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Build filename
    const ext = path.extname(file.originalname) || "";
    const safePhone = (user.phone || "unknown").replace(/[^0-9+]/g, "");
    const timestamp = Date.now();
    const newFileName = `${safePhone}.${docTypeNormalized}.${side}.${timestamp}${ext}`;
    const newPath = path.join(path.dirname(file.path), newFileName);

    try {
      fs.renameSync(file.path, newPath);
    } catch (renameErr) {
      console.error("❌ Failed to rename file:", renameErr);
    }

    const finalPath = fs.existsSync(newPath) ? newPath : file.path;

    // ✅ PERFORM OCR EXTRACTION
    let ocrExtractedData = {};
    
    // Skip OCR for profile photos
    if (docTypeNormalized !== "profile") {
      try {
        console.log(`🔍 Starting OCR for ${docTypeNormalized} (${side})...`);
        
        const rawText = await extractTextFromImage(finalPath);
        console.log("📝 Raw OCR text extracted, length:", rawText.length);
        console.log("📝 First 300 characters of OCR text:");
        console.log("═".repeat(60));
        console.log(rawText.substring(0, 300));
        console.log("═".repeat(60));
        
        ocrExtractedData = parseDocumentData(rawText, docTypeNormalized);
        console.log("✅ Parsed OCR data:", JSON.stringify(ocrExtractedData, null, 2));
        
      } catch (ocrError) {
        console.error("❌ OCR extraction failed:", ocrError.message);
        ocrExtractedData = { 
          ocrError: ocrError.message,
          ocrFailed: true 
        };
      }
    }

    // ✅ MERGE: Client data takes precedence, OCR fills in gaps
    const finalExtractedData = {
      ...ocrExtractedData,        // OCR extracted data as base
      ...parsedExtracted,          // Client provided data overrides
      ocrPerformed: docTypeNormalized !== "profile",
      ocrTimestamp: new Date().toISOString(),
    };

    console.log("📄 Final extracted data:", JSON.stringify(finalExtractedData, null, 2));

    // Check if document already exists
    let existingDoc = await DriverDoc.findOne({
      userId: userId,
      docType: docTypeNormalized,
      side: side,
      vehicleType: vehicleTypeNormalized,
    });

    if (existingDoc) {
      existingDoc.url = finalPath;
      existingDoc.status = "pending";
      existingDoc.remarks = "";
      existingDoc.extractedData = finalExtractedData;
      existingDoc.imageDeleted = false;
      existingDoc.updatedAt = new Date();
      await existingDoc.save();
      console.log("📄 Updated existing document:", existingDoc._id);
    } else {
      existingDoc = new DriverDoc({
        userId: userId,
        docType: docTypeNormalized,
        side: side,
        url: finalPath,
        status: "pending",
        remarks: "",
        extractedData: finalExtractedData,
        vehicleType: vehicleTypeNormalized,
      });
      await existingDoc.save();
      console.log("📄 Created new document:", existingDoc._id);
    }

    await recomputeDriverDocumentStatus(userId);

    const updatedDriver = await User.findById(userId)
      .select("_id firebaseUid documentStatus isVerified vehicleType")
      .lean();

    return res.status(200).json({
      success: true,
      message: `${docTypeNormalized} ${side} uploaded successfully`,
      document: existingDoc,
      driver: updatedDriver,
      ocrPerformed: finalExtractedData.ocrPerformed,
      extractedFields: Object.keys(ocrExtractedData).filter(k => 
        !['ocrError', 'ocrFailed', 'rawText', 'parseError', 'fullRawText'].includes(k)
      ),
    });
  } catch (err) {
    console.error("❌ Upload error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ============================================================================
// GET DRIVER DOCUMENTS (FIXED - Uses MongoDB _id)
// ============================================================================

export const getDriverDocuments = async (req, res) => {
  const driverId = req.params.driverId;

  if (!driverId) {
    return res.status(400).json({ message: "Driver ID is required" });
  }

  try {
    const baseUrl = req.protocol + "://" + req.get("host");

    console.log("📋 getDriverDocuments for:", driverId);

    // ✅ FIX: Find driver by MongoDB _id
    let driver = null;

    // Try MongoDB ObjectId first
    if (mongoose.Types.ObjectId.isValid(driverId)) {
      driver = await User.findById(driverId).lean();
    }

    // Fallback: try by firebaseUid (for backward compatibility with admin routes)
    if (!driver) {
      driver = await User.findOne({ firebaseUid: driverId }).lean();
    }

    // Fallback: try by phone
    if (!driver) {
      driver = await User.findOne({ phone: driverId }).lean();
    }

    if (!driver) {
      console.log("❌ Driver not found for:", driverId);
      return res.status(404).json({
        message: "Driver not found",
        docs: [],
        vehicleType: null,
      });
    }

    const vehicleType = driver.vehicleType
      ? driver.vehicleType.toString().toLowerCase()
      : null;

    console.log("📋 Found driver:", driver.name, "userId:", driver._id, "vehicleType:", vehicleType);

    // ✅ FIX: Find documents using MongoDB _id
    let docs = await DriverDoc.find({
      userId: driver._id,
      imageDeleted: { $ne: true },
    })
      .sort({ updatedAt: -1 })
      .lean();

    console.log("📋 Found", docs.length, "documents");

    if (docs.length === 0) {
      return res.status(200).json({
        message: "No documents found.",
        docs: [],
        vehicleType: vehicleType,
      });
    }

    // Build URLs
    const docsWithUrls = docs.map((doc) => {
      let imageUrl = null;

      if (doc.url) {
        if (doc.url.startsWith("http")) {
          imageUrl = doc.url;
        } else {
          let cleanPath = doc.url.replace(/\\/g, "/");
          const idx = cleanPath.indexOf("uploads/");
          cleanPath = idx !== -1 ? cleanPath.substring(idx) : "uploads/" + path.basename(cleanPath);
          imageUrl = baseUrl + "/" + cleanPath;
        }
      }

      return {
        _id: doc._id,
        userId: doc.userId,
        docType: doc.docType,
        side: doc.side,
        url: doc.url,
        status: doc.status,
        remarks: doc.remarks,
        extractedData: doc.extractedData,
        vehicleType: doc.vehicleType,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        imageUrl: imageUrl,
        isVirtual: doc.isVirtual || false,
      };
    });

    return res.status(200).json({
      docs: docsWithUrls,
      vehicleType: vehicleType,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ============================================================================
// UPLOAD PROFILE PHOTO (FIXED - Uses MongoDB _id)
// ============================================================================

export const uploadDriverProfilePhoto = async (req, res) => {
  try {
    // ✅ FIX: Use req.user._id directly
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No image uploaded." });
    }

    const userId = req.user._id;
    console.log("📸 uploadProfilePhoto - userId:", userId);

    // ✅ FIX: Find user by MongoDB _id
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const vehicleType = (user.vehicleType || "bike").toLowerCase();

    console.log("📸 Uploading for userId:", userId);

    // Upload to Cloudinary
    const streamUpload = (buffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "driver_profiles",
            public_id: "profile_" + userId.toString() + "_" + Date.now(),
            overwrite: true,
          },
          (error, result) => {
            if (result) resolve(result);
            else reject(error);
          }
        );
        streamifier.createReadStream(buffer).pipe(stream);
      });
    };

    const result = await streamUpload(req.file.buffer);
    const profilePhotoUrl = result.secure_url;

    console.log("📸 Uploaded:", profilePhotoUrl);

    // Update user
    user.profilePhotoUrl = profilePhotoUrl;
    await user.save();

    // ✅ FIX: Update or create DriverDoc using MongoDB _id
    let existingDoc = await DriverDoc.findOne({
      userId: userId,
      docType: "profile",
      vehicleType: vehicleType,
    });

    if (existingDoc) {
      existingDoc.url = profilePhotoUrl;
      existingDoc.status = "pending";
      existingDoc.remarks = "";
      existingDoc.imageDeleted = false;
      existingDoc.updatedAt = new Date();
      await existingDoc.save();
      console.log("📸 Updated profile doc");
    } else {
      existingDoc = new DriverDoc({
        userId: userId,
        docType: "profile",
        side: "front",
        url: profilePhotoUrl,
        status: "pending",
        remarks: "",
        extractedData: {},
        vehicleType: vehicleType,
      });
      await existingDoc.save();
      console.log("📸 Created profile doc");
    }

    // ✅ FIX: Recompute using MongoDB _id
    await recomputeDriverDocumentStatus(userId);

    const updatedDriver = await User.findById(userId)
      .select("_id firebaseUid documentStatus isVerified vehicleType profilePhotoUrl")
      .lean();

    res.status(200).json({
      success: true,
      message: "Profile photo uploaded successfully.",
      profilePhotoUrl: profilePhotoUrl,
      document: existingDoc,
      driver: updatedDriver,
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ============================================================================
// RESEND DOCUMENT (FIXED - Uses .equals() for ObjectId comparison)
// ============================================================================

export const resendDriverDocument = async (req, res) => {
  try {
    const docId = req.params.docId;

    // ✅ FIX: Use req.user._id directly
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const userId = req.user._id;

    const existing = await DriverDoc.findById(docId);

    if (!existing) {
      return res.status(404).json({ message: "Document not found." });
    }

    // ✅ FIX: Use .equals() for Mongoose ObjectId comparison
    if (!existing.userId.equals(userId)) {
      return res.status(403).json({ message: "Not allowed." });
    }

    existing.status = "pending";
    existing.remarks = "";
    existing.resendRequestedAt = new Date();
    existing.resendCount = (existing.resendCount || 0) + 1;
    await existing.save();

    // ✅ FIX: Recompute using MongoDB _id
    await recomputeDriverDocumentStatus(userId);

    return res.status(200).json({
      success: true,
      message: "Document ready for re-upload",
      docId: existing._id,
      docType: existing.docType,
      side: existing.side,
    });
  } catch (err) {
    console.error("❌ Resend error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// ============================================================================
// GET DRIVER BY ID (FIXED - Uses MongoDB _id)
// ============================================================================

export const getDriverById = async (req, res) => {
  try {
    const driverId = req.params.driverId;

    if (!driverId) {
      return res.status(400).json({ message: "Driver ID required" });
    }

    let driver = null;

    // Try MongoDB ObjectId first
    if (mongoose.Types.ObjectId.isValid(driverId)) {
      driver = await User.findById(driverId).lean();
    }

    // Fallback: try by firebaseUid
    if (!driver) {
      driver = await User.findOne({ firebaseUid: driverId }).lean();
    }

    // Fallback: try by phone
    if (!driver) {
      driver = await User.findOne({ phone: driverId }).lean();
    }

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    return res.status(200).json(driver);
  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).json({ message: "Error", error: err.message });
  }
};

// ============================================================================
// ADMIN: Verify Document (FIXED - Uses MongoDB _id)
// ============================================================================

export const verifyDocument = async (req, res) => {
  try {
    const docId = req.params.docId;
    const { status, remarks } = req.body;

    if (!docId) {
      return res.status(400).json({ message: "Document ID required" });
    }

    if (!["approved", "verified", "rejected"].includes(status?.toLowerCase())) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const doc = await DriverDoc.findById(docId);

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    doc.status = status.toLowerCase();
    doc.remarks = remarks || "";
    await doc.save();

    // ✅ FIX: doc.userId is now MongoDB _id, so this works correctly
    await recomputeDriverDocumentStatus(doc.userId);

    return res.status(200).json({
      success: true,
      message: "Status updated",
      document: doc,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ============================================================================
// ADMIN: Get Pending Documents (FIXED - Uses MongoDB _id)
// ============================================================================

export const getPendingDocuments = async (req, res) => {
  try {
    const docs = await DriverDoc.find({
      status: "pending",
      imageDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();

    const baseUrl = req.protocol + "://" + req.get("host");

    // ✅ FIX: Extract MongoDB _ids instead of firebaseUids
    const userIds = [...new Set(docs.map((d) => d.userId.toString()))];

    // ✅ FIX: Find users by MongoDB _id
    const users = await User.find({ _id: { $in: userIds } })
      .select("_id name phone vehicleType")
      .lean();

    // ✅ FIX: Build map using MongoDB _id
    const userMap = {};
    for (const user of users) {
      userMap[user._id.toString()] = user;
    }

    const docsWithUrls = docs.map((doc) => {
      let imageUrl = null;

      if (doc.url) {
        if (doc.url.startsWith("http")) {
          imageUrl = doc.url;
        } else {
          let cleanPath = doc.url.replace(/\\/g, "/");
          const idx = cleanPath.indexOf("uploads/");
          cleanPath = idx !== -1 ? cleanPath.substring(idx) : "uploads/" + path.basename(cleanPath);
          imageUrl = baseUrl + "/" + cleanPath;
        }
      }

      // ✅ FIX: Look up user by MongoDB _id
      const userInfo = userMap[doc.userId.toString()] || null;

      return {
        ...doc,
        imageUrl,
        driverName: userInfo?.name || null,
        driverPhone: userInfo?.phone || null,
      };
    });

    return res.status(200).json({
      count: docsWithUrls.length,
      docs: docsWithUrls,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};