// controllers/walletController.js - COMPLETE FIXED WALLET CONTROLLER
import Wallet from '../models/Wallet.js';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════
// SOCKET.IO - Safe access via req.io (set in server.js middleware)
// ═══════════════════════════════════════════════════════════════════

/**
 * Safe emit to socket - uses req.io if available, won't crash if not
 */
const safeEmit = (reqIo, room, event, data) => {
  try {
    if (reqIo) {
      reqIo.to(room).emit(event, data);
      console.log(`📡 Socket emit: ${event} to ${room}`);
    } else {
      console.log(`⚠️ Socket not available, skipped emit: ${event} to ${room}`);
    }
  } catch (err) {
    console.warn('⚠️ Socket emit failed:', err.message);
  }
};

// ═══════════════════════════════════════════════════════════════════
// RAZORPAY INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

let razorpay = null;

try {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (keyId && keySecret) {
    razorpay = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
    console.log('✅ Razorpay initialized successfully');
  } else {
    console.warn('⚠️ Razorpay credentials missing - payment features disabled');
  }
} catch (error) {
  console.error('❌ Failed to initialize Razorpay:', error.message);
}

// ═══════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════

const toPaisa = (rupees) => Math.round(rupees * 100);

/**
 * Get or create wallet for a driver
 */
const getOrCreateWallet = async (driverId) => {
  let wallet = await Wallet.findOne({ driverId });

  if (!wallet) {
    wallet = new Wallet({
      driverId,
      availableBalance: 0,
      balance: 0,
      totalEarnings: 0,
      totalCommission: 0,
      pendingAmount: 0,
      transactions: []
    });
    await wallet.save();
    console.log(`💰 Created new wallet for driver: ${driverId}`);
  }

  return wallet;
};

// ═══════════════════════════════════════════════════════════════════
// DRIVER CONTROLLERS
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/wallet/:driverId
 */
export const getWalletByDriverId = async (req, res) => {
  try {
    const { driverId } = req.params;
    console.log(`📋 Getting wallet for driver: ${driverId}`);

    let wallet = await Wallet.findOne({ driverId })
      .populate('driverId', 'name phone vehicleType email')
      .lean();

    if (!wallet) {
      await getOrCreateWallet(driverId);
      wallet = await Wallet.findOne({ driverId })
        .populate('driverId', 'name phone vehicleType email')
        .lean();
    }

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found and could not be created'
      });
    }

    res.json({ success: true, wallet });
  } catch (error) {
    console.error('❌ Error fetching wallet:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching wallet',
      error: error.message
    });
  }
};

/**
 * GET /api/wallet/today/:driverId
 */
export const getTodayEarnings = async (req, res) => {
  try {
    const { driverId } = req.params;
    console.log(`📋 Getting today earnings for driver: ${driverId}`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const wallet = await Wallet.findOne({ driverId });
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found'
      });
    }

    const todayTransactions = wallet.transactions.filter(t => {
      const txnDate = new Date(t.createdAt);
      txnDate.setHours(0, 0, 0, 0);
      return txnDate.getTime() === today.getTime() && t.type === 'credit';
    });

    const todayEarnings = todayTransactions.reduce(
      (sum, t) => sum + (t.amount || 0), 0
    );

    res.json({
      success: true,
      todayEarnings,
      transactionCount: todayTransactions.length,
      transactions: todayTransactions
    });
  } catch (error) {
    console.error('❌ Error fetching today earnings:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching today earnings',
      error: error.message
    });
  }
};

/**
 * GET /api/wallet/payment-proof/:driverId
 */
export const getPaymentProofs = async (req, res) => {
  try {
    const { driverId } = req.params;
    console.log(`📋 Getting payment proofs for driver: ${driverId}`);

    const wallet = await Wallet.findOne({ driverId });
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found'
      });
    }

    const pendingPayments = wallet.transactions.filter(t =>
      t.status === 'pending' && (t.type === 'credit' || t.type === 'debit')
    );

    res.json({
      success: true,
      pendingPayments,
      totalPending: pendingPayments.reduce(
        (sum, p) => sum + (p.amount || 0), 0
      )
    });
  } catch (error) {
    console.error('❌ Error fetching payment proofs:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching payment proofs',
      error: error.message
    });
  }
};

