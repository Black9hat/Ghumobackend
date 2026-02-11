// routes/rewards.routes.js
import express from 'express';
import admin from 'firebase-admin';
import Reward from '../models/Reward.js';
import RewardSettings from '../models/RewardSettings.js';
import Customer from '../models/User.js';

const router = express.Router();

// Middleware to verify Firebase token
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Get customer rewards with distance tiers
router.get('/customer/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    console.log(`📊 Fetching rewards for customer: ${customerId}`);

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const settings = await RewardSettings.findOne();
    
    const history = await Reward.find({ customerId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const formattedHistory = history.map((item) => ({
      description: item.description,
      coins: item.coins,
      date: new Date(item.createdAt).toLocaleDateString(),
      type: item.type,
    }));

    console.log(`✅ Returning rewards data: ${customer.coins || 0} coins`);

    res.json({
      totalCoins: customer.coins || 0,
      distanceTiers: settings?.distanceTiers || [],
      referralBonus: settings?.referralBonus || 50,
      isDiscountEnabled: settings?.isDiscountEnabled ?? true,
      history: formattedHistory,
    });
  } catch (error) {
    console.error('Error fetching rewards:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Award coins after ride completion (distance-based)
router.post('/award', verifyToken, async (req, res) => {
  try {
    const { customerId, tripId, distance, isWeekend } = req.body;

    if (!distance || distance <= 0) {
      return res.status(400).json({ error: 'Valid distance required' });
    }

    const settings = await RewardSettings.findOne();
    if (!settings) {
      return res.status(500).json({ error: 'Reward settings not configured' });
    }

    // Find the appropriate tier based on distance
    const tier = settings.getTierByDistance(distance);
    let coinsToAward = tier.coinsPerRide;

    // Optional: Keep weekend bonus if needed
    if (isWeekend && settings.weekendBonus > 0) {
      coinsToAward += settings.weekendBonus;
    }

    const customer = await Customer.findByIdAndUpdate(
      customerId,
      { $inc: { coins: coinsToAward } },
      { new: true }
    );

    await Reward.create({
      customerId,
      tripId,
      coins: coinsToAward,
      type: 'earned',
      description: `Ride completed (${distance.toFixed(1)}km) - ${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km tier`,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      coinsAwarded: coinsToAward,
      totalCoins: customer.coins,
      distanceTier: {
        range: `${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`,
        platformFee: tier.platformFee,
      },
    });
  } catch (error) {
    console.error('Error awarding coins:', error);
    res.status(500).json({ error: 'Failed to award coins' });
  }
});

// Redeem coins for discount (distance-based)
router.post('/redeem', verifyToken, async (req, res) => {
  try {
    const { customerId, coinsToRedeem, estimatedDistance } = req.body;

    if (!estimatedDistance || estimatedDistance <= 0) {
      return res.status(400).json({ error: 'Estimated distance required for redemption' });
    }

    const settings = await RewardSettings.findOne();
    if (!settings) {
      return res.status(500).json({ error: 'Reward settings not configured' });
    }

    // ✅ Check if discount system is enabled
    if (!settings.isDiscountEnabled) {
      return res.status(400).json({ 
        error: 'Discount system is currently disabled',
        success: false 
      });
    }

    const tier = settings.getTierByDistance(estimatedDistance);
    const requiredCoins = tier.coinsRequiredForDiscount;
    const discountAmount = tier.discountAmount;

    if (coinsToRedeem !== requiredCoins) {
      return res.status(400).json({ 
        error: `For ${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km rides, you need ${requiredCoins} coins to redeem ₹${discountAmount} off` 
      });
    }

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    if (customer.coins < requiredCoins) {
      return res.status(400).json({ error: 'Insufficient coins' });
    }

    customer.coins -= requiredCoins;
    customer.hasRedeemableDiscount = true;
    customer.discountTierDistance = estimatedDistance; // Store which tier discount applies to
    await customer.save();

    await Reward.create({
      customerId,
      coins: -requiredCoins,
      type: 'redeemed',
      description: `₹${discountAmount} off coupon redeemed for ${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km rides`,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      remainingCoins: customer.coins,
      discountAvailable: true,
      discountAmount,
      applicableTier: `${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`,
    });
  } catch (error) {
    console.error('Error redeeming coins:', error);
    res.status(500).json({ error: 'Failed to redeem coins' });
  }
});

// Check discount eligibility (distance-based)
router.get('/discount/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { distance } = req.query;

    console.log(`🔍 Checking discount for customer: ${customerId}, distance: ${distance}km`);

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const settings = await RewardSettings.findOne();
    if (!settings) {
      return res.status(500).json({ error: 'Reward settings not configured' });
    }

    // ✅ Check if discount system is enabled
    const isDiscountEnabled = settings.isDiscountEnabled ?? true;
    
    if (!isDiscountEnabled) {
      console.log('⚠️ Discount system is disabled');
      return res.json({
        hasDiscount: false,
        discountAmount: 0,
        coins: customer.coins || 0,
        coinsRequired: 0,
        hasRedeemableDiscount: false,
        autoEligible: false,
        isDiscountEnabled: false,
        message: 'Discount system is currently disabled',
      });
    }

    const estimatedDistance = parseFloat(distance) || 5; // Default to 5km if not provided
    const tier = settings.getTierByDistance(estimatedDistance);

    const coinsRequired = tier.coinsRequiredForDiscount;
    const discountAmount = tier.discountAmount;

    const hasEnoughCoins = (customer.coins || 0) >= coinsRequired;
    const hasDiscount = customer.hasRedeemableDiscount || hasEnoughCoins;

    res.json({
      hasDiscount,
      discountAmount: hasDiscount ? discountAmount : 0,
      coins: customer.coins || 0,
      coinsRequired,
      hasRedeemableDiscount: customer.hasRedeemableDiscount || false,
      autoEligible: hasEnoughCoins,
      isDiscountEnabled: true,
      applicableTier: {
        range: `${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`,
        platformFee: tier.platformFee,
        coinsPerRide: tier.coinsPerRide,
      },
    });
  } catch (error) {
    console.error('❌ Error checking discount:', error);
    res.status(500).json({ error: 'Failed to check discount' });
  }
});

// Apply discount (distance-based with auto-redeem)
router.post('/apply-discount', verifyToken, async (req, res) => {
  try {
    const { customerId, originalFare, distance } = req.body;

    if (!distance || distance <= 0) {
      return res.status(400).json({ error: 'Valid distance required' });
    }

    console.log(`💳 Applying discount for customer: ${customerId}, distance: ${distance}km, fare: ₹${originalFare}`);

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const settings = await RewardSettings.findOne();
    if (!settings) {
      return res.status(500).json({ error: 'Reward settings not configured' });
    }

    // ✅ Check if discount system is enabled
    if (!settings.isDiscountEnabled) {
      console.log('⚠️ Discount system is disabled, returning original fare');
      return res.json({
        discountApplied: false,
        finalFare: originalFare,
        discount: 0,
        message: 'Discount system is currently disabled',
      });
    }

    const tier = settings.getTierByDistance(distance);
    const coinsRequired = tier.coinsRequiredForDiscount;
    const discountAmount = tier.discountAmount;

    const hasRedeemed = customer.hasRedeemableDiscount;
    const hasEnoughCoins = (customer.coins || 0) >= coinsRequired;

    if (!hasRedeemed && !hasEnoughCoins) {
      return res.json({
        discountApplied: false,
        finalFare: originalFare,
        discount: 0,
        message: `Need ${coinsRequired - (customer.coins || 0)} more coins for ₹${discountAmount} off on ${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km rides`,
      });
    }

    // Auto-redeem if eligible
    if (!hasRedeemed && hasEnoughCoins) {
      console.log(`🎯 Auto-redeeming ${coinsRequired} coins for ₹${discountAmount} discount`);
      
      customer.coins -= coinsRequired;
      customer.hasRedeemableDiscount = true;
      
      await Reward.create({
        customerId,
        coins: -coinsRequired,
        type: 'redeemed',
        description: `₹${discountAmount} discount auto-applied (${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km tier)`,
        createdAt: new Date(),
      });
    }

    // Apply discount
    const finalFare = Math.max(0, originalFare - discountAmount);
    
    customer.hasRedeemableDiscount = false;
    customer.discountTierDistance = null;
    await customer.save();

    res.json({
      discountApplied: true,
      originalFare,
      discount: discountAmount,
      finalFare,
      coinsDeducted: !hasRedeemed && hasEnoughCoins ? coinsRequired : 0,
      remainingCoins: customer.coins,
      appliedTier: `${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`,
    });
  } catch (error) {
    console.error('❌ Error applying discount:', error);
    res.status(500).json({ error: 'Failed to apply discount' });
  }
});

// Health check
router.get('/', (req, res) => {
  res.json({
    message: '🎁 Distance-Based Rewards API is active',
    availableEndpoints: [
      'GET /api/rewards/customer/:customerId',
      'POST /api/rewards/award (requires: customerId, tripId, distance)',
      'POST /api/rewards/redeem (requires: customerId, coinsToRedeem, estimatedDistance)',
      'GET /api/rewards/discount/:customerId?distance=X',
      'POST /api/rewards/apply-discount (requires: customerId, originalFare, distance)',
    ],
  });
});

export default router;