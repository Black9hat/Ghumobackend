// controllers/driverRideHistoryController.js
import Trip from '../models/Trip.js';
import Driver from '../models/User.js';

/**
 * Get ride history for a driver with fare breakdown
 * GET /api/driver/ride-history/:driverId
 * Query params: 
 *   - includeUnpaid=true (optional, includes trips where payment not yet collected)
 */
export const getDriverRideHistory = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { includeUnpaid } = req.query;
    
    console.log('📊 Fetching ride history for driver:', driverId);
    console.log('   Include unpaid:', includeUnpaid === 'true');

    // Build query - show completed trips
    const query = {
      assignedDriver: driverId,
      status: 'completed',
    };

    // ✅ Optional: Only show paid trips (default behavior)
    if (includeUnpaid !== 'true') {
      query.paymentCollected = true;
    }

    const trips = await Trip.find(query)
      .populate('customerId', 'name phone photoUrl')
      .sort({ completedAt: -1 })
      .lean();

    console.log(`✅ Found ${trips.length} completed trips`);

    // Calculate commission for each trip
    const ridesWithBreakdown = trips.map(trip => {
      const fare = trip.fare || 0;
      const commissionPercentage = trip.commissionPercentage || 15;
      const commission = (fare * commissionPercentage) / 100;
      const driverEarning = fare - commission;

      return {
        tripId: trip._id,
        pickup: trip.pickup,
        drop: trip.drop,
        fare: fare,
        commission: commission,
        commissionPercentage: commissionPercentage,
        driverEarning: driverEarning,
        paymentCollected: trip.paymentCollected || false,
        paymentMethod: trip.paymentMethod || 'Cash',
        customer: trip.customerId ? {
          id: trip.customerId._id,
          name: trip.customerId.name,
          phone: trip.customerId.phone,
          photoUrl: trip.customerId.photoUrl,
        } : null,
        vehicleType: trip.vehicleType,
        distance: trip.distance,
        duration: trip.duration,
        rideCode: trip.rideCode,
        completedAt: trip.completedAt || trip.updatedAt,
        createdAt: trip.createdAt,
      };
    });

    // Calculate summary statistics
    const summary = {
      totalRides: ridesWithBreakdown.length,
      totalFares: ridesWithBreakdown.reduce((sum, ride) => sum + ride.fare, 0),
      totalCommission: ridesWithBreakdown.reduce((sum, ride) => sum + ride.commission, 0),
      totalEarnings: ridesWithBreakdown.reduce((sum, ride) => sum + ride.driverEarning, 0),
      unpaidRides: ridesWithBreakdown.filter(r => !r.paymentCollected).length,
    };

    console.log('📈 Summary:', summary);

    res.json({
      success: true,
      rides: ridesWithBreakdown,
      summary: summary,
    });

  } catch (error) {
    console.error('❌ Error fetching driver ride history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ride history',
      error: error.message,
    });
  }
};

/**
 * Get ride history for a specific date range
 * GET /api/driver/ride-history/:driverId/range?startDate=...&endDate=...&includeUnpaid=true
 */
export const getDriverRideHistoryByDateRange = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { startDate, endDate, includeUnpaid } = req.query;
    
    console.log('📊 Fetching ride history for driver:', driverId);
    console.log('📅 Date range:', startDate, 'to', endDate);

    const query = {
      assignedDriver: driverId,
      status: 'completed',
    };

    // Optional: Only show paid trips
    if (includeUnpaid !== 'true') {
      query.paymentCollected = true;
    }

    // Add date range filter if provided
    if (startDate || endDate) {
      query.completedAt = {};
      if (startDate) query.completedAt.$gte = new Date(startDate);
      if (endDate) query.completedAt.$lte = new Date(endDate);
    }

    const trips = await Trip.find(query)
      .populate('customerId', 'name phone photoUrl')
      .sort({ completedAt: -1 })
      .lean();

    console.log(`✅ Found ${trips.length} trips in range`);

    // Process trips with fare breakdown
    const ridesWithBreakdown = trips.map(trip => {
      const fare = trip.fare || 0;
      const commissionPercentage = trip.commissionPercentage || 15;
      const commission = (fare * commissionPercentage) / 100;
      const driverEarning = fare - commission;

      return {
        tripId: trip._id,
        pickup: trip.pickup,
        drop: trip.drop,
        fare: fare,
        commission: commission,
        commissionPercentage: commissionPercentage,
        driverEarning: driverEarning,
        paymentCollected: trip.paymentCollected || false,
        customer: trip.customerId ? {
          id: trip.customerId._id,
          name: trip.customerId.name,
          phone: trip.customerId.phone,
          photoUrl: trip.customerId.photoUrl,
        } : null,
        vehicleType: trip.vehicleType,
        distance: trip.distance,
        duration: trip.duration,
        rideCode: trip.rideCode,
        completedAt: trip.completedAt || trip.updatedAt,
        createdAt: trip.createdAt,
      };
    });

    // Calculate summary
    const summary = {
      totalRides: ridesWithBreakdown.length,
      totalFares: ridesWithBreakdown.reduce((sum, ride) => sum + ride.fare, 0),
      totalCommission: ridesWithBreakdown.reduce((sum, ride) => sum + ride.commission, 0),
      totalEarnings: ridesWithBreakdown.reduce((sum, ride) => sum + ride.driverEarning, 0),
    };

    res.json({
      success: true,
      rides: ridesWithBreakdown,
      summary: summary,
      dateRange: { startDate, endDate },
    });

  } catch (error) {
    console.error('❌ Error fetching ride history by date range:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ride history',
      error: error.message,
    });
  }
};