/**
 * POST /api/wallet/collect-cash
 */
export const processCashCollection = async (req, res) => {
  try {
    const { tripId, amount, description } = req.body;
    console.log(`💵 Processing cash collection: trip=${tripId}, amount=${amount}`);

    if (!tripId || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Trip ID and amount are required'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({
        success: false,
        message: 'Trip not found'
      });
    }

    const driverId = trip.assignedDriver || trip.driverId;
    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'No driver assigned to this trip'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    const transaction = {
      tripId,
      type: 'credit',
      amount: parseFloat(amount),
      description: description || 'Cash collected from trip',
      status: 'completed',
      paymentMethod: 'cash',
      createdAt: new Date()
    };

    wallet.transactions.push(transaction);
    wallet.availableBalance += parseFloat(amount);
    wallet.totalEarnings += parseFloat(amount);
    await wallet.save();

    safeEmit(req.io, `driver_${driverId}`, 'wallet_updated', {
      availableBalance: wallet.availableBalance,
      transaction
    });

    console.log(`✅ Cash collected: ₹${amount} for driver ${driverId}`);

    res.json({
      success: true,
      message: 'Cash collected successfully',
      wallet: {
        availableBalance: wallet.availableBalance,
        totalEarnings: wallet.totalEarnings
      },
      transaction
    });
  } catch (error) {
    console.error('❌ Error collecting cash:', error);
    res.status(500).json({
      success: false,
      message: 'Error collecting cash',
      error: error.message
    });
  }
};

/**
 * POST /api/wallet/create-order
 */
export const createRazorpayOrder = async (req, res) => {
  try {
    const { driverId, amount, description } = req.body;
    console.log(`🔄 Creating Razorpay order: driver=${driverId}, amount=${amount}`);

    if (!razorpay) {
      return res.status(503).json({
        success: false,
        message: 'Payment service not configured. Contact admin.'
      });
    }

    if (!driverId || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Driver ID and amount are required'
      });
    }

    if (amount < 1 || amount > 100000) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be between ₹1 and ₹1,00,000'
      });
    }

    await getOrCreateWallet(driverId);

    const order = await razorpay.orders.create({
      amount: toPaisa(amount),
      currency: 'INR',
      receipt: `receipt_${driverId}_${Date.now()}`,
      description: description || 'Wallet payment',
      notes: { driverId }
    });

    console.log(`✅ Razorpay order created: ${order.id}`);

    res.json({
      success: true,
      order,
      key: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    console.error('❌ Error creating Razorpay order:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating order',
      error: error.message
    });
  }
};

/**
 * POST /api/wallet/verify-payment
 */
