import User from "../models/User.js";

/* =====================================================
   UPDATE DRIVER VEHICLE TYPE
===================================================== */
export const updateDriverVehicleType = async (req, res) => {
  try {
    const userId = req.user.id;
    const { vehicleType } = req.body;

    console.log(`🚗 Vehicle type update request for user: ${userId}`);
    console.log(`   Requested vehicle type: ${vehicleType}`);

    if (!vehicleType) {
      return res.status(400).json({
        success: false,
        message: "Vehicle type is required",
      });
    }

    const normalizedType = vehicleType.toLowerCase().trim();

    // Allow all supported types
    const allowedTypes = ["bike", "auto", "car", "premium", "xl"];

    if (!allowedTypes.includes(normalizedType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid vehicle type. Must be: ${allowedTypes.join(", ")}`,
      });
    }

    const driver = await User.findByIdAndUpdate(
      userId,
      { vehicleType: normalizedType, isDriver: true },
      { new: true }
    );

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    console.log(`✅ Vehicle type updated successfully:`);
    console.log(`   Driver ID: ${driver._id}`);
    console.log(`   Vehicle Type: ${driver.vehicleType}`);
    console.log(`   Phone: ${driver.phone}`);

    res.status(200).json({
      success: true,
      message: `Vehicle type set to ${normalizedType}`,
      vehicleType: driver.vehicleType,
      driver: {
        _id: driver._id,
        phone: driver.phone,
        name: driver.name,
        vehicleType: driver.vehicleType,
        vehicleBrand: driver.vehicleBrand,
        vehicleNumber: driver.vehicleNumber,
        isDriver: driver.isDriver,
        documentStatus: driver.documentStatus,
      },
    });
  } catch (err) {
    console.error("❌ updateDriverVehicleType error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

/* =====================================================
   UPDATE DRIVER PROFILE
===================================================== */
export const updateDriverProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { phoneNumber, name, vehicleNumber, vehicleType, vehicleBrand } =
      req.body;

    console.log("");
    console.log("=".repeat(70));
    console.log("📝 UPDATE DRIVER PROFILE REQUEST");
    console.log(`   User ID: ${userId}`);
    console.log(`   Name: ${name}`);
    console.log(`   Vehicle Number: ${vehicleNumber}`);
    console.log(`   Vehicle Type: ${vehicleType}`);
    console.log(`   Vehicle Brand: ${vehicleBrand || "N/A"}`);
    console.log("=".repeat(70));

    if (!name || !vehicleNumber) {
      return res.status(400).json({
        success: false,
        message: "Name and vehicle number are required",
      });
    }

    const trimmedName = name.trim();
    if (trimmedName.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Name must be at least 3 characters long",
      });
    }

    const trimmedVehicleNumber = vehicleNumber.trim().toUpperCase();
    const vehicleNumberRegex = /^[A-Z]{2}\d{2}[A-Z]{0,2}\d{4}$/;

    if (!vehicleNumberRegex.test(trimmedVehicleNumber)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vehicle number format (e.g., KA01AB1234)",
      });
    }

    const existingDriver = await User.findOne({
      vehicleNumber: trimmedVehicleNumber,
      isDriver: true,
      _id: { $ne: userId },
    });

    if (existingDriver) {
      return res.status(409).json({
        success: false,
        message: "This vehicle number is already registered",
      });
    }

    const updateData = {
      name: trimmedName,
      vehicleNumber: trimmedVehicleNumber,
      isDriver: true, // Ensure driver flag
      updatedAt: new Date(),
    };

    if (vehicleType) {
      const allowedTypes = ["bike", "auto", "car", "premium", "xl"];
      const normalizedType = vehicleType.toLowerCase().trim();
      if (!allowedTypes.includes(normalizedType)) {
        return res.status(400).json({
          success: false,
          message: `Invalid vehicle type. Must be: ${allowedTypes.join(", ")}`,
        });
      }
      updateData.vehicleType = normalizedType;
    }

    if (vehicleBrand) {
      updateData.vehicleBrand = vehicleBrand.trim();
    }

    const updatedDriver = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      {
        new: true,
        runValidators: true,
      }
    ).select(
      "_id name phone vehicleNumber vehicleType vehicleBrand isDriver documentStatus"
    );

    if (!updatedDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    console.log("🎉 PROFILE UPDATED SUCCESSFULLY");
    console.log(updatedDriver);

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      driver: updatedDriver,
    });
  } catch (error) {
    console.error("❌ UPDATE DRIVER PROFILE ERROR", error);

    res.status(500).json({
      success: false,
      message: "Server error while updating profile",
      error:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/* =====================================================
   CLEAR DRIVER STATE
===================================================== */
export const clearDriverState = async (req, res) => {
  try {
    const userIdFromToken = req.user?.id;
    const { driverId: driverIdFromBody } = req.body || {};

    const driverId = userIdFromToken || driverIdFromBody;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    console.log("");
    console.log("=".repeat(70));
    console.log("🧹 CLEAR DRIVER STATE REQUEST");
    console.log(`   driverId: ${driverId}`);
    console.log("=".repeat(70));

    const driver = await User.findById(driverId);

    if (!driver || !driver.isDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    driver.isBusy = false;
    driver.currentTripId = null;
    driver.canReceiveNewRequests = false;

    await driver.save();

    return res.status(200).json({
      success: true,
      message: "Driver state cleared successfully",
      driver: {
        _id: driver._id,
        phone: driver.phone,
        name: driver.name,
        isBusy: driver.isBusy,
        currentTripId: driver.currentTripId,
        canReceiveNewRequests: driver.canReceiveNewRequests,
      },
    });
  } catch (err) {
    console.error("❌ clearDriverState error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};
/* =====================================================
   GO TO DESTINATION (WITH DISTANCE VALIDATION)
===================================================== */

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export const setGoToDestination = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { lat, lng, enabled, radius = 2000 } = req.body;

    // 🔐 AUTH CHECK
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User not authenticated",
      });
    }

    // ✅ REQUIRE lat/lng ONLY WHEN ENABLING
    if (enabled === true && (lat == null || lng == null)) {
      return res.status(400).json({
        success: false,
        message: "lat and lng are required when enabling Go To Destination",
      });
    }

    const driver = await User.findById(userId).select(
      "location goToDestination isDriver"
    );

    if (!driver || !driver.isDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    // ===============================
    // 🟢 ENABLE GO TO DESTINATION
    // ===============================
    if (enabled === true) {
      if (!driver.location?.coordinates) {
        return res.status(400).json({
          success: false,
          message: "Driver current location not available",
        });
      }

      const [driverLng, driverLat] = driver.location.coordinates;

      const distanceKm = calculateDistanceKm(
        driverLat,
        driverLng,
        lat,
        lng
      );

      // ❌ BLOCK IF TOO NEAR
      if (distanceKm <= 3) {
        return res.status(400).json({
          success: false,
          code: "DESTINATION_TOO_NEAR",
          message:
            "You are already near this destination. Go To Destination works only for far locations.",
        });
      }

      driver.goToDestination = {
        enabled: true,
        location: {
          type: "Point",
          coordinates: [lng, lat], // ✅ VALID NUMBERS
        },
        radius,
        enabledAt: new Date(),
        disabledAt: null,
      };

      await driver.save();

      return res.json({
        success: true,
        enabled: true,
        distanceKm: distanceKm.toFixed(2),
        message: "Go To Destination enabled successfully",
      });
    }

    // ===============================
    // 🔴 DISABLE GO TO DESTINATION
    // ===============================
    driver.goToDestination = {
      enabled: false,

      // ✅ KEEP GEO INDEX SAFE
      location: {
        type: "Point",
        coordinates: [0, 0], // ⚠️ MUST be numbers
      },

      radius,
      disabledAt: new Date(),
    };

    await driver.save();

    return res.json({
      success: true,
      enabled: false,
      message: "Go To Destination disabled",
    });

  } catch (error) {
    console.error("setGoToDestination error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

export const getGoToDestinationStatus = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

  const driver = await User.findById(userId)
  .select("goToDestination.enabled isDriver")
  .lean();


    if (!driver || !driver.isDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    return res.json({
      success: true,
      enabled: driver.goToDestination?.enabled === true,
    });
  } catch (error) {
    console.error("getGoToDestinationStatus error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};