/**
 * Get monthly earnings breakdown
 * GET /api/driver/ride-history/:driverId/monthly?year=2025&month=1&includeUnpaid=true
 */
export const getDriverMonthlyEarnings = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { year, month, includeUnpaid } = req.query;
    
    const currentYear = year ? parseInt(year) : new Date().getFullYear();
    const currentMonth = month ? parseInt(month) : new Date().getMonth() + 1;
    
    console.log(`📊 Fetching monthly earnings for ${currentMonth}/${currentYear}`);

    // Calculate start and end of month
    const startDate = new Date(currentYear, currentMonth - 1, 1);
    const endDate = new Date(currentYear, currentMonth, 0, 23, 59, 59);

    const query = {
      assignedDriver: driverId,
      status: 'completed',
      completedAt: {
        $gte: startDate,
        $lte: endDate,
      },
    };

    // Optional: Only show paid trips
    if (includeUnpaid !== 'true') {
      query.paymentCollected = true;
    }

    const trips = await Trip.find(query)
      .sort({ completedAt: -1 })
      .lean();

    console.log(`✅ Found ${trips.length} trips in ${currentMonth}/${currentYear}`);

    // Group by day
    const dailyEarnings = {};
    
    trips.forEach(trip => {
      const day = new Date(trip.completedAt).getDate();
      const fare = trip.fare || 0;
      const commissionPercentage = trip.commissionPercentage || 15;
      const commission = (fare * commissionPercentage) / 100;
      const earning = fare - commission;

      if (!dailyEarnings[day]) {
        dailyEarnings[day] = {
          day: day,
          rides: 0,
          totalFares: 0,
          totalCommission: 0,
          totalEarnings: 0,
        };
      }

      dailyEarnings[day].rides++;
      dailyEarnings[day].totalFares += fare;
      dailyEarnings[day].totalCommission += commission;
      dailyEarnings[day].totalEarnings += earning;
    });

    // Convert to array and sort
    const dailyBreakdown = Object.values(dailyEarnings).sort((a, b) => a.day - b.day);

    // Calculate monthly totals
    const monthlyTotal = {
      totalRides: trips.length,
      totalFares: trips.reduce((sum, trip) => sum + (trip.fare || 0), 0),
      totalCommission: trips.reduce((sum, trip) => {
        const fare = trip.fare || 0;
        const commissionPercentage = trip.commissionPercentage || 15;
        return sum + ((fare * commissionPercentage) / 100);
      }, 0),
      totalEarnings: 0,
    };
    monthlyTotal.totalEarnings = monthlyTotal.totalFares - monthlyTotal.totalCommission;

    res.json({
      success: true,
      year: currentYear,
      month: currentMonth,
      monthlyTotal: monthlyTotal,
      dailyBreakdown: dailyBreakdown,
    });

  } catch (error) {
    console.error('❌ Error fetching monthly earnings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to monthly earnings',
      error: error.message,
    });
  }
};

// Export all functions
export default {
  getDriverRideHistory,
  getDriverRideHistoryByDateRange,
  getDriverMonthlyEarnings,
};