export const verifyRazorpayPayment = async (req, res) => {
  try {
    const {
      razorpayPaymentId, razorpayOrderId, razorpaySignature,
      amount, driverId
    } = req.body;

    console.log(`🔐 Verifying payment: ${razorpayPaymentId}`);

    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID, Order ID, and Signature are required'
      });
    }

    // Verify signature
    const body = razorpayOrderId + '|' + razorpayPaymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      console.error('❌ Payment signature mismatch');
      return res.status(400).json({
        success: false,
        message: 'Payment signature verification failed'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    // Check duplicate
    const exists = wallet.transactions.find(
      t => t.razorpayPaymentId === razorpayPaymentId
    );
    if (exists) {
      return res.status(409).json({
        success: false,
        message: 'Payment already processed'
      });
    }

    const transaction = {
      type: 'credit',
      amount: parseFloat(amount),
      description: 'Payment via UPI',
      razorpayPaymentId,
      razorpayOrderId,
      paymentMethod: 'upi',
      status: 'completed',
      createdAt: new Date()
    };

    wallet.transactions.push(transaction);
    wallet.availableBalance += parseFloat(amount);
    wallet.totalEarnings += parseFloat(amount);
    await wallet.save();

    safeEmit(req.io, `driver_${driverId}`, 'wallet_updated', {
      availableBalance: wallet.availableBalance,
      transaction
    });

    console.log(`✅ Payment verified: ₹${amount} for driver ${driverId}`);

    res.json({
      success: true,
      message: 'Payment verified successfully',
      wallet: {
        availableBalance: wallet.availableBalance,
        totalEarnings: wallet.totalEarnings
      },
      transaction
    });
  } catch (error) {
    console.error('❌ Error verifying payment:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying payment',
      error: error.message
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// ADMIN CONTROLLERS
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/wallet/admin/wallets
 * Fetch all driver wallets with filtering and pagination
 */
export const getAllWallets = async (req, res) => {
  try {
    const {
      status = 'all',
      page = 1,
      limit = 50,
      search = '',
      sortBy = 'date',
      order = 'desc'
    } = req.query;

    console.log('📊 Admin: Fetching all wallets', { status, page, limit, search });

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // ════════════════════════════════════════════════════════════════
    // BUILD DRIVER QUERY
    // ════════════════════════════════════════════════════════════════
    // Check what field your User model uses to identify drivers:
    //   - If role field:     { role: 'driver' }
    //   - If isDriver field: { isDriver: true }
    //   - If userType field: { userType: 'driver' }
    // ════════════════════════════════════════════════════════════════

    let driverQuery = {};

    // Try to detect which field identifies drivers
    const sampleUser = await User.findOne({
      $or: [
        { role: 'driver' },
        { isDriver: true },
        { userType: 'driver' }
      ]
    }).lean();

    if (sampleUser) {
      if (sampleUser.role === 'driver') {
        driverQuery.role = 'driver';
      } else if (sampleUser.isDriver === true) {
        driverQuery.isDriver = true;
      } else if (sampleUser.userType === 'driver') {
        driverQuery.userType = 'driver';
      }
      console.log('🔍 Driver query filter:', driverQuery);
    } else {
      // Fallback: try isDriver since your server.js cron uses it
      driverQuery.isDriver = true;
      console.log('⚠️ No sample driver found, using isDriver: true');
    }

    // Status filter
    if (status === 'active') {
      driverQuery.isOnline = true;
    } else if (status === 'inactive') {
      driverQuery.isOnline = false;
    }

    // Search filter
    if (search && search.trim() !== '') {
      const searchRegex = { $regex: search.trim(), $options: 'i' };
      driverQuery.$or = [
        { name: searchRegex },
        { phone: searchRegex },
        { email: searchRegex }
      ];
    }

    // Count and fetch drivers
    const totalDrivers = await User.countDocuments(driverQuery);
    console.log(`👥 Total drivers matching query: ${totalDrivers}`);

    const drivers = await User.find(driverQuery)
      .select('_id name phone vehicleType isOnline email isBlocked')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    console.log(`👥 Fetched ${drivers.length} drivers for page ${page}`);

    // Fetch wallets for these drivers
    const driverIds = drivers.map(d => d._id);
    const wallets = await Wallet.find({ driverId: { $in: driverIds } }).lean();

    console.log(`💰 Found ${wallets.length} wallets for ${driverIds.length} drivers`);

    // Build wallet map using string keys for reliable matching
    const walletMap = {};
    wallets.forEach(w => {
      walletMap[w.driverId.toString()] = w;
    });

    // Combine driver + wallet data
    const combinedData = drivers.map(driver => {
      const driverIdStr = driver._id.toString();
      const wallet = walletMap[driverIdStr];

      return {
        _id: driverIdStr,
        driverId: driverIdStr,
        name: driver.name || 'Unknown',
        phone: driver.phone || 'N/A',
        vehicleType: driver.vehicleType || 'Unknown',
        isOnline: driver.isOnline || false,
        email: driver.email || '',
        isBlocked: driver.isBlocked || false,
        wallet: wallet ? {
          _id: wallet._id.toString(),
          availableBalance: wallet.availableBalance || 0,
          balance: wallet.balance || 0,
          totalEarnings: wallet.totalEarnings || 0,
          totalCommission: wallet.totalCommission || 0,
          pendingAmount: wallet.pendingAmount || 0,
          transactions: (wallet.transactions || [])
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 10),
          lastUpdated: wallet.lastUpdated || wallet.updatedAt
        } : {
          _id: null,
          availableBalance: 0,
          balance: 0,
          totalEarnings: 0,
          totalCommission: 0,
          pendingAmount: 0,
          transactions: [],
          lastUpdated: null
        }
      };
    });

    // Calculate overall stats
    const allWallets = await Wallet.find()
      .select('availableBalance totalEarnings totalCommission pendingAmount')
      .lean();

    const stats = {
      totalDrivers,
      totalBalance: allWallets.reduce((sum, w) => sum + (w.availableBalance || 0), 0),
      totalEarnings: allWallets.reduce((sum, w) => sum + (w.totalEarnings || 0), 0),
      totalCommission: allWallets.reduce((sum, w) => sum + (w.totalCommission || 0), 0),
      pendingPayouts: allWallets.reduce((sum, w) => sum + (w.pendingAmount || 0), 0)
    };

    console.log('📈 Stats:', stats);
    console.log(`✅ Returning ${combinedData.length} wallet entries`);

    res.json({
      success: true,
      wallets: combinedData,
      total: totalDrivers,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(totalDrivers / parseInt(limit)),
      stats
    });

  } catch (error) {
    console.error('❌ Error fetching all wallets:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching wallets',
      error: error.message
    });
  }
};

/**
 * GET /api/wallet/admin/wallets/:driverId
 */
export const getWalletDetails = async (req, res) => {
  try {
    const { driverId } = req.params;
    console.log(`📋 Admin: Getting wallet details for driver: ${driverId}`);

    const driver = await User.findById(driverId)
      .select('_id name phone vehicleType isOnline email isBlocked')
      .lean();

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    let wallet = await Wallet.findOne({ driverId }).lean();

    if (!wallet) {
      await getOrCreateWallet(driverId);
      wallet = await Wallet.findOne({ driverId }).lean();
    }

    res.json({
      success: true,
      driver,
      wallet: wallet || {
        availableBalance: 0,
        totalEarnings: 0,
        totalCommission: 0,
        pendingAmount: 0,
        transactions: []
      }
    });
  } catch (error) {
    console.error('❌ Error fetching wallet details:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching wallet details',
      error: error.message
    });
  }
};

