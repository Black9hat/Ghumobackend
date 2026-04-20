import User from "../models/User.js";
import { getDistance } from "../utils/distanceCalculator.js";
import mongoose from "mongoose";

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
    console.log(`   Is Online: ${driver.isOnline}`);
    console.log(`   Socket ID: ${driver.socketId || "NOT SET"}`);
    console.log(`   FCM Token: ${driver.fcmToken ? "SET" : "NOT SET"}`);

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
    // ✅ NEW: extract `seats` from request body
    const { phoneNumber, name, vehicleNumber, vehicleType, vehicleBrand, seats, vehicleModel } =
      req.body;

    console.log("");
    console.log("=".repeat(70));
    console.log("📝 UPDATE DRIVER PROFILE REQUEST");
    console.log(`   User ID: ${userId}`);
    console.log(`   Name: ${name}`);
    console.log(`   Vehicle Number: ${vehicleNumber}`);
    console.log(`   Vehicle Type: ${vehicleType}`);
    console.log(`   Vehicle Brand: ${vehicleBrand || "N/A"}`);
    console.log(`   Vehicle Model: ${vehicleModel || "N/A"}`);
    console.log(`   Seats: ${seats ?? "N/A"}`);
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

    // ✅ Save vehicleModel (free text or predefined dropdown value)
    if (vehicleModel !== undefined && vehicleModel !== null) {
      const trimmedModel = String(vehicleModel).trim();
      if (trimmedModel.length > 0) {
        updateData.vehicleModel = trimmedModel;
      }
    }

    // ✅ Save seats + auto-upgrade to xl for 6-seaters
    // seats must be 4 or 6; 6 seats automatically forces vehicleType = "xl"
    if (seats !== undefined && seats !== null) {
      const seatsNum = Number(seats);
      if ([4, 6].includes(seatsNum)) {
        updateData.seats = seatsNum;
        if (seatsNum === 6) {
          // 6-seat vehicles are always XL — no admin override needed
          updateData.vehicleType = "xl";
          console.log("   🔄 Auto-setting vehicleType=xl for 6-seat vehicle");
        }
      }
    }

    const updatedDriver = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      {
        new: true,
        runValidators: false,   // ✅ false: avoids enum/required errors on partial updates
      }
    ).select(
      "_id name phone vehicleNumber vehicleType vehicleBrand vehicleModel seats isDriver documentStatus"
    );

    if (!updatedDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    console.log("🎉 PROFILE UPDATED SUCCESSFULLY");
    console.log(`   Driver ID: ${updatedDriver._id}`);
    console.log(`   Name: ${updatedDriver.name}`);
    console.log(`   Vehicle Number: ${updatedDriver.vehicleNumber}`);
    console.log(`   Vehicle Type: ${updatedDriver.vehicleType}`);
    console.log(`   Vehicle Model: ${updatedDriver.vehicleModel || "N/A"}`);
    console.log(`   Seats: ${updatedDriver.seats || "N/A"}`);
    console.log(`   Is Online: ${updatedDriver.isOnline}`);
    console.log(`   Socket ID: ${updatedDriver.socketId || "NOT SET"}`);
    console.log(`   Document Status: ${updatedDriver.documentStatus || "PENDING"}`);

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

    // 🔐 DEBUG LOGGING
    console.log("🔍 setGoToDestination called");
    console.log("   📝 Request body:", req.body);
    console.log("   🔑 userId:", userId);
    console.log("   📍 lat:", lat, "| lng:", lng, "| enabled:", enabled);
    console.log("   👤 req.user:", req.user ? { id: req.user.id, phone: req.user.phone } : "null");

    // 🔐 AUTH CHECK
    if (!userId) {
      console.log("❌ AUTH FAILED: userId not found");
      return res.status(400).json({
        success: false,
        message: "User not authenticated",
      });
    }

    // ✅ REQUIRE lat/lng ONLY WHEN ENABLING
    if (enabled === true && (lat == null || lng == null)) {
      console.log("❌ VALIDATION FAILED: lat or lng is null");
      console.log("   lat:", lat, "| lng:", lng, "| enabled:", enabled);
      return res.status(400).json({
        success: false,
        message: "lat and lng are required when enabling Go To Destination",
      });
    }

    const driver = await User.findById(userId).select(
      "location goToDestination isDriver"
    );

    if (!driver || !driver.isDriver) {
      console.log("❌ DRIVER NOT FOUND or not a driver");
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    console.log("✅ Driver found:", driver._id);
    console.log("   📍 Driver location:", driver.location?.coordinates);

    // ===============================
    // 🟢 ENABLE GO TO DESTINATION
    // ===============================
    if (enabled === true) {
      if (!driver.location?.coordinates) {
        console.log("❌ ENABLE FAILED: Driver location not available");
        return res.status(400).json({
          success: false,
          message: "Driver current location not available",
        });
      }

      const [driverLng, driverLat] = driver.location.coordinates;

      const distanceKm = getDistance(
        driverLat,
        driverLng,
        lat,
        lng
      );

      console.log("📏 Distance calculation:");
      console.log("   Driver location: [" + driverLat + ", " + driverLng + "]");
      console.log("   Destination: [" + lat + ", " + lng + "]");
      console.log("   Distance: " + distanceKm + " km");

      // ❌ BLOCK IF TOO NEAR
      if (distanceKm <= 0.1) {
        console.log("❌ ENABLE FAILED: Destination too near (" + distanceKm + " km)");
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

      console.log("✅ Go To Destination ENABLED successfully");
      console.log("   Distance: " + distanceKm.toFixed(2) + " km");

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

/* =====================================================
   SAVE GO TO DESTINATION LOCATION
===================================================== */

export const saveGoToDestinationLocation = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { name, category, lat, lng, address } = req.body;

    console.log("🔍 saveGoToDestinationLocation called");
    console.log("   name:", name);
    console.log("   category:", category);
    console.log("   lat:", lat, "| lng:", lng);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User not authenticated",
      });
    }

    if (!name || !category || lat == null || lng == null) {
      return res.status(400).json({
        success: false,
        message: "name, category, lat, and lng are required",
      });
    }

    const driver = await User.findById(userId);

    if (!driver || !driver.isDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    // Create new location object
    const newLocation = {
      _id: new mongoose.Types.ObjectId(),
      name: name.trim(),
      category: category,
      location: {
        type: "Point",
        coordinates: [lng, lat],
      },
      address: address || name,
      isActive: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Add to saved locations
    if (!driver.goToDestinationLocations) {
      driver.goToDestinationLocations = [];
    }

    driver.goToDestinationLocations.push(newLocation);
    await driver.save();

    console.log("✅ Location saved successfully");

    return res.json({
      success: true,
      message: "Location saved successfully",
      location: newLocation,
    });
  } catch (error) {
    console.error("saveGoToDestinationLocation error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/* =====================================================
   GET GO TO DESTINATION SAVED LOCATIONS
===================================================== */

export const getGoToDestinationLocations = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User not authenticated",
      });
    }

    const driver = await User.findById(userId).select(
      "goToDestinationLocations isDriver"
    );

    if (!driver || !driver.isDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    const locations = (driver.goToDestinationLocations || []).map((loc) => ({
      id: loc._id.toString(),
      name: loc.name,
      category: loc.category,
      lat: loc.location.coordinates[1],
      lng: loc.location.coordinates[0],
      address: loc.address,
      isActive: loc.isActive,
      createdAt: loc.createdAt,
    }));

    console.log("✅ Retrieved " + locations.length + " saved locations");

    return res.json({
      success: true,
      locations: locations,
    });
  } catch (error) {
    console.error("getGoToDestinationLocations error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/* =====================================================
   TOGGLE GO TO DESTINATION LOCATION ACTIVE/INACTIVE
===================================================== */

export const toggleGoToDestinationLocation = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { locationId } = req.params;
    const { isActive } = req.body;

    console.log("🔍 toggleGoToDestinationLocation called");
    console.log("   locationId:", locationId);
    console.log("   isActive:", isActive);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User not authenticated",
      });
    }

    const driver = await User.findById(userId);

    if (!driver || !driver.isDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    // Find and update the location
    const location = driver.goToDestinationLocations.id(locationId);

    if (!location) {
      return res.status(404).json({
        success: false,
        message: "Location not found",
      });
    }

    // If activating, deactivate all others
    if (isActive === true) {
      driver.goToDestinationLocations.forEach((loc) => {
        loc.isActive = false;
      });
    }

    location.isActive = isActive;
    location.updatedAt = new Date();

    await driver.save();

    console.log("✅ Location toggled successfully");

    return res.json({
      success: true,
      message: "Location updated successfully",
      location: {
        id: location._id.toString(),
        name: location.name,
        isActive: location.isActive,
      },
    });
  } catch (error) {
    console.error("toggleGoToDestinationLocation error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/* =====================================================
   UPDATE GO TO DESTINATION LOCATION NAME
===================================================== */

export const updateGoToDestinationLocation = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { locationId } = req.params;
    const { name } = req.body;

    console.log("🔍 updateGoToDestinationLocation called");
    console.log("   locationId:", locationId);
    console.log("   name:", name);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User not authenticated",
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "name is required",
      });
    }

    const driver = await User.findById(userId);

    if (!driver || !driver.isDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    // Find and update the location
    const location = driver.goToDestinationLocations.id(locationId);

    if (!location) {
      return res.status(404).json({
        success: false,
        message: "Location not found",
      });
    }

    location.name = name.trim();
    location.updatedAt = new Date();

    await driver.save();

    console.log("✅ Location name updated successfully");

    return res.json({
      success: true,
      message: "Location updated successfully",
      location: {
        id: location._id.toString(),
        name: location.name,
      },
    });
  } catch (error) {
    console.error("updateGoToDestinationLocation error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/* =====================================================
   DELETE GO TO DESTINATION LOCATION
===================================================== */

export const deleteGoToDestinationLocation = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { locationId } = req.params;

    console.log("🔍 deleteGoToDestinationLocation called");
    console.log("   locationId:", locationId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User not authenticated",
      });
    }

    const driver = await User.findById(userId);

    if (!driver || !driver.isDriver) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    // Find and remove the location
    const location = driver.goToDestinationLocations.id(locationId);

    if (!location) {
      return res.status(404).json({
        success: false,
        message: "Location not found",
      });
    }

    location.deleteOne();
    await driver.save();

    console.log("✅ Location deleted successfully");

    return res.json({
      success: true,
      message: "Location deleted successfully",
    });
  } catch (error) {
    console.error("deleteGoToDestinationLocation error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};