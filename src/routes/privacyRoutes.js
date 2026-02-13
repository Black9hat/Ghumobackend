// routes/privacyRoutes.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper function to find file in multiple possible locations
const findFile = (filename) => {
  const possiblePaths = [
    path.join(__dirname, '../public', filename),
    path.join(__dirname, '../../public', filename),
    path.join(process.cwd(), 'public', filename),
    path.join(process.cwd(), 'src/public', filename),
    path.join(process.cwd(), filename) // Sometimes files are in root
  ];

  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      return testPath;
    }
  }

  return null;
};

// Serve privacy policy HTML
router.get('/privacy-policy', (req, res) => {
  try {
    const privacyPolicyPath = findFile('privacy-policy.html');
    
    if (!privacyPolicyPath) {
      console.error('❌ Privacy policy file not found');
      console.error('Current working directory:', process.cwd());
      console.error('__dirname:', __dirname);
      
      return res.status(404).json({
        success: false,
        message: 'Privacy policy file not found'
      });
    }

    console.log('✅ Serving privacy policy from:', privacyPolicyPath);
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
    const termsPath = findFile('terms-and-conditions.html');
    
    if (!termsPath) {
      console.error('❌ Terms and conditions file not found');
      console.error('Current working directory:', process.cwd());
      console.error('__dirname:', __dirname);
      
      return res.status(404).json({
        success: false,
        message: 'Terms and conditions file not found'
      });
    }

    console.log('✅ Serving terms and conditions from:', termsPath);
    res.sendFile(termsPath);
  } catch (error) {
    console.error('❌ Error serving terms and conditions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load terms and conditions'
    });
  }
});

// Debug route to check file locations
router.get('/debug-paths', (req, res) => {
  const privacyPath = findFile('privacy-policy.html');
  const termsPath = findFile('terms-and-conditions.html');
  
  res.json({
    cwd: process.cwd(),
    __dirname,
    privacyPolicyPath: privacyPath || 'NOT FOUND',
    termsAndConditionsPath: termsPath || 'NOT FOUND',
    privacyExists: privacyPath ? fs.existsSync(privacyPath) : false,
    termsExists: termsPath ? fs.existsSync(termsPath) : false
  });
});

export default router;
