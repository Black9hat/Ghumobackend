import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { cleanupStuckDrivers } from './jobs/driverCleanup.js';
import User from './models/User.js';
import Trip from './models/Trip.js';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import connectDB from './config/db.js';
import { Server } from "socket.io";
import supportRoutes from './routes/supportRoutes.js';
import { initSupportSockets } from './socket/supportSocketHandler.js';
import path from 'path';
import adminIncentiveRoutes from './routes/adminIncentiveRoutes.js';
import driverRideHistoryRoutes from './routes/driverRideHistory.js';
import customerBannerRoutes from "./routes/customerBannerRoutes.js";
import privacyRoutes from './routes/privacyRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import planRoutes from './routes/planRoutes.js';
import zoneRoutes from './routes/zoneRoutes.js';
import userRoutes from './routes/userRoutes.js';
import authRoutes from './routes/authRoutes.js';
import driverRoutes from './routes/driverRoutes.js';
import fareRoutes from './routes/fareRoutes.js';
import parcelRoutes from './routes/parcelRoutes.js';
import rateRoutes from './routes/rateRoutes.js';
import locationRoutes from './routes/locationRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import tripRoutes from './routes/tripRoutes.js';
import healthRoutes from './routes/healthRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import rideHistoryRoutes from './routes/rideHistory.js';
import driverIncentiveRoutes from './routes/driverIncentiveRoutes.js';
import timingSlotIncentiveRoutes from './routes/timingSlotIncentiveRoutes.js';
import driverEarningsRoutes from './routes/driverEarningsRoutes.js';
import { startPlanExpiryJob } from './cron/planExpiryJob.js';
import couponRoutes from './routes/coupons.routes.js';
import adminCouponRoutes from './routes/admin.coupons.routes.js';
import promotionRoutes from './routes/promotionRoutes.js';
import sosRoutes from './routes/sosRoutes.js';
import referralRoutes from './routes/referralRoutes.js';
import driverReferralRoutes from './routes/driverReferralRoutes.js';
import rewardRoutes from './routes/rewards.routes.js';
import adminRewardConfigRoutes from './routes/adminRewardConfigRoutes.js';
import serviceAreaRoutes from './routes/service_area_routes.js';
import adminServiceAreaRoutes from './routes/admin_service_area_routes.js';
import helpRoutes from './routes/helpRoutes.js';
import adminHelpRoutes from './routes/adminHelpRoutes.js';
import standbyReassignCron from './cron/standbyReassignCron.js';
import { startExpirePlansCron } from './cron/expirePlans.js';
import { expireOldSos } from './cron/sosExpireCron.js';
import { initSocket } from './socket/socketHandler.js';
import { seedCommissionSettings } from './seed/commissionSettings.js';
import notificationRoutes from './routes/notificationRoutes.js';

dotenv.config();

// ============================================================================
// 🔥 TRACK SERVER READINESS — Prevents 503 during cold start
// ============================================================================
let isServerReady = false;
let serverStartTime = null;

await connectDB();
await seedCommissionSettings();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});
const __dirname = path.resolve();

// ============================================================================
// ✅ CORS — MUST BE FIRST before any routes or middleware
// NOTE: app.use(cors()) with an options object automatically handles
// OPTIONS preflight requests — no need for a separate app.options() call
// ============================================================================
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:5174',
    'https://ghumobackend.onrender.com',
    'https://adminfrontend-n30d.onrender.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'ngrok-skip-browser-warning',
    'x-admin-token'
  ],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

// ============================================================================
// 🛡️ READINESS MIDDLEWARE
// ============================================================================
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/health' || req.path === '/ping') {
    return next();
  }
  if (!isServerReady) {
    // ✅ Explicitly set CORS header so browser doesn't misreport 503 as a CORS error
    res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.set('Access-Control-Allow-Credentials', 'true');
    return res.status(503).json({
      message: '⏳ Server is warming up, please retry in a few seconds',
      retryAfter: 10,
      status: 'starting'
    });
  }
  next();
});

// ============================================================================
// 🔐 ATTACH SOCKET.IO TO REQUESTS
// ============================================================================
app.use((req, res, next) => {
  req.io = io;
  next();
});

app.use(morgan('dev'));

// ============================================================================
// ✅ ROOT / HEALTH / PING ROUTES
// ============================================================================
app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'alive',
    message: '🌏 Ghumo backend is running 🚀',
    ready: isServerReady,
    uptime: process.uptime(),
    startedAt: serverStartTime,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'OK',
    ready: isServerReady,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (_req, res) => {
  res.status(200).send('pong');
});

