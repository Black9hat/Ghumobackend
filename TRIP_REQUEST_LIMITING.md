# Trip Request Broadcasting - Documentation Index

> **⚠️ UPDATE (Phase 5)**: This documentation has been superseded by a more sophisticated system.

---

## Current System: Progressive Distance Expansion

The trip broadcasting system now uses **intelligent distance-based expansion** instead of time-based retries.

### What Changed:
- **Old Approach**: Send to same drivers at T=0 and T=10 (2 attempts with 10-second gap)
- **New Approach**: Send to drivers in expanding circles: 2km → 3km → 5km with 5-second gaps

### Benefits:
- ✅ Reaches nearby drivers **immediately** (no waiting)
- ✅ Gradually expands to capture drivers who were far away
- ✅ **Zero duplicates**: Each driver sees trip only once
- ✅ **50% bandwidth reduction**: Don't broadcast to distant drivers upfront

---

## For Complete Documentation

**👉 See: [PROGRESSIVE_DISTANCE_BROADCAST.md](PROGRESSIVE_DISTANCE_BROADCAST.md)**

That file contains:
- Three-stage broadcasting strategy (2km → 3km → 5km)
- Backend implementation details
- Frontend behavior & deduplication
- Real-world scenarios with examples
- Configuration & customization guide
- Performance metrics & monitoring
- Troubleshooting tips

---

## Quick Reference

| Aspect | Details |
|--------|---------|
| **Stage 1** | T=0s, 2km radius |
| **Stage 2** | T=5s, 3km radius (5s delay) |
| **Stage 3** | T=10s, 5km radius (10s total) |
| **Duplicates** | None (tracked via Set) |
| **File** | `src/utils/tripRetryBroadcaster.js` |
| **Frontend** | `lib/screens/driver_dashboard_page.dart` |
| **Duration** | 10 seconds total |

---

## Legacy Content

The previous version (time-based with MAX_RETRY_ATTEMPTS = 2) has been fully replaced. If you need to understand the old system for historical reference, this document previously contained:
- Retry-based broadcasting (T=0, T=10, T=20)
- MAX_RETRY_ATTEMPTS constant logic
- Two-attempt limitation strategy

This approach is **no longer used**. All active code uses the progressive distance system documented in [PROGRESSIVE_DISTANCE_BROADCAST.md](PROGRESSIVE_DISTANCE_BROADCAST.md).

---

## Key Files

- **Backend**: `src/utils/tripRetryBroadcaster.js` (progressive stages)
- **Broadcasting**: `src/utils/tripBroadcaster.js` (Socket + FCM hybrid)
- **Frontend**: `lib/screens/driver_dashboard_page.dart` (trip queue UI)
- **Trip Creation**: `src/controllers/tripController.js` (initiates broadcast)
- **Main Doc**: [PROGRESSIVE_DISTANCE_BROADCAST.md](PROGRESSIVE_DISTANCE_BROADCAST.md)

---

## Questions?

Refer to the comprehensive guide at [PROGRESSIVE_DISTANCE_BROADCAST.md](PROGRESSIVE_DISTANCE_BROADCAST.md) for:
- Architecture overview
- Configuration examples
- Real-world scenarios
- Troubleshooting
- Monitoring setup

// Current: 20 seconds between attempts
const RETRY_INTERVAL_MS = 20000;

// To change to 30 seconds:
// const RETRY_INTERVAL_MS = 30000;
```

Edit `lib/screens/driver_dashboard_page.dart`:

```dart
// Current: 2 maximum occurrences per trip
const MAX_OCCURRENCES = 2;

// To change to 3:
// const MAX_OCCURRENCES = 3;

// Current: 20-second gap enforcement
if (diffSeconds < 20) return true;

// To change to 30 seconds:
// if (diffSeconds < 30) return true;
```

---

## Performance Impact

### Memory Usage
- **Per-trip tracking**: ~50 bytes per tripId in `_tripVisibilityTracking`
- **Cleanup**: Automatic removal after 2 minutes of inactivity
- **Impact**: Negligible (typical < 1MB even with 1000+ trips)

### CPU Usage
- **Retry interval**: Same as before (20s)
- **Attempt limit enforcement**: O(1) integer comparison
- **Impact**: Reduced (fewer broadcasts = less socket I/O)

### Network Bandwidth
- **Broadcast reduction**: 50%+ fewer messages when drivers don't accept
- **Per-trip**: 2 broadcasts max vs. unlimited before
- **Impact**: Significant improvement in high-traffic scenarios

---

## Backward Compatibility

✅ **Fully backward compatible**
- No breaking changes to Trip model
- Socket events unchanged
- Payload structure enhanced but compatible
- Existing driver apps work without update

---

## Future Enhancements

1. **Per-Zone retry configuration**: Different retry limits based on demand
2. **Dynamic retry interval**: Adaptive timing based on driver acceptance rate
3. **Smart retry**: Skip drivers who consistently reject trips
4. **Analytics**: Track retry effectiveness per vehicle type/zone

---

## Related Files Modified

1. ✅ `src/utils/tripRetryBroadcaster.js` - Backend retry limiting
2. ✅ `lib/screens/driver_dashboard_page.dart` - Frontend deduplication
3. 📄 `COMPLETE_PLAN_COMMISSION_FLOW.md` (if trip flow documented)

---

## Questions & Support

For issues or questions about this implementation:
1. Check the logs first (search for "Max retries" or "Trip tracking")
2. Verify both backend and frontend changes are deployed
3. Clear driver app cache and restart if deduplication issues persist
4. Monitor socket broadcast logs for retry patterns
