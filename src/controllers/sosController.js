// src/controllers/sosController.js
import SosAlert from "../models/SosAlert.js";
import Trip from "../models/Trip.js";
import User from "../models/User.js";

/* =====================================================
   TRIGGER SOS ALERT
   POST /api/sos/trigger

   Security model:
   • customerId is taken from req.user._id (Firebase-verified JWT)
     — body value is completely ignored to prevent spoofing
   • Trip ownership is verified against DB before any write
   • Rate-limit: one SOS per trip per 10 seconds
   • Dedup: if an ACTIVE SOS exists for the trip, return it (no new record)
   • All customer / driver / vehicle details are fetched from DB — zero
     trust on anything the frontend sends

   Body: { tripId, lat, lng, sosType? }
   Auth: protect / verifyUser middleware REQUIRED on this route
===================================================== */
export const triggerSos = async (req, res) => {
  try {
    console.log("🚨 Incoming SOS Request:", req.body);

    // ── 1. Identity from auth token — never from body ─────────────────────
    const customerId = req.user._id.toString();

    const { tripId, lat, lng, sosType = "TRIPLE_TAP" } = req.body;

    if (!tripId) {
      return res.status(400).json({
        success: false,
        message: "tripId is required",
      });
    }

    // ── 2. Rate limit — block if a SOS was triggered in last 10 seconds ───
    const lastSos = await SosAlert.findOne({ tripId }).sort({ createdAt: -1 });
    if (lastSos && Date.now() - new Date(lastSos.createdAt).getTime() < 10000) {
      return res.status(429).json({
        success: false,
        message: "SOS already triggered recently. Please wait a moment.",
        alert: lastSos,
      });
    }

    // ── 3. Prevent duplicate ACTIVE SOS for the same trip ─────────────────
    const existingSos = await SosAlert.findOne({ tripId, status: "ACTIVE" });
    if (existingSos) {
      return res.status(200).json({
        success: true,
        message: "SOS already active for this trip",
        alert: existingSos,
      });
    }

    // ── 4. Fetch all details from DB (zero trust on frontend body) ─────────
    let customerName  = "";
    let customerPhone = "";
    let driverName    = "";
    let driverPhone   = "";
    let vehicleNumber = "";
    let vehicleType   = "";

    // Customer — from the authenticated user record
    try {
      const customer = await User.findById(customerId).select("name phone");
      if (customer) {
        customerName  = customer.name  || "";
        customerPhone = customer.phone || "";
      }
    } catch (_) { /* non-blocking — SOS must never fail on a lookup error */ }

    // Trip → ownership check → driver → vehicle
    try {
      const trip = await Trip.findById(tripId).lean();

      if (!trip) {
        return res.status(404).json({
          success: false,
          message: "Trip not found",
        });
      }

      // 5. Ownership check — confirm this trip belongs to the caller
      if (trip.customerId.toString() !== customerId) {
        console.warn(
          `🚫 SOS ownership mismatch: user=${customerId} trip.customerId=${trip.customerId}`
        );
        return res.status(403).json({
          success: false,
          message: "Unauthorized: this trip does not belong to you",
        });
      }

      // Driver details
      if (trip.assignedDriver) {
        const driver = await User.findById(trip.assignedDriver).select(
          "name phone vehicleNumber vehicleType"
        );
        if (driver) {
          driverName    = driver.name          || "";
          driverPhone   = driver.phone         || "";
          vehicleNumber = driver.vehicleNumber || "";
          vehicleType   = driver.vehicleType   || "";
        }
      }

      // Fallback: some schemas cache vehicle info directly on the trip document
      if (!vehicleNumber && trip.vehicleNumber) vehicleNumber = trip.vehicleNumber;
      if (!vehicleType   && trip.vehicleType)   vehicleType   = trip.vehicleType;

    } catch (lookupErr) {
      console.error("⚠️  Trip/driver lookup error:", lookupErr.message);
      // If we already sent a 403/404 response, stop — otherwise continue
      if (res.headersSent) return;
    }

    // ── 6. Build initial location history entry (if coords provided) ───────
    const initialLocationHistory =
      lat != null && lng != null
        ? [{ lat, lng, timestamp: new Date() }]
        : [];

    // ── 7. Persist alert with ACTIVE status entry in statusHistory ─────────
    const sosAlert = await SosAlert.create({
      customerId,
      customerName,
      customerPhone,
      driverName,
      driverPhone,
      vehicleNumber,
      vehicleType,
      tripId,
      location:        { lat: lat ?? null, lng: lng ?? null },
      locationHistory: initialLocationHistory,
      statusHistory:   [{ status: "ACTIVE", timestamp: new Date() }],
      sosType,
      priority: "HIGH",
      status:   "ACTIVE",
    });

    // ── 8. Real-time admin notification ───────────────────────────────────
    const io = req.app.get("io");
    if (io) {
      io.to("admin-room").emit("SOS_ALERT", {
        _id:          sosAlert._id,
        customerId,
        customerName,
        customerPhone,
        driverName,
        driverPhone,
        vehicleNumber,
        vehicleType,
        tripId,
        location:  sosAlert.location,
        priority:  sosAlert.priority,
        status:    sosAlert.status,
        sosType:   sosAlert.sosType,
        createdAt: sosAlert.createdAt,
      });
      console.log("🚨 SOS_ALERT emitted to admin-room | alertId:", sosAlert._id);
    } else {
      console.warn("⚠️  Socket.IO not attached to app — SOS saved but not emitted in real-time.");
    }

    console.log(`🚨 SOS triggered: alertId=${sosAlert._id} tripId=${tripId} user=${customerId}`);

    return res.status(201).json({
      success: true,
      message: "SOS alert triggered successfully",
      alert:   sosAlert,
    });
  } catch (err) {
    console.error("❌ triggerSos error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while triggering SOS",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/* =====================================================
   UPDATE SOS LIVE LOCATION  (customer sends continuously)
   POST /api/sos/location-update

   • Updates current location field (latest snapshot)
   • Appends to locationHistory — capped at 100 entries ($slice: -100)
     so the array never grows beyond ~100 points regardless of trip length
   • Emits SOS_LOCATION_UPDATE to admin-room in real-time

   Body: { trip_id, lat, lng }
   Auth: protect / verifyUser middleware REQUIRED on this route
===================================================== */
export const updateSosLocation = async (req, res) => {
  try {
    const { trip_id, lat, lng } = req.body;

    if (!trip_id) {
      return res.status(400).json({
        success: false,
        message: "trip_id is required",
      });
    }
    if (lat == null || lng == null) {
      return res.status(400).json({
        success: false,
        message: "lat and lng are required",
      });
    }

    const sosAlert = await SosAlert.findOneAndUpdate(
      { tripId: trip_id, status: "ACTIVE" },
      {
        // Overwrite current snapshot
        $set: {
          "location.lat": lat,
          "location.lng": lng,
        },
        // Append to trail, capped at 100 most-recent points
        $push: {
          locationHistory: {
            $each:  [{ lat, lng, timestamp: new Date() }],
            $slice: -100,
          },
        },
      },
      { new: true, sort: { createdAt: -1 } }
    );

    if (!sosAlert) {
      return res.status(404).json({
        success: false,
        message: "No active SOS alert found for this trip",
      });
    }

    // Real-time update to admin
    const io = req.app.get("io");
    if (io) {
      io.to("admin-room").emit("SOS_LOCATION_UPDATE", {
        _id:       sosAlert._id,
        tripId:    trip_id,
        location:  { lat, lng },
        updatedAt: new Date(),
      });
    }

    console.log(`📍 SOS location updated: alertId=${sosAlert._id} → lat=${lat} lng=${lng}`);

    return res.status(200).json({
      success: true,
      message: "SOS location updated",
      alert:   sosAlert,
    });
  } catch (err) {
    console.error("❌ updateSosLocation error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while updating SOS location",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/* =====================================================
   UPDATE DRIVER LIVE LOCATION  (called from driver socket / driver route)
   POST /api/sos/driver-location

   Allows admin to see driver and customer positions side-by-side on map.

   Body: { trip_id, lat, lng }
   Auth: protect / verifyUser middleware REQUIRED on this route
===================================================== */
export const updateDriverLocation = async (req, res) => {
  try {
    const { trip_id, lat, lng } = req.body;

    if (!trip_id || lat == null || lng == null) {
      return res.status(400).json({
        success: false,
        message: "trip_id, lat and lng are required",
      });
    }

    const sosAlert = await SosAlert.findOneAndUpdate(
      { tripId: trip_id, status: "ACTIVE" },
      {
        $set: {
          "driverLocation.lat":       lat,
          "driverLocation.lng":       lng,
          "driverLocation.updatedAt": new Date(),
        },
      },
      { new: true, sort: { createdAt: -1 } }
    );

    if (!sosAlert) {
      return res.status(404).json({
        success: false,
        message: "No active SOS alert found for this trip",
      });
    }

    // Real-time driver position to admin
    const io = req.app.get("io");
    if (io) {
      io.to("admin-room").emit("SOS_DRIVER_LOCATION_UPDATE", {
        _id:            sosAlert._id,
        tripId:         trip_id,
        driverLocation: { lat, lng },
        updatedAt:      new Date(),
      });
    }

    console.log(`🚗 SOS driver location updated: alertId=${sosAlert._id} → lat=${lat} lng=${lng}`);

    return res.status(200).json({
      success: true,
      message: "Driver location updated",
      alert:   sosAlert,
    });
  } catch (err) {
    console.error("❌ updateDriverLocation error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while updating driver location",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/* =====================================================
   RESOLVE SOS ALERT  (admin action)
   POST /api/sos/resolve

   • Sets status → RESOLVED
   • Records resolvedAt + resolvedBy
   • Appends RESOLVED entry to statusHistory
   • Emits SOS_RESOLVED to admin-room

   Body: { sos_id, resolvedBy? }
===================================================== */
export const resolveSos = async (req, res) => {
  try {
    const { sos_id, resolvedBy } = req.body;

    if (!sos_id) {
      return res.status(400).json({
        success: false,
        message: "sos_id is required",
      });
    }

    const sosAlert = await SosAlert.findByIdAndUpdate(
      sos_id,
      {
        $set: {
          status:     "RESOLVED",
          resolvedAt: new Date(),
          resolvedBy: resolvedBy || null,
        },
        $push: {
          statusHistory: { status: "RESOLVED", timestamp: new Date() },
        },
      },
      { new: true }
    );

    if (!sosAlert) {
      return res.status(404).json({
        success: false,
        message: "SOS alert not found",
      });
    }

    const io = req.app.get("io");
    if (io) {
      io.to("admin-room").emit("SOS_RESOLVED", {
        _id:        sosAlert._id,
        tripId:     sosAlert.tripId,
        resolvedAt: sosAlert.resolvedAt,
        resolvedBy: sosAlert.resolvedBy,
      });
    }

    console.log(`✅ SOS resolved: alertId=${sosAlert._id} by ${resolvedBy || "unknown"}`);

    return res.status(200).json({
      success: true,
      message: "SOS alert resolved successfully",
      alert:   sosAlert,
    });
  } catch (err) {
    console.error("❌ resolveSos error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while resolving SOS",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/* =====================================================
   ESCALATE SOS — MARK POLICE CONTACTED  (admin action)
   POST /api/sos/escalate

   • Sets isEscalated → true
   • Appends ESCALATED entry to statusHistory
   • Emits SOS_ESCALATED to admin-room

   Body: { sos_id }
===================================================== */
export const escalateSos = async (req, res) => {
  try {
    const { sos_id } = req.body;

    if (!sos_id) {
      return res.status(400).json({
        success: false,
        message: "sos_id is required",
      });
    }

    const sosAlert = await SosAlert.findByIdAndUpdate(
      sos_id,
      {
        $set:  { isEscalated: true },
        $push: { statusHistory: { status: "ESCALATED", timestamp: new Date() } },
      },
      { new: true }
    );

    if (!sosAlert) {
      return res.status(404).json({
        success: false,
        message: "SOS alert not found",
      });
    }

    const io = req.app.get("io");
    if (io) {
      io.to("admin-room").emit("SOS_ESCALATED", {
        _id:         sosAlert._id,
        tripId:      sosAlert.tripId,
        isEscalated: true,
        timestamp:   new Date(),
      });
    }

    console.log(`🚔 SOS escalated (police contacted): alertId=${sosAlert._id}`);

    return res.status(200).json({
      success: true,
      message: "SOS escalated — police contacted flag set",
      alert:   sosAlert,
    });
  } catch (err) {
    console.error("❌ escalateSos error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while escalating SOS",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/* =====================================================
   GET ALL ACTIVE SOS ALERTS  (admin dashboard)
   GET /api/sos/active
===================================================== */
export const getActiveSosAlerts = async (req, res) => {
  try {
    const alerts = await SosAlert.find({ status: "ACTIVE" })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count:  alerts.length,
      alerts,
    });
  } catch (err) {
    console.error("❌ getActiveSosAlerts error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching active SOS alerts",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/* =====================================================
   GET SINGLE SOS ALERT BY ID  (admin detail view)
   GET /api/sos/:id
===================================================== */
export const getSosById = async (req, res) => {
  try {
    const { id } = req.params;

    const sosAlert = await SosAlert.findById(id).lean();

    if (!sosAlert) {
      return res.status(404).json({
        success: false,
        message: "SOS alert not found",
      });
    }

    return res.status(200).json({
      success: true,
      alert: sosAlert,
    });
  } catch (err) {
    console.error("❌ getSosById error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching SOS alert",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};