// src/controllers/standbyController.js

import Standby from '../models/standby.js';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';
import { sendToDriver } from '../utils/fcmSender.js';

/**
 * ➕ Add standby drivers for a trip
 */
export const addToStandby = async (tripId, driverIds) => {
  try {
    await Standby.findOneAndUpdate(
      { tripId },
      { $set: { driverQueue: driverIds, currentIndex: 0 } },
      { upsert: true }
    );
    console.log(`📥 Standby queue created for trip ${tripId} with ${driverIds.length} drivers`);
  } catch (err) {
    console.error(`❌ Error in addToStandby:`, err.message);
  }
};

/**
 * 🔁 Promote next standby driver (called via cron or timeout)
 */
export const promoteNextStandby = async (tripId) => {
  try {
    console.log(`🔍 [DEBUG] promoteNextStandby called for trip: ${tripId}`);
    
    const standby = await Standby.findOne({ tripId });
    console.log(`🔍 [DEBUG] Standby record: ${standby ? JSON.stringify(standby) : 'Not found'}`);
    
    const trip = await Trip.findById(tripId);
    console.log(`🔍 [DEBUG] Trip record: ${trip ? 'Found' : 'Not found'}`);
    
    if (trip) {
      console.log(`🔍 [DEBUG] Trip status: ${trip.status}, Assigned driver: ${trip.assignedDriver || 'None'}`);
      console.log(`🔍 [DEBUG] Trip requested status: ${trip.status === 'requested' ? 'MATCHES' : 'DOES NOT MATCH'}`);
    }

    // 🚫 Safety checks with detailed logging
    if (!standby) {
      console.log(`⛔ No standby promotion: No standby record found for trip ${tripId}`);
      return;
    }
    
    if (!trip) {
      console.log(`⛔ No standby promotion: Trip ${tripId} not found`);
      return;
    }
    
    if (trip.status !== 'requested') {
      console.log(`⛔ No standby promotion: Trip status is '${trip.status}' but expected 'requested'`);
      return;
    }

    // 🚫 If already assigned, no need to promote
    if (trip.assignedDriver) {
      console.log(`🚫 Trip ${tripId} already assigned to driver ${trip.assignedDriver}`);
      return;
    }

    const nextDriverId = standby.driverQueue[standby.currentIndex];
    console.log(`🔍 [DEBUG] Next driver in queue: ${nextDriverId} (index: ${standby.currentIndex})`);
    
    if (!nextDriverId) {
      console.log(`⚠️ No more drivers in standby queue for trip ${tripId}`);
      return;
    }

    const driver = await User.findById(nextDriverId);
    console.log(`🔍 [DEBUG] Driver lookup: ${driver ? 'Found' : 'Not found'}`);
    
    if (!driver) {
      console.log(`❌ Driver not found: ${nextDriverId}`);
      return;
    }

    // 🚫 Avoid duplicate pending requests
    const isPending = trip.pendingDrivers?.includes(driver._id.toString());
    console.log(`🔍 [DEBUG] Driver pending status: ${isPending ? 'Already pending' : 'Not pending'}`);
    
    if (isPending) {
      console.log(`⚠️ Driver ${driver._id} already has a pending request for trip ${tripId}`);
      return;
    }

    const payload = {
      tripId: trip._id.toString(),
      pickup: trip.pickup || trip.pickupLocation,
      drop: trip.drop || trip.dropLocation,
      vehicleType: trip.vehicleType,
      type: trip.type,
    };

    console.log(`🔍 [DEBUG] Preparing to send request to driver ${driver._id}`);
    console.log(`🔍 [DEBUG] Driver socket: ${driver.socketId}, FCM token: ${driver.fcmToken ? 'Yes' : 'No'}`);

    // ✅ Send ride request to driver via socket or FCM
    if (driver.socketId) {
      io.to(driver.socketId).emit('trip:request', payload);
      console.log(`📡 Sent ride request to standby driver ${driver._id} via socket`);
    } else if (driver.fcmToken) {
      await sendToDriver(
        driver.fcmToken,
        'New Ride Request',
        'You have been promoted from standby queue.',
        payload
      );
      console.log(`📲 Sent ride request to standby driver ${driver._id} via FCM`);
    } else {
      console.log(`⚠️ Driver ${driver._id} has no socket or FCM token`);
    }

    // 📌 Mark driver as pending for this trip
    if (!trip.pendingDrivers) trip.pendingDrivers = [];
    trip.pendingDrivers.push(driver._id.toString());
    await trip.save();
    console.log(`✅ Added driver ${driver._id} to pending drivers list`);

    // ⏳ Increment index for next promotion
    standby.currentIndex += 1;
    await standby.save();

    console.log(`✅ Updated standby index to ${standby.currentIndex} for trip ${tripId}`);
    return driver._id; // Return the promoted driver ID for tracking
  } catch (err) {
    console.error(`❌ Error in promoteNextStandby:`, err.message);
    console.error(err.stack);
  }
};
// ============================================
// 🎫 DRIVER TICKET FUNCTIONS
// ============================================