/**
 * GET /api/wallet/admin/wallets/:driverId/transactions
 */
export const getWalletTransactions = async (req, res) => {
  try {
    const { driverId } = req.params;
    const {
      type = 'all',
      status = 'all',
      page = 1,
      limit = 20,
      sortBy = 'date',
      order = 'desc'
    } = req.query;

    console.log(`📋 Admin: Getting transactions for driver: ${driverId}`);

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const wallet = await Wallet.findOne({ driverId });
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found'
      });
    }

    let transactions = [...wallet.transactions];

    // Filter
    if (type !== 'all') {
      transactions = transactions.filter(t => t.type === type);
    }
    if (status !== 'all') {
      transactions = transactions.filter(t => t.status === status);
    }

    const total = transactions.length;

    // Sort
    const mult = order === 'asc' ? 1 : -1;
    if (sortBy === 'amount') {
      transactions.sort((a, b) => (b.amount - a.amount) * mult);
    } else {
      transactions.sort((a, b) =>
        (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) * mult
      );
    }

    // Paginate
    const paged = transactions.slice(skip, skip + parseInt(limit));

    // Type totals
    const typeTotals = {
      credit: wallet.transactions.filter(t => t.type === 'credit')
        .reduce((sum, t) => sum + (t.amount || 0), 0),
      debit: wallet.transactions.filter(t => t.type === 'debit')
        .reduce((sum, t) => sum + (t.amount || 0), 0),
      commission: wallet.transactions.filter(t => t.type === 'commission')
        .reduce((sum, t) => sum + (t.amount || 0), 0)
    };

    res.json({
      success: true,
      transactions: paged,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
      typeTotals
    });
  } catch (error) {
    console.error('❌ Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching transactions',
      error: error.message
    });
  }
};

/**
 * POST /api/wallet/admin/wallets/:driverId/payout
 */
