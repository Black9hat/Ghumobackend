// routes/admin_service_area_routes.js
import express from 'express';
import ServiceArea from '../models/ServiceArea.js'; // You'll need to create this model

const router = express.Router();

// 🗺️ GET ALL SERVICE AREAS
router.get('/', async (req, res) => {
  try {
    const serviceAreas = await ServiceArea.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      serviceAreas,
    });
  } catch (error) {
    console.error('❌ Error fetching service areas:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch service areas',
    });
  }
});

// 📊 GET STATISTICS
router.get('/stats', async (req, res) => {
  try {
    const totalAreas = await ServiceArea.countDocuments();
    const activeAreas = await ServiceArea.countDocuments({ enabled: true });
    
    const areas = await ServiceArea.find();
    
    let totalCities = 0;
    let totalSpecialZones = 0;
    let totalRadius = 0;
    
    areas.forEach(area => {
      totalCities += area.allowedCities?.length || 0;
      totalSpecialZones += area.specialZones?.length || 0;
      totalRadius += area.radiusKm || 0;
    });
    
    const averageRadius = totalAreas > 0 ? Math.round(totalRadius / totalAreas) : 0;

    const stats = {
      totalAreas,
      activeAreas,
      totalCities,
      totalSpecialZones,
      averageRadius,
    };

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
    });
  }
});

// ➕ CREATE SERVICE AREA
router.post('/', async (req, res) => {
  try {
    const {
      id,
      name,
      enabled,
      center,
      radiusKm,
      allowedCities,
      allowedStates,
      specialZones,
      outOfServiceMessage,
    } = req.body;

    // Validation
    if (!id || !name) {
      return res.status(400).json({
        success: false,
        error: 'Service area ID and name are required',
      });
    }

    if (!center || !center.lat || !center.lng) {
      return res.status(400).json({
        success: false,
        error: 'Center coordinates are required',
      });
    }

    if (!radiusKm || radiusKm <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Radius must be greater than 0',
      });
    }

    if ((!allowedCities || allowedCities.length === 0) && 
        (!allowedStates || allowedStates.length === 0)) {
      return res.status(400).json({
        success: false,
        error: 'At least one city or state must be specified',
      });
    }

    // Check if ID already exists
    const existing = await ServiceArea.findOne({ id: id.toLowerCase() });
    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Service area with this ID already exists',
      });
    }

    // Create service area
    const serviceArea = new ServiceArea({
      id: id.toLowerCase(),
      name,
      enabled: enabled !== undefined ? enabled : true,
      center: {
        lat: Number(center.lat),
        lng: Number(center.lng),
      },
      radiusKm: Number(radiusKm),
      allowedCities: allowedCities || [],
      allowedStates: allowedStates || [],
      specialZones: specialZones || [],
      outOfServiceMessage: outOfServiceMessage || {
        title: 'Oops! We currently don\'t service your drop location.',
        message: 'Please select a different location within our service area',
        suggestions: [],
      },
    });

    await serviceArea.save();

    console.log(`✅ Service area created: ${serviceArea.name}`);

    res.status(201).json({
      success: true,
      serviceArea,
      message: 'Service area created successfully',
    });
  } catch (error) {
    console.error('❌ Error creating service area:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create service area',
    });
  }
});

// ✏️ UPDATE SERVICE AREA
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      enabled,
      center,
      radiusKm,
      allowedCities,
      allowedStates,
      specialZones,
      outOfServiceMessage,
    } = req.body;

    const serviceArea = await ServiceArea.findById(id);

    if (!serviceArea) {
      return res.status(404).json({
        success: false,
        error: 'Service area not found',
      });
    }

    // Update fields
    if (name) serviceArea.name = name;
    if (enabled !== undefined) serviceArea.enabled = enabled;
    if (center) {
      serviceArea.center = {
        lat: Number(center.lat),
        lng: Number(center.lng),
      };
    }
    if (radiusKm) serviceArea.radiusKm = Number(radiusKm);
    if (allowedCities !== undefined) serviceArea.allowedCities = allowedCities;
    if (allowedStates !== undefined) serviceArea.allowedStates = allowedStates;
    if (specialZones !== undefined) serviceArea.specialZones = specialZones;
    if (outOfServiceMessage) serviceArea.outOfServiceMessage = outOfServiceMessage;

    await serviceArea.save();

    console.log(`✅ Service area updated: ${serviceArea.name}`);

    res.json({
      success: true,
      serviceArea,
      message: 'Service area updated successfully',
    });
  } catch (error) {
    console.error('❌ Error updating service area:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update service area',
    });
  }
});

// 🔄 TOGGLE STATUS
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;

    const serviceArea = await ServiceArea.findById(id);

    if (!serviceArea) {
      return res.status(404).json({
        success: false,
        error: 'Service area not found',
      });
    }

    serviceArea.enabled = !serviceArea.enabled;
    await serviceArea.save();

    console.log(`✅ Service area ${serviceArea.enabled ? 'enabled' : 'disabled'}: ${serviceArea.name}`);

    res.json({
      success: true,
      serviceArea,
      message: `Service area ${serviceArea.enabled ? 'enabled' : 'disabled'} successfully`,
    });
  } catch (error) {
    console.error('❌ Error toggling service area:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to toggle service area status',
    });
  }
});

// 🗑️ DELETE SERVICE AREA
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const serviceArea = await ServiceArea.findByIdAndDelete(id);

    if (!serviceArea) {
      return res.status(404).json({
        success: false,
        error: 'Service area not found',
      });
    }

    console.log(`✅ Service area deleted: ${serviceArea.name}`);

    res.json({
      success: true,
      message: 'Service area deleted successfully',
    });
  } catch (error) {
    console.error('❌ Error deleting service area:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete service area',
    });
  }
});

export default router;