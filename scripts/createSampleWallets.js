// scripts/createSampleWallets.js
// Fixed version - Run with: node scripts/createSampleWallets.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Connect to database first
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
};

// Define schemas directly (in case models aren't found)
const userSchema = new mongoose.Schema({
  name: String,
  phone: String,
  isDriver: Boolean,
  vehicleType: String,
});

const walletSchema = new mongoose.Schema({
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  availableBalance: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  totalCommission: { type: Number, default: 0 },
  pendingAmount: { type: Number, default: 0 },
  balance: { type: Number, default: 0 },
  transactions: [{
    type: { type: String },
    amount: Number,
    description: String,
    status: String,
    paymentMethod: String,
    createdAt: { type: Date, default: Date.now }
  }],
  lastUpdated: { type: Date, default: Date.now }
});

// Get or create models
const User = mongoose.model('User', userSchema);
const Wallet = mongoose.model('Wallet', walletSchema);

const createSampleWallets = async () => {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();

    // Get all drivers
    const drivers = await User.find({ isDriver: true }).limit(20);
    console.log(`📊 Found ${drivers.length} drivers\n`);

    if (drivers.length === 0) {
      console.log('⚠️  No drivers found in database!');
      console.log('✅ Run this script after creating some drivers.\n');
      process.exit(0);
    }

    let created = 0;
    let updated = 0;

    for (const driver of drivers) {
      try {
        // Check if wallet already exists
        let wallet = await Wallet.findOne({ driverId: driver._id });

        // Generate realistic random values
        const totalEarnings = Math.floor(Math.random() * 150000) + 20000;    // ₹20K - ₹170K
        const totalCommission = Math.floor(totalEarnings * 0.15);             // 15% commission
        const availableBalance = Math.floor(Math.random() * 80000) + 5000;   // ₹5K - ₹85K
        const pendingAmount = Math.floor(Math.random() * 30000);             // ₹0 - ₹30K

        if (!wallet) {
          // Create new wallet with sample transactions
          const sampleTransactions = [
            {
              type: 'credit',
              amount: Math.floor(Math.random() * 2000) + 300,
              description: 'Trip completed - City ride',
              status: 'completed',
              paymentMethod: 'cash',
              createdAt: new Date(Date.now() - 86400000 * Math.random())
            },
            {
              type: 'credit',
              amount: Math.floor(Math.random() * 1500) + 250,
              description: 'Trip completed - Outstation',
              status: 'completed',
              paymentMethod: 'upi',
              createdAt: new Date(Date.now() - 86400000 * Math.random())
            },
            {
              type: 'commission',
              amount: Math.floor(Math.random() * 500) + 50,
              description: 'Commission deducted',
              status: 'completed',
              paymentMethod: 'system',
              createdAt: new Date(Date.now() - 86400000 * Math.random())
            },
            {
              type: 'credit',
              amount: Math.floor(Math.random() * 3000) + 500,
              description: 'Trip completed - Long distance',
              status: 'completed',
              paymentMethod: 'card',
              createdAt: new Date(Date.now() - 86400000 * Math.random())
            },
            {
              type: 'debit',
              amount: Math.floor(Math.random() * 10000) + 1000,
              description: 'Payout to driver',
              status: 'completed',
              paymentMethod: 'netbanking',
              createdAt: new Date(Date.now() - 86400000 * Math.random())
            }
          ];

          wallet = new Wallet({
            driverId: driver._id,
            availableBalance,
            totalEarnings,
            totalCommission,
            pendingAmount,
            balance: availableBalance,
            transactions: sampleTransactions,
            lastUpdated: new Date()
          });

          await wallet.save();
          created++;
          console.log(`✅ Created wallet for ${driver.name || 'Unknown'}`);
          console.log(`   💰 Balance: ₹${availableBalance.toLocaleString()}`);
          console.log(`   📈 Earnings: ₹${totalEarnings.toLocaleString()}`);
          console.log(`   ⏳ Pending: ₹${pendingAmount.toLocaleString()}\n`);
        } else {
          // Update existing wallet with realistic data
          wallet.availableBalance = availableBalance;
          wallet.totalEarnings = totalEarnings;
          wallet.totalCommission = totalCommission;
          wallet.pendingAmount = pendingAmount;
          wallet.balance = availableBalance;
          wallet.lastUpdated = new Date();

          // Keep existing transactions but add new sample ones if empty
          if (!wallet.transactions || wallet.transactions.length === 0) {
            wallet.transactions = [
              {
                type: 'credit',
                amount: Math.floor(Math.random() * 2000) + 300,
                description: 'Trip completed',
                status: 'completed',
                paymentMethod: 'cash',
                createdAt: new Date()
              }
            ];
          }

          await wallet.save();
          updated++;
          console.log(`🔄 Updated wallet for ${driver.name || 'Unknown'}`);
          console.log(`   💰 Balance: ₹${availableBalance.toLocaleString()}`);
          console.log(`   📈 Earnings: ₹${totalEarnings.toLocaleString()}`);
          console.log(`   ⏳ Pending: ₹${pendingAmount.toLocaleString()}\n`);
        }
      } catch (error) {
        console.error(`❌ Error processing driver ${driver.name}: ${error.message}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Created: ${created} new wallets`);
    console.log(`🔄 Updated: ${updated} existing wallets`);
    console.log(`📈 Total: ${created + updated} wallets processed`);
    console.log('='.repeat(60));
    console.log('\n🎉 Sample wallets created successfully!');
    console.log('💻 Refresh your admin dashboard to see the values.\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('\n📝 Troubleshooting:');
    console.error('1. Make sure .env file exists with MONGODB_URI');
    console.error('2. Make sure MongoDB is running');
    console.error('3. Check that MONGODB_URI is correct\n');
    process.exit(1);
  }
};

createSampleWallets();