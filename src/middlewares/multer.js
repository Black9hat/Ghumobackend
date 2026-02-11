// src/middlewares/multer.js
import multer from "multer";
import path from "path";
import fs from "fs";

// ─────────────────────────────────────────────
// 📁 1. Disk storage for driver documents with phone number
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/documents";

    // ✅ Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    cb(null, dir);
  },
  filename: (req, file, cb) => {
    try {
      // Get phone number from authenticated user or request body
      const phoneNumber = req.user?.phoneNumber || req.body.phoneNumber;
      const docType = req.body.docType || 'document';
      const docSide = req.body.docSide || 'unknown';
      
      if (!phoneNumber) {
        return cb(new Error("Phone number is required"));
      }

      // Get file extension
      const ext = path.extname(file.originalname);
      
      // Format: phoneNumber_docType_side.ext
      // Example: 8331134126_RC_front.jpg
      const filename = `${phoneNumber}_${docType.toUpperCase()}_${docSide}${ext}`;
      
      console.log(`📝 Saving document as: ${filename}`);
      cb(null, filename);
    } catch (error) {
      console.error("❌ Error generating filename:", error);
      cb(error);
    }
  },
});

export const uploadDocument = multer({
  storage: documentStorage,
  fileFilter: (req, file, cb) => {
    console.log("Received file type:", file.mimetype); 
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and WEBP files are allowed."));
    }
  },
});

// ─────────────────────────────────────────────
// 🧠 2. In-memory buffer for Cloudinary uploads (profile photos)
const profilePhotoStorage = multer.memoryStorage();

export const uploadProfilePhoto = multer({
  storage: profilePhotoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    console.log("Received file type:", file.mimetype);
    const allowedTypes = ["image/jpeg", "image/png"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG and PNG image files are allowed."));
    }
  },
});
// ===============================
// 🖼 Banner Upload Storage
// ===============================
const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/banners";
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `banner_${Date.now()}${ext}`;
    cb(null, filename);
  }
});

export const uploadBanner = multer({
  storage: bannerStorage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPG, PNG, WEBP allowed"));
  },
});