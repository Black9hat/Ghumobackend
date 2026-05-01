// src/middlewares/multer.js
import multer from "multer";
import path from "path";
import fs from "fs";

// ✅ No multer-storage-cloudinary — use memoryStorage + manual upload instead.
// This avoids all CJS/ESM interop issues with multer-storage-cloudinary v3/v4.
import { cloudinaryV2 } from "../utils/cloudinary.js";

// ─────────────────────────────────────────────
// 📁 1. Disk storage for driver documents
// ─────────────────────────────────────────────
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/documents";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    try {
      const phoneNumber = req.user?.phoneNumber || req.body.phoneNumber;
      const docType = req.body.docType || "document";
      const docSide = req.body.docSide || "unknown";
      if (!phoneNumber) return cb(new Error("Phone number is required"));
      const ext = path.extname(file.originalname);
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
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    allowedTypes.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPEG, PNG, and WEBP files are allowed."));
  },
});

// ─────────────────────────────────────────────
// 🧠 2. In-memory buffer for profile photos
// ─────────────────────────────────────────────
const profilePhotoStorage = multer.memoryStorage();

export const uploadProfilePhoto = multer({
  storage: profilePhotoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png"];
    allowedTypes.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPEG and PNG image files are allowed."));
  },
});

// ─────────────────────────────────────────────
// 🖼 3. Disk storage for banners (local)
// ─────────────────────────────────────────────
const bannerDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/banners";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `banner_${Date.now()}${ext}`);
  },
});

export const uploadBanner = multer({
  storage: bannerDiskStorage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPG, PNG, WEBP allowed"));
  },
});

// ─────────────────────────────────────────────
// ☁️ 4. Memory storage → manual Cloudinary upload
//    Replaces multer-storage-cloudinary entirely.
//    Usage: call upload.single('image'), then in your route handler
//    the file is in req.file.buffer — uploadToCloudinary() sends it up.
// ─────────────────────────────────────────────
const cloudinaryMemStorage = multer.memoryStorage();

const cloudinaryMulter = multer({
  storage: cloudinaryMemStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only image files are allowed!"));
  },
});

// Helper: upload a buffer to Cloudinary and return { secure_url, public_id }
export async function uploadToCloudinary(buffer, folder = "uploads") {
  return new Promise((resolve, reject) => {
    const stream = cloudinaryV2.uploader.upload_stream(
      {
        folder,
        public_id: `${folder.split("/").pop()}_${Date.now()}_${Math.round(Math.random() * 1e4)}`,
        resource_type: "image",
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

// ✅ Drop-in replacements — same API as before (multer instance with .single() etc.)
//    After multer runs, call uploadToCloudinary(req.file.buffer, "banners") in your handler.
export const uploadBannerToCloudinary = cloudinaryMulter;
export const uploadNotificationToCloudinary = cloudinaryMulter;