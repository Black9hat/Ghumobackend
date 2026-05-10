// src/utils/notificationScheduler.js
//
// Daily automated notification scheduler using node-cron.
//
// SETUP in your server.js / app.js:
//   import { startNotificationScheduler } from './utils/notificationScheduler.js';
//   startNotificationScheduler();

import cron from 'node-cron';
import User from '../models/User.js';
import { sendFCMNotification } from './fcmHelper.js';

// ─── DAILY MESSAGES CONFIG ────────────────────────────────────────────────
// Customize these messages for your Ghumo/Ridde brand.
// Times are in IST (India Standard Time = UTC+5:30).
// node-cron uses server time — make sure your server TZ is set to Asia/Kolkata
// OR use UTC times adjusted for IST offset.

const MORNING_MESSAGES = [
  {
    title: '🌅 Good Morning! Special Offers Await',
    body:  'Start your day with 20% OFF on your first ride today!',
  },
  {
    title: '☀️ Rise & Ride with Ghumo!',
    body:  'Book now and get a flat ₹30 OFF. Limited slots!',
  },
  {
    title: '🚗 Your Driver is Ready!',
    body:  'Morning commute sorted. Book your ride in 30 seconds.',
  },
];

const EVENING_MESSAGES = [
  {
    title: '🌆 Evening Rush? We\'ve Got You!',
    body:  'Skip the traffic stress. Get 15% OFF on evening rides.',
  },
  {
    title: '🏠 Heading Home?',
    body:  'Book your safe ride home now. Drivers nearby!',
  },
  {
    title: '🌙 Late Night? Stay Safe!',
    body:  'Ride safe with Ghumo. Book anytime, anywhere.',
  },
];

const DRIVER_EARNINGS_MESSAGES = [
  {
    title: '💰 Boost Your Earnings Today!',
    body:  'Complete 5 trips today and earn ₹100 bonus. Go online now!',
  },
  {
    title: '🏆 Top Driver Bonus Available',
    body:  'Top 10 drivers this week earn ₹500 bonus. Check your ranking!',
  },
  {
    title: '⚡ High Demand in Your Area!',
    body:  'Surge pricing active. Go online now to earn more!',
  },
];

// ─── HELPER ───────────────────────────────────────────────────────────────
const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const sendToAllByRole = async (role, title, body) => {
  const query = {
    fcmToken: { $exists: true, $ne: '' },
    role:     role === 'customer' ? { $in: ['customer', 'user'] } : role,
  };

  const users = await User.find(query).select('_id fcmToken').lean();
  console.log(`📤 Sending scheduled "${title}" to ${users.length} ${role}s`);

  let sent = 0, failed = 0;

  // Batch of 200 to keep memory low in cron context
  const BATCH = 200;
  for (let i = 0; i < users.length; i += BATCH) {
    const chunk = users.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      chunk.map((user) =>
        sendFCMNotification({
          userId: user._id,
          token:  user.fcmToken,
          title,
          body,
          type:  'general',
        })
      )
    );
    results.forEach((r) => {
      if (r.status === 'fulfilled' && r.value?.success) sent++;
      else failed++;
    });
  }

  console.log(`✅ Scheduled notification done — sent: ${sent}, failed: ${failed}`);
};

// ═══════════════════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════════════════
export const startNotificationScheduler = () => {
  // ── Morning message to customers — 9:00 AM IST (3:30 AM UTC) ──────────
  cron.schedule('30 3 * * *', async () => {
    console.log('⏰ [CRON] Morning notification to customers');
    const msg = getRandom(MORNING_MESSAGES);
    await sendToAllByRole('customer', msg.title, msg.body);
  });

  // ── Evening message to customers — 6:00 PM IST (12:30 PM UTC) ─────────
  cron.schedule('30 12 * * *', async () => {
    console.log('⏰ [CRON] Evening notification to customers');
    const msg = getRandom(EVENING_MESSAGES);
    await sendToAllByRole('customer', msg.title, msg.body);
  });

  // ── Morning driver earnings nudge — 8:00 AM IST (2:30 AM UTC) ─────────
  cron.schedule('30 2 * * *', async () => {
    console.log('⏰ [CRON] Driver earnings notification');
    const msg = getRandom(DRIVER_EARNINGS_MESSAGES);
    await sendToAllByRole('driver', msg.title, msg.body);
  });

  // ── Inactive user re-engagement — every Sunday 11:00 AM IST (5:30 AM UTC)
  cron.schedule('30 5 * * 0', async () => {
    console.log('⏰ [CRON] Weekly re-engagement notification');
    await sendToAllByRole('customer', '😢 We Miss You!', 'It\'s been a while! Book a ride today and get ₹50 OFF with code COMEBACK.');
  });

  console.log('✅ Notification scheduler started (4 cron jobs active)');
};