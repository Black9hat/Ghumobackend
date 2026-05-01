// routes/rideHistory.js
import express from 'express';
import RideHistory from '../models/RideHistory.js';
import User from '../models/User.js';

const router = express.Router();

// ✅ Get all ride history for a customer
router.get('/api/ride-history/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    // Find user by customerId to get phone number
    const user = await User.findById(customerId);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get all ride history for this phone number
    const rideHistory = await RideHistory.find({ phone: user.phone })
      .sort({ dateTime: -1 }); // Most recent first

    res.json(rideHistory);
  } catch (error) {
    console.error('Error fetching ride history:', error);
    res.status(500).json({ message: 'Error fetching ride history', error });
  }
});

// ✅ Get ride history by phone (alternative)
router.get('/api/ride-history/phone/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    const rideHistory = await RideHistory.find({ phone })
      .sort({ dateTime: -1 });

    res.json(rideHistory);
  } catch (error) {
    console.error('Error fetching ride history:', error);
    res.status(500).json({ message: 'Error fetching ride history', error });
  }
});

export default router;