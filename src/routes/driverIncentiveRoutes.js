// src/routes/driverIncentiveRoutes.js
import express from 'express';
import mongoose from 'mongoose';
import IncentiveCampaign from '../models/IncentiveCampaign.js';
import DriverIncentiveHistory from '../models/DriverIncentiveHistory.js';
import Trip from '../models/Trip.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Helper function to get today's date in YYYY-MM-DD format
const getTodayDate = () => {
  const today = new Date();
  return today.toISOString().split('T')[0];
};

// GET /api/driver/incentives - Get driver's incentive data for today
router.get('/', protect, async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

  try {
    const driverId = req.user._id;
    const today = getTodayDate();

    console.log('📊 Fetching incentives for driver:', driverId);

    // Get today's campaign
    let campaign = await IncentiveCampaign.findOne({ 
      date: today,
      isActive: true 
    }).lean();

    // If no campaign for today, return default
    if (!campaign) {
      campaign = {
        date: today,
        slabs: [
          { rides: 10, amount: 100 },
          { rides: 13, amount: 150 },
          { rides: 15, amount: 200 }
        ],
        images: [],
        isActive: true,
        isDefault: true
      };
    }

    // Get driver's history for today
    let history = await DriverIncentiveHistory.findOne({
      driverId,
      date: today
    }).lean();

    // If no history, count today's completed trips
    if (!history) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      
      const completedTrips = await Trip.countDocuments({
        driverId,
        status: 'completed',
        completedAt: { $gte: todayStart }
      });

      history = {
        driverId,
        date: today,
        ridesCompleted: completedTrips,
        incentiveEarned: 0,
        slabMatched: null,
        isPaid: false
      };
    }

    // Calculate current progress
    const ridesCompleted = history.ridesCompleted || 0;
    const sortedSlabs = campaign.slabs.sort((a, b) => a.rides - b.rides);
    
    // Find current and next slab
    let currentSlab = null;
    let nextSlab = null;
    let potentialEarning = 0;

    for (const slab of sortedSlabs) {
      if (ridesCompleted >= slab.rides) {
        currentSlab = slab;
        potentialEarning = slab.amount;
      } else if (!nextSlab) {
        nextSlab = slab;
      }
    }

    // Build response
    const response = {
      success: true,
      data: {
        date: today,
        campaign: {
  slabs: campaign.slabs,
  images: (campaign.images || []).map(img =>
    img.startsWith('http') ? img : `${baseUrl}${img}`
  ),
  isActive: campaign.isActive
},
        progress: {
          ridesCompleted,
          currentSlabRides: currentSlab?.rides || 0,
          currentSlabAmount: currentSlab?.amount || 0,
          nextSlabRides: nextSlab?.rides || null,
          nextSlabAmount: nextSlab?.amount || null,
          potentialEarning,
          ridesRemaining: nextSlab ? nextSlab.rides - ridesCompleted : 0,
          percentComplete: nextSlab 
            ? Math.round((ridesCompleted / nextSlab.rides) * 100)
            : (currentSlab ? 100 : 0)
        },
        earned: {
          incentiveEarned: history.incentiveEarned || 0,
          isPaid: history.isPaid || false,
          slabMatched: history.slabMatched || null
        }
      }
    };

    console.log('✅ Incentive data:', {
      driverId,
      ridesCompleted,
      potentialEarning,
      nextTarget: nextSlab?.rides
    });

    res.json(response);
  } catch (error) {
    console.error('❌ Error fetching driver incentives:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch incentive data'
    });
  }
});

// GET /api/driver/incentives/history - Get driver's incentive history
router.get('/history', protect, async (req, res) => {
  try {
    const driverId = req.user._id;
    const { limit = 30, page = 1 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const history = await DriverIncentiveHistory.find({ driverId })
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    const total = await DriverIncentiveHistory.countDocuments({ driverId });

    // Calculate totals
    const totals = await DriverIncentiveHistory.aggregate([
      { $match: { driverId: new mongoose.Types.ObjectId(driverId) } },
      {
        $group: {
          _id: null,
          totalRides: { $sum: '$ridesCompleted' },
          totalEarned: { $sum: '$incentiveEarned' },
          totalPaid: { 
            $sum: { 
              $cond: [{ $eq: ['$isPaid', true] }, '$incentiveEarned', 0] 
            } 
          }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        history,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit))
        },
        totals: totals[0] || {
          totalRides: 0,
          totalEarned: 0,
          totalPaid: 0
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch history'
    });
  }
});

// GET /api/driver/incentives/weekly-stats - Get weekly statistics
router.get('/weekly-stats', protect, async (req, res) => {
  try {
    const driverId = req.user._id;
    
    // Get last 7 days
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().split('T')[0]);
    }

    const history = await DriverIncentiveHistory.find({
      driverId,
      date: { $in: dates }
    }).lean();

    // Build stats for each day
    const stats = dates.map(date => {
      const dayData = history.find(h => h.date === date);
      return {
        date,
        ridesCompleted: dayData?.ridesCompleted || 0,
        incentiveEarned: dayData?.incentiveEarned || 0,
        isPaid: dayData?.isPaid || false
      };
    });

    // Calculate week totals
    const weekTotals = {
      totalRides: stats.reduce((sum, day) => sum + day.ridesCompleted, 0),
      totalEarned: stats.reduce((sum, day) => sum + day.incentiveEarned, 0),
      totalPaid: stats.reduce((sum, day) => 
        sum + (day.isPaid ? day.incentiveEarned : 0), 0
      ),
      averageRidesPerDay: 0,
      averageEarningsPerDay: 0
    };

    const activeDays = stats.filter(d => d.ridesCompleted > 0).length;
    if (activeDays > 0) {
      weekTotals.averageRidesPerDay = Math.round(weekTotals.totalRides / activeDays);
      weekTotals.averageEarningsPerDay = Math.round(weekTotals.totalEarned / activeDays);
    }

    res.json({
      success: true,
      data: {
        dailyStats: stats,
        weekTotals
      }
    });
  } catch (error) {
    console.error('❌ Error fetching weekly stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch weekly stats'
    });
  }
});

// GET /api/driver/incentives/campaigns/:date - Get campaign for specific date
router.get('/campaigns/:date', protect, async (req, res) => {
  try {
    const { date } = req.params;

    let campaign = await IncentiveCampaign.findOne({ 
      date,
      isActive: true 
    }).lean();

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: 'No campaign found for this date'
      });
    }

    res.json({
      success: true,
      data: campaign
    });
  } catch (error) {
    console.error('❌ Error fetching campaign:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch campaign'
    });
  }
});

export default router;