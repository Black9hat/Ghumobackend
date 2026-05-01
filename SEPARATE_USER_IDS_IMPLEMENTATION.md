# 🔥 Separate User IDs for Driver & Customer Accounts - Implementation Guide

## Problem Statement
Previously, when a user created an account as a customer and later logged in as a driver, the same user ID was used for both roles. This caused:
- Profile changes in one app to affect the other app
- Shared referral codes between roles
- Confusion with session management

## Solution Overview
**Now each phone number can have TWO separate user accounts:**
- One for **customer** role with its own user ID
- One for **driver** role with its own user ID

These are completely independent accounts with separate profiles, rewards, and referrals.

---

## Backend Changes Made

### 1. User Model (`src/models/User.js`)

**Changed:** Phone field is no longer globally unique
```javascript
// ❌ BEFORE
phone: {
  type: String,
  required: true,
  unique: true,  // ← Only allows 1 phone globally
},

// ✅ AFTER
phone: {
  type: String,
  required: true,
  index: true,   // ← Index for faster queries
},
```

**Added:** Compound unique index on `phone + role`
```javascript
// 🔥 NEW COMPOUND INDEX
userSchema.index({ phone: 1, role: 1 }, { unique: true });
// ↑ Now allows phone "9876543210" for BOTH customer AND driver as separate documents
```

### 2. Auth Controller (`src/controllers/authController.js`)

**Changed:** User lookup now includes role
```javascript
// ❌ BEFORE
let user = await User.findOne({ phone: phoneKey });

// ✅ AFTER  
let user = await User.findOne({ phone: phoneKey, role: loginRole });
// ↑ Searches for user with BOTH phone AND role
```

**Removed:** Role conversion logic
```javascript
// ❌ DELETED: This code that converted users between roles
if (loginRole === "driver" && user.role !== "driver") {
  user.role = "driver";
  user.isDriver = true;
  await user.save();
  // ↑ This caused shared user IDs - NOW REMOVED
}
```

---

## Database Migration Required

### ⚠️ BEFORE YOU DEPLOY

You MUST run this migration script to fix existing duplicate users:

```javascript
// migration-separate-user-ids.js
// Run this ONCE before deploying the code changes

const mongoose = require('mongoose');
const User = require('./models/User');

async function migrateSeparateUserIds() {
  try {
    console.log('🔄 Starting migration for separate user IDs...');
    
    // Find all users with duplicate phone+role combinations
    const duplicates = await User.aggregate([
      { $group: { _id: { phone: '$phone', role: '$role' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } }
    ]);

    console.log(`📊 Found ${duplicates.length} duplicate phone+role combinations`);

    // For each duplicate, keep the newest, delete older ones
    for (const dup of duplicates) {
      const users = await User.find({ 
        phone: dup._id.phone, 
        role: dup._id.role 
      }).sort({ createdAt: -1 });

      console.log(`  Processing ${dup._id.phone} (${dup._id.role}): ${users.length} records`);

      // Keep the first (newest), delete the rest
      for (let i = 1; i < users.length; i++) {
        console.log(`    Deleting duplicate: ${users[i]._id}`);
        await User.deleteOne({ _id: users[i]._id });
      }
    }

    // Drop old global phone unique index if it exists
    try {
      await User.collection.dropIndex('phone_1');
      console.log('✅ Dropped old global phone unique index');
    } catch (e) {
      console.log('ℹ️ No old global phone index to drop');
    }

    console.log('✅ Migration complete!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrateSeparateUserIds();
```

### How to Run the Migration

```bash
# 1. Connect to MongoDB
mongo "mongodb://your-connection-string"

# 2. Run the migration script
node migration-separate-user-ids.js

# 3. Verify the compound index was created
db.users.getIndexes()
# ↑ Should show: { "phone": 1, "role": 1 }, unique: true
```

---

## What This Means for Users

### ✅ Before (Old Behavior - FIXED)
```
Phone: +91-9876543210
├── User ID: 507f1f77bcf86cd799439011
│   ├── Role: customer
│   ├── Name: John Doe (Customer)
│   └── Coins: 500
│
└── (Same ID when logged in as driver!)
    ├── Role: driver
    ├── Name: John Doe (Driver) ← Shared name
    └── Vehicle: Bike ← Shared profile
    
# Problem: Name change in customer app affects driver app!
```

