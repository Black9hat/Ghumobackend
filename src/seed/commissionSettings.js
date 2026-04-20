// src/seed/commissionSettings.js
// Auto-seed default commission settings on server startup

import CommissionSetting from '../models/CommissionSetting.js';

export const seedCommissionSettings = async () => {
  try {
    // Check if settings already exist
    const existingCount = await CommissionSetting.countDocuments();
    
    if (existingCount > 0) {
      console.log(`✅ Commission settings already seeded (${existingCount} documents)`);
      return;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`🌱 SEEDING DEFAULT COMMISSION SETTINGS`);
    console.log(`${"=".repeat(60)}`);

    // Default settings for each vehicle type
    const defaultSettings = [
      {
        vehicleType: 'bike',
        city: 'all',
        commissionPercent: 20,
        platformFeeFlat: 0,
        platformFeePercent: 0,
        perRideIncentive: 5,
        perRideCoins: 10,
        isActive: true,
        updatedByAdmin: 'system:seed',
        changeNote: 'Initial seed - Default bike commission',
      },
      {
        vehicleType: 'auto',
        city: 'all',
        commissionPercent: 20,
        platformFeeFlat: 0,
        platformFeePercent: 0,
        perRideIncentive: 5,
        perRideCoins: 10,
        isActive: true,
        updatedByAdmin: 'system:seed',
        changeNote: 'Initial seed - Default auto commission',
      },
      {
        vehicleType: 'car',
        city: 'all',
        commissionPercent: 20,
        platformFeeFlat: 5,
        platformFeePercent: 0,
        perRideIncentive: 10,
        perRideCoins: 15,
        isActive: true,
        updatedByAdmin: 'system:seed',
        changeNote: 'Initial seed - Default car commission',
      },
      {
        vehicleType: 'premium',
        city: 'all',
        commissionPercent: 15,
        platformFeeFlat: 10,
        platformFeePercent: 0,
        perRideIncentive: 15,
        perRideCoins: 20,
        isActive: true,
        updatedByAdmin: 'system:seed',
        changeNote: 'Initial seed - Default premium commission',
      },
      {
        vehicleType: 'xl',
        city: 'all',
        commissionPercent: 18,
        platformFeeFlat: 10,
        platformFeePercent: 0,
        perRideIncentive: 15,
        perRideCoins: 20,
        isActive: true,
        updatedByAdmin: 'system:seed',
        changeNote: 'Initial seed - Default XL/SUV commission',
      },
      {
        vehicleType: 'all',
        city: 'all',
        commissionPercent: 20,
        platformFeeFlat: 0,
        platformFeePercent: 0,
        perRideIncentive: 5,
        perRideCoins: 10,
        isActive: true,
        updatedByAdmin: 'system:seed',
        changeNote: 'Initial seed - Global fallback commission',
      },
    ];

    // Insert all default settings
    const result = await CommissionSetting.insertMany(defaultSettings);

    console.log(`\n✅ SEEDED ${result.length} default commission settings:`);
    result.forEach((doc) => {
      console.log(
        `   📍 ${doc.vehicleType.toUpperCase()} (${doc.city}): ${doc.commissionPercent}% commission, ₹${doc.perRideIncentive} + ${doc.perRideCoins} coins/ride`
      );
    });
    console.log(`${"=".repeat(60)}\n`);

  } catch (err) {
    // Duplicate key error is expected if called multiple times
    if (err.code === 11000) {
      console.log(`⚠️  Commission settings already exist (duplicate key), skipping seed`);
      return;
    }
    console.error('❌ Error seeding commission settings:', err.message);
  }
};
