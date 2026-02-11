// walletController.js - SECURE UPI PAYMENT WITH RAZORPAY + DRIVER INCENTIVES
// ⚠️ CUSTOMER COINS ARE AWARDED ONLY IN tripController.js - NOT HERE!

import mongoose from 'mongoose';
import Wallet from '../models/Wallet.js';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
// ❌ REMOVED: import Reward from '../models/Reward.js';
// ❌ REMOVED: import RewardSettings from '../models/RewardSettings.js';
import { io } from '../socket/socketHandler.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import axios from 'axios';

// ✅ Initialize Razorpay with enhanced security
const initializeRazorpay = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    console.error('🔥 RAZORPAY CREDENTIALS MISSING');
    console.error('Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
    throw new Error('Razorpay credentials not configured');
  }

  if (!keyId.startsWith('rzp_test_') && !keyId.startsWith('rzp_live_')) {
    console.warn('⚠️  Warning: Razorpay Key ID format incorrect');
  }

  console.log('✅ Razorpay initialized:', keyId.substring(0, 12) + '...');

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

let razorpay;
try {
  razorpay = initializeRazorpay();
} catch (error) {
  console.error('Failed to initialize Razorpay:', error.message);
}

// Configuration
const COMMISSION_PERCENTAGE = 15;
const PAISA_MULTIPLIER = 100;
const MAX_PAYMENT_AMOUNT = 100000;
const MIN_PAYMENT_AMOUNT = 1;

const toPaisa = (rupees) => Math.round(rupees * PAISA_MULTIPLIER);
const toRupees = (paisa) => paisa / PAISA_MULTIPLIER;

const paymentProcessing = new Map();

const calculateFareBreakdown = (tripFare) => {
  const tripFareInPaisa = toPaisa(tripFare);
  const commissionInPaisa = Math.round((tripFareInPaisa * COMMISSION_PERCENTAGE) / 100);
  const driverEarningInPaisa = tripFareInPaisa - commissionInPaisa;

  return {
    tripFare: toRupees(tripFareInPaisa),
    commission: toRupees(commissionInPaisa),
    driverEarning: toRupees(driverEarningInPaisa),
    commissionPercentage: COMMISSION_PERCENTAGE
  };
};

const calculateWalletBalance = (transactions) => {
  let totalEarnings = 0;
  let totalCommission = 0;
  let pendingAmount = 0;
  let availableBalance = 0;

  transactions.forEach(t => {
    if (t.status !== 'completed') return;

    if (t.type === 'credit') {
      totalEarnings += t.amount;
      availableBalance += t.amount;
    } else if (t.type === 'commission') {
      totalCommission += t.amount;
      pendingAmount += t.amount;
    } else if (t.type === 'debit') {
      pendingAmount -= t.amount;
    }
  });

  return {
    totalEarnings: Number(totalEarnings.toFixed(2)),
    totalCommission: Number(totalCommission.toFixed(2)),
    pendingAmount: Math.max(0, Number(pendingAmount.toFixed(2))),
    availableBalance: Number(availableBalance.toFixed(2))
  };
};

const getOrCreateWallet = async (driverId, session = null) => {
  const wallet = await Wallet.findOneAndUpdate(
    { driverId },
    {
      $setOnInsert: {
        driverId,
        totalEarnings: 0,
        totalCommission: 0,
        pendingAmount: 0,
        availableBalance: 0,
        transactions: []
      }
    },
    { 
      upsert: true, 
      new: true,
      session 
    }
  );
  
  return wallet;
};

