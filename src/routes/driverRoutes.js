import express from "express";
import { uploadDriverProfilePhoto } from "../controllers/driverProfileController.js";
import {
  uploadDriverDocument,
  getDriverDocuments,
  getDriverById,
  getDriverProfile,

  resendDriverDocument,
} from "../controllers/documentController.js";
import { protect } from "../middlewares/authMiddleware.js";
import { uploadDocument, uploadProfilePhoto } from "../middlewares/multer.js";
import {
  updateDriverVehicleType,
  updateDriverProfile,
  clearDriverState,  
      setGoToDestination, // 👈 ADD THIS
        getGoToDestinationStatus,   // 👈 ADD THIS

        // 👈 NEW IMPORT
} from "../controllers/driverController.js";
import User from "../models/User.js";

const router = express.Router();

/**
 * @route   GET /api/driver/nearby
 * @desc    Get nearby online drivers within specified radius
 * @access  Protected
 */
router.get("/nearby", protect, async (req, res) => {
  try {
    const { lat, lng, radius = 2 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude are required",
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const radiusKm = parseFloat(radius);

    if (isNaN(latitude) || isNaN(longitude) || isNaN(radiusKm)) {
      return res.status(400).json({
        success: false,
        message: "Invalid coordinate or radius values",
      });
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({
        success: false,
        message: "Coordinates out of valid range",
      });
    }

    console.log(`🔍 Searching for drivers near: [${latitude}, ${longitude}] within ${radiusKm}km`);

    // ✅ FIX: Only find TRULY online drivers with recent location updates
    const drivers = await User.find({
      isDriver: true,
      isOnline: true,
      
      // ✅ CRITICAL: Only drivers who updated location in last 10 minutes
      lastLocationUpdate: {
        $exists: true,
        $ne: null,
        $gte: new Date(Date.now() - 10 * 60 * 1000)
      },
      
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [longitude, latitude],
          },
          $maxDistance: radiusKm * 1000,
        },
      },
    })
      .select("name phone vehicleType location rating vehicleBrand vehicleNumber lastLocationUpdate")
      .limit(50)
      .lean();

    console.log(`✅ Found ${drivers.length} nearby ACTIVE drivers`);

    // ✅ DEBUG: Show each driver's last update time
    drivers.forEach((driver) => {
      const minutesAgo = Math.round((Date.now() - new Date(driver.lastLocationUpdate)) / 60000);
      console.log(`   📍 ${driver.name}: updated ${minutesAgo} min ago`);
    });

    const formattedDrivers = drivers.map((driver) => ({
      id: driver._id.toString(),
      name: driver.name || "Driver",
      phone: driver.phone || "",
      vehicleType: driver.vehicleType || "bike",
      lat: driver.location.coordinates[1],
      lng: driver.location.coordinates[0],
      rating: driver.rating || 4.5,
      vehicleBrand: driver.vehicleBrand || "",
      vehicleNumber: driver.vehicleNumber || "",
    }));

    return res.status(200).json(formattedDrivers);
  } catch (error) {
    console.error("❌ Error in /api/driver/nearby:", error);

    if (error.name === "MongoError" && error.code === 27) {
      return res.status(500).json({
        success: false,
        message: "Geospatial index not found. Please ensure location field has a 2dsphere index.",
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to fetch nearby drivers",
      error: error.message,
    });
  }
});


/**
 * @route   GET /api/driver/profile
 * @desc    Get authenticated driver's own profile
 * @access  Protected
 */
router.get("/profile", protect, getDriverProfile);

/**
 * @route   POST /api/driver/setVehicleType
 * @desc    Update driver's vehicle type
 * @access  Protected
 */
router.post("/setVehicleType", protect, updateDriverVehicleType);

/**
 * @route   POST /api/driver/updateProfile
 * @desc    Update driver profile (name, vehicle number, vehicle type)
 * @access  Protected
 */
router.post("/updateProfile", protect, updateDriverProfile);

/**
 * @route   POST /api/driver/clear-state
 * @desc    Clear driver state (isBusy, currentTripId, canReceiveNewRequests)
 * @access  Protected
 */
router.post("/clear-state", protect, clearDriverState);
/**
 * @route   POST /api/driver/go-to-destination
 * @desc    Enable / Disable Go To Destination
 * @access  Protected
 */
router.post(
  "/go-to-destination",
  protect,
  setGoToDestination
);
router.get(
  "/go-to-destination/status",
  protect,
  getGoToDestinationStatus
);

/**
 * @route   GET /api/driver/documents/:driverId
 * @desc    Get driver documents by driver ID
 * @access  Protected
 */
router.get("/documents/:driverId", protect, getDriverDocuments);

/**
 * @route   POST /api/driver/uploadProfilePhoto
 * @desc    Upload driver profile photo
 * @access  Protected
 */
router.post(
  "/uploadProfilePhoto",
  protect,
  uploadProfilePhoto.single("image"),
  uploadDriverProfilePhoto
);

/**
 * @route   POST /api/driver/uploadDocument
 * @desc    Upload driver verification document
 * @access  Protected
 */
router.post(
  "/uploadDocument",
  protect,
  uploadDocument.single("document"),
  uploadDriverDocument
);

/**
 * @route   GET /api/driver/:driverId
 * @desc    Get driver details by ID
 * @access  Protected
 */
router.get("/:driverId", protect, getDriverById);

/**
 * @route   PUT /api/driver/documents/:docId/resend
 * @desc    Mark document as pending so driver can resend
 * @access  Protected
 */
router.put("/documents/:docId/resend", protect, resendDriverDocument);

export default router;