### ✅ After (New Behavior - NOW FIXED)
```
Phone: +91-9876543210
├── Customer Account
│   ├── User ID: 507f1f77bcf86cd799439011
│   ├── Role: customer
│   ├── Name: John Doe
│   └── Coins: 500
│
└── Driver Account (SEPARATE ID!)
    ├── User ID: 607f2f88c1g97de8aa55a122 ← Different!
    ├── Role: driver
    ├── Name: John Driver
    ├── Vehicle: Bike
    └── Earnings: ₹2,500

# ✅ Now completely independent accounts!
```

---

## How It Works in the Apps

### Customer App (Unchanged)
```dart
// lib/screens/login_page.dart
// Already sends role: 'customer'
body: jsonEncode({
  'phone': cleanPhone,
  'firebaseUid': uid,
  'role': 'customer',  // ← This ensures customer account
  'deviceInfo': {'deviceId': deviceId},
}),
```

### Driver App (Unchanged)  
```dart
// lib/screens/driver_login_page.dart
// Already sends role: 'driver'
body: jsonEncode({
  'phone': cleanPhone,
  'firebaseUid': uid,
  'role': 'driver',  // ← This ensures driver account
  'deviceInfo': {'deviceId': deviceId},
}),
```

**No frontend changes needed!** The apps already send the correct role.

---

## API Response Changes

The API response will now return **different user IDs** for each role:

```javascript
// POST /api/auth/firebase-sync
// Response when logging in as CUSTOMER
{
  "customerId": "507f1f77bcf86cd799439011",  // Customer ID
  "user": {
    "_id": "507f1f77bcf86cd799439011",
    "phone": "+919876543210",
    "name": "John Doe",
    "role": "customer",
    "coins": 500
  }
}

// Response when logging in as DRIVER (same phone)
{
  "customerId": "607f2f88c1g97de8aa55a122",  // ← DIFFERENT ID!
  "user": {
    "_id": "607f2f88c1g97de8aa55a122",
    "phone": "+919876543210",
    "name": "John Driver",
    "role": "driver",
    "vehicleType": "bike"
  }
}
```

---

## Deployment Checklist

- [ ] **Backup your database** before making any changes
  ```bash
  mongodump --uri "mongodb://..." --out ./backup
  ```

- [ ] **Stop all services** (API, apps, sockets, etc.)

- [ ] **Run the migration script** on your database

- [ ] **Deploy the updated backend code**
  - Updated `src/models/User.js`
  - Updated `src/controllers/authController.js`

- [ ] **Verify the changes**
  ```bash
  # Check the new compound index exists
  db.users.getIndexes()
  
  # Test: Create a new customer account
  # Then: Create a new driver account with same phone
  # Result: Should get TWO different user IDs
  ```

- [ ] **Restart all services**

- [ ] **Test with both apps**
  - Register as customer with phone 9876543210
  - Register as driver with same phone 9876543210
  - Verify different user IDs in both apps
  - Change name in customer app → shouldn't affect driver app ✅

---

## Troubleshooting

### ❌ Getting "Duplicate key error on phone_1"
This means the old unique index still exists. Drop it:
```javascript
db.users.dropIndex("phone_1")
```

### ❌ User can't login with different role
Make sure the migration script ran successfully and the compound index is created:
```javascript
db.users.getIndexes()
// Should show: { "phone": 1, "role": 1 }, unique: true
```

### ❌ Old user IDs not changing
The old data still exists. The migration script preserves existing user IDs (keeps newest, deletes duplicates). New users will get new IDs.

---

## Rollback Plan

If you need to revert:

```javascript
// Restore from backup
mongorestore --uri "mongodb://..." ./backup

// Revert code changes
git revert <commit-hash>

// Restart services
```

---

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| **Unique identifier** | Phone only | Phone + Role |
| **User accounts per phone** | 1 (shared) | 2 (separate) |
| **Profile independence** | No ❌ | Yes ✅ |
| **Referral independence** | No ❌ | Yes ✅ |
| **Database changes** | None | Compound index |
| **API changes** | None | Returns different IDs |
| **App changes** | None | No changes needed |

---

## Questions?

Check the logs during migration:
```bash
tail -f backend.log | grep "🔥\|✅\|❌"
```
