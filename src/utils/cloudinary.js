// utils/cloudinary.js
import cloudinaryPkg from 'cloudinary';
import dotenv from 'dotenv';

dotenv.config();

// ✅ Configure v2 via root package
// multer-storage-cloudinary v3 calls this.cloudinary.v2.uploader internally,
// so CloudinaryStorage must receive the ROOT package, not the unwrapped v2 instance.
cloudinaryPkg.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Default export = root package  →  for multer-storage-cloudinary (v3)
export default cloudinaryPkg;

// Named export = v2 instance  →  for direct uploads/deletes in controllers
export const cloudinaryV2 = cloudinaryPkg.v2;