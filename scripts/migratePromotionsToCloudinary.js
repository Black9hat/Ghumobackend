// scripts/migratePromotionsToCloudinary.js
// Run this ONCE to migrate existing promotions to Cloudinary
import mongoose from 'mongoose';
import cloudinary from '../utils/cloudinary.js';
import Promotion from '../models/Promotion.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'your_mongodb_connection_string';

async function migrateToCloudinary() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const promotions = await Promotion.find({});
    console.log(`📋 Found ${promotions.length} promotions to check`);

    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    for (const promo of promotions) {
      try {
        // Skip if already on Cloudinary
        if (promo.imageUrl.includes('cloudinary.com')) {
          console.log(`⏭️  Already on Cloudinary: ${promo.title}`);
          skipped++;
          continue;
        }

        // Try to find local file
        let localPath = promo.imagePath;
        
        // Handle different path formats
        if (!localPath.startsWith('uploads/')) {
          // Extract path from URL if it's a full URL
          if (localPath.includes('/uploads/')) {
            localPath = localPath.split('/uploads/')[1];
            localPath = 'uploads/' + localPath;
          }
        }

        const fullPath = path.join(process.cwd(), localPath);
        
        if (!fs.existsSync(fullPath)) {
          console.log(`⚠️  Local file not found: ${promo.title}`);
          console.log(`   Path: ${fullPath}`);
          failed++;
          continue;
        }

        console.log(`⬆️  Uploading to Cloudinary: ${promo.title}`);
        
        // Upload to Cloudinary
        const result = await cloudinary.uploader.upload(fullPath, {
          folder: 'go-china/promotions',
          public_id: `promo-${promo._id}`,
          overwrite: true,
        });

        console.log(`✅ Uploaded: ${result.secure_url}`);

        // Update database
        await Promotion.findByIdAndUpdate(promo._id, {
          imageUrl: result.secure_url,
          imagePath: result.public_id,
        });

        console.log(`✅ Database updated for: ${promo.title}`);
        migrated++;

        // Optional: Delete local file after successful upload
        // fs.unlinkSync(fullPath);
        // console.log(`🗑️  Local file deleted: ${fullPath}`);

      } catch (promoErr) {
        console.error(`❌ Failed to migrate ${promo.title}:`, promoErr.message);
        failed++;
      }
    }

    console.log('\n🎉 Migration completed!');
    console.log(`✅ Migrated: ${migrated}`);
    console.log(`⏭️  Skipped (already on Cloudinary): ${skipped}`);
    console.log(`❌ Failed: ${failed}`);
    
    await mongoose.disconnect();
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrateToCloudinary();

// Run with: node scripts/migratePromotionsToCloudinary.js