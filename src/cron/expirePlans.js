// src/cron/expirePlans.js - Auto-expire driver plans when they pass their expiry date

import cron from 'node-cron';
import DriverPlan from '../models/DriverPlan.js';

/**
 * Find and mark all expired driver plans as inactive.
 * Called at server startup and then hourly.
 */
export const runExpirePlansJob = async () => {
  try {
    const expiredPlans = await DriverPlan.find({
      isActive: true,
      expiryDate: { $lt: new Date() },
      paymentStatus: 'completed',
    });

    for (const plan of expiredPlans) {
      await plan.markAsExpired();
      console.log(`[CRON] Expired plan ${plan._id} for driver ${plan.driver}`);
    }

    if (expiredPlans.length > 0) {
      console.log(`[CRON] Auto-expired ${expiredPlans.length} driver plan(s)`);
    }
  } catch (error) {
    console.error('[CRON] Error expiring plans:', error);
  }
};

/**
 * Start the plan expiry cron job.
 * Runs immediately on startup, then every hour.
 */
export const startExpirePlansCron = () => {
  // Run immediately at startup
  runExpirePlansJob().catch((err) =>
    console.error('[CRON] Initial plan expiry run failed:', err)
  );

  // Schedule to run every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Running scheduled plan expiry check...');
    await runExpirePlansJob();
  });

  console.log('✅ Plan expiry cron started (runs every hour)');
};
