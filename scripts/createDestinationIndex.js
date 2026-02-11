// scripts/createDestinationIndex.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function createIndex() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');

    // Check existing indexes
    const existingIndexes = await usersCollection.indexes();
    console.log('📋 Existing indexes:', existingIndexes.map(i => i.name));

    // Check if goToDestination.location index exists
    const hasDestinationIndex = existingIndexes.some(
      idx => idx.key && idx.key['goToDestination.location'] === '2dsphere'
    );

    if (hasDestinationIndex) {
      console.log('✅ goToDestination.location 2dsphere index already exists');
    } else {
      console.log('📍 Creating goToDestination.location 2dsphere index...');
      
      await usersCollection.createIndex(
        { "goToDestination.location": "2dsphere" },
        { 
          name: "goToDestination_location_2dsphere",
          sparse: true, // Only index documents that have this field
          background: true 
        }
      );
      
      console.log('✅ Index created successfully!');
    }

    // Also create compound index for destination mode queries
    const hasCompoundIndex = existingIndexes.some(
      idx => idx.name === 'destination_mode_search'
    );

    if (!hasCompoundIndex) {
      console.log('📍 Creating compound destination mode index...');
      
      await usersCollection.createIndex(
        {
          isDriver: 1,
          isOnline: 1,
          isBusy: 1,
          vehicleType: 1,
          "goToDestination.enabled": 1,
        },
        { 
          name: "destination_mode_search",
          background: true 
        }
      );
      
      console.log('✅ Compound index created!');
    }

    // Verify
    const finalIndexes = await usersCollection.indexes();
    console.log('');
    console.log('📋 Final indexes:');
    finalIndexes.forEach(idx => {
      console.log(`   - ${idx.name}: ${JSON.stringify(idx.key)}`);
    });

    await mongoose.disconnect();
    console.log('');
    console.log('✅ Done! You can now use destination mode queries.');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

createIndex();