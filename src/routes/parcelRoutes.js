import express from 'express';
import multer from 'multer';
import path from 'path';
import { estimateParcel, createParcel } from '../controllers/parcelController.js';

const router = express.Router();

// ✅ Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Folder where images will be saved
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${file.fieldname}${ext}`); // Unique filename
  },
});

// ✅ Enhanced File filter (more flexible)
const fileFilter = (req, file, cb) => {
  console.log("📦 Received file type:", file.mimetype);
  console.log("📦 Original filename:", file.originalname);

  // Check if it's an image by MIME type
  if (file.mimetype.startsWith('image/')) {
    return cb(null, true);
  }

  // Check if it's an image by file extension (for cases where MIME type is octet-stream)
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
  const fileExtension = path.extname(file.originalname).toLowerCase();
  
  if (allowedExtensions.includes(fileExtension)) {
    // If it has an image extension but wrong MIME type, accept it
    console.log("✅ Accepting file based on extension:", fileExtension);
    return cb(null, true);
  }

  // Reject if neither MIME type nor extension is valid
  console.log("❌ Rejected file - not an image");
  cb(new Error('Only image files are allowed!'), false);
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  }
});

// ✅ Estimate parcel cost
router.post('/estimate', estimateParcel);

// ✅ Create parcel (with photo upload)
router.post('/create', upload.single('parcelPhoto'), createParcel);

export default router;