/**
 * 🎫 CREATE DRIVER TICKET - WITH DUPLICATE PREVENTION
 */
export const createDriverTicket = async (req, res) => {
  try {
    const { driverId, issueType, message } = req.body;

    console.log('🎫 Creating driver ticket:', { driverId, issueType });

    // Basic validation
    if (!driverId || !issueType || !message) {
      return res.status(400).json({
        success: false,
        message: 'driverId, issueType, and message are required'
      });
    }

    // Validate driver exists
    const driver = await User.findById(driverId).select('name phone');
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    // ✅ FIXED: Map covers all Flutter dropdown values exactly
    const issueTypeMap = {
      // Flutter dropdown sends these exact strings:
      'App Issue':        'app_issue',
      'Payment Issue':    'payment_issue',
      'Trip Issue':       'trip_issue',
      'Account Issue':    'account_issue',
      'Documents Issue':  'documents_issue',
      'Safety Issue':     'safety_issue',
      'Other':            'other',
      // Legacy / alternate labels kept for safety:
      'Ride Issue':       'trip_issue',
      'Technical Issue':  'app_issue',
      'Wallet Issue':     'wallet_issue',
      'Commission Issue': 'commission_issue',
    };

    const normalizedIssueType =
      issueTypeMap[issueType] ||
      issueType.toLowerCase().replace(/\s+/g, '_');

    // ✅ DUPLICATE CHECK: active ticket for the same driver
    const existingTicket = await DriverTicket.findOne({
      driverId,
      status: { $in: ['pending', 'in_progress'] }
    }).sort({ createdAt: -1 });

    if (existingTicket) {
      // Strip '_issue' suffix for loose comparison
      const stripSuffix = (s) => s.replace(/_?issue/g, '').replace(/_/g, '').trim();

      if (stripSuffix(existingTicket.issueType) === stripSuffix(normalizedIssueType)) {
        return res.status(400).json({
          success: false,
          message: 'You already have an active ticket for this issue',
          existingTicket: {
            _id: existingTicket._id,
            issueType: existingTicket.issueType,
            createdAt: existingTicket.createdAt,
            status: existingTicket.status
          }
        });
      }
    }

    // ✅ FIXED: priority uses 'urgent' not 'critical' (matches schema enum)
    let priority = 'medium';
    if (['payment_issue', 'wallet_issue'].includes(normalizedIssueType)) {
      priority = 'high';
    } else if (['safety_issue'].includes(normalizedIssueType)) {
      priority = 'urgent';
    } else if (['app_issue', 'trip_issue'].includes(normalizedIssueType)) {
      priority = 'medium';
    } else {
      priority = 'low';
    }

    // Create ticket
    const ticket = await DriverTicket.create({
      driverId,
      driverName: driver.name,
      driverPhone: driver.phone,
      issueType: normalizedIssueType,
      message,
      priority,
      status: 'pending'
    });

    console.log(`✅ Driver ticket created: ${ticket._id}`);

    // Notify admin via socket
    if (io) {
      io.to('admin-room').emit('admin:driver_ticket', {
        ticket: {
          _id: ticket._id,
          driverId: ticket.driverId,
          driverName: ticket.driverName,
          driverPhone: ticket.driverPhone,
          issueType: ticket.issueType,
          message: ticket.message,
          priority: ticket.priority,
          status: ticket.status,
          createdAt: ticket.createdAt
        },
        timestamp: new Date().toISOString()
      });
      console.log('✅ Admin notified of new driver ticket');
    }

    res.json({
      success: true,
      message: 'Ticket submitted successfully. Our team will contact you soon.',
      ticketId: ticket._id
    });

  } catch (error) {
    console.error('❌ createDriverTicket error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ GET DRIVER'S ACTIVE TICKETS
 */
export const getDriverActiveTickets = async (req, res) => {
  try {
    const { driverId } = req.params;

    console.log('📋 Fetching active tickets for driver:', driverId);

    const tickets = await DriverTicket.find({
      driverId,
      status: { $in: ['pending', 'in_progress'] }
    })
      .select('_id issueType status priority createdAt')
      .sort({ createdAt: -1 })
      .lean();

    console.log(`✅ Found ${tickets.length} active tickets`);

    res.json({
      success: true,
      tickets
    });

  } catch (error) {
    console.error('❌ getDriverActiveTickets error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 📋 GET ALL DRIVER TICKETS (Admin)
 */
export const getDriverTickets = async (req, res) => {
  try {
    const { status } = req.query;

    console.log('📋 Fetching driver tickets, status filter:', status || 'active only');

    const query = status
      ? { status }
      : { status: { $in: ['pending', 'in_progress'] } };

    const tickets = await DriverTicket.find(query)
      .select('_id driverId driverName driverPhone issueType message priority status adminNotes resolvedAt createdAt')
      .sort({ priority: -1, createdAt: -1 })
      .lean();

    console.log(`✅ Found ${tickets.length} driver tickets`);

    res.json({
      success: true,
      count: tickets.length,
      tickets
    });

  } catch (error) {
    console.error('❌ getDriverTickets error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 💬 SEND MESSAGE TO DRIVER TICKET (Admin)
 */
export const sendDriverTicketMessage = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { message } = req.body;

    console.log('💬 Admin sending message to ticket:', ticketId);

    const ticket = await DriverTicket.findById(ticketId);

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Auto-move to in_progress when admin responds
    if (ticket.status === 'pending') {
      ticket.status = 'in_progress';
    }

    ticket.adminNotes = (ticket.adminNotes || '') +
      `\n[${new Date().toLocaleString('en-IN')}] ${message}`;
    await ticket.save();

    // Notify driver via socket if online
    const driver = await User.findById(ticket.driverId).select('socketId');
    if (driver?.socketId && io) {
      io.to(driver.socketId).emit('driver:ticket_message', {
        ticketId: ticket._id.toString(),
        message,
        timestamp: new Date().toISOString()
      });
    }

    res.json({ success: true, message: 'Message sent to driver' });

  } catch (error) {
    console.error('❌ sendDriverTicketMessage error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ RESOLVE DRIVER TICKET
 */
export const resolveDriverTicket = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { resolutionNotes } = req.body;

    console.log('✅ Resolving driver ticket:', ticketId);

    const ticket = await DriverTicket.findByIdAndUpdate(
      ticketId,
      {
        status: 'resolved',
        resolvedAt: new Date(),
        adminNotes: resolutionNotes
      },
      { new: true }
    );

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Notify driver via socket
    const driver = await User.findById(ticket.driverId).select('socketId');
    if (driver?.socketId && io) {
      io.to(driver.socketId).emit('driver:ticket_resolved', {
        ticketId: ticket._id.toString(),
        message: 'Your support ticket has been resolved by our team.',
        timestamp: new Date().toISOString()
      });
      console.log('✅ Driver notified via socket');
    }

    res.json({ success: true, message: 'Ticket resolved successfully' });

  } catch (error) {
    console.error('❌ resolveDriverTicket error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
/**
 * ♻️ Reassign trip to next standby driver if previous expired
 */
export const reassignStandbyDriver = async (trip) => {
  try {
    console.log(`🔁 Reassigning standby driver for trip: ${trip._id}`);
    const standby = await Standby.findOne({ tripId: trip._id });
    
    if (!standby) {
      console.log(`ℹ️ No standby found for trip ${trip._id}`);
      return;
    }

    await promoteNextStandby(trip._id);
  } catch (err) {
    console.error(`❌ Error in reassignStandbyDriver:`, err.message);
  }
};

/**
 * 🧹 Cleanup standby queue when trip is no longer active
 */
export const cleanupStandbyQueue = async (tripId) => {
  try {
    const result = await Standby.deleteOne({ tripId });
    if (result.deletedCount > 0) {
      console.log(`🧹 Cleaned standby queue for trip ${tripId}`);
    } else {
      console.log(`ℹ️ No standby queue to clean for trip ${tripId}`);
    }
  } catch (err) {
    console.error(`❌ Error cleaning standby queue:`, err.message);
  }
};

/**
 * 🔍 Get standby status for debugging
 */
export const getStandbyStatus = async (tripId) => {
  try {
    const standby = await Standby.findOne({ tripId });
    const trip = await Trip.findById(tripId);
    
    return {
      standby: standby ? {
        tripId: standby.tripId,
        driverQueue: standby.driverQueue,
        currentIndex: standby.currentIndex,
        queueLength: standby.driverQueue.length
      } : null,
      trip: trip ? {
        _id: trip._id,
        status: trip.status,
        assignedDriver: trip.assignedDriver,
        pendingDrivers: trip.pendingDrivers || []
      } : null
    };
  } catch (err) {
    console.error(`❌ Error getting standby status:`, err.message);
    return { error: err.message };
  }
};