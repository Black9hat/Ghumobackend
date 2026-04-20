// 🔧 FIX SCRIPT: Sync role and isDriver fields
// This script ensures all users with role="driver" also have isDriver=true

import mongoose from 'mongoose';
import User from "../models/User.js";
import dotenv from 'dotenv';

dotenv.config();

async function syncDriverFields() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // ============================================
    // STEP 1: Check current state
    // ============================================
    console.log('📊 CURRENT STATE:');
    console.log('─'.repeat(50));

    const totalUsers = await User.countDocuments();
    const usersWithRoleDriver = await User.countDocuments({ role: "driver" });
    const usersWithIsDriverTrue = await User.countDocuments({ isDriver: true });
    const driversWithBothFields = await User.countDocuments({ 
      role: "driver", 
      isDriver: true 
    });

    console.log(`Total users:                ${totalUsers}`);
    console.log(`Users with role="driver":   ${usersWithRoleDriver}`);
    console.log(`Users with isDriver=true:   ${usersWithIsDriverTrue}`);
    console.log(`Drivers with both fields:   ${driversWithBothFields}`);

    // ============================================
    // STEP 2: Find mismatched users
    // ============================================
    console.log('\n🔍 CHECKING FOR MISMATCHES:');
    console.log('─'.repeat(50));

    // Find users with role="driver" but isDriver=false
    const needsIsDriverTrue = await User.find({ 
      role: "driver", 
      isDriver: { $ne: true } 
    }).select('name phone role isDriver vehicleType');

    // Find users with isDriver=true but role!="driver"
    const needsRoleDriver = await User.find({ 
      isDriver: true, 
      role: { $ne: "driver" } 
    }).select('name phone role isDriver vehicleType');

    console.log(`\nUsers with role="driver" but isDriver≠true: ${needsIsDriverTrue.length}`);
    if (needsIsDriverTrue.length > 0) {
      needsIsDriverTrue.forEach((user, i) => {
        console.log(`  ${i + 1}. ${user.name} (${user.phone}) - isDriver: ${user.isDriver}`);
      });
    }

    console.log(`\nUsers with isDriver=true but role≠"driver": ${needsRoleDriver.length}`);
    if (needsRoleDriver.length > 0) {
      needsRoleDriver.forEach((user, i) => {
        console.log(`  ${i + 1}. ${user.name} (${user.phone}) - role: ${user.role}`);
      });
    }

    // ============================================
    // STEP 3: Fix mismatches
    // ============================================
    if (needsIsDriverTrue.length === 0 && needsRoleDriver.length === 0) {
      console.log('\n✅ No mismatches found! All fields are synced.');
      return;
    }

    console.log('\n🔧 FIXING MISMATCHES:');
    console.log('─'.repeat(50));

    let fixedCount = 0;

    // Fix users with role="driver" but isDriver=false
    if (needsIsDriverTrue.length > 0) {
      const result1 = await User.updateMany(
        { role: "driver", isDriver: { $ne: true } },
        { $set: { isDriver: true } }
      );
      console.log(`✅ Set isDriver=true for ${result1.modifiedCount} users`);
      fixedCount += result1.modifiedCount;
    }

    // Fix users with isDriver=true but role!="driver"
    if (needsRoleDriver.length > 0) {
      const result2 = await User.updateMany(
        { isDriver: true, role: { $ne: "driver" } },
        { $set: { role: "driver" } }
      );
      console.log(`✅ Set role="driver" for ${result2.modifiedCount} users`);
      fixedCount += result2.modifiedCount;
    }

    // ============================================
    // STEP 4: Verify fix
    // ============================================
    console.log('\n📊 AFTER FIX:');
    console.log('─'.repeat(50));

    const finalRoleDriver = await User.countDocuments({ role: "driver" });
    const finalIsDriverTrue = await User.countDocuments({ isDriver: true });
    const finalBothFields = await User.countDocuments({ 
      role: "driver", 
      isDriver: true 
    });

    console.log(`Users with role="driver":   ${finalRoleDriver}`);
    console.log(`Users with isDriver=true:   ${finalIsDriverTrue}`);
    console.log(`Drivers with both fields:   ${finalBothFields}`);

    if (finalRoleDriver === finalIsDriverTrue && finalRoleDriver === finalBothFields) {
      console.log('\n🎉 SUCCESS! All driver fields are now synced.');
    } else {
      console.log('\n⚠️ Warning: Some mismatches may still exist.');
    }

    // ============================================
    // STEP 5: List all drivers
    // ============================================
    console.log('\n👥 ALL DRIVERS IN DATABASE:');
    console.log('─'.repeat(50));

    const allDrivers = await User.find({ isDriver: true })
      .select('name phone email vehicleType vehicleNumber isVerified documentStatus')
      .sort({ name: 1 })
      .lean();

    if (allDrivers.length === 0) {
      console.log('❌ No drivers found! You need to add drivers to your database.');
    } else {
      allDrivers.forEach((driver, i) => {
        const verifiedIcon = driver.isVerified ? '✅' : '⏳';
        const statusIcon = driver.documentStatus === 'approved' ? '✅' : 
                          driver.documentStatus === 'rejected' ? '❌' : '⏳';
        
        console.log(`\n${i + 1}. ${driver.name} ${verifiedIcon}`);
        console.log(`   📞 ${driver.phone}`);
        console.log(`   📧 ${driver.email || 'No email'}`);
        console.log(`   🚗 ${driver.vehicleType || 'No vehicle'} - ${driver.vehicleNumber || 'No number'}`);
        console.log(`   📋 Status: ${driver.documentStatus} ${statusIcon}`);
      });

      console.log(`\n📊 Total: ${allDrivers.length} driver(s)`);
    }

  } catch (error) {
    console.error('\n❌ ERROR:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

// Run the script
syncDriverFields();