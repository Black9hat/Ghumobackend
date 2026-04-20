// Add to your routes file (e.g., standbyRoutes.js or a debug routes file)
import { getStandbyStatus } from '../controllers/standbyController.js';

router.get('/debug/standby/:tripId', async (req, res) => {
  try {
    const status = await getStandbyStatus(req.params.tripId);
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});