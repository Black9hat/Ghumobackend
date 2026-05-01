// controllers/promotionController.js
import Promotion from '../models/Promotion.js';
import cloudinary from '../utils/cloudinary.js';

/**
 * Upload new promotion to Cloudinary
 * POST /api/admin/promotions/upload
 */
export const uploadPromotion = async (req, res) => {
  try {
    console.log('📸 Upload attempt received');
    console.log('File:', req.file);
    console.log('Body:', req.body);

    if (!req.file) {
      console.log('❌ No file in request');
      return res.status(400).json({ message: 'No image file provided' });
    }

    const { title, target, isStartupBanner } = req.body;
    
    if (!title) {
      if (req.file.filename) {
        await cloudinary.uploader.destroy(req.file.filename);
      }
      return res.status(400).json({ message: 'Title is required' });
    }

    // ✅ Parse target array from request
    let targetArray = ['customer', 'driver']; // Default to both
    if (target) {
      try {
        targetArray = JSON.parse(target);
      } catch (e) {
        console.log('Invalid target format, using default');
      }
    }

    // ✅ Parse isStartupBanner flag
    const isStartupBannerFlag = isStartupBanner === 'true' || isStartupBanner === true;

    const imageUrl = req.file.path;
    const cloudinaryId = req.file.filename;

    console.log('🌐 Cloudinary URL:', imageUrl);
    console.log('🆔 Cloudinary ID:', cloudinaryId);
    console.log('🎯 Target:', targetArray);
    console.log('🚀 Is Startup Banner:', isStartupBannerFlag);

    const maxOrder = await Promotion.findOne().sort('-order').select('order');
    const order = maxOrder ? maxOrder.order + 1 : 0;

    const promotion = await Promotion.create({
      title,
      imageUrl,
      imagePath: cloudinaryId,
      target: targetArray,
      isStartupBanner: isStartupBannerFlag,
      order,
      isActive: true,
    });

    console.log('✅ Promotion created:', promotion._id);

    res.status(201).json({
      message: 'Promotion uploaded successfully',
      promotion,
    });
  } catch (err) {
    console.error('❌ Error uploading promotion:', err);
    
    if (req.file && req.file.filename) {
      try {
        await cloudinary.uploader.destroy(req.file.filename);
        console.log('🗑️ Cleaned up Cloudinary file after error');
      } catch (deleteErr) {
        console.error('Error deleting from Cloudinary:', deleteErr);
      }
    }
    res.status(500).json({ 
      message: 'Server error while uploading promotion',
      error: err.message 
    });
  }
};

/**
 * Get all promotions (Admin)
 * GET /api/admin/promotions
 */
export const getAllPromotions = async (req, res) => {
  try {
    console.log('📋 Fetching all promotions');
    
    const promotions = await Promotion.find({}).sort({ order: 1, createdAt: -1 });
    
    console.log(`✅ Found ${promotions.length} promotions`);
    
    res.status(200).json({
      message: 'Promotions fetched successfully',
      promotions,
    });
  } catch (err) {
    console.error('❌ Error fetching promotions:', err);
    res.status(500).json({ message: 'Server error while fetching promotions' });
  }
};

/**
 * Get active promotions for CUSTOMERS (excluding startup banners)
 * GET /api/promotions/active
 */
export const getActivePromotions = async (req, res) => {
  try {
    console.log('📱 Customer app fetching active promotions');
    
    const promotions = await Promotion.find({ 
      isActive: true,
      target: 'customer',
      isStartupBanner: false // ✅ Exclude startup banners from carousel
    })
      .sort({ order: 1 })
      .select('title imageUrl order');

    console.log(`✅ Returning ${promotions.length} customer promotions`);

    const promotionIds = promotions.map(p => p._id);
    await Promotion.updateMany(
      { _id: { $in: promotionIds } },
      { $inc: { viewCount: 1 } }
    );

    res.status(200).json({
      message: 'Active promotions fetched successfully',
      promotions,
    });
  } catch (err) {
    console.error('❌ Error fetching active promotions:', err);
    res.status(500).json({ message: 'Server error while fetching promotions' });
  }
};

/**
 * Get active promotions for DRIVERS (excluding startup banners)
 * GET /api/promotions/active/driver
 */
export const getActiveDriverPromotions = async (req, res) => {
  try {
    console.log('🚗 Driver app fetching active promotions');
    
    const promotions = await Promotion.find({ 
      isActive: true,
      target: 'driver',
      isStartupBanner: false // ✅ Exclude startup banners from carousel
    })
      .sort({ order: 1 })
      .select('title imageUrl order');

    console.log(`✅ Returning ${promotions.length} driver promotions`);

    const promotionIds = promotions.map(p => p._id);
    await Promotion.updateMany(
      { _id: { $in: promotionIds } },
      { $inc: { viewCount: 1 } }
    );

    res.status(200).json({
      message: 'Active driver promotions fetched successfully',
      promotions,
    });
  } catch (err) {
    console.error('❌ Error fetching driver promotions:', err);
    res.status(500).json({ message: 'Server error while fetching promotions' });
  }
};

/**
 * ✅ NEW: Get active startup banner for CUSTOMERS
 * GET /api/promotions/startup-banner
 */
