// src/cron/planExpiryJob.js - Auto-deactivate expired driver plans

import DriverPlan from '../models/DriverPlan.js';

let _intervalId = null;
let _ioInstance = null;

export async function runPlanExpiryJob() {
  try {
    const now = new Date();
    console.log(`⏰ [PlanExpiryJob] Running at ${now.toISOString()}`);

    // Fetch expired plans BEFORE deactivating
    const expiredPlans = await DriverPlan.find({
      isActive: true,
      expiryDate: { $lt: now },
    });

    if (expiredPlans.length > 0) {
      console.log(`📋 [PlanExpiryJob] Found ${expiredPlans.length} expired plan(s)`);

      // Emit plan:expired event to each driver
      if (_ioInstance) {
        expiredPlans.forEach((plan) => {
          try {
            _ioInstance.to(`driver_${plan.driver}`).emit('plan:expired', {
              driverId: plan.driver.toString(),
              planName: plan.planName,
              expiredAt: now.toISOString(),
              message: `⚠️ Your plan "${plan.planName}" has expired. Purchase a new plan to continue earning bonuses!`,
              nextAction: 'Browse and purchase a new plan to maintain earnings boost',
            });
            console.log(
              `✅ [PlanExpiryJob] Emitted plan:expired to driver ${plan.driver}`
            );
          } catch (err) {
            console.warn(
              `⚠️ [PlanExpiryJob] Failed to emit plan:expired for driver ${plan.driver}: ${err.message}`
            );
          }
        });
      }
    }

    const result = await DriverPlan.updateMany(
      {
        isActive: true,
        expiryDate: { $lt: now },
      },
      {
        $set: {
          isActive: false,
          deactivatedDate: now,
          deactivationReason: 'expired',
        },
      }
    );

    if (result.modifiedCount > 0) {
      console.log(
        `✅ [PlanExpiryJob] Deactivated ${result.modifiedCount} expired plan(s)`
      );
    } else {
      console.log(`✅ [PlanExpiryJob] No expired plans found`);
    }

    return result.modifiedCount;
  } catch (error) {
    console.error('❌ [PlanExpiryJob] Error:', error.message);
    return 0;
  }
}

export function startPlanExpiryJob(io) {
  _ioInstance = io; // Store io instance for later use
  const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  runPlanExpiryJob(); // Run immediately on startup
  _intervalId = setInterval(runPlanExpiryJob, INTERVAL_MS);
  console.log('⏰ [PlanExpiryJob] Started — runs every 15 minutes');
  return _intervalId;
}

export function stopPlanExpiryJob() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    _ioInstance = null;
    console.log('⏰ [PlanExpiryJob] Stopped');
  }
}

export default { startPlanExpiryJob, stopPlanExpiryJob, runPlanExpiryJob };