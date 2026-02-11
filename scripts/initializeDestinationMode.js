// scripts/initializeDestinationMode.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function initialize() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');

    // Update all drivers that don't have goToDestination field
    const result = await usersCollection.updateMany(
      {
        isDriver: true,
        goToDestination: { $exists: false }
      },
      {
        $set: {
          goToDestination: {
            enabled: false,
            location: {
              type: "Point",
              coordinates: [0, 0]
            },
            address: null,
            enabledAt: null,
            disabledAt: null
          }
        }
      }
    );

    console.log(`✅ Updated ${result.modifiedCount} drivers with goToDestination field`);

    await mongoose.disconnect();
    console.log('✅ Done!');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

initialize();