const addRideIncentive = async (userId, tripId) => {
  try {
    const baseUrl = process.env.API_BASE_URL || 'https://chauncey-unpercolated-roastingly.ngrok-free.dev';
    
    console.log('📞 Calling incentive API:', {
      url: `${baseUrl}/api/incentives/add-ride-incentive`,
      userId,
      tripId
    });
    
    const response = await axios.post(
      `${baseUrl}/api/incentives/add-ride-incentive`, 
      {
        userId,
        tripId
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    if (response.data.success) {
      console.log('✅ Ride incentive added:', response.data.data);
      return response.data.data;
    } else {
      console.error('❌ Incentive API returned error:', response.data);
      return null;
    }
  } catch (error) {
    console.error('❌ Error adding ride incentive:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      url: error.config?.url
    });
    return null;
  }
};

// ❌ REMOVED: awardCustomerCoins function
// Customer coins are now ONLY awarded in tripController.js -> confirmCashCollection()

const createRazorpayOrder = async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({
        success: false,
        message: 'Payment service temporarily unavailable',
        errorCode: 'SERVICE_UNAVAILABLE'
      });
    }

    const { driverId, amount } = req.body;

    if (!driverId || !mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID'
      });
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount'
      });
    }

    if (amount < MIN_PAYMENT_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Minimum payment amount is ₹${MIN_PAYMENT_AMOUNT}`
      });
    }

    if (amount > MAX_PAYMENT_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Maximum payment amount is ₹${MAX_PAYMENT_AMOUNT}`
      });
    }

    const driver = await User.findById(driverId).select('_id role');
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    if (amount > wallet.pendingAmount + 0.01) {
      return res.status(400).json({
        success: false,
        message: `Amount exceeds pending commission (₹${wallet.pendingAmount.toFixed(2)})`
      });
    }

    const timestamp = Date.now().toString().slice(-10);
    const driverIdShort = driverId.toString().slice(-8);
    const receipt = `rcpt_${driverIdShort}_${timestamp}`;
    
    const options = {
      amount: toPaisa(amount),
      currency: 'INR',
      receipt: receipt,
      notes: {
        driverId: driverId.toString(),
        purpose: 'commission_payment',
        timestamp: new Date().toISOString()
      },
      payment_capture: 1
    };

    console.log('Creating Razorpay order:', {
      receipt,
      amount: `${options.amount} paise (₹${amount})`,
      driverId
    });

    const order = await razorpay.orders.create(options);

    console.log('✅ Order created:', order.id);

    await Wallet.findOneAndUpdate(
      { driverId },
      {
        $push: {
          transactions: {
            type: 'debit',
            amount: amount,
            description: `Payment order created - ${order.id}`,
            razorpayOrderId: order.id,
            status: 'pending',
            createdAt: new Date()
          }
        }
      }
    );

    res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      message: 'Order created successfully'
    });

  } catch (err) {
    console.error('🔥 createRazorpayOrder error:', err);
    
    let message = 'Failed to create order';
    let errorCode = 'ORDER_CREATION_FAILED';
    let statusCode = 500;

    if (err.statusCode === 401) {
      message = 'Payment gateway authentication failed';
      errorCode = 'AUTH_FAILED';
      statusCode = 503;
    } else if (err.statusCode === 400) {
      message = err.error?.description || 'Invalid order parameters';
      errorCode = 'INVALID_REQUEST';
      statusCode = 400;
    } else if (err.error?.code) {
      message = err.error.description || message;
      errorCode = err.error.code;
    }

    res.status(statusCode).json({ 
      success: false, 
      message,
      errorCode
    });
  }
};