export const processManualPayout = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { amount, description = 'Admin payout', utrNumber } = req.body;

    console.log(`💸 Admin: Processing payout for driver: ${driverId}, amount: ₹${amount}`);

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount. Must be greater than 0.'
      });
    }

    const driver = await User.findById(driverId).lean();
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    const wallet = await Wallet.findOne({ driverId });
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found for this driver'
      });
    }

    if (wallet.availableBalance < parseFloat(amount)) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: ₹${wallet.availableBalance.toFixed(2)}`,
        availableBalance: wallet.availableBalance
      });
    }

    const transaction = {
      type: 'debit',
      amount: parseFloat(amount),
      description: utrNumber ? `${description} (UTR: ${utrNumber})` : description,
      status: 'completed',
      paymentMethod: 'netbanking',
      createdAt: new Date()
    };

    wallet.transactions.push(transaction);
    wallet.availableBalance -= parseFloat(amount);
    wallet.balance = Math.max(0, (wallet.balance || 0) - parseFloat(amount));
    wallet.pendingAmount = Math.max(0, (wallet.pendingAmount || 0) - parseFloat(amount));
    await wallet.save();

    safeEmit(req.io, `driver_${driverId}`, 'payout_processed', {
      amount: parseFloat(amount),
      utrNumber,
      availableBalance: wallet.availableBalance
    });

    console.log(`✅ Payout processed: ₹${amount} for driver ${driverId}`);

    res.json({
      success: true,
      message: `Payout of ₹${parseFloat(amount).toFixed(2)} processed successfully`,
      transaction,
      updatedBalance: wallet.availableBalance,
      driverName: driver.name
    });
  } catch (error) {
    console.error('❌ Error processing payout:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing payout',
      error: error.message
    });
  }
};

/**
 * GET /api/wallet/admin/wallets/stats/summary
 */
export const getWalletStats = async (req, res) => {
  try {
    console.log('📊 Admin: Fetching wallet statistics');

    const wallets = await Wallet.find()
      .populate('driverId', 'name phone vehicleType isOnline')
      .lean();

    const stats = {
      totalDrivers: wallets.length,
      totalBalance: 0,
      totalEarnings: 0,
      totalCommission: 0,
      pendingPayouts: 0,
      avgBalance: 0,
      totalTransactions: 0,
      topEarners: [],
      recentTransactions: []
    };

    const allTxns = [];

    wallets.forEach(w => {
      stats.totalBalance += w.availableBalance || 0;
      stats.totalEarnings += w.totalEarnings || 0;
      stats.totalCommission += w.totalCommission || 0;
      stats.pendingPayouts += w.pendingAmount || 0;
      stats.totalTransactions += (w.transactions || []).length;

      (w.transactions || []).forEach(t => {
        allTxns.push({
          ...t,
          driverId: w.driverId?._id,
          driverName: w.driverId?.name || 'Unknown'
        });
      });
    });

    stats.avgBalance = stats.totalDrivers > 0
      ? stats.totalBalance / stats.totalDrivers
      : 0;

    stats.topEarners = wallets
      .filter(w => w.driverId)
      .sort((a, b) => (b.totalEarnings || 0) - (a.totalEarnings || 0))
      .slice(0, 5)
      .map(w => ({
        driverId: w.driverId._id.toString(),
        driverName: w.driverId.name || 'Unknown',
        driverPhone: w.driverId.phone || 'N/A',
        totalEarnings: w.totalEarnings || 0,
        availableBalance: w.availableBalance || 0
      }));

    stats.recentTransactions = allTxns
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);

    console.log('📈 Stats calculated:', {
      totalDrivers: stats.totalDrivers,
      totalBalance: stats.totalBalance
    });

    res.json({ success: true, stats });
  } catch (error) {
    console.error('❌ Error fetching wallet stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching stats',
      error: error.message
    });
  }
};

export default {
  getWalletByDriverId,
  processCashCollection,
  getTodayEarnings,
  createRazorpayOrder,
  verifyRazorpayPayment,
  getPaymentProofs,
  getAllWallets,
  getWalletDetails,
  getWalletTransactions,
  processManualPayout,
  getWalletStats
};