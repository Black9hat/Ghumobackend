// src/controllers/userController.js
import User from "../models/User.js";
import { normalizePhone, isValidObjectId } from "../utils/phoneNormalizer.js";

/* Helper: convert createdAt to "Month Year" */
function formatMemberSince(createdAt) {
  const date = new Date(createdAt);
  const month = date.toLocaleString("default", { month: "long" });
  const year = date.getFullYear();
  return `${month} ${year}`;
}

/* ================================
   GET USER BY ID (or Firebase UID)
================================ */
export const getUserById = async (req, res) => {
  try {
    console.log("📥 GET /api/user/id/:id called");
    const { id } = req.params;

    let user = await User.findById(id);

    // fallback: firebase uid
    if (!user) {
      user = await User.findOne({ firebaseUid: id });
    }

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    return res.status(200).json({
      message: "Profile fetched successfully.",
      user: {
        ...user._doc,
        memberSince: formatMemberSince(user.createdAt),
      },
    });
  } catch (error) {
    console.error("Error in getUserById:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/* ================================
   SAVE FCM TOKEN (Driver / Customer)
================================ */
export const saveFcmToken = async (req, res) => {
  try {
    const userId = req.user._id;
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ message: "FCM token is required" });
    }

    await User.findByIdAndUpdate(userId, { fcmToken });

    return res.status(200).json({
      success: true,
      message: "FCM token saved successfully",
    });
  } catch (error) {
    console.error("❌ saveFcmToken error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/* ================================
   CREATE or UPDATE USER
================================ */
export const createUser = async (req, res) => {
  try {
    const { phone, name, gender } = req.body;

    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone number format" });
    }

    let user = await User.findOne({ phone: normalizedPhone });

    if (user) {
      // Update existing
      user.name = name ?? user.name;
      user.gender = gender ?? user.gender;
      await user.save();
      return res.status(200).json({ message: "User updated successfully" });
    }

    // Create new
    user = new User({ phone: normalizedPhone, name, gender });
    await user.save();

    return res.status(201).json({ message: "User created successfully" });
  } catch (err) {
    console.error("Error in createUser:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

/* ================================
   UPDATE USER PROFILE BY PHONE
================================ */
export const updateUser = async (req, res) => {
  try {
    console.log("🔧 PUT /api/user/:phone called");
    const { phone } = req.params;
    const normalizedPhone = normalizePhone(phone);
    
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone number format" });
    }

    const body = req.body;

    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) {
      console.warn(`❌ User not found for phone: ${phone} (normalized: ${normalizedPhone})`);
      return res.status(404).json({ message: "User not found." });
    }

    // Apply patch updates (only if field is provided)
    [
      "name",
      "gender",
      "email",
      "dateOfBirth",
      "emergencyContact",
      "role",
      "vehicleType",
      "city",
      "profilePhotoUrl",
      "documentStatus",
    ].forEach((key) => {
      if (body[key] !== undefined) {
        user[key] = body[key];
      }
    });

    await user.save();

    return res.status(200).json({
      message: "Profile updated successfully.",
      user: {
        ...user._doc,
        memberSince: formatMemberSince(user.createdAt),
      },
    });
  } catch (error) {
    console.error("Error in updateUser:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/* ================================
   UPDATE USER PROFILE BY ID (customerId)
================================ */
export const updateUserById = async (req, res) => {
  try {
    console.log("🔧 PUT /api/user/id/:customerId called");
    const { customerId } = req.params;
    
    if (!isValidObjectId(customerId)) {
      console.warn(`❌ Invalid customerId format: ${customerId}`);
      return res.status(400).json({ message: "Invalid customer ID format" });
    }

    const body = req.body;

    let user = await User.findById(customerId);
    if (!user) {
      console.warn(`❌ User not found for customerId: ${customerId}`);
      return res.status(404).json({ message: "User not found." });
    }

    // Apply patch updates (only if field is provided)
    [
      "name",
      "gender",
      "email",
      "dateOfBirth",
      "emergencyContact",
      "role",
      "vehicleType",
      "city",
      "profilePhotoUrl",
      "documentStatus",
    ].forEach((key) => {
      if (body[key] !== undefined) {
        user[key] = body[key];
      }
    });

    await user.save();

    console.log(`✅ Profile updated for user ${customerId} (${user.name})`);
    return res.status(200).json({
      message: "Profile updated successfully.",
      user: {
        ...user._doc,
        memberSince: formatMemberSince(user.createdAt),
      },
    });
  } catch (error) {
    console.error("Error in updateUserById:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/* ================================
   GET USER BY PHONE
================================ */
export const getUser = async (req, res) => {
  try {
    console.log("📥 GET /api/user/:phone called");
    const { phone } = req.params;
    const normalizedPhone = normalizePhone(phone);
    
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone number format" });
    }

    const user = await User.findOne({ phone: normalizedPhone });

    if (!user) {
      console.warn(`❌ User not found for phone: ${phone} (normalized: ${normalizedPhone})`);
      return res.status(404).json({ message: "User not found." });
    }

    return res.status(200).json({
      message: "Profile fetched successfully.",
      user: {
        ...user._doc,
        memberSince: formatMemberSince(user.createdAt),
      },
    });
  } catch (error) {
    console.error("Error in getUser:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/* ================================
   DELETE USER
================================ */
export const deleteUser = async (req, res) => {
  try {
    const { phone } = req.params;
    const normalizedPhone = normalizePhone(phone);
    
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Invalid phone number format" });
    }

    const user = await User.findOneAndDelete({ phone: normalizedPhone });

    if (!user) {
      console.warn(`❌ User not found for phone: ${phone} (normalized: ${normalizedPhone})`);
      return res.status(404).json({ message: "User not found." });
    }

    return res.status(200).json({ message: "Profile deleted successfully." });
  } catch (error) {
    console.error("Error in deleteUser:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};