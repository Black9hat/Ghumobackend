/**
 * 🔥 Migration Script: Separate User IDs for Driver & Customer Accounts
 * 
 * Run this ONCE before deploying the code changes:
 * node migration-separate-user-ids.js
 * 
 * This script:
 * 1. Finds all duplicate phone+role combinations
 * 2. Keeps the newest record, deletes older duplicates
 * 3. Drops the old global phone unique index
 * 4. Verifies the new compound index
 */

import mongoose from "mongoose";
import User from "./src/models/User.js";
import dotenv from "dotenv";

dotenv.config();

async function migrateSeparateUserIds() {
  try {
    // Connect to MongoDB
    const mongoUrl = process.env.MONGO_URL || "mongodb://localhost:27017/goindia";
    console.log(`🔌 Connecting to MongoDB: ${mongoUrl}`);
    
    await mongoose.connect(mongoUrl);
    console.log("✅ Connected to MongoDB");

    console.log("\n🔄 Starting migration for separate user IDs...\n");

    // Step 1: Find all duplicate phone+role combinations
    console.log("📊 Finding duplicate phone+role combinations...");
    const duplicates = await User.aggregate([
      {
        $group: {
          _id: { phone: "$phone", role: "$role" },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
          createdDates: { $push: "$createdAt" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]);

    console.log(`✅ Found ${duplicates.length} duplicate phone+role combinations\n`);

    // Step 2: For each duplicate, keep the newest, delete older ones
    let deletedCount = 0;
    for (const dup of duplicates) {
      const users = await User.find({
        phone: dup._id.phone,
        role: dup._id.role,
      }).sort({ createdAt: -1 });

      console.log(
        `📌 ${dup._id.phone} (${dup._id.role}): ${users.length} records found`
      );

      // Keep the first (newest), delete the rest
      for (let i = 1; i < users.length; i++) {
        console.log(
          `   🗑️  Deleting duplicate: ${users[i]._id} (created: ${users[i].createdAt})`
        );
        await User.deleteOne({ _id: users[i]._id });
        deletedCount++;
      }
      console.log("");
    }

    console.log(`✅ Deleted ${deletedCount} duplicate records\n`);

    // Step 3: Drop old global phone unique index if it exists
    console.log("🔧 Cleaning up old indexes...");
    try {
      await User.collection.dropIndex("phone_1");
      console.log("✅ Dropped old global phone unique index (phone_1)");
    } catch (e) {
      if (e.message.includes("index not found")) {
        console.log("ℹ️  No old global phone index to drop");
      } else {
        throw e;
      }
    }

    // Step 4: Verify the new compound index exists
    console.log("\n📋 Verifying indexes...");
    const indexes = await User.collection.getIndexes();
    
    const hasCompoundIndex = Object.values(indexes).some((idx) => {
      return idx.key && idx.key.phone === 1 && idx.key.role === 1 && idx.unique === true;
    });

    if (hasCompoundIndex) {
      console.log("✅ Compound unique index on (phone, role) verified!");
    } else {
      console.warn("⚠️  WARNING: Compound index not found. Creating it now...");
      await User.collection.createIndex(
        { phone: 1, role: 1 },
        { unique: true }
      );
      console.log("✅ Compound unique index created!");
    }

    // Step 5: Final verification
    console.log("\n📊 Final Statistics:");
    const totalUsers = await User.countDocuments();
    const customerUsers = await User.countDocuments({ role: "customer" });
    const driverUsers = await User.countDocuments({ role: "driver" });

    console.log(`   Total users: ${totalUsers}`);
    console.log(`   Customer accounts: ${customerUsers}`);
    console.log(`   Driver accounts: ${driverUsers}`);

    // Check for any remaining duplicates
    const remainingDuplicates = await User.aggregate([
      {
        $group: {
          _id: { phone: "$phone", role: "$role" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]);

    if (remainingDuplicates.length === 0) {
      console.log("✅ No duplicate phone+role combinations remaining!\n");
    } else {
      console.warn(`⚠️  WARNING: ${remainingDuplicates.length} duplicates still exist!\n`);
    }

    console.log("🎉 Migration complete!\n");
    console.log("📝 Next steps:");
    console.log("   1. Deploy the updated code (User.js and authController.js)");
    console.log("   2. Restart all services");
    console.log("   3. Test: Create customer account with phone 9876543210");
    console.log("   4. Test: Create driver account with same phone 9876543210");
    console.log("   5. Verify: Both should have DIFFERENT user IDs ✅\n");

    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error.message);
    console.error(error);
    process.exit(1);
  }
}

// Run migration
migrateSeparateUserIds();
