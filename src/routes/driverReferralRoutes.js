import express from 'express';
import admin from 'firebase-admin';
import User from '../models/User.js';
import Referral from '../models/Referral.js';
import AppSettings from '../models/AppSettings.js';
import {
  ensureReferralCode,
  claimReferralReward,
  recordReferralSignup,
} from '../services/rewardService.js';

const router = express.Router();

const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

function getCycleReward(ref, cycle) {
  const referralsRequired = Number.isFinite(Number(ref.referralsRequired))
    ? Number(ref.referralsRequired)
    : (ref.baseReferralsRequired ?? 5) + cycle * (ref.extraReferralsPerCycle ?? 2);
  const rewardAmount = Number.isFinite(Number(ref.rewardAmount))
    ? Number(ref.rewardAmount)
    : (ref.baseRewardAmount ?? 100) + cycle * (ref.extraRewardAmount ?? 25);

  return {
    referralsRequired: Math.max(1, referralsRequired),
    rewardAmount: Math.max(0, rewardAmount),
    ridesToComplete: Math.max(1, Number(ref.ridesToComplete) || 1),
  };
}

router.get('/status/:driverId', verifyToken, async (req, res) => {
  try {
    const { driverId } = req.params;

    let driver = await User.findById(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    if (!driver.driverReferralCode) {
      await ensureReferralCode(driverId, 'driver');
      driver = await User.findById(driverId);
    }

    const settings = await AppSettings.getSettings();
    const ref = settings.driverReferral;
    const maxAllowedCycles = 1;
    const currentCycle = 0;
    const cyclesExhausted = false;

    const cycleReward = getCycleReward(ref, currentCycle);
    const progress = driver.driverReferralProgress ?? 0;
    const remaining = Math.max(0, cycleReward.referralsRequired - progress);
    const milestoneReached = progress >= cycleReward.referralsRequired;
    const successfulTotal = driver.driverSuccessfulReferrals ?? 0;

    const [successfulReferrals, pendingReferrals] = await Promise.all([
      Referral.find({
        referrerId: driverId,
        firstRideCompleted: true,
        isFlagged: { $ne: true },
      })
        .populate('referredUserId', 'name phone')
        .sort({ firstRideCompletedAt: -1 })
        .lean(),
      Referral.find({
        referrerId: driverId,
        firstRideCompleted: false,
        isFlagged: { $ne: true },
      })
        .populate('referredUserId', 'name phone')
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const pendingDriverIds = pendingReferrals
      .map((r) => r.referredUserId?._id)
      .filter(Boolean);

    let pendingRideMap = new Map();
    if (pendingDriverIds.length > 0) {
      const pendingDrivers = await User.find({ _id: { $in: pendingDriverIds } })
        .select('_id totalRidesCompleted')
        .lean();
      pendingRideMap = new Map(
        pendingDrivers.map((d) => [String(d._id), Number(d.totalRidesCompleted || 0)])
      );
    }

    const playStoreBase = 'https://play.google.com/store/apps/details?id=com.startech.goindia';
    const referrer = encodeURIComponent(`referralCode=${driver.driverReferralCode}`);
    const deepLink = `${playStoreBase}&referrer=${referrer}`;
    const shareText =
      `Join me on GoIndia as a driver!\n\n` +
      `Use my referral code *${driver.driverReferralCode}* when you sign up.\n\n` +
      `Complete ${cycleReward.ridesToComplete} ride(s) after signup to unlock referral reward.\n\n` +
      `Download here:\n${deepLink}`;

    return res.json({
      success: true,
      referralCode: driver.driverReferralCode,
      shareLink: shareText,
      deepLink,
      systemEnabled: ref.enabled,
      progress: {
        successful: progress,
        required: cycleReward.referralsRequired,
        remaining,
        milestoneReached,
        rewardClaimed: driver.driverReferralRewardClaimed || false,
        pendingClaim: driver.driverReferralRewardPendingClaim || false,
        pendingAmount: driver.driverReferralAmountBalance || 0,
      },
      reward: {
        amount: cycleReward.rewardAmount,
        ridesToComplete: cycleReward.ridesToComplete,
        description:
          `Refer ${cycleReward.referralsRequired} driver(s). Each referred driver must complete ${cycleReward.ridesToComplete} ride(s) to earn ₹${cycleReward.rewardAmount}.`,
      },
      cycle: {
        current: currentCycle,
        max: maxAllowedCycles,
        exhausted: cyclesExhausted,
        successfulTotal,
      },
      referrals: {
        successful: successfulReferrals.map((r) => ({
          name: r.referredUserId?.name || 'Driver',
          completedAt: r.firstRideCompletedAt,
        })),
        pending: pendingReferrals.map((r) => ({
          name: r.referredUserId?.name || 'Driver',
          joinedAt: r.createdAt,
          ridesCompleted: pendingRideMap.get(String(r.referredUserId?._id)) || 0,
          ridesRequired: cycleReward.ridesToComplete,
        })),
      },
    });
  } catch (err) {
    console.error('❌ GET /driver/referral/status:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/claim/:driverId', verifyToken, async (req, res) => {
  try {
    const { driverId } = req.params;

    const user = await User.findById(driverId).select('firebaseUid role').lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.firebaseUid !== req.user?.uid || user.role !== 'driver') {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized — token does not match driver user',
      });
    }

    const result = await claimReferralReward(driverId, 'driver');

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.json(result);
  } catch (err) {
    console.error('❌ POST /driver/referral/claim:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/validate/:code', async (req, res) => {
  try {
    const code = req.params.code?.trim().toUpperCase();
    if (!code || code.length < 4) {
      return res.status(400).json({ success: false, message: 'Invalid code' });
    }

    const referrer = await User.findOne({ driverReferralCode: code })
      .select('name driverReferralCode role')
      .lean();

    if (!referrer || referrer.role !== 'driver') {
      return res.status(404).json({
        success: false,
        message: 'Invalid referral code',
      });
    }

    return res.json({
      success: true,
      valid: true,
      referrerName: referrer.name || 'A driver',
      message: `You were invited by ${referrer.name || 'a driver'}`,
    });
  } catch (err) {
    console.error('❌ GET /driver/referral/validate:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/code/:driverId', verifyToken, async (req, res) => {
  try {
    const { driverId } = req.params;
    let user = await User.findById(driverId).select('driverReferralCode').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.driverReferralCode) {
      await ensureReferralCode(driverId, 'driver');
      user = await User.findById(driverId).select('driverReferralCode').lean();
    }

    return res.json({ success: true, referralCode: user?.driverReferralCode || null });
  } catch (err) {
    console.error('❌ GET /driver/referral/code:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/record-signup', async (req, res) => {
  try {
    const { userId, referralCode } = req.body;
    const result = await recordReferralSignup(userId, referralCode, 'driver');
    return res.json(result);
  } catch (err) {
    console.error('❌ POST /driver/referral/record-signup:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/', (_req, res) => {
  res.json({
    message: '🔗 Driver referral API active',
    endpoints: [
      'GET  /api/driver/referral/status/:driverId',
      'GET  /api/driver/referral/code/:driverId',
      'GET  /api/driver/referral/validate/:code',
      'POST /api/driver/referral/claim/:driverId',
    ],
  });
});

export default router;