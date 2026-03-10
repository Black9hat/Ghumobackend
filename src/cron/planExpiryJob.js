// src/cron/planExpiryJob.js - Auto-deactivate expired driver plans

import DriverPlan from '../models/DriverPlan.js';

/**
 * Runs every 15 minutes.
 * Finds all DriverPlan records where:
 *   - isActive = true
 *   - expiryDate < now
 * And marks them as expired.
 */
export async function runPlanExpiryJob() {
  try {
    const now = new Date();
    console.log(`⏰ [PlanExpiryJob] Running at ${now.toISOString()}`);

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
      console.log(`✅ [PlanExpiryJob] Deactivated ${result.modifiedCount} expired plan(s)`);
    } else {
      console.log(`✅ [PlanExpiryJob] No expired plans found`);
    }

    return result.modifiedCount;
  } catch (error) {
    console.error('❌ [PlanExpiryJob] Error:', error.message);
    return 0;
  }
}

/**
 * Start the cron job — runs every 15 minutes using setInterval.
 * Call this once from server startup.
 */
export function startPlanExpiryJob() {
  const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  // Run immediately on startup
  runPlanExpiryJob();

  // Then run every 15 minutes
  const intervalId = setInterval(runPlanExpiryJob, INTERVAL_MS);

  console.log('⏰ [PlanExpiryJob] Started — runs every 15 minutes');

  return intervalId;
}

export default { startPlanExpiryJob, runPlanExpiryJob };
