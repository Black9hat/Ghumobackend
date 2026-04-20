import express from 'express';
import { verifyAdminToken } from '../middlewares/adminAuth.js';
import RewardSettings from '../models/RewardSettings.js';
import Reward from '../models/Reward.js';
import Customer from '../models/User.js';

const router = express.Router();

// --- Reward Settings ---

// GET - Fetch reward settings (NO AUTH for testing, add verifyAdminToken later)
router.get('/rewards/settings', async (req, res) => {
  try {
    console.log('🔥 GET /api/admin/rewards/settings');
    
    const settings = await RewardSettings.findOne();

    if (!settings) {
      return res.json({
        success: true,
        settings: null,
        message: 'No reward settings configured yet.',
      });
    }

    console.log('✅ Settings found:', settings);
    res.json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error('❌ Error fetching settings:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// PUT - Update or create reward settings (NO AUTH for testing)
router.put('/rewards/settings', async (req, res) => {
  try {
    console.log('🔥 PUT /api/admin/rewards/settings');
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));

    const { distanceTiers, referralBonus, isDiscountEnabled } = req.body;

    if (distanceTiers && !Array.isArray(distanceTiers)) {
      return res.status(400).json({ success: false, error: 'distanceTiers must be an array' });
    }

    if (distanceTiers) {
      for (const tier of distanceTiers) {
        // ✅ Handle null as Infinity
        const max = tier.maxDistance === null || tier.maxDistance === undefined ? Infinity : tier.maxDistance;
        
        if (tier.minDistance < 0) {
          return res.status(400).json({ success: false, error: 'Min distance cannot be negative' });
        }
        if (max !== Infinity && max <= tier.minDistance) {
          return res.status(400).json({ success: false, error: 'Invalid distance range in tier' });
        }
        if (tier.coinsPerRide < 1 || tier.coinsPerRide > 20) {
          return res.status(400).json({ success: false, error: 'coinsPerRide must be 1–20' });
        }
        if (tier.discountAmount < 5 || tier.discountAmount > 100) {
          return res.status(400).json({ success: false, error: 'discountAmount must be ₹5–₹100' });
        }
      }
    }

    let settings = await RewardSettings.findOne();

    // Process tiers: convert null back to Infinity for storage
    const processedTiers = distanceTiers.map(tier => ({
      ...tier,
      maxDistance: tier.maxDistance === null ? Infinity : tier.maxDistance
    }));

    if (!settings) {
      console.log('🆕 Creating new settings document');
      settings = await RewardSettings.create({
        distanceTiers: processedTiers,
        referralBonus: Number(referralBonus) || 50,
        isDiscountEnabled: isDiscountEnabled !== undefined ? Boolean(isDiscountEnabled) : true,
        updatedAt: new Date(),
        updatedBy: req.user?.email || 'admin',
      });
    } else {
      console.log('📝 Updating existing settings');
      if (distanceTiers) settings.distanceTiers = processedTiers;
      if (referralBonus !== undefined) settings.referralBonus = Number(referralBonus);
      if (isDiscountEnabled !== undefined) settings.isDiscountEnabled = Boolean(isDiscountEnabled);
      settings.updatedAt = new Date();
      settings.updatedBy = req.user?.email || 'admin';
      await settings.save();
    }

    console.log('✅ Settings saved successfully');
    res.json({ success: true, message: 'Reward settings saved', settings });
  } catch (err) {
    console.error('❌ Error saving settings:', err);
    res.status(500).json({ success: false, error: 'Server error saving settings', details: err.message });
  }
});

// --- Customer Reward Actions ---

// POST - Manually award coins to a customer by admin
router.post('/rewards/manual-award', /* verifyAdminToken, */ async (req, res) => {
  try {
    console.log('🔥 POST /api/admin/rewards/manual-award');
    const { customerId, coins, description } = req.body;

    if (!customerId || !coins || !description) {
      return res.status(400).json({
        success: false,
        error: 'customerId, coins, description are required',
      });
    }

    if (Number(coins) <= 0) {
      return res.status(400).json({ success: false, error: 'coins must be positive' });
    }

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }

    customer.coins = (customer.coins || 0) + Number(coins);
    await customer.save();

    await Reward.create({
      customerId,
      coins: Number(coins),
      type: 'earned',
      description: `Admin award: ${description}`,
      createdAt: new Date(),
    });

    console.log('✅ Coins awarded successfully');
    res.json({
      success: true,
      message: 'Coins awarded successfully',
      customer: {
        id: customer._id,
        name: customer.name,
        totalCoins: customer.coins,
      },
      coinsAwarded: coins,
    });
  } catch (error) {
    console.error('❌ Error in manual award:', error);
    res.status(500).json({ success: false, error: 'Server error awarding coins' });
  }
});

// GET - Fetch reward statistics
router.get('/rewards/stats', async (req, res) => {
  try {
    console.log('🔥 GET /api/admin/rewards/stats');
    
    const earned = await Reward.aggregate([
      { $match: { type: 'earned' } },
      { $group: { _id: null, total: { $sum: '$coins' } } },
    ]);

    const redeemed = await Reward.aggregate([
      { $match: { type: 'redeemed' } },
      { $group: { _id: null, total: { $sum: { $abs: '$coins' } } } },
    ]);

    const customersWithCoins = await Customer.countDocuments({ coins: { $gt: 0 } });
    const customersWithDiscount = await Customer.countDocuments({ hasRedeemableDiscount: true });

    const recent = await Reward.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('customerId', 'name email phone')
      .lean();

    const stats = {
      totalCoinsEarned: earned[0]?.total || 0,
      totalCoinsRedeemed: redeemed[0]?.total || 0,
      netCirculation: (earned[0]?.total || 0) - (redeemed[0]?.total || 0),
      customersWithCoins,
      customersWithDiscount,
    };

    console.log('✅ Stats fetched:', stats);
    res.json({
      success: true,
      stats,
      recentActivity: recent,
    });
  } catch (error) {
    console.error('❌ Error in stats:', error);
    res.status(500).json({ success: false, error: 'Server error loading stats' });
  }
});

export default router;