const verifyRazorpayPayment = async (req, res) => {
  let session = null;

  try {
    if (!razorpay) {
      return res.status(503).json({
        success: false,
        message: 'Payment verification service unavailable',
        errorCode: 'SERVICE_UNAVAILABLE'
      });
    }

    const { driverId, paymentId, orderId, signature } = req.body;

    if (!driverId || !paymentId || !orderId || !signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing required payment details'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID'
      });
    }

    const processingKey = `${driverId}-${paymentId}`;
    if (paymentProcessing.has(processingKey)) {
      console.log('⚠️  Payment already being processed:', paymentId);
      return res.status(409).json({
        success: false,
        message: 'Payment is already being processed',
        errorCode: 'DUPLICATE_PROCESSING'
      });
    }

    paymentProcessing.set(processingKey, Date.now());

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const generatedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (generatedSignature !== signature) {
      paymentProcessing.delete(processingKey);
      console.error('❌ SIGNATURE MISMATCH - POSSIBLE FRAUD ATTEMPT');
      
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed - invalid signature',
        errorCode: 'SIGNATURE_MISMATCH'
      });
    }

    console.log('✅ Signature verified successfully');

    const payment = await razorpay.payments.fetch(paymentId);

    console.log('Payment status:', payment.status);
    console.log('Payment amount:', payment.amount, 'paise');

    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      paymentProcessing.delete(processingKey);
      return res.status(400).json({
        success: false,
        message: `Payment not completed. Status: ${payment.status}`,
        errorCode: 'PAYMENT_NOT_CAPTURED'
      });
    }

    if (payment.order_id !== orderId) {
      paymentProcessing.delete(processingKey);
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed - order mismatch',
        errorCode: 'ORDER_MISMATCH'
      });
    }

    const amount = toRupees(payment.amount);

    const existingTransaction = await Wallet.findOne({
      driverId,
      'transactions.razorpayPaymentId': paymentId
    });

    if (existingTransaction) {
      const existingTxn = existingTransaction.transactions.find(
        t => t.razorpayPaymentId === paymentId && t.status === 'completed'
      );
      
      if (existingTxn) {
        paymentProcessing.delete(processingKey);
        
        const balances = calculateWalletBalance(existingTransaction.transactions);
        
        return res.status(200).json({
          success: true,
          message: 'Payment already processed',
          wallet: balances
        });
      }
    }

    session = await mongoose.startSession();
    session.startTransaction();

    const wallet = await Wallet.findOne({ driverId }).session(session);
    
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    if (amount > wallet.pendingAmount + 0.01) {
      throw new Error(`Amount (₹${amount}) exceeds pending commission (₹${wallet.pendingAmount.toFixed(2)})`);
    }

    const updatedWallet = await Wallet.findOneAndUpdate(
      { driverId },
      {
        $inc: { 
          pendingAmount: -amount 
        },
        $push: {
          transactions: {
            type: 'debit',
            amount: Number(amount.toFixed(2)),
            description: `Commission paid via ${payment.method?.toUpperCase() || 'Razorpay'} (${paymentId.substring(0, 15)}...)`,
            razorpayPaymentId: paymentId,
            razorpayOrderId: orderId,
            status: 'completed',
            paymentMethod: payment.method || 'unknown',
            createdAt: new Date()
          }
        },
        $set: {
          lastUpdated: new Date()
        }
      },
      { new: true, session }
    );

    await session.commitTransaction();

    paymentProcessing.delete(processingKey);

    const balances = calculateWalletBalance(updatedWallet.transactions);

    console.log('');
    console.log('='.repeat(70));
    console.log('💳 PAYMENT VERIFIED & PROCESSED');
    console.log(`   Payment ID: ${paymentId}`);
    console.log(`   Driver ID: ${driverId}`);
    console.log(`   Amount: ₹${amount}`);
    console.log('='.repeat(70));

    const driver = await User.findById(driverId).select('socketId').lean();
    if (driver?.socketId) {
      io.to(driver.socketId).emit('wallet:updated', {
        wallet: balances,
        message: 'Commission payment successful',
        paymentId: paymentId
      });
    }

    res.status(200).json({
      success: true,
      message: 'Payment verified and commission cleared',
      wallet: balances,
      paymentDetails: {
        paymentId: paymentId,
        amount: amount,
        method: payment.method || 'unknown',
        timestamp: new Date().toISOString()
      }
    });

  } catch (err) {
    if (session && session.inTransaction()) {
      await session.abortTransaction();
    }

    if (req.body.driverId && req.body.paymentId) {
      paymentProcessing.delete(`${req.body.driverId}-${req.body.paymentId}`);
    }

    console.error('🔥 verifyRazorpayPayment error:', err);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        message: 'Payment verification failed',
        error: err.message,
        errorCode: 'VERIFICATION_FAILED'
      });
    }
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

const getWalletByDriverId = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID format'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    const balances = calculateWalletBalance(wallet.transactions);

    const recentTransactions = wallet.transactions
      .filter(t => !t.status || t.status === 'completed')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20);

    res.status(200).json({
      success: true,
      wallet: balances,
      recentTransactions,
    });
  } catch (err) {
    console.error('🔥 getWalletByDriverId error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch wallet data',
      error: err.message 
    });
  }
};

