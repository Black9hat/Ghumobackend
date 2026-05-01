// src/routes/incentiveRoutes.js
import express from 'express';
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import Wallet from '../models/Wallet.js';
import { protect } from '../middlewares/authMiddleware.js';
import mongoose from 'mongoose';

const router = express.Router();

// ==================== INCENTIVE SETTINGS ====================

// ✅ GET /api/incentives/settings - Get current incentive settings
router.get('/settings', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const IncentiveSettings = db.collection('incentiveSettings');
    let settings = await IncentiveSettings.findOne({ type: 'global' });

    if (!settings) {
      settings = {
        perRideIncentive: 0.0,
        perRideCoins: 0,
        coinsToRupeeConversion: 0.5,
        minimumCoinsForWithdrawal: 100,
        type: 'global'
      };
    }

    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    console.error('❌ Error fetching incentive settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch incentive settings'
    });
  }
});

// ✅ PUT /api/incentives/settings - Update incentive settings
router.put('/settings', async (req, res) => {
  try {
    const { perRideIncentive, perRideCoins } = req.body;

    if (typeof perRideIncentive !== 'number' || perRideIncentive < 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid perRideIncentive value. Must be a positive number.'
      });
    }

    if (typeof perRideCoins !== 'number' || perRideCoins < 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid perRideCoins value. Must be a positive number.'
      });
    }

    const settings = {
      perRideIncentive,
      perRideCoins,
      coinsToRupeeConversion: 0.5,
      minimumCoinsForWithdrawal: 100,
      updatedAt: new Date(),
      updatedBy: 'Public Access',
      type: 'global'
    };

    const db = mongoose.connection.db;
    const IncentiveSettings = db.collection('incentiveSettings');
    await IncentiveSettings.updateOne(
      { type: 'global' },
      { $set: settings },
      { upsert: true }
    );

    console.log('✅ Incentive settings updated:', {
      perRideIncentive,
      perRideCoins,
      updatedBy: 'Public Access'
    });

    res.json({
      success: true,
      message: 'Incentive settings updated successfully',
      data: settings
    });
  } catch (error) {
    console.error('❌ Error updating incentive settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update incentive settings'
    });
  }
});

// ==================== USER INCENTIVES ====================

// ✅ GET /api/incentives/:userId - Get user's incentive data
router.get('/:userId', protect, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.id.toString() !== userId && !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'You can only view your own incentive data'
      });
    }

    const db = mongoose.connection.db;
    const IncentiveSettings = db.collection('incentiveSettings');
    let settings = await IncentiveSettings.findOne({ type: 'global' });

    if (!settings) {
      settings = { perRideIncentive: 0.0, perRideCoins: 0 };
    }

    const user = await User.findById(userId).select(
      'name phone totalCoinsCollected totalIncentiveEarned totalRidesCompleted wallet'
    );

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Get today's data
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayTrips = await Trip.find({
      $or: [
        { customerId: userId },
        { driverId: userId }
      ],
      status: 'completed',
      completedAt: { $gte: today }
    });

    const todayRidesCompleted = todayTrips.length;
    const todayIncentiveEarned = todayRidesCompleted * (settings.perRideIncentive || 0);
    const todayCoinsEarned = todayRidesCompleted * (settings.perRideCoins || 0);

    res.json({
      success: true,
      data: {
        perRideIncentive: settings.perRideIncentive || 0.0,
        perRideCoins: settings.perRideCoins || 0,
        totalCoinsCollected: user.totalCoinsCollected || 0,
        totalIncentiveEarned: user.totalIncentiveEarned || 0.0,
        totalRidesCompleted: user.totalRidesCompleted || 0,
        wallet: user.wallet || 0.0,
        // Today's data
        todayRidesCompleted,
        todayIncentiveEarned,
        todayCoinsEarned
      }
    });
  } catch (error) {
    console.error('❌ Error fetching user incentives:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch incentive data'
    });
  }
});

// ✅ POST /api/incentives/withdraw-earnings - Withdraw coins to wallet
router.post('/withdraw-earnings', protect, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId } = req.body;

    // Verify user authorization
    if (req.user.id.toString() !== userId && !req.user.isAdmin) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        error: 'You can only withdraw your own coins'
      });
    }

    // Get settings
    const db = mongoose.connection.db;
    const IncentiveSettings = db.collection('incentiveSettings');
    let settings = await IncentiveSettings.findOne({ type: 'global' });

    if (!settings) {
      settings = {
        coinsToRupeeConversion: 0.5,
        minimumCoinsForWithdrawal: 100
      };
    }

    const minimumCoins = settings.minimumCoinsForWithdrawal || 100;
    const conversionRate = settings.coinsToRupeeConversion || 0.5;

    // Find user
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if user has enough coins
    const currentCoins = user.totalCoinsCollected || 0;
    if (currentCoins < minimumCoins) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: `You need at least ${minimumCoins} coins to withdraw. You have ${currentCoins} coins.`
      });
    }

    // Calculate withdrawal
    const coinsToWithdraw = minimumCoins;
    const rupeeAmount = coinsToWithdraw * conversionRate;

    // Update user
    user.totalCoinsCollected = (user.totalCoinsCollected || 0) - coinsToWithdraw;
    user.wallet = (user.wallet || 0) + rupeeAmount;
    await user.save({ session });

    // 🆕 ADD TRANSACTION TO DRIVER'S WALLET
    const wallet = await Wallet.findOneAndUpdate(
      { driverId: userId },
      {
        $inc: {
          availableBalance: rupeeAmount
        },
        $push: {
          transactions: {
            type: 'credit',
            amount: Number(rupeeAmount.toFixed(2)),
            description: `Coins withdrawal - ${coinsToWithdraw} coins converted to cash`,
            status: 'completed',
            createdAt: new Date()
          }
        },
        $set: {
          lastUpdated: new Date()
        }
      },
      { 
        new: true, 
        upsert: true,
        session 
      }
    );

    console.log('✅ Coins withdrawal successful:', {
      userId,
      coinsWithdrawn: coinsToWithdraw,
      rupeeAmount,
      remainingCoins: user.totalCoinsCollected,
      newWalletBalance: user.wallet,
      walletAvailableBalance: wallet.availableBalance
    });

    // Log transaction
    const Transactions = db.collection('coinTransactions');
    await Transactions.insertOne({
      userId: new mongoose.Types.ObjectId(userId),
      type: 'withdrawal',
      coinsDeducted: coinsToWithdraw,
      rupeeAmount,
      conversionRate,
      timestamp: new Date(),
      status: 'completed'
    }, { session });

    await session.commitTransaction();

    res.json({
      success: true,
      message: `Successfully withdrew ${coinsToWithdraw} coins (₹${rupeeAmount}) to wallet`,
      data: {
        coinsWithdrawn: coinsToWithdraw,
        rupeeAmount,
        remainingCoins: user.totalCoinsCollected,
        newWalletBalance: user.wallet,
        walletAvailableBalance: Number(wallet.availableBalance.toFixed(2))
      }
    });

  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('❌ Error withdrawing coins:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to withdraw coins'
    });
  } finally {
    session.endSession();
  }
});

