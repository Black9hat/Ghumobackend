// routes/privacyRoutes.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();

// Get current directory path (ES module workaround)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * GET /api/privacy-policy
 * Serves the privacy policy HTML page
 */
router.get('/privacy-policy', (req, res) => {
  try {
    const privacyPolicyPath = path.join(__dirname, '../public/privacy-policy.html');
    res.sendFile(privacyPolicyPath);
  } catch (error) {
    console.error('❌ Error serving privacy policy:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load privacy policy'
    });
  }
});

export default router;