const getPaymentProofs = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID'
      });
    }

    const wallet = await Wallet.findOne({ driverId });
    
    if (!wallet) {
      return res.status(200).json({
        success: true,
        proofs: []
      });
    }

    const proofs = wallet.transactions
      .filter(t => t.status === 'pending' && t.razorpayPaymentId)
      .map(t => ({
        amount: t.amount,
        razorpayPaymentId: t.razorpayPaymentId,
        razorpayOrderId: t.razorpayOrderId,
        status: 'pending',
        submittedAt: t.createdAt
      }));

    res.status(200).json({
      success: true,
      proofs
    });

  } catch (err) {
    console.error('🔥 getPaymentProofs error:', err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

/**
 * ✅ FIXED: Process cash collection - ONLY handles wallet/payment
 * ⚠️ CUSTOMER COINS ARE NOT AWARDED HERE - handled by tripController.js
 */
const processCashCollection = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tripId, driverId } = req.body;

    console.log('');
    console.log('💳 ═══════════════════════════════════════════════════════════════');
    console.log('💳 WALLET: processCashCollection');
    console.log('💳 ⚠️ NOTE: This function does NOT award customer coins!');
    console.log('💳 ⚠️ Customer coins are awarded in tripController.js');
    console.log('💳 ═══════════════════════════════════════════════════════════════');
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Driver ID: ${driverId}`);

    if (!mongoose.Types.ObjectId.isValid(tripId) || !mongoose.Types.ObjectId.isValid(driverId)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Invalid trip ID or driver ID format'
      });
    }

    // Get trip (NO need to populate customer for coins - that's handled elsewhere)
    const trip = await Trip.findById(tripId)
      .populate('customerId', 'phone name socketId')
      .session(session);

    if (!trip) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.assignedDriver?.toString() !== driverId) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (trip.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Trip must be completed before collecting cash'
      });
    }

    if (trip.paymentCollected) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Cash already collected for this trip'
      });
    }

    const tripFare = trip.fare || trip.finalFare || 0;

    if (tripFare <= 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Invalid trip fare amount'
      });
    }

    const fareBreakdown = calculateFareBreakdown(tripFare);

    // Update driver wallet
    const wallet = await Wallet.findOneAndUpdate(
      { driverId },
      {
        $inc: {
          totalEarnings: fareBreakdown.driverEarning,
          totalCommission: fareBreakdown.commission,
          pendingAmount: fareBreakdown.commission,
          availableBalance: fareBreakdown.driverEarning
        },
        $push: {
          transactions: {
            $each: [
              {
                type: 'credit',
                amount: fareBreakdown.driverEarning,
                tripId: trip._id,
                description: `Trip earning from ${trip.pickup.address?.substring(0, 30) || 'customer'}`,
                status: 'completed',
                createdAt: new Date()
              },
              {
                type: 'commission',
                amount: fareBreakdown.commission,
                tripId: trip._id,
                description: `Platform commission (${COMMISSION_PERCENTAGE}%)`,
                status: 'completed',
                createdAt: new Date()
              }
            ]
          }
        }
      },
      { 
        new: true, 
        upsert: true,
        session 
      }
    );

    // Update trip payment status
    trip.paymentCollected = true;
    trip.paymentCollectedAt = new Date();
    await trip.save({ session });

    // Free driver for next trip
    await User.findByIdAndUpdate(
      driverId,
      {
        $set: { 
          currentTripId: null,
          isBusy: false,
          canReceiveNewRequests: false,
          awaitingCashCollection: false,
          lastCashCollectedAt: new Date()
        }
      },
      { session }
    );

    await session.commitTransaction();

    console.log('');
    console.log('✅ WALLET TRANSACTION COMPLETE');
    console.log(`   Fare: ₹${tripFare}`);
    console.log(`   Driver Earning: ₹${fareBreakdown.driverEarning}`);
    console.log(`   Commission: ₹${fareBreakdown.commission}`);

    // ❌ REMOVED: Customer coin awarding
    // ❌ REMOVED: awardCustomerCoins() call
    // ✅ Customer coins are awarded ONLY in tripController.js -> confirmCashCollection()

    // Add DRIVER incentive (non-blocking)
    addRideIncentive(driverId, tripId)
      .then((incentiveData) => {
        if (incentiveData) {
          console.log('💎 Per-ride incentive added:', incentiveData);
        }
      })
      .catch(err => {
        console.error('⚠️ Error adding driver incentive:', err);
      });

    // Recalculate accurate balances
    const balances = calculateWalletBalance(wallet.transactions);

    // Socket notifications
    const driver = await User.findById(driverId).select('socketId').lean();
    const customer = trip.customerId;

    if (driver?.socketId) {
      io.to(driver.socketId).emit('wallet:updated', {
        fareBreakdown: {
          tripFare: Number(fareBreakdown.tripFare.toFixed(2)),
          commission: Number(fareBreakdown.commission.toFixed(2)),
          commissionPercentage: fareBreakdown.commissionPercentage,
          driverEarning: Number(fareBreakdown.driverEarning.toFixed(2))
        },
        wallet: balances,
        message: 'Cash collected successfully',
      });
    }

    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:cash_collected', {
        tripId: tripId.toString(),
        message: 'Payment confirmed. Thank you for riding with us!',
        timestamp: new Date().toISOString()
      });
    }

    console.log('💳 ═══════════════════════════════════════════════════════════════');
    console.log('');

    // ❌ REMOVED: coinReward from response - it's handled by tripController
    res.status(200).json({
      success: true,
      message: 'Cash collection confirmed',
      fareBreakdown: {
        tripFare: Number(fareBreakdown.tripFare.toFixed(2)),
        commission: Number(fareBreakdown.commission.toFixed(2)),
        commissionPercentage: fareBreakdown.commissionPercentage,
        driverEarning: Number(fareBreakdown.driverEarning.toFixed(2))
      },
      wallet: balances
      // ❌ REMOVED: coinReward - coins are awarded by tripController.js
    });

  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('🔥 processCashCollection error:', err);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to process cash collection',
        error: err.message 
      });
    }
  } finally {
    session.endSession();
  }
};

const getTodayEarnings = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID format'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const todayTransactions = wallet.transactions.filter(t => {
      const transactionDate = new Date(t.createdAt);
      return transactionDate >= startOfDay && 
             transactionDate <= endOfDay &&
             (!t.status || t.status === 'completed');
    });

    let totalFares = 0;
    let totalCommission = 0;
    let tripsCompleted = 0;
    const tripIds = new Set();

    todayTransactions.forEach(transaction => {
      if (transaction.type === 'credit') {
        totalFares += transaction.amount;
        if (transaction.tripId && !tripIds.has(transaction.tripId.toString())) {
          tripIds.add(transaction.tripId.toString());
          tripsCompleted++;
        }
      } else if (transaction.type === 'commission') {
        totalCommission += transaction.amount;
      }
    });

    const netEarnings = totalFares;

    const todayTripsCount = await Trip.countDocuments({
      assignedDriver: driverId,
      status: 'completed',
      $or: [
        { completedAt: { $gte: startOfDay, $lte: endOfDay } },
        { rideEndTime: { $gte: startOfDay, $lte: endOfDay } }
      ]
    });

    const finalTripsCount = Math.max(tripsCompleted, todayTripsCount);

    res.status(200).json({
      success: true,
      todayStats: {
        totalFares: Number(totalFares.toFixed(2)),
        totalCommission: Number(totalCommission.toFixed(2)),
        netEarnings: Number(netEarnings.toFixed(2)),
        tripsCompleted: finalTripsCount,
        date: new Date().toISOString().split('T')[0],
        breakdown: {
          commissionPercentage: COMMISSION_PERCENTAGE,
          averagePerTrip: finalTripsCount > 0 
            ? Number((totalFares / finalTripsCount).toFixed(2)) 
            : 0
        }
      }
    });
  } catch (err) {
    console.error('🔥 getTodayEarnings error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch today\'s earnings',
      error: err.message 
    });
  }
};

// Cleanup old processing entries
setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000;
  
  for (const [key, timestamp] of paymentProcessing.entries()) {
    if (now - timestamp > timeout) {
      paymentProcessing.delete(key);
      console.log('🧹 Cleaned up stale payment processing entry:', key);
    }
  }
}, 5 * 60 * 1000);

export {
  getWalletByDriverId,
  processCashCollection,
  getTodayEarnings,
  createRazorpayOrder,
  verifyRazorpayPayment,
  getPaymentProofs,
  getOrCreateWallet,
};