// routes/service_area_routes.js
import express from 'express';
import ServiceArea from '../models/ServiceArea.js';

const router = express.Router();

// 📡 GET - Service area configuration (for Flutter app)
router.get('/config', async (req, res) => {
  try {
    // Get all enabled service areas
    const activeAreas = await ServiceArea.find({ enabled: true }).sort({ createdAt: 1 });

    if (activeAreas.length === 0) {
      // Return default Hyderabad config if no areas configured
      return res.json({
        success: true,
        serviceAreas: [{
          id: 'hyderabad',
          name: 'Hyderabad',
          enabled: true,
          center: {
            lat: 17.3850,
            lng: 78.4867,
          },
          radiusKm: 50,
          allowedCities: ['hyderabad', 'secunderabad'],
          allowedStates: ['telangana'],
          specialZones: [],
          outOfServiceMessage: {
            title: 'Oops! We currently don\'t service your drop location.',
            message: 'Please select a different location within Hyderabad',
            suggestions: [
              'Try locations within Hyderabad',
              'We serve all areas up to 50km from city center',
            ],
          },
        }],
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
      });
    }

    // Format response
    const formattedAreas = activeAreas.map(area => ({
      id: area.id,
      name: area.name,
      enabled: area.enabled,
      center: {
        lat: area.center.lat,
        lng: area.center.lng,
      },
      radiusKm: area.radiusKm,
      allowedCities: area.allowedCities || [],
      allowedStates: area.allowedStates || [],
      specialZones: area.specialZones || [],
      outOfServiceMessage: area.outOfServiceMessage || {
        title: 'Oops! We currently don\'t service your drop location.',
        message: 'Please select a different location within our service area',
        suggestions: [],
      },
      lastUpdated: area.updatedAt,
    }));

    res.json({
      success: true,
      serviceAreas: formattedAreas,
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Error fetching service area config:', error);
    
    // Return default config on error
    res.json({
      success: true,
      serviceAreas: [{
        id: 'hyderabad',
        name: 'Hyderabad',
        enabled: true,
        center: {
          lat: 17.3850,
          lng: 78.4867,
        },
        radiusKm: 50,
        allowedCities: ['hyderabad', 'secunderabad'],
        allowedStates: ['telangana'],
        specialZones: [],
        outOfServiceMessage: {
          title: 'Oops! We currently don\'t service your drop location.',
          message: 'Please select a different location within Hyderabad',
          suggestions: [],
        },
      }],
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
    });
  }
});

// ✅ POST - Validate location (server-side validation)
router.post('/validate', async (req, res) => {
  try {
    const { lat, lng, city, state } = req.body;

    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        error: 'Location coordinates required',
      });
    }

    // Get all enabled service areas
    const activeAreas = await ServiceArea.find({ enabled: true });

    if (activeAreas.length === 0) {
      // No service areas configured - allow all
      return res.json({
        success: true,
        isValid: true,
        serviceArea: 'Default',
        message: 'Location is in service area',
      });
    }

    // Check if location is valid in any service area
    let validArea = null;
    for (const area of activeAreas) {
      if (area.isLocationValid(lat, lng, city, state)) {
        validArea = area;
        break;
      }
    }

    if (validArea) {
      res.json({
        success: true,
        isValid: true,
        serviceArea: validArea.name,
        message: 'Location is in service area',
      });
    } else {
      // Get first area's message (or default)
      const message = activeAreas[0]?.outOfServiceMessage || {
        title: 'Oops! We currently don\'t service your drop location.',
        message: 'Please select a different location within our service area',
      };

      res.json({
        success: true,
        isValid: false,
        serviceArea: null,
        message: message.message,
        title: message.title,
        suggestions: message.suggestions || [],
      });
    }
  } catch (error) {
    console.error('❌ Error validating location:', error);
    res.status(500).json({
      success: false,
      error: 'Validation failed',
    });
  }
});

export default router;