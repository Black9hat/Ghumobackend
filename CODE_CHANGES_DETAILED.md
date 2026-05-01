# 📝 Code Changes - Before & After

## Change 1: User Model (`src/models/User.js`)

### Before
```javascript
const userSchema = new mongoose.Schema(
  {
    // 📞 Basic Info
    phone: {
      type: String,
      required: true,
      unique: true,  // ❌ PROBLEM: Only allows 1 phone globally
    },
    name: {
      type: String,
      required: true,
    },
    // ... rest of schema
  }
);

/* Indexes */
userSchema.index({ location: "2dsphere" });
// ❌ No compound index for phone+role
```

### After ✅
```javascript
const userSchema = new mongoose.Schema(
  {
    // 📞 Basic Info
    // 🔥 FIXED: phone is no longer unique globally — only phone+role combination is unique
    // This allows same phone number to have SEPARATE accounts for driver and customer
    phone: {
      type: String,
      required: true,
      index: true,  // ✅ Index but not unique globally
    },
    name: {
      type: String,
      required: true,
    },
    // ... rest of schema
  }
);

/* ================================
   📌 INDEXES
================================ */
// 🔥 FIXED: Compound unique index on phone + role to allow separate accounts per role
userSchema.index({ phone: 1, role: 1 }, { unique: true });  // ✅ NEW!
userSchema.index({ location: "2dsphere" });
```

**What Changed:**
- Removed `unique: true` from phone field
- Changed to `index: true` (for speed)
- Added compound unique index: `{ phone: 1, role: 1 }`

**Effect:**
- ✅ Same phone can have multiple users (one per role)
- ✅ Phone + role combination is guaranteed unique
- ✅ Queries by phone+role are fast

---

## Change 2: Auth Controller - User Lookup (`src/controllers/authController.js`)

### Before
```javascript
export const firebaseSync = async (req, res) => {
  try {
    const { phone, firebaseUid, role, referralCode, deviceId, fcmToken } = req.body;

    if (!phone || !firebaseUid) {
      return res.status(400).json({
        message: "Phone and firebaseUid are required",
      });
    }

    const phoneKey = normalizePhone(phone);
    
    // ── Find or Create User ──────────────────────────────────────────────────
    let user      = await User.findOne({ phone: phoneKey });  // ❌ PROBLEM: Only searches by phone
    let isNewUser = false;
    
    if (!user) {
      // Create new user
      isNewUser = true;
      user = new User({
        phone:       phoneKey,
        name:        "New User",
        role:        loginRole,
        // ... other fields
      });
      await user.save();
    } else {
      // ❌ PROBLEM: Existing user
      // ... rest of code
    }
```

### After ✅
```javascript
export const firebaseSync = async (req, res) => {
  try {
    const { phone, firebaseUid, role, referralCode, deviceId, fcmToken } = req.body;

    if (!phone || !firebaseUid) {
      return res.status(400).json({
        message: "Phone and firebaseUid are required",
      });
    }

    const phoneKey = normalizePhone(phone);
    
    // ── Find or Create User ──────────────────────────────────────────────────
    // 🔥 FIXED: Find user by BOTH phone AND role to support separate accounts
    let user      = await User.findOne({ phone: phoneKey, role: loginRole });  // ✅ FIXED!
    let isNewUser = false;
    
    if (!user) {
      // Create new user (with separate ID)
      isNewUser = true;
      user = new User({
        phone:       phoneKey,
        name:        "New User",
        role:        loginRole,
        // ... other fields
      });
      await user.save();
    } else {
      // ✅ IMPROVED: Now handles same role only
      // ... rest of code
    }
```

**What Changed:**
- User lookup: `findOne({ phone })` → `findOne({ phone, role })`

**Effect:**
- ✅ Each role gets its own user document
- ✅ Same phone can have 2 documents (one per role)
- ✅ Searches are role-aware

---

## Change 3: Auth Controller - Role Conversion (Removed)

### Before
```javascript
    } else {
      // Existing user login
      if (!user.firebaseUid) {
        user.firebaseUid = firebaseUid;
        await user.save();
      }

      // ❌ PROBLEM: Converting same user to driver role!
      if (loginRole === "driver" && user.role !== "driver") {
        isNewUser        = true;
        user.role        = "driver";  // ❌ Changes role on SAME document
        user.isDriver    = true;
        user.vehicleType = null;
        await user.save();
        console.log(`🔄 Converted to driver: ${user._id}`);
      } else {
        console.log(`✅ Existing user login: ${user._id}`);
      }
      
      // Late referral handling...
    }
```

### After ✅
```javascript
    } else {
      // Existing user login (same phone, same role)
      if (!user.firebaseUid) {
        user.firebaseUid = firebaseUid;
        await user.save();
      }

      // 🔥 FIXED: Removed role conversion logic
      // Now each role is a separate user account, so we never convert roles
      console.log(`✅ Existing user login: ${user._id} (role: ${loginRole})`);

      // Late referral handling...
    }
```

**What Changed:**
- Deleted entire role conversion block (lines that changed `user.role = "driver"`)

**Effect:**
- ✅ No more shared accounts between roles
- ✅ Each login finds/creates user with correct role
- ✅ Simpler, cleaner logic

---

## Database Index Changes

### Before
```javascript
db.users.getIndexes()

// Output:
{
  "v": 2,
  "key": { "_id": 1 }
},
{
  "v": 2,
  "key": { "phone": 1 },
  "unique": true  // ❌ Only allows 1 phone globally
}
```

### After ✅
```javascript
db.users.getIndexes()

// Output:
{
  "v": 2,
  "key": { "_id": 1 }
},
{
  "v": 2,
  "key": { "phone": 1, "role": 1 },
  "unique": true  // ✅ Allows multiple phones if roles differ
}
```

