// scripts/migrateSessionFields.js

/**
 * 🗄️ DATABASE MIGRATION SCRIPT
 * 
 * Adds session management fields to existing users
 * Run this once after deploying the new User model
 * 
 * Usage: node scripts/migrateSessionFields.js
 */

import mongoose from 'mongoose';
import User from '../src/models/User.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/your-db';

async function migrateSessionFields() {
  try {
    console.log('🚀 Starting session fields migration...');
    console.log(`📡 Connecting to: ${MONGODB_URI}`);

    // Connect to MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Count total users
    const totalUsers = await User.countDocuments({});
    console.log(`📊 Total users in database: ${totalUsers}`);

    // Find users without session fields
    const usersToUpdate = await User.countDocuments({
      currentDeviceId: { $exists: false },
    });
    console.log(`🔍 Users to update: ${usersToUpdate}`);

    if (usersToUpdate === 0) {
      console.log('✨ All users already have session fields. Migration not needed!');
      await mongoose.disconnect();
      return;
    }

    // Update users in batches
    console.log('🔄 Updating users...');
    
    const result = await User.updateMany(
      {
        currentDeviceId: { $exists: false },
      },
      {
        $set: {
          currentDeviceId: null,
          currentFcmToken: null,
          lastLoginAt: null,
          sessionActive: false,
          previousSessions: [],
        },
      }
    );

    console.log(`✅ Migration complete!`);
    console.log(`📈 Users updated: ${result.modifiedCount}`);
    console.log(`📊 Users matched: ${result.matchedCount}`);

    // Verify migration
    const verifyCount = await User.countDocuments({
      currentDeviceId: { $exists: true },
    });
    console.log(`🔍 Verification: ${verifyCount}/${totalUsers} users have session fields`);

    // Create indexes
    console.log('🔨 Creating indexes...');
    await User.collection.createIndex({ phone: 1, sessionActive: 1 });
    await User.collection.createIndex({ currentDeviceId: 1 });
    console.log('✅ Indexes created');

    // Disconnect
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
    console.log('🎉 Migration successful!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run migration
migrateSessionFields();