export const getCustomerStartupBanner = async (req, res) => {
  try {
    console.log('🚀 Customer app fetching startup banner');
    
    const banner = await Promotion.findOne({ 
      isActive: true,
      target: 'customer',
      isStartupBanner: true
    })
      .sort({ order: 1 })
      .select('title imageUrl');

    if (!banner) {
      console.log('ℹ️ No active startup banner found for customers');
      return res.status(200).json({
        message: 'No active startup banner',
        banner: null,
      });
    }

    console.log(`✅ Returning startup banner: ${banner.title}`);

    // Track view
    await Promotion.findByIdAndUpdate(banner._id, {
      $inc: { viewCount: 1 }
    });

    res.status(200).json({
      message: 'Startup banner fetched successfully',
      banner,
    });
  } catch (err) {
    console.error('❌ Error fetching customer startup banner:', err);
    res.status(500).json({ message: 'Server error while fetching startup banner' });
  }
};

/**
 * ✅ NEW: Get active startup banner for DRIVERS
 * GET /api/promotions/startup-banner/driver
 */
export const getDriverStartupBanner = async (req, res) => {
  try {
    console.log('🚀 Driver app fetching startup banner');
    
    const banner = await Promotion.findOne({ 
      isActive: true,
      target: 'driver',
      isStartupBanner: true
    })
      .sort({ order: 1 })
      .select('title imageUrl');

    if (!banner) {
      console.log('ℹ️ No active startup banner found for drivers');
      return res.status(200).json({
        message: 'No active startup banner',
        banner: null,
      });
    }

    console.log(`✅ Returning startup banner: ${banner.title}`);

    // Track view
    await Promotion.findByIdAndUpdate(banner._id, {
      $inc: { viewCount: 1 }
    });

    res.status(200).json({
      message: 'Startup banner fetched successfully',
      banner,
    });
  } catch (err) {
    console.error('❌ Error fetching driver startup banner:', err);
    res.status(500).json({ message: 'Server error while fetching startup banner' });
  }
};

/**
 * Toggle promotion active status
 * PUT /api/admin/promotions/:id/toggle
 */
export const togglePromotionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    console.log(`🔄 Toggling promotion ${id} to ${isActive ? 'active' : 'inactive'}`);

    const promotion = await Promotion.findByIdAndUpdate(
      id,
      { isActive },
      { new: true }
    );

    if (!promotion) {
      return res.status(404).json({ message: 'Promotion not found' });
    }

    console.log('✅ Promotion status updated');

    res.status(200).json({
      message: `Promotion ${isActive ? 'activated' : 'deactivated'} successfully`,
      promotion,
    });
  } catch (err) {
    console.error('❌ Error toggling promotion status:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * ✅ NEW: Toggle startup banner flag
 * PUT /api/admin/promotions/:id/toggle-startup-banner
 */
export const toggleStartupBanner = async (req, res) => {
  try {
    const { id } = req.params;
    const { isStartupBanner } = req.body;

    console.log(`🚀 Toggling startup banner flag for promotion ${id} to ${isStartupBanner}`);

    const promotion = await Promotion.findByIdAndUpdate(
      id,
      { isStartupBanner },
      { new: true }
    );

    if (!promotion) {
      return res.status(404).json({ message: 'Promotion not found' });
    }

    console.log('✅ Startup banner flag updated');

    res.status(200).json({
      message: `Promotion ${isStartupBanner ? 'set as' : 'removed from'} startup banner successfully`,
      promotion,
    });
  } catch (err) {
    console.error('❌ Error toggling startup banner flag:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Delete promotion from database AND Cloudinary
 * DELETE /api/admin/promotions/:id
 */
export const deletePromotion = async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🗑️ Attempting to delete promotion ${id}`);
    
    const promotion = await Promotion.findById(id);

    if (!promotion) {
      return res.status(404).json({ message: 'Promotion not found' });
    }

    try {
      if (promotion.imagePath) {
        const result = await cloudinary.uploader.destroy(promotion.imagePath);
        console.log('🗑️ Cloudinary deletion result:', result);
      }
    } catch (cloudinaryErr) {
      console.error('❌ Error deleting from Cloudinary:', cloudinaryErr);
    }

    await Promotion.findByIdAndDelete(id);

    console.log('✅ Promotion deleted from database');

    res.status(200).json({
      message: 'Promotion deleted successfully',
    });
  } catch (err) {
    console.error('❌ Error deleting promotion:', err);
    res.status(500).json({ message: 'Server error while deleting promotion' });
  }
};

/**
 * Update promotion order
 * PUT /api/admin/promotions/:id/order
 */
export const updatePromotionOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { order } = req.body;

    console.log(`🔢 Updating promotion ${id} order to ${order}`);

    const promotion = await Promotion.findByIdAndUpdate(
      id,
      { order },
      { new: true }
    );

    if (!promotion) {
      return res.status(404).json({ message: 'Promotion not found' });
    }

    console.log('✅ Promotion order updated');

    res.status(200).json({
      message: 'Promotion order updated successfully',
      promotion,
    });
  } catch (err) {
    console.error('❌ Error updating promotion order:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Track promotion click
 * POST /api/promotions/:id/click
 */
export const trackPromotionClick = async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`👆 Click tracked for promotion ${id}`);
    
    await Promotion.findByIdAndUpdate(id, {
      $inc: { clickCount: 1 }
    });

    res.status(200).json({ message: 'Click tracked' });
  } catch (err) {
    console.error('❌ Error tracking click:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const cleanupOldPromotions = async (req, res) => {
  try {
    const result = await Promotion.deleteMany({
      imageUrl: { $not: { $regex: /cloudinary\.com/ } }
    });
    
    res.json({
      message: 'Old promotions cleaned up',
      deletedCount: result.deletedCount
    });
  } catch (err) {
    res.status(500).json({ message: 'Cleanup failed', error: err.message });
  }
};