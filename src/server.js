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

// Routes
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

// Coupon Routes
import couponRoutes from './routes/coupons.routes.js';
import adminCouponRoutes from './routes/admin.coupons.routes.js';

import promotionRoutes from './routes/promotionRoutes.js';

// Service Area Routes
import serviceAreaRoutes from './routes/service_area_routes.js';
import adminServiceAreaRoutes from './routes/admin_service_area_routes.js';

// Help/Support Routes
import helpRoutes from './routes/helpRoutes.js';
import adminHelpRoutes from './routes/adminHelpRoutes.js';

// Cron / Reassignment
import standbyReassignCron from './cron/standbyReassignCron.js';

// Sockets
import { initSocket } from './socket/socketHandler.js';

dotenv.config();
await connectDB();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});
const __dirname = path.resolve();

// ============================================================================
// 🔐 ATTACH SOCKET.IO TO REQUESTS (IMPORTANT FOR SESSION MANAGEMENT!)
// ============================================================================
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'))
);

app.get('/', (_req, res) => {
  res.send('🌏 Go India backend live 🚀');
});

// ============================================================================
// INITIALIZE SOCKET.IO WITH SESSION MANAGEMENT
// ============================================================================
initSocket(io);

/**
 * ROUTES
 */
app.use('/api/support', supportRoutes);
app.use('/api', adminIncentiveRoutes);
app.use('/api/driver/incentives', driverIncentiveRoutes);

// Static file serving for uploaded images
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.use("/api/customer/banners", customerBannerRoutes);

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
app.use('/api/chat', chatRoutes);
app.use('/api', rideHistoryRoutes);
app.use('/api/driver', driverRideHistoryRoutes);
app.use('/api', healthRoutes);

// Coupon Routes
app.use('/api/coupons', couponRoutes);
app.use('/api/admin', adminCouponRoutes);

// Promotions
app.use('/api', promotionRoutes);

// Service Area Routes
app.use('/api/service-areas', serviceAreaRoutes);
app.use('/api/admin/service-areas', adminServiceAreaRoutes);

// Help/Support Routes
app.use('/api/help', helpRoutes);
app.use('/api/admin', adminHelpRoutes);

// Legacy ride history route
app.use(rideHistoryRoutes);

/**
 * Debug Logs
 */
console.log('\n📋 Registered Routes:');
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
console.log('    POST /api/admin/promotions/upload');
console.log('    GET  /api/admin/promotions');
console.log('    GET  /api/promotions/active');
console.log('    PUT  /api/admin/promotions/:id/toggle');
console.log('    DELETE /api/admin/promotions/:id');
console.log('    POST /api/promotions/:id/click');
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
console.log('    GET  /api/auth/session-history/:phone\n');

/**
 * STANDBY DRIVER REASSIGN CRON
 */
setInterval(() => {
  standbyReassignCron().catch((err) =>
    console.error('❌ Unhandled cron error:', err)
  );
}, 2 * 60 * 1000);

/**
 * DRIVER STUCK CLEANUP EVERY 5 MINUTES
 */
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

/**
 * 404 Handler
 */
app.use((req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ message: '🔍 Route not found', path: req.path });
});

/**
 * Error Handler
 */
app.use((err, req, res, _next) => {
  console.error('❌ Server error:', err);
  res.status(err.status || 500).json({
    message: err.message || '🚨 Internal Server Error',
  });
});

/**
 * START SERVER
 */
const PORT = process.env.PORT || 5002;
httpServer.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(70));
  console.log(`🚀 Go India server running on port ${PORT}`);
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
  console.log('🗺️ Service Area system enabled');
  console.log('   - Customer: /api/service-area/config');
  console.log('   - Customer: /api/service-area/validate');
  console.log('   - Admin Panel: /api/admin/service-area/*');
  console.log('');
  console.log('🆘 Help/Support system enabled');
  console.log('   - Customer: /api/help/*');
  console.log('   - Admin Panel: /api/admin/help/*');
  console.log('='.repeat(70));
  console.log('');
});

export { io, httpServer };