// src/middlewares/multer.js
import multer from "multer";
import path from "path";
import fs from "fs";

// ✅ multer-storage-cloudinary v3 (CommonJS) — import via default then destructure
import multerCloudinary from "multer-storage-cloudinary";
const CloudinaryStorage = multerCloudinary.CloudinaryStorage; // ✅ property access, not destructure (ESM+CJS compat)

// ✅ Import ROOT cloudinary package — v3 calls this.cloudinary.v2.uploader internally
import cloudinary from "../utils/cloudinary.js";

// ─────────────────────────────────────────────
// 📁 1. Disk storage for driver documents with phone number
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/documents";
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    try {
      const phoneNumber = req.user?.phoneNumber || req.body.phoneNumber;
      const docType = req.body.docType || 'document';
      const docSide = req.body.docSide || 'unknown';
      if (!phoneNumber) {
        return cb(new Error("Phone number is required"));
      }
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
  limits: { fileSize: 5 * 1024 * 1024 },
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
// 🖼 Banner Upload Storage (disk)
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
    cb(null, `banner_${Date.now()}${ext}`);
  },
});

export const uploadBanner = multer({
  storage: bannerStorage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPG, PNG, WEBP allowed"));
  },
});

// ===============================
// ☁️ Cloudinary Banner Storage
// ===============================
const bannerCloudinaryStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => ({
    folder: "banners",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    public_id: `banner_${Date.now()}_${Math.round(Math.random() * 1e4)}`,
  }),
});

export const uploadBannerToCloudinary = multer({
  storage: bannerCloudinaryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ===============================
// ☁️ Cloudinary Notification Storage
// ===============================
const notificationCloudinaryStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => ({
    folder: "notifications",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    public_id: `notif_${Date.now()}_${Math.round(Math.random() * 1e4)}`,
  }),
});

export const uploadNotificationToCloudinary = multer({
  storage: notificationCloudinaryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});