// ✅ GET /api/incentives/:userId/history - Get withdrawal history
router.get('/:userId/history', protect, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.id.toString() !== userId && !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'You can only view your own history'
      });
    }

    const db = mongoose.connection.db;
    const Transactions = db.collection('coinTransactions');
    
    const history = await Transactions.find({
      userId: new mongoose.Types.ObjectId(userId)
    })
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();

    res.json({
      success: true,
      data: history
    });

  } catch (error) {
    console.error('❌ Error fetching withdrawal history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch history'
    });
  }
});

// 🆕 POST /api/incentives/add-ride-incentive - Add per-ride incentive to wallet
// ⚠️ NO AUTH REQUIRED - Called server-to-server from walletController
router.post('/add-ride-incentive', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    console.log('📥 Received add-ride-incentive request:', req.body);

    const { userId, tripId } = req.body;

    if (!userId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID format'
      });
    }

    // Get incentive settings
    const db = mongoose.connection.db;
    const IncentiveSettings = db.collection('incentiveSettings');
    let settings = await IncentiveSettings.findOne({ type: 'global' });

    if (!settings) {
      console.log('⚠️ No settings found, using defaults');
      settings = { perRideIncentive: 0.0, perRideCoins: 0 };
    }

    const perRideIncentive = settings.perRideIncentive || 0.0;
    const perRideCoins = settings.perRideCoins || 0;

    console.log('💰 Incentive settings:', { perRideIncentive, perRideCoins });

    // Skip if both are zero
    if (perRideIncentive === 0 && perRideCoins === 0) {
      await session.abortTransaction();
      console.log('ℹ️ No incentives configured, skipping');
      return res.json({
        success: true,
        message: 'No incentives configured',
        data: {
          cashIncentive: 0,
          coinsAwarded: 0
        }
      });
    }

    // Update user
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $inc: {
          totalIncentiveEarned: perRideIncentive,
          totalCoinsCollected: perRideCoins,
          totalRidesCompleted: 1,
          wallet: perRideIncentive
        }
      },
      { new: true, session }
    );

    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    console.log('✅ User updated:', {
      userId,
      newWallet: user.wallet,
      totalCoins: user.totalCoinsCollected
    });

    // Add to wallet page with transaction history
    const wallet = await Wallet.findOneAndUpdate(
      { driverId: userId },
      {
        $inc: {
          availableBalance: perRideIncentive,
          totalEarnings: perRideIncentive
        },
        $push: {
          transactions: {
            type: 'credit',
            amount: Number(perRideIncentive.toFixed(2)),
            tripId: tripId || null,
            description: `Ride incentive - ₹${perRideIncentive.toFixed(2)}${perRideCoins > 0 ? ` + ${perRideCoins} coins` : ''}`,
            status: 'completed',
            createdAt: new Date()
          }
        },
        $set: {
          lastUpdated: new Date()
        }
      },
      { 
        new: true, 
        upsert: true,
        session 
      }
    );

    console.log('✅ Wallet updated:', {
      availableBalance: wallet.availableBalance,
      totalEarnings: wallet.totalEarnings
    });

    await session.commitTransaction();

    console.log('='.repeat(70));
    console.log('💎 RIDE INCENTIVE ADDED SUCCESSFULLY');
    console.log(`   User ID: ${userId}`);
    console.log(`   Trip ID: ${tripId || 'N/A'}`);
    console.log(`   Cash Incentive: ₹${perRideIncentive}`);
    console.log(`   Coins Awarded: ${perRideCoins}`);
    console.log(`   New Wallet Balance: ₹${user.wallet}`);
    console.log(`   Wallet Available Balance: ₹${wallet.availableBalance}`);
    console.log('='.repeat(70));

    res.json({
      success: true,
      message: 'Ride incentive added successfully',
      data: {
        cashIncentive: perRideIncentive,
        coinsAwarded: perRideCoins,
        totalCoins: user.totalCoinsCollected,
        totalIncentiveEarned: user.totalIncentiveEarned,
        walletBalance: user.wallet,
        walletAvailableBalance: Number(wallet.availableBalance.toFixed(2))
      }
    });

  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('❌ Error adding ride incentive:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Failed to add ride incentive',
      details: error.message
    });
  } finally {
    session.endSession();
  }
});

export default router;