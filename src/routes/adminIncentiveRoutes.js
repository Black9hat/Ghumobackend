import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import IncentiveCampaign from '../models/IncentiveCampaign.js';
import DriverIncentiveHistory from '../models/DriverIncentiveHistory.js';
import { verifyAdminToken } from '../middlewares/adminAuth.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ======================================================
   UPLOAD DIRECTORY SETUP
====================================================== */

const uploadsDir = path.join(process.cwd(), 'uploads', 'incentives');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

/* ======================================================
   MULTER CONFIG
====================================================== */

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `incentive-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/.test(file.mimetype);
    cb(allowed ? null : new Error('Only image files allowed'), allowed);
  }
});

/* ======================================================
   DRIVER INCENTIVES (USES SAME CAMPAIGN)
====================================================== */

router.get('/driver/incentives', protect, async (req, res) => {
  try {
    const driverId = req.user._id;
    const today = new Date().toISOString().split('T')[0];
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    console.log('🔥 DRIVER INCENTIVES ROUTE HIT');

    let campaign =
      (await IncentiveCampaign.findOne({ date: today, isActive: true })) ||
      (await IncentiveCampaign.findOne({ isActive: true }).sort({ date: -1 }));

    const images = (campaign?.images || []).map(img =>
      img.startsWith('http') ? img : `${baseUrl}${img}`
    );

    const todayHistory = await DriverIncentiveHistory.findOne({
      driverId,
      date: today
    });

    res.json({
      success: true,
      data: {
        images,
        slabs: campaign?.slabs || [],
        today: {
          rides: todayHistory?.ridesCompleted || 0,
          amount: todayHistory?.incentiveEarned || 0
        }
      }
    });
  } catch (error) {
    console.error('❌ Driver incentives error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch driver incentives'
    });
  }
});

/* ======================================================
   ADMIN ROUTES
====================================================== */

// ✅ UPLOAD IMAGE
router.post(
  '/admin/incentives/upload-image',
  verifyAdminToken,
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No image file provided'
        });
      }

      const imageUrl = `/uploads/incentives/${req.file.filename}`;

      console.log('✅ Image uploaded:', {
        filename: req.file.filename,
        size: req.file.size
      });

      res.json({
        success: true,
        imageUrl
      });
    } catch (error) {
      console.error('❌ Upload image error:', error);
      res.status(500).json({ success: false, error: 'Upload failed' });
    }
  }
);

// ✅ DELETE IMAGE
router.delete('/admin/incentives/delete-image', verifyAdminToken, async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ success: false, error: 'imageUrl required' });
    }

    const filename = path.basename(imageUrl);
    const filePath = path.join(uploadsDir, filename);

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await IncentiveCampaign.updateMany(
      { images: imageUrl },
      { $pull: { images: imageUrl } }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Delete image error:', error);
    res.status(500).json({ success: false, error: 'Delete failed' });
  }
});

// ✅ CREATE / UPDATE CAMPAIGN
router.post('/admin/incentives', verifyAdminToken, async (req, res) => {
  try {
    const { date, slabs, images, isActive } = req.body;

    if (!date || !Array.isArray(slabs) || slabs.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid payload' });
    }

   const existingCampaign = await IncentiveCampaign.findOne({ date });

const finalImages = existingCampaign
  ? [...new Set([...(existingCampaign.images || []), ...(images || [])])]
  : images || [];

const campaign = await IncentiveCampaign.findOneAndUpdate(
  { date },
  {
    date,
    slabs,
    images: finalImages,   // ✅ appends, not replaces
    isActive
  },
  { upsert: true, new: true }
);


    res.json({
      success: true,
      data: campaign
    });
  } catch (error) {
    console.error('❌ Save campaign error:', error);
    res.status(500).json({ success: false, error: 'Save failed' });
  }
});

// ✅ ANALYTICS
router.get('/admin/incentives/analytics/overview', verifyAdminToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const match = {};

    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = startDate;
      if (endDate) match.date.$lte = endDate;
    }

    const analytics = await DriverIncentiveHistory.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalDrivers: { $addToSet: '$driverId' },
          totalRides: { $sum: '$ridesCompleted' },
          totalIncentivesPaid: { $sum: '$incentiveEarned' },
          avgRides: { $avg: '$ridesCompleted' },
          avgIncentive: { $avg: '$incentiveEarned' }
        }
      },
      {
        $project: {
          _id: 0,
          totalDrivers: { $size: '$totalDrivers' },
          totalRides: 1,
          totalIncentivesPaid: 1,
          avgRides: { $round: ['$avgRides', 2] },
          avgIncentive: { $round: ['$avgIncentive', 2] }
        }
      }
    ]);

    res.json({
      success: true,
      data: analytics[0] || {
        totalDrivers: 0,
        totalRides: 0,
        totalIncentivesPaid: 0,
        avgRides: 0,
        avgIncentive: 0
      }
    });
  } catch (error) {
    console.error('❌ Analytics error:', error);
    res.status(500).json({ success: false, error: 'Analytics failed' });
  }
});

// ✅ DRIVER HISTORY (ADMIN)
router.get('/admin/incentives/history/:driverId', verifyAdminToken, async (req, res) => {
  try {
    const history = await DriverIncentiveHistory.find({
      driverId: req.params.driverId
    }).sort({ date: -1 });

    res.json({ success: true, data: history });
  } catch (error) {
    console.error('❌ History error:', error);
    res.status(500).json({ success: false, error: 'History failed' });
  }
});

// ✅ GET CAMPAIGN BY DATE (KEEP LAST)
router.get('/admin/incentives/:date', verifyAdminToken, async (req, res) => {
  try {
    const { date } = req.params;

    let campaign = await IncentiveCampaign.findOne({ date }).lean();
    if (!campaign) {
      campaign = {
        date,
        slabs: [
          { rides: 10, amount: 100 },
          { rides: 13, amount: 150 },
          { rides: 15, amount: 200 }
        ],
        images: [],
        isActive: true,
        isDefault: true
      };
    }

    res.json({ success: true, data: campaign });
  } catch (error) {
    console.error('❌ Get campaign error:', error);
    res.status(500).json({ success: false, error: 'Fetch failed' });
  }
});

export default router;