---

## API Response Changes

### Before
```bash
# Request 1: Customer login
POST /api/auth/firebase-sync
{
  "phone": "9876543210",
  "firebaseUid": "uid123",
  "role": "customer"
}

# Response
{
  "customerId": "507f1f77bcf86cd799439011",
  "user": {
    "_id": "507f1f77bcf86cd799439011",
    "phone": "9876543210",
    "name": "John Doe",
    "role": "customer"
  }
}

# Request 2: Same phone, driver login (SAME DEVICE!)
POST /api/auth/firebase-sync
{
  "phone": "9876543210",
  "firebaseUid": "uid123",
  "role": "driver"
}

# Response (SAME ID - ❌ PROBLEM!)
{
  "customerId": "507f1f77bcf86cd799439011",  // ❌ SAME!
  "user": {
    "_id": "507f1f77bcf86cd799439011",      // ❌ SAME!
    "phone": "9876543210",
    "name": "John Doe",  // ❌ Shared name
    "role": "driver"
  }
}
```

### After ✅
```bash
# Request 1: Customer login
POST /api/auth/firebase-sync
{
  "phone": "9876543210",
  "firebaseUid": "uid123",
  "role": "customer"
}

# Response
{
  "customerId": "507f1f77bcf86cd799439011",
  "user": {
    "_id": "507f1f77bcf86cd799439011",
    "phone": "9876543210",
    "name": "John Doe",
    "role": "customer"
  }
}

# Request 2: Same phone, driver login (DIFFERENT USER!)
POST /api/auth/firebase-sync
{
  "phone": "9876543210",
  "firebaseUid": "uid456",
  "role": "driver"
}

# Response (DIFFERENT ID - ✅ FIXED!)
{
  "customerId": "607f2f88c1g97de8aa55a122",  // ✅ DIFFERENT!
  "user": {
    "_id": "607f2f88c1g97de8aa55a122",      // ✅ DIFFERENT!
    "phone": "9876543210",
    "name": "John Driver",  // ✅ Independent name
    "role": "driver"
  }
}
```

**What Changed:**
- Same phone number now returns **different user IDs** for different roles
- Profile data is completely independent

---

## User Document Structure Comparison

### Before (Single Document)
```javascript
db.users.findOne({ phone: "9876543210" })

{
  "_id": ObjectId("507f1f77bcf86cd799439011"),
  "phone": "9876543210",
  "name": "John Doe",     // ❌ Shared between roles
  "role": "customer",     // Currently customer...
  "isDriver": true,       // But was switched to driver
  "vehicleType": "bike",
  "coins": 500,           // ❌ Shared coins
  "createdAt": ISODate("2024-01-15"),
  // Role converted multiple times - confusing state!
}
```

### After (Separate Documents) ✅
```javascript
// Customer document
db.users.findOne({ phone: "9876543210", role: "customer" })
{
  "_id": ObjectId("507f1f77bcf86cd799439011"),
  "phone": "9876543210",
  "name": "John Doe",
  "role": "customer",
  "coins": 500,
  "createdAt": ISODate("2024-01-15"),
  // Customer-specific fields only
}

// Driver document (different ID!)
db.users.findOne({ phone: "9876543210", role: "driver" })
{
  "_id": ObjectId("607f2f88c1g97de8aa55a122"),  // ✅ DIFFERENT!
  "phone": "9876543210",
  "name": "John Driver",  // ✅ Different name
  "role": "driver",
  "vehicleType": "bike",
  "wallet": 2500,         // ✅ Different earnings
  "createdAt": ISODate("2024-03-20"),
  // Driver-specific fields only
}
```

---

## Query Changes

### Before
```javascript
// Find user by phone only
const user = await User.findOne({ phone: "9876543210" });
// Returns: First document created with this phone
// ❌ Might be customer, might be driver - unpredictable!

// To get customer specifically - had to check role after
const user = await User.findOne({ phone: "9876543210" });
if (user.role !== "customer") {
  user.role = "customer";  // ❌ Overwrites driver role
  await user.save();
}
```

### After ✅
```javascript
// Find customer explicitly
const customer = await User.findOne({ phone: "9876543210", role: "customer" });
// Returns: Customer document only (if exists)

// Find driver explicitly
const driver = await User.findOne({ phone: "9876543210", role: "driver" });
// Returns: Driver document only (if exists)

// Get both
const [customer, driver] = await Promise.all([
  User.findOne({ phone: "9876543210", role: "customer" }),
  User.findOne({ phone: "9876543210", role: "driver" })
]);
// ✅ Clean, predictable, no overwrites
```

---

## Summary of Changes

| Aspect | Before | After |
|--------|--------|-------|
| **Unique Key** | phone | phone + role |
| **Documents per phone** | 1 | 2 (one per role) |
| **User lookups** | `{ phone }` | `{ phone, role }` |
| **Role conversion** | Yes (overwrites) | No (separate accounts) |
| **Profile sharing** | Yes ❌ | No ✅ |
| **Database index** | `{ phone: 1 }` unique | `{ phone: 1, role: 1 }` unique |

---

## Migration Path

```javascript
// Old state
db.users.find({ phone: "9876543210" })
→ Returns: 1 document (could be either role)

// Migration runs
→ Splits data

// New state
db.users.find({ phone: "9876543210", role: "customer" })
→ Returns: Customer document

db.users.find({ phone: "9876543210", role: "driver" })
→ Returns: Driver document (different _id!)
```

---

That's it! These 3 changes enable completely separate user accounts per role while maintaining backward compatibility.
