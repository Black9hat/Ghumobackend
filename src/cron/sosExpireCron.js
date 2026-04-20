// src/cron/sosExpireCron.js
import SosAlert from "../models/SosAlert.js";

/**
 * Auto-resolve SOS alerts that have been ACTIVE for more than 2 hours.
 *
 * Why this matters:
 *   - Admin might resolve via socket but connection drop means DB never updated
 *   - Edge cases where customer closes app mid-SOS without resolving
 *   - Prevents stale ACTIVE alerts clogging the admin dashboard forever
 *
 * Called every 10 minutes from server.js via setInterval.
 * Safe to run concurrently — updateMany is atomic per document.
 */
export const expireOldSos = async () => {
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const result = await SosAlert.updateMany(
      {
        status: "ACTIVE",
        createdAt: { $lt: twoHoursAgo },
      },
      {
        $set: {
          status:     "RESOLVED",
          resolvedAt: new Date(),
          resolvedBy: "AUTO_SYSTEM",
        },
        $push: {
          statusHistory: {
            status:    "AUTO_RESOLVED",
            timestamp: new Date(),
          },
        },
      }
    );

    if (result.modifiedCount > 0) {
      console.log(
        `⏰ [SOS Cron] Auto-resolved ${result.modifiedCount} stale SOS alert(s) older than 2 hours`
      );
    }
  } catch (err) {
    // Non-fatal — log and continue. Never crash the server over a cron job.
    console.error("❌ [SOS Cron] expireOldSos error:", err.message);
  }
};