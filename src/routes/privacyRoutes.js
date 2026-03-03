// routes/privacyRoutes.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve privacy policy HTML
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

// Serve terms and conditions HTML
router.get('/terms-and-conditions', (req, res) => {
  try {
    const termsPath = path.join(__dirname, '../public/terms-and-conditions.html');
    res.sendFile(termsPath);
  } catch (error) {
    console.error('❌ Error serving terms and conditions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load terms and conditions'
    });
  }
});

export default router;