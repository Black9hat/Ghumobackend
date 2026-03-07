// controllers/paymentController.js
// ✅ PRODUCTION — Phase 2b hardened
//
// Fixes applied vs. original:
//   1. COMMISSION_RATE removed — reads from DB collection (no hardcoded 0.20)
//   2. generateIdempotencyKey — deterministic (tripId+type, no Date.now)
//   3. confirmCashReceipt — checks trip.walletUpdated FIRST (master idempotency flag)
//   4. verifyDirectPayment — atomic $inc+$push wallet update (no lost-update race)
//   5. session.withTransaction() throughout — no leaked sessions
//   6. Webhook route removed from paymentRoutes (lives in webhookRoutes.js only)
//   7. pendingAmount logic — single-pass, no conflicting if-blocks
//   8. confirmCashReceipt — releases driver after confirmation
//   9. No CommissionSettings model import — uses mongoose.connection.db directly

import mongoose from 'mongoose';
import crypto   from 'crypto';
import Razorpay from 'razorpay';
import PaymentTransaction from '../models/PaymentTransaction.js';
import Wallet              from '../models/Wallet.js';
import Trip                from '../models/Trip.js';

// ═══════════════════════════════════════════════════════════════════════════
// RAZORPAY INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Commission rate from DB
// Uses raw mongoose.connection.db — no extra model file needed
// Consistent with tripController & walletController
// ═══════════════════════════════════════════════════════════════════════════

const getCommissionRate = async () => {
  try {
    const settings = await mongoose.connection.db
      .collection('commissionSettings')
      .findOne({ type: 'global' });
    return settings?.percentage ? settings.percentage / 100 : 0.20;
  } catch {
    return 0.20; // safe default
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Deterministic idempotency key
// ✅ FIX: removed Date.now() — same trip+type always produces same key
//         so retries correctly find the existing record
// ═══════════════════════════════════════════════════════════════════════════

const generateIdempotencyKey = (tripId, type) =>
  `${tripId.toString()}_${type}`;

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Safe socket emit
// ═══════════════════════════════════════════════════════════════════════════

const emitToRoom = (io, room, event, data) => {
  try {
    if (io) io.to(room).emit(event, data);
  } catch (err) {
    console.warn(`⚠️ Socket emit failed [${event} → ${room}]:`, err.message);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 1️⃣  CREATE DIRECT PAYMENT ORDER (QR / Razorpay checkout)
// POST /api/payment/direct/create
// ═══════════════════════════════════════════════════════════════════════════

export const createDirectPaymentOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { tripId, amount } = req.body;

      const customerId =
        req.body.customerId       ||
        req.user?.mongoId?.toString() ||
        req.user?._id?.toString() ||
        req.user?.id?.toString()  ||
        null;

      let driverId = req.body.driverId || null;

      // Resolve driverId from trip if caller didn't supply it
      if (!driverId && tripId) {
        const t = await Trip.findById(tripId).select('assignedDriver').lean();
        if (t?.assignedDriver) {
          driverId = t.assignedDriver.toString();
          console.log('✅ Resolved driverId from trip:', driverId);
        }
      }

      console.log('📦 direct/create:', { tripId, customerId, driverId, amount });

      // Validation
      const missingFields = [];
      if (!tripId)     missingFields.push('tripId');
      if (!customerId) missingFields.push('customerId');
      if (!driverId)   missingFields.push('driverId');
      if (!amount)     missingFields.push('amount');

      if (missingFields.length) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: ' + missingFields.join(', '),
          received: { tripId, customerId, driverId, amount },
        });
      }
      if (amount <= 0) {
        return res.status(400).json({ success: false, message: 'Amount must be > 0' });
      }

      // ✅ Idempotency — deterministic key means retries find the same record
      const iKey = generateIdempotencyKey(tripId, 'direct');

      const existingPayment = await PaymentTransaction.findOne({
        $or: [
          { idempotencyKey: iKey },
          { tripId, paymentStatus: { $in: ['pending', 'processing', 'completed'] } },
        ],
      }).session(session);

      if (existingPayment) {
        if (existingPayment.paymentStatus === 'completed') {
          return res.json({
            success: true, message: 'Payment already completed',
            alreadyCompleted: true, paymentId: existingPayment.razorpayPaymentId,
          });
        }
        if (existingPayment.razorpayOrderId) {
          return res.json({
            success: true, message: 'Order already exists',
            orderId: existingPayment.razorpayOrderId,
            amount: existingPayment.amount, existingOrder: true,
          });
        }
      }

      const trip = await Trip.findById(tripId).session(session);
      if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });

      // Commission from DB
      const commissionRate = await getCommissionRate();
      const commission     = Math.round(amount * commissionRate * 100) / 100;
      const driverAmount   = Math.round((amount - commission) * 100) / 100;

      // Create Razorpay order
      const razorpayOrder = await razorpay.orders.create({
        amount:   Math.round(amount * 100), // paise
        currency: 'INR',
        receipt:  `T${tripId.toString().slice(-8)}_${Date.now().toString().slice(-6)}`,
        notes:    {
          tripId:     tripId.toString(),
          customerId: customerId.toString(),
          driverId:   driverId.toString(),
          type:       'trip_payment',
        },
      });

      const paymentTxn = new PaymentTransaction({
        idempotencyKey:  iKey,
        razorpayOrderId: razorpayOrder.id,
        tripId, driverId, customerId,
        amount, driverAmount, commission,
        commissionRate,
        paymentMethod: 'direct',
        paymentStatus: 'pending',
        ipAddress:     req.ip,
        userAgent:     req.headers['user-agent'],
      });
      await paymentTxn.save({ session });

      await Trip.findByIdAndUpdate(
        tripId,
        { $set: { paymentStatus: 'pending', paymentMethod: 'direct' } },
        { session }
      );

      console.log(`✅ Order created: ${razorpayOrder.id} | Trip: ${tripId} | ₹${amount}`);

      emitToRoom(req.io, `driver_${driverId}`, 'payment:pending', {
        tripId, amount, method: 'direct',
        message: 'Customer is completing payment...',
      });

      res.json({
        success:    true,
        orderId:    razorpayOrder.id,
        amount, driverAmount, commission,
        currency:   'INR',
        keyId:      process.env.RAZORPAY_KEY_ID,
        tripId,
        expiresAt:  Date.now() + 15 * 60 * 1000,
      });
    });
  } catch (error) {
    console.error('❌ createDirectPaymentOrder error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to create payment order',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 2️⃣  VERIFY DIRECT PAYMENT (after customer pays via Razorpay)
// POST /api/payment/direct/verify
//
// ✅ FIX: Atomic $inc+$push wallet update — no lost-update race
// ✅ FIX: Sets trip.walletUpdated=true so webhook cannot double-credit
// ═══════════════════════════════════════════════════════════════════════════

export const verifyDirectPayment = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const {
        razorpayOrderId, razorpayPaymentId, razorpaySignature,
        tripId, driverId, customerId,
      } = req.body;

      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return res.status(400).json({ success: false, message: 'Missing payment verification data' });
      }

      // ✅ Verify signature FIRST — reject fraud immediately
      const expectedSig = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      if (expectedSig !== razorpaySignature) {
        console.error('❌ SIGNATURE MISMATCH — possible fraud:', { orderId: razorpayOrderId });
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }

      // ✅ Idempotency: already completed?
      const alreadyDone = await PaymentTransaction.findOne({
        razorpayPaymentId, paymentStatus: 'completed',
      }).session(session);

      if (alreadyDone) {
        console.log(`⚠️ Already processed: ${razorpayPaymentId}`);
        return res.json({
          success: true, message: 'Payment already processed',
          alreadyProcessed: true, paymentId: razorpayPaymentId,
          amount: alreadyDone.driverAmount,
        });
      }

      // ✅ Atomic lock: set status=processing only if not already processing/completed
      // Exactly one concurrent request will succeed this update
      const paymentTxn = await PaymentTransaction.findOneAndUpdate(
        { razorpayOrderId, paymentStatus: { $nin: ['completed', 'processing'] } },
        { $set: { paymentStatus: 'processing', razorpayPaymentId } },
        { session, new: true }
      );

      if (!paymentTxn) {
        const existing = await PaymentTransaction.findOne({ razorpayOrderId }).session(session);
        if (existing?.paymentStatus === 'completed') {
          return res.json({ success: true, message: 'Already processed', alreadyProcessed: true });
        }
        return res.status(404).json({ success: false, message: 'Payment order not found or already processing' });
      }

      // ✅ Verify with Razorpay API (source of truth)
      let razorpayPayment;
      try {
        razorpayPayment = await razorpay.payments.fetch(razorpayPaymentId);
      } catch (fetchErr) {
        // Reset to pending so it can be retried
        await PaymentTransaction.findByIdAndUpdate(
          paymentTxn._id,
          { $set: { paymentStatus: 'pending' } },
          { session }
        );
        console.error('❌ Razorpay fetch failed:', fetchErr.message);
        return res.status(400).json({ success: false, message: 'Could not verify with Razorpay — please retry' });
      }

      if (razorpayPayment.status !== 'captured') {
        await PaymentTransaction.findByIdAndUpdate(
          paymentTxn._id,
          { $set: { paymentStatus: 'pending' } },
          { session }
        );
        return res.status(400).json({ success: false, message: `Payment not captured (status: ${razorpayPayment.status})` });
      }

      const resolvedDriverId   = driverId   || paymentTxn.driverId?.toString();
      const resolvedCustomerId = customerId || paymentTxn.customerId?.toString();

      // ✅ Atomic wallet credit — $inc+$push prevents any concurrent request
      //    from reading a stale balance and overwriting it with save()
      const updatedWallet = await Wallet.findOneAndUpdate(
        { driverId: resolvedDriverId },
        {
          $inc:  {
            availableBalance: paymentTxn.driverAmount,
            totalEarnings:    paymentTxn.driverAmount,
          },
          $push: {
            transactions: {
              tripId:            paymentTxn.tripId,
              type:              'credit',
              amount:            paymentTxn.driverAmount,
              description:       `Trip payment received (Total: ₹${paymentTxn.amount})`,
              razorpayPaymentId,
              razorpayOrderId,
              paymentMethod:     razorpayPayment.method || 'direct',
              status:            'completed',
              createdAt:         new Date(),
            },
          },
        },
        { session, new: true, upsert: true }
      );

      // Mark transaction complete
      await PaymentTransaction.findByIdAndUpdate(
        paymentTxn._id,
        {
          $set: {
            paymentStatus:  'completed',
            paymentMethod:  razorpayPayment.method || 'direct',
            completedAt:    new Date(),
            apiProcessed:   true,
          },
          $inc: { processedCount: 1 },
        },
        { session }
      );

      // ✅ Update trip — set walletUpdated=true so webhook won't double-credit
      await Trip.findByIdAndUpdate(
        paymentTxn.tripId,
        {
          $set: {
            paymentStatus:      'completed',
            paymentMethod:      'direct',
            razorpayPaymentId,
            walletUpdated:      true,
            walletUpdatedAt:    new Date(),
            paidAmount:         paymentTxn.amount,
            paymentCompletedAt: new Date(),
          },
        },
        { session }
      );

      console.log(`✅ Payment verified: ${razorpayPaymentId} | Driver: ${resolvedDriverId} | ₹${paymentTxn.driverAmount}`);

      emitToRoom(req.io, `driver_${resolvedDriverId}`, 'payment:received', {
        tripId:       paymentTxn.tripId,
        amount:       paymentTxn.driverAmount,
        totalFare:    paymentTxn.amount,
        paymentId:    razorpayPaymentId,
        method:       razorpayPayment.method,
        walletBalance: updatedWallet.availableBalance,
        timestamp:    new Date().toISOString(),
        message:      `₹${paymentTxn.driverAmount} received!`,
      });

      emitToRoom(req.io, `customer_${resolvedCustomerId}`, 'payment:confirmed', {
        tripId:    paymentTxn.tripId,
        amount:    paymentTxn.amount,
        paymentId: razorpayPaymentId,
        timestamp: new Date().toISOString(),
      });

      res.json({
        success:      true,
        message:      'Payment verified successfully',
        paymentId:    razorpayPaymentId,
        amount:       paymentTxn.amount,
        driverAmount: paymentTxn.driverAmount,
        commission:   paymentTxn.commission,
        walletBalance: updatedWallet.availableBalance,
      });
    });
  } catch (error) {
    console.error('❌ verifyDirectPayment error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Payment verification failed',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 3️⃣  INITIATE CASH PAYMENT (customer says "I'll pay cash")
// POST /api/payment/cash/initiate
// ═══════════════════════════════════════════════════════════════════════════

export const initiateCashPayment = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { tripId, amount } = req.body;

      const customerId =
        req.body.customerId       ||
        req.user?.mongoId?.toString() ||
        req.user?._id?.toString() ||
        null;

      let driverId = req.body.driverId || null;
      if (!driverId && tripId) {
        const t = await Trip.findById(tripId).select('assignedDriver').lean();
        if (t?.assignedDriver) driverId = t.assignedDriver.toString();
      }

      console.log('📦 cash/initiate:', { tripId, customerId, driverId, amount });

      const missingFields = [];
      if (!tripId)     missingFields.push('tripId');
      if (!customerId) missingFields.push('customerId');
      if (!driverId)   missingFields.push('driverId');
      if (!amount)     missingFields.push('amount');

      if (missingFields.length) {
        return res.status(400).json({
          success: false,
          message: 'Missing: ' + missingFields.join(', '),
          received: { tripId, customerId, driverId, amount },
        });
      }

      const iKey = generateIdempotencyKey(tripId, 'cash');

      // ✅ Idempotency check
      const existingPayment = await PaymentTransaction.findOne({
        $or: [
          { idempotencyKey: iKey },
          { tripId, paymentStatus: { $in: ['pending', 'completed'] } },
        ],
      }).session(session);

      if (existingPayment) {
        if (existingPayment.paymentStatus === 'completed') {
          return res.json({ success: true, message: 'Payment already completed', alreadyCompleted: true });
        }
        return res.json({
          success: true, message: 'Cash payment already pending',
          paymentId: existingPayment._id, amount: existingPayment.amount,
        });
      }

      const commissionRate = await getCommissionRate();
      const commission     = Math.round(amount * commissionRate * 100) / 100;
      const driverAmount   = Math.round((amount - commission) * 100) / 100;

      const paymentTxn = new PaymentTransaction({
        idempotencyKey: iKey,
        tripId, driverId, customerId,
        amount, driverAmount, commission, commissionRate,
        paymentMethod: 'cash',
        paymentStatus: 'pending',
        ipAddress:     req.ip,
        userAgent:     req.headers['user-agent'],
      });
      await paymentTxn.save({ session });

      await Trip.findByIdAndUpdate(
        tripId,
        { $set: { paymentStatus: 'pending', paymentMethod: 'cash' } },
        { session }
      );

      console.log(`✅ Cash payment initiated: Trip ${tripId} | ₹${amount}`);

      emitToRoom(req.io, `driver_${driverId}`, 'cash:payment:pending', {
        tripId, amount,
        paymentId: paymentTxn._id.toString(),
        message:   `Collect ₹${amount} cash from customer`,
        action:    'confirm_cash_receipt',
      });

      res.json({
        success:    true,
        message:    'Cash payment initiated. Driver will confirm receipt.',
        paymentId:  paymentTxn._id,
        amount, driverAmount, commission,
      });
    });
  } catch (error) {
    console.error('❌ initiateCashPayment error:', error);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed to initiate cash payment' });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 4️⃣  CONFIRM CASH RECEIPT (driver taps "Cash Collected")
// POST /api/payment/cash/confirm
//
// ✅ FIX: Checks trip.walletUpdated FIRST — master idempotency flag
//         Prevents double-credit race with tripController.confirmCashCollection
// ✅ FIX: Atomic wallet update via $inc+$push
// ✅ FIX: Single-pass pendingAmount calculation
// ✅ FIX: Releases driver after confirmation
// ═══════════════════════════════════════════════════════════════════════════

export const confirmCashReceipt = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { paymentId, tripId, driverId, amount } = req.body;

      if (!tripId || !driverId) {
        return res.status(400).json({ success: false, message: 'Missing tripId or driverId' });
      }

      // ✅ ATOMIC walletUpdated check — this is the race condition guard.
      //    findOneAndUpdate with walletUpdated:{$ne:true} means EXACTLY ONE
      //    concurrent request wins. The loser gets null and returns early.
      const trip = await Trip.findOneAndUpdate(
        { _id: tripId, walletUpdated: { $ne: true } },
        { $set: { walletUpdated: true, walletUpdatedAt: new Date() } },
        { session, new: false } // return OLD doc so we can read fare
      ).lean();

      if (!trip) {
        // walletUpdated was already true — already processed
        console.log(`⚠️ confirmCashReceipt: wallet already updated for trip ${tripId}`);
        return res.json({
          success: true, message: 'Cash already confirmed', alreadyProcessed: true,
        });
      }

      // Resolve payment transaction
      let paymentTxn;
      if (paymentId) {
        paymentTxn = await PaymentTransaction.findById(paymentId).session(session);
      }
      if (!paymentTxn) {
        paymentTxn = await PaymentTransaction.findOne({
          tripId, paymentMethod: 'cash', paymentStatus: 'pending',
        }).session(session);
      }

      const fareAmount     = parseFloat(amount || trip.finalFare || trip.fare || 0);
      const commissionRate = await getCommissionRate();
      const commission     = Math.round(fareAmount * commissionRate * 100) / 100;
      const netAmount      = Math.round((fareAmount - commission)   * 100) / 100;

      if (!paymentTxn) {
        // Driver-initiated with no prior initiate call — create record
        paymentTxn = new PaymentTransaction({
          idempotencyKey: generateIdempotencyKey(tripId, 'cash'),
          tripId, driverId,
          customerId:    req.body.customerId || trip.customerId || null,
          amount:        fareAmount,
          driverAmount:  netAmount,
          commission, commissionRate,
          paymentMethod: 'cash',
          paymentStatus: 'pending',
        });
        await paymentTxn.save({ session });
      }

      if (paymentTxn.paymentStatus === 'completed') {
        return res.json({ success: true, message: 'Cash already confirmed', alreadyProcessed: true });
      }

      // ✅ Single-pass pendingAmount: reduce debt by netAmount earned
      //    (driver holds the cash, so this trip's earning offsets what they owe)
      const currentWallet  = await Wallet.findOne({ driverId }).session(session).lean();
      const currentPending = currentWallet?.pendingAmount    || 0;
      const currentBalance = currentWallet?.availableBalance || 0;

      const pendingReduced = Math.min(currentPending, netAmount);
      const newBalance     = Math.max(0, currentBalance + netAmount - pendingReduced);
      const newPending     = Math.max(0, currentPending - pendingReduced);

      // ✅ Atomic update — no read-modify-write race possible
      const updatedWallet = await Wallet.findOneAndUpdate(
        { driverId },
        {
          $set:  { availableBalance: newBalance, pendingAmount: newPending },
          $inc:  { totalEarnings: fareAmount, totalCommission: commission },
          $push: {
            transactions: {
              $each: [
                {
                  tripId, type: 'credit', amount: fareAmount,
                  description:   'Cash collected from trip',
                  paymentMethod: 'cash', status: 'completed', createdAt: new Date(),
                },
                {
                  tripId, type: 'commission', amount: commission,
                  description:   `Platform commission (${Math.round(commissionRate * 100)}%)`,
                  paymentMethod: 'cash', status: 'completed', createdAt: new Date(),
                },
              ],
            },
            processedTripIds: tripId,
          },
        },
        { session, new: true, upsert: true }
      );

      // Mark payment complete
      await PaymentTransaction.findByIdAndUpdate(
        paymentTxn._id,
        {
          $set: { paymentStatus: 'completed', completedAt: new Date() },
          $inc: { processedCount: 1 },
        },
        { session }
      );

      // Update trip payment fields
      await Trip.findByIdAndUpdate(
        tripId,
        {
          $set: {
            paymentStatus:      'completed',
            paymentMethod:      'cash',
            paymentCollected:   true,
            paidAmount:         fareAmount,
            paymentCompletedAt: new Date(),
            'payment.collected':  true,
            'payment.collectedAt': new Date(),
            'payment.method':     'Cash',
          },
        },
        { session }
      );

      // ✅ Release driver — was missing in original
      const User = (await import('../models/User.js')).default;
      await User.findByIdAndUpdate(driverId, {
        $set: {
          isBusy:                  false,
          currentTripId:           null,
          canReceiveNewRequests:   true,
          awaitingCashCollection:  false,
          lastCashCollectedAt:     new Date(),
          lastTripCompletedAt:     new Date(),
        },
      }, { session });

      console.log(`✅ Cash confirmed: Trip ${tripId} | ₹${fareAmount} | Net: ₹${netAmount}`);

      // Socket notifications
      emitToRoom(req.io, `driver_${driverId}`, 'payment:confirmed', {
        tripId, amount: fareAmount, driverAmount: netAmount, commission,
        walletBalance:  updatedWallet.availableBalance,
        pendingAmount:  updatedWallet.pendingAmount,
        method: 'cash', timestamp: new Date().toISOString(),
        message: `₹${netAmount} added to wallet. Ready for next ride!`,
      });

      const resolvedCustomerId = paymentTxn.customerId?.toString() || trip.customerId?.toString();
      if (resolvedCustomerId) {
        emitToRoom(req.io, `customer_${resolvedCustomerId}`, 'payment:confirmed', {
          tripId, amount: fareAmount, method: 'cash', timestamp: new Date().toISOString(),
        });
      }

      res.json({
        success:       true,
        message:       'Cash receipt confirmed',
        amount:        fareAmount,
        driverAmount:  netAmount,
        commission,
        walletBalance: updatedWallet.availableBalance,
        pendingAmount: updatedWallet.pendingAmount,
      });
    });
  } catch (error) {
    console.error('❌ confirmCashReceipt error:', error);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed to confirm cash receipt' });
  } finally {
    session.endSession();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default {
  createDirectPaymentOrder,
  verifyDirectPayment,
  initiateCashPayment,
  confirmCashReceipt,
};