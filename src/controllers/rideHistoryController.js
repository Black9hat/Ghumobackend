// controllers/rideHistoryController.js
import RideHistory from "../models/RideHistory.js";
import User from "../models/User.js";

// ✅ Manual save (if needed)
export const saveRideHistory = async (req, res) => {
  try {
    const { pickupLocation, dropLocation, vehicleType, fare, customerId } = req.body;
    
    // Get phone from customerId
    const user = await User.findById(customerId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const newRide = new RideHistory({
      phone: user.phone,
      customerId: user._id,
      pickupLocation,
      dropLocation,
      vehicleType,
      fare,
      status: 'Completed',
    });

    await newRide.save();
    console.log('✅ Ride history saved manually:', newRide._id);
    
    res.status(201).json({ 
      message: "Ride history saved successfully",
      rideHistory: newRide
    });
  } catch (error) {
    console.error('❌ Error saving ride history:', error);
    res.status(500).json({ message: "Error saving ride history", error: error.message });
  }
};

// ✅ Get ride history by customerId
export const getRideHistoryByCustomerId = async (req, res) => {
  try {
    const { customerId } = req.params;
    
    console.log('📥 Fetching ride history for customerId:', customerId);

    // Try to find by customerId
    let rideHistory = await RideHistory.find({ customerId })
      .sort({ dateTime: -1 })
      .lean();

    // If no results, try to find by phone
    if (!rideHistory || rideHistory.length === 0) {
      const user = await User.findById(customerId);
      
      if (user && user.phone) {
        console.log('🔄 Trying by phone:', user.phone);
        rideHistory = await RideHistory.find({ phone: user.phone })
          .sort({ dateTime: -1 })
          .lean();
      }
    }

    console.log(`✅ Found ${rideHistory.length} rides`);
    res.json(rideHistory);
  } catch (error) {
    console.error('❌ Error fetching ride history:', error);
    res.status(500).json({ message: "Error fetching history", error: error.message });
  }
};

// ✅ Get ride history by phone
export const getRideHistoryByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    
    console.log('📥 Fetching ride history for phone:', phone);

    const rideHistory = await RideHistory.find({ phone })
      .sort({ dateTime: -1 })
      .lean();

    console.log(`✅ Found ${rideHistory.length} rides`);
    res.json(rideHistory);
  } catch (error) {
    console.error('❌ Error fetching ride history:', error);
    res.status(500).json({ message: "Error fetching history", error: error.message });
  }
};

// ✅ Get recent rides (last 10)
export const getRecentRides = async (req, res) => {
  try {
    const { customerId } = req.params;
    
    const recentRides = await RideHistory.find({ customerId })
      .sort({ dateTime: -1 })
      .limit(10)
      .lean();

    res.json(recentRides);
  } catch (error) {
    console.error('❌ Error fetching recent rides:', error);
    res.status(500).json({ message: "Error fetching history", error: error.message });
  }
};

// ✅ Get all ride history (for debugging)
export const getAllRideHistory = async (req, res) => {
  try {
    const allRides = await RideHistory.find()
      .sort({ dateTime: -1 })
      .limit(100)
      .populate('customerId', 'name phone')
      .lean();

    console.log(`📊 Total rides in database: ${allRides.length}`);
    
    res.json({
      count: allRides.length,
      rides: allRides
    });
  } catch (error) {
    console.error('❌ Error fetching all rides:', error);
    res.status(500).json({ message: "Error fetching history", error: error.message });
  }
};

// ✅ Delete ride history (optional)
export const deleteRideHistory = async (req, res) => {
  try {
    const { rideId } = req.params;
    
    await RideHistory.findByIdAndDelete(rideId);
    
    res.json({ message: 'Ride history deleted successfully' });
  } catch (error) {
    console.error('❌ Error deleting ride history:', error);
    res.status(500).json({ message: "Error deleting history", error: error.message });
  }
};