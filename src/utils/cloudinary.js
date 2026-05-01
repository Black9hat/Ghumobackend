// utils/cloudinary.js
import { v2 as cloudinaryV2 } from "cloudinary";
import dotenv from "dotenv";

dotenv.config();

cloudinaryV2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Named export for direct use in controllers and multer.js
export { cloudinaryV2 };

// Default export kept for any existing imports: import cloudinary from '../utils/cloudinary.js'
export default cloudinaryV2;