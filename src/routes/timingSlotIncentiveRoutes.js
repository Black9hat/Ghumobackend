// src/routes/timingSlotIncentiveRoutes.js
// API routes for time-based incentives (driver and admin endpoints)

import express from 'express';
import mongoose from 'mongoose';
import TimingSlotIncentive from '../models/TimingSlotIncentive.js';
import DriverIncentiveHistory from '../models/DriverIncentiveHistory.js';
import Trip from '../models/Trip.js';
import { protect } from '../middlewares/authMiddleware.js';
import { verifyAdminToken } from '../middlewares/adminAuth.js';

const router = express.Router();

// Helper: Get today's date in YYYY-MM-DD format
const getTodayDate = () => {
  const today = new Date();
  return today.toISOString().split('T')[0];
};

// Helper: Get yesterday's date in YYYY-MM-DD format
const getYesterdayDate = (baseDateStr) => {
  const yesterday = baseDateStr ? new Date(baseDateStr) : new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
};

// ============================================================================
// DRIVER ENDPOINTS
// ============================================================================

/**
 * GET /api/driver/incentives/timing
 * Fetch timing slot incentives for today and yesterday
 * Returns: { today: TimingSlotIncentive, yesterday: TimingSlotIncentive, ridesData: {...} }
 */
router.get('/timing', protect, async (req, res) => {
  try {
    const driverId = req.user._id;
    const queryDate = typeof req.query.date === 'string' ? req.query.date : null;
    const today = queryDate || getTodayDate();
    const yesterday = getYesterdayDate(today);

    console.log('📊 Fetching timing slot incentives for driver:', driverId);

    // Fetch today's and yesterday's campaigns (regardless of active status)
    let [todayIncentive, yesterdayIncentive] = await Promise.all([
      TimingSlotIncentive.findOne({ date: today }).lean(),
      TimingSlotIncentive.findOne({ date: yesterday }).lean()
    ]);

    // If no campaigns found, use defaults
    if (!todayIncentive) {
      todayIncentive = {
        date: today,
        timingSlots: [
          {
            timeLabel: '06:00 AM - 11:59 AM',
            startHour: 6,
            endHour: 11,
            milestones: [
              { ridesTarget: 2, reward: 30 },
              { ridesTarget: 5, reward: 30 },
              { ridesTarget: 10, reward: 40 }
            ]
          },
          {
            timeLabel: '12:00 PM - 05:59 PM',
            startHour: 12,
            endHour: 17,
            milestones: [
              { ridesTarget: 2, reward: 30 },
              { ridesTarget: 5, reward: 30 },
              { ridesTarget: 10, reward: 40 }
            ]
          },
          {
            timeLabel: '06:00 PM - 11:59 PM',
            startHour: 18,
            endHour: 23,
            milestones: [
              { ridesTarget: 2, reward: 30 },
              { ridesTarget: 5, reward: 30 },
              { ridesTarget: 10, reward: 40 }
            ]
          }
        ],
        isActive: true,
        isDefault: true
      };
    }

    if (!yesterdayIncentive) {
      yesterdayIncentive = {
        date: yesterday,
        timingSlots: [
          {
            timeLabel: '06:00 AM - 11:59 AM',
            startHour: 6,
            endHour: 11,
            milestones: [
              { ridesTarget: 2, reward: 25 },
              { ridesTarget: 5, reward: 25 },
              { ridesTarget: 10, reward: 35 }
            ]
          },
          {
            timeLabel: '12:00 PM - 05:59 PM',
            startHour: 12,
            endHour: 17,
            milestones: [
              { ridesTarget: 2, reward: 25 },
              { ridesTarget: 5, reward: 25 },
              { ridesTarget: 10, reward: 35 }
            ]
          },
          {
            timeLabel: '06:00 PM - 11:59 PM',
            startHour: 18,
            endHour: 23,
            milestones: [
              { ridesTarget: 2, reward: 25 },
              { ridesTarget: 5, reward: 25 },
              { ridesTarget: 10, reward: 35 }
            ]
          }
        ],
        isActive: true,
        isDefault: true
      };
    }

    // Fetch rider completion data
    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const yesterdayStart = new Date(yesterday);
    yesterdayStart.setHours(0, 0, 0, 0);
    const yesterdayEnd = new Date(yesterday);
    yesterdayEnd.setHours(23, 59, 59, 999);

    // Count completed trips by time slot for today
    const todayRides = await Trip.aggregate([
      {
        $match: {
          driverId: new mongoose.Types.ObjectId(driverId),
          status: 'completed',
          completedAt: { $gte: todayStart, $lte: todayEnd }
        }
      },
      {
        $group: {
          _id: { $hour: '$completedAt' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Count completed trips by time slot for yesterday
    const yesterdayRides = await Trip.aggregate([
      {
        $match: {
          driverId: new mongoose.Types.ObjectId(driverId),
          status: 'completed',
          completedAt: { $gte: yesterdayStart, $lte: yesterdayEnd }
        }
      },
      {
        $group: {
          _id: { $hour: '$completedAt' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Helper: Count rides in time slot
    const countRidesInSlot = (ridesByHour, startHour, endHour) => {
      return ridesByHour
        .filter(r => r._id >= startHour && r._id <= endHour)
        .reduce((sum, r) => sum + r.count, 0);
    };

    // Calculate rides per time slot
    const todaySlotRides = todayIncentive.timingSlots.map(slot => ({
      timeLabel: slot.timeLabel,
      completedRides: countRidesInSlot(todayRides, slot.startHour, slot.endHour)
    }));

    const yesterdaySlotRides = yesterdayIncentive.timingSlots.map(slot => ({
      timeLabel: slot.timeLabel,
      completedRides: countRidesInSlot(yesterdayRides, slot.startHour, slot.endHour)
    }));

    res.json({
      success: true,
      data: {
        today: {
          ...todayIncentive,
          slotRides: todaySlotRides
        },
        yesterday: {
          ...yesterdayIncentive,
          slotRides: yesterdaySlotRides
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching timing incentives:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch timing incentives',
      message: error.message
    });
  }
});

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/incentives/timing/:date
 * Fetch timing slot incentive for a specific date
 */
router.get('/timing/:date', verifyAdminToken, async (req, res) => {
  try {
    const { date } = req.params;

    let incentive = await TimingSlotIncentive.findOne({ date }).lean();
    
    if (!incentive) {
      incentive = {
        date,
        timingSlots: [
          {
            timeLabel: '06:00 AM - 11:59 AM',
            startHour: 6,
            endHour: 11,
            milestones: [
              { ridesTarget: 2, reward: 30 },
              { ridesTarget: 5, reward: 30 },
              { ridesTarget: 10, reward: 40 }
            ]
          },
          {
            timeLabel: '12:00 PM - 05:59 PM',
            startHour: 12,
            endHour: 17,
            milestones: [
              { ridesTarget: 2, reward: 30 },
              { ridesTarget: 5, reward: 30 },
              { ridesTarget: 10, reward: 40 }
            ]
          },
          {
            timeLabel: '06:00 PM - 11:59 PM',
            startHour: 18,
            endHour: 23,
            milestones: [
              { ridesTarget: 2, reward: 30 },
              { ridesTarget: 5, reward: 30 },
              { ridesTarget: 10, reward: 40 }
            ]
          }
        ],
        isActive: true,
        isDefault: true
      };
    }

    res.json({
      success: true,
      data: incentive
    });
  } catch (error) {
    console.error('❌ Error fetching incentive:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch incentive'
    });
  }
});

/**
 * POST /api/admin/incentives/timing
 * Create or update timing slot incentives for a date
 * Body: { date, timingSlots: [...], isActive }
 */
router.post('/timing', verifyAdminToken, async (req, res) => {
  try {
    const { date, timingSlots, isActive } = req.body;

    if (!date || !Array.isArray(timingSlots) || timingSlots.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payload: date and timingSlots required'
      });
    }

    const incentive = await TimingSlotIncentive.findOneAndUpdate(
      { date },
      {
        date,
        timingSlots,
        isActive: isActive !== undefined ? isActive : true,
        createdBy: req.user ? req.user._id : null
      },
      { upsert: true, new: true }
    );

    console.log('✅ Timing incentive saved:', { date, slotsCount: timingSlots.length });

    res.json({
      success: true,
      data: incentive
    });
  } catch (error) {
    console.error('❌ Error saving incentive:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save incentive'
    });
  }
});

/**
 * PUT /api/admin/incentives/timing/:date
 * Update timing slot incentives
 */
router.put('/timing/:date', verifyAdminToken, async (req, res) => {
  try {
    const { date } = req.params;
    const { timingSlots, isActive } = req.body;

    const incentive = await TimingSlotIncentive.findOneAndUpdate(
      { date },
      {
        timingSlots,
        isActive: isActive !== undefined ? isActive : true
      },
      { new: true }
    );

    if (!incentive) {
      return res.status(404).json({
        success: false,
        error: 'Incentive not found'
      });
    }

    res.json({
      success: true,
      data: incentive
    });
  } catch (error) {
    console.error('❌ Error updating incentive:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update incentive'
    });
  }
});

/**
 * DELETE /api/admin/incentives/timing/:date
 * Deactivate timing slot incentives
 */
router.delete('/timing/:date', verifyAdminToken, async (req, res) => {
  try {
    const { date } = req.params;

    const incentive = await TimingSlotIncentive.findOneAndUpdate(
      { date },
      { isActive: false },
      { new: true }
    );

    if (!incentive) {
      return res.status(404).json({
        success: false,
        error: 'Incentive not found'
      });
    }

    res.json({
      success: true,
      data: incentive
    });
  } catch (error) {
    console.error('❌ Error deleting incentive:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete incentive'
    });
  }
});

/**
 * GET /api/admin/incentives/timing
 * Fetch all active timing slot incentives (for dashboard)
 */
router.get('/timing', verifyAdminToken, async (req, res) => {
  try {
    const incentives = await TimingSlotIncentive.find({ isActive: true })
      .sort({ date: -1 })
      .lean();

    res.json({
      success: true,
      data: incentives
    });
  } catch (error) {
    console.error('❌ Error fetching incentives:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch incentives'
    });
  }
});

export default router;