// ============================================================================
// ⚠️ WEBHOOK — MUST BE BEFORE express.json() (needs raw body)
// ============================================================================
app.use('/api/webhook', webhookRoutes);

// ============================================================================
// 📦 BODY PARSERS
// ============================================================================
app.use(express.json());

// ============================================================================
// 📄 STATIC FILES
// ============================================================================
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.use(express.static(path.join(__dirname, 'src', 'public')));

// ============================================================================
// 🔌 INITIALIZE SOCKET.IO
// ============================================================================
initSocket(io);
app.set('io', io);

// ============================================================================
// 📄 PRIVACY ROUTES & PAGE
// ============================================================================
app.use('/api', privacyRoutes);

app.get('/privacy-policy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'privacy-policy.html'));
});

// ============================================================================
// 🛣️ ALL API ROUTES
// ============================================================================
app.use('/api/sos', sosRoutes);
app.use('/api/support', supportRoutes);
app.use('/api', adminIncentiveRoutes);
app.use('/api/driver/incentives', driverIncentiveRoutes);
app.use('/api/driver/incentives', timingSlotIncentiveRoutes);
app.use('/api/admin/incentives', timingSlotIncentiveRoutes);
app.use('/api', planRoutes);
app.use('/api/zones', zoneRoutes);
app.use('/api/customer/banners', customerBannerRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/user', userRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/fares', fareRoutes);
app.use('/api/parcels', parcelRoutes);
app.use('/api/rates', rateRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trip', tripRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/withdrawal', walletRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api', rideHistoryRoutes);
app.use('/api/driver', driverRideHistoryRoutes);
app.use('/api', healthRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/admin', adminCouponRoutes);
app.use('/api', promotionRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/driver/referral', driverReferralRoutes);
app.use('/api/rewards', rewardRoutes);
app.use('/api/admin', adminRewardConfigRoutes);
app.use('/api/service-areas', serviceAreaRoutes);
app.use('/api/admin/service-areas', adminServiceAreaRoutes);
app.use('/api/help', helpRoutes);
app.use('/api/admin', adminHelpRoutes);
app.use('/api', driverEarningsRoutes);
app.use(rideHistoryRoutes);

// ✅ Notification routes — after /api/admin so adminRoutes takes priority on conflicts
app.use('/api/notifications', notificationRoutes);

// ============================================================================
// 📋 DEBUG: Registered Route Logs
// ============================================================================
console.log('\n📋 Registered Routes:');
console.log('  🔔 Notification Routes (Driver/Customer):');
console.log('    GET    /api/notifications');
console.log('    GET    /api/notifications/offers');
console.log('    PATCH  /api/notifications/:id/read');
console.log('    PATCH  /api/notifications/read-all');
console.log('    DELETE /api/notifications/clear-all');
console.log('    DELETE /api/notifications/:id');
console.log('');
console.log('  🔔 Notification Routes (Admin):');
console.log('    POST   /api/admin/send-fcm                    → broadcast');
console.log('    POST   /api/admin/send-individual-notification → individual');
console.log('    GET    /api/admin/offers/all                   → admin offer list');
console.log('    GET    /api/admin/offers                       → user offers');
console.log('    DELETE /api/admin/offers/:id                   → delete offer');
console.log('');
console.log('  🎫 Coupon Routes (Customer):');
console.log('    GET  /api/coupons/available/:customerId');
console.log('    POST /api/coupons/validate');
console.log('    POST /api/coupons/apply');
console.log('    GET  /api/coupons/history/:customerId');
console.log('');
console.log('  🎫 Coupon Routes (Admin):');
console.log('    GET    /api/admin/coupons');
console.log('    POST   /api/admin/coupons');
console.log('    PUT    /api/admin/coupons/:id');
console.log('    DELETE /api/admin/coupons/:id');
console.log('    GET    /api/admin/coupons/:id/stats');
console.log('    GET    /api/admin/coupons-stats/overview');
console.log('');
console.log('  🎯 Promotion Routes:');
console.log('    POST   /api/admin/promotions/upload');
console.log('    GET    /api/admin/promotions');
console.log('    GET    /api/promotions/active');
console.log('    PUT    /api/admin/promotions/:id/toggle');
console.log('    DELETE /api/admin/promotions/:id');
console.log('    POST   /api/promotions/:id/click');
console.log('');
console.log('  🗺️ Service Area Routes (Customer):');
console.log('    GET  /api/service-area/config');
console.log('    POST /api/service-area/validate');
console.log('');
console.log('  🗺️ Service Area Routes (Admin):');
console.log('    GET    /api/admin/service-area');
console.log('    GET    /api/admin/service-area/stats');
console.log('    POST   /api/admin/service-area');
console.log('    PUT    /api/admin/service-area/:id');
console.log('    PATCH  /api/admin/service-area/:id/toggle');
console.log('    DELETE /api/admin/service-area/:id');
console.log('');
console.log('  🆘 Help/Support Routes (Customer):');
console.log('    GET  /api/help/settings');
console.log('    POST /api/help/request');
console.log('    GET  /api/help/requests/:customerId');
console.log('    GET  /api/help/request/:id');
console.log('');
console.log('  🆘 Help/Support Routes (Admin):');
console.log('    GET    /api/admin/help/settings');
console.log('    PUT    /api/admin/help/settings');
console.log('    GET    /api/admin/help/requests');
console.log('    GET    /api/admin/help/requests/:id');
console.log('    PUT    /api/admin/help/requests/:id');
console.log('    DELETE /api/admin/help/requests/:id');
console.log('    GET    /api/admin/help/stats');
console.log('');
console.log('  🔐 Session Management Routes:');
console.log('    POST /api/auth/firebase-sync');
console.log('    POST /api/auth/logout');
console.log('    POST /api/auth/refresh-fcm-token');
console.log('    GET  /api/auth/session-status/:phone');
console.log('    GET  /api/auth/session-history/:phone');
console.log('');
console.log('  💰 Plan Management Routes (Driver):');
console.log('    GET  /api/driver/plans/available');
console.log('    POST /api/driver/plans/:planId/create-order');
console.log('    POST /api/driver/plans/:planId/verify-payment');
console.log('    GET  /api/driver/plan/current');
console.log('    POST /api/driver/plan/current/deactivate');
console.log('');
console.log('  💰 Plan Management Routes (Admin):');
console.log('    POST   /api/admin/plans');
console.log('    GET    /api/admin/plans');
console.log('    GET    /api/admin/plans/:planId');
console.log('    PUT    /api/admin/plans/:planId');
console.log('    DELETE /api/admin/plans/:planId');
console.log('    PATCH  /api/admin/plans/:planId/toggle');
console.log('');
console.log('  👥 Driver Management Routes (Admin):');
console.log('    GET    /api/admin/drivers');
console.log('    POST   /api/admin/drivers/:driverId/approve');
console.log('    POST   /api/admin/drivers/:driverId/reject');
console.log('    POST   /api/admin/drivers/:driverId/suspend');
console.log('    POST   /api/admin/drivers/:driverId/block');
console.log('    POST   /api/admin/drivers/:driverId/unblock');
console.log('');
console.log('  💹 Driver Earnings Routes:');
console.log('    GET  /api/driver/earnings/summary/:driverId');
console.log('    GET  /api/driver/earnings/breakdown/:driverId');
console.log('    GET  /api/driver/earnings/transactions/:driverId\n');

// ============================================================================
// ⏰ CRON JOBS
// ============================================================================

// Standby driver reassign — every 2 minutes
setInterval(() => {
  standbyReassignCron().catch((err) =>
    console.error('❌ Unhandled cron error:', err)
  );
}, 2 * 60 * 1000);

// SOS auto-expire — every 10 minutes
setInterval(() => {
  expireOldSos().catch((err) =>
    console.error('❌ SOS expire cron error:', err)
  );
}, 10 * 60 * 1000);

// Plan expiry
startExpirePlansCron();
startPlanExpiryJob(io);

// Driver stuck cleanup — every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  try {
    console.log('🔍 Running driver availability cleanup...');

    const stuckDrivers = await User.find({
      isDriver: true,
      isBusy: true,
      $or: [
        { currentTripId: null },
        { currentTripId: { $exists: false } }
      ]
    });

    if (stuckDrivers.length > 0) {
      console.log(`⚠️ Found ${stuckDrivers.length} drivers stuck in busy state`);

      for (const driver of stuckDrivers) {
        const activeTrip = await Trip.findOne({
          assignedDriver: driver._id,
          status: { $in: ['driver_assigned', 'ride_started'] }
        });

        if (!activeTrip) {
          await User.findByIdAndUpdate(driver._id, {
            $set: {
              isBusy: false,
              currentTripId: null,
              canReceiveNewRequests: false
            }
          });
          console.log(`✅ Reset stuck driver: ${driver.name} (${driver._id})`);
        }
      }
    } else {
      console.log('✅ All drivers have correct availability status');
    }
  } catch (error) {
    console.error('❌ Cleanup job error:', error);
  }
});

cron.schedule('*/5 * * * *', cleanupStuckDrivers);

// ============================================================================
// 🔄 SELF-PING KEEP-ALIVE — every 14 minutes
// ============================================================================
const SELF_PING_INTERVAL = 14 * 60 * 1000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://ghumobackend.onrender.com';

setInterval(async () => {
  try {
    const response = await fetch(`${RENDER_URL}/ping`);
    const text = await response.text();
    console.log(`🏓 Self-ping: ${response.status} — ${text} (${new Date().toLocaleTimeString()})`);
  } catch (err) {
    console.error('❌ Self-ping failed:', err.message);
  }
}, SELF_PING_INTERVAL);

// ============================================================================
// ❌ 404 HANDLER
// ============================================================================
app.use((req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ message: '🔍 Route not found', path: req.path });
});

// ============================================================================
// ❌ GLOBAL ERROR HANDLER
// ============================================================================
app.use((err, req, res, _next) => {
  console.error('❌ Server error:', err);
  res.status(err.status || 500).json({
    message: err.message || '🚨 Internal Server Error',
  });
});

// ============================================================================
// 🚀 START SERVER
// ============================================================================
const PORT = process.env.PORT || 5002;
httpServer.listen(PORT, () => {
  isServerReady = true;
  serverStartTime = new Date().toISOString();

  console.log('');
  console.log('='.repeat(70));
  console.log(`🚀 Ghumo backend running on port ${PORT}`);
  console.log(`✅ Server READY at ${serverStartTime}`);
  console.log('');
  console.log('🏓 Keep-Alive Configuration:');
  console.log(`   - Self-ping every 14 minutes to ${RENDER_URL}/ping`);
  console.log('   - Health check: /health');
  console.log('   - Quick ping: /ping');
  console.log('   - Root status: /');
  console.log('');
  console.log('✅ CORS enabled for:');
  console.log('   - http://localhost:5173');
  console.log('   - http://localhost:3000');
  console.log('   - http://localhost:5174');
  console.log('   - https://ghumobackend.onrender.com');
  console.log('   - https://adminfrontend-n30d.onrender.com');
  console.log('');
  console.log('🔔 Notification system enabled');
  console.log('   - Driver/Customer: /api/notifications/*');
  console.log('   - Admin Broadcast: /api/admin/send-fcm');
  console.log('   - Admin Individual: /api/admin/send-individual-notification');
  console.log('   - Admin Offers: /api/admin/offers/all');
  console.log('');
  console.log('💬 Chat system enabled');
  console.log('   - WebSocket: Active');
  console.log('   - REST API: /api/chat/*');
  console.log('');
  console.log('🔐 Session Management enabled');
  console.log('   - Multi-device detection: Active');
  console.log('   - Force logout: Socket.io');
  console.log('   - REST API: /api/auth/*');
  console.log('');
  console.log('🎫 Coupon system enabled');
  console.log('   - Customer Coupons: /api/coupons/*');
  console.log('   - Admin Panel: /api/admin/coupons/*');
  console.log('');
  console.log('🎯 Promotion system enabled');
  console.log('   - Customer: /api/promotions/active');
  console.log('   - Admin Panel: /api/admin/promotions/*');
  console.log('');
  console.log('💰 Plan Management system enabled');
  console.log('   - Plan Types: Basic, Standard, Premium');
  console.log('   - Auto-Expiration: Plans expire automatically');
  console.log('   - Customer Routes: /api/driver/plans/*');
  console.log('   - Admin Routes: /api/admin/plans/*');
  console.log('');
  console.log('⏰ Cron Jobs enabled');
  console.log('   - Self-Ping Keep-Alive: Every 14 minutes');
  console.log('   - Plan Expiry Check: Every hour');
  console.log('   - Driver Stuck Cleanup: Every 5 minutes');
  console.log('   - Standby Reassign: Every 2 minutes');
  console.log('   - SOS Auto-Expire: Every 10 minutes');
  console.log('='.repeat(70));
  console.log('');

  setTimeout(async () => {
    try {
      const res = await fetch(`${RENDER_URL}/ping`);
      console.log(`🏓 Initial self-ping: ${res.status} — Server confirmed reachable`);
    } catch (err) {
      console.warn('⚠️ Initial self-ping failed (may be normal for local dev):', err.message);
    }
  }, 5000);
});

export { io, httpServer };