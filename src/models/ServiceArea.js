// models/ServiceArea.js
import mongoose from 'mongoose';

const SpecialZoneSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  lat: {
    type: Number,
    required: true,
  },
  lng: {
    type: Number,
    required: true,
  },
  radiusKm: {
    type: Number,
    required: true,
    default: 5,
  },
}, { _id: false });

const OutOfServiceMessageSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    default: 'Oops! We currently don\'t service your drop location.',
  },
  message: {
    type: String,
    required: true,
    default: 'Please select a different location within our service area',
  },
  suggestions: {
    type: [String],
    default: [],
  },
}, { _id: false });

const ServiceAreaSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  enabled: {
    type: Boolean,
    default: true,
    index: true,
  },
  center: {
    lat: {
      type: Number,
      required: true,
    },
    lng: {
      type: Number,
      required: true,
    },
  },
  radiusKm: {
    type: Number,
    required: true,
    min: 1,
  },
  allowedCities: {
    type: [String],
    default: [],
    lowercase: true,
  },
  allowedStates: {
    type: [String],
    default: [],
    lowercase: true,
  },
  specialZones: {
    type: [SpecialZoneSchema],
    default: [],
  },
  outOfServiceMessage: {
    type: OutOfServiceMessageSchema,
    default: () => ({
      title: 'Oops! We currently don\'t service your drop location.',
      message: 'Please select a different location within our service area',
      suggestions: [],
    }),
  },
}, {
  timestamps: true,
});

// Index for geospatial queries (optional, for future optimization)
ServiceAreaSchema.index({ 'center.lat': 1, 'center.lng': 1 });

// Method to validate if a location is within service area
ServiceAreaSchema.methods.isLocationValid = function(lat, lng, city, state) {
  // Check city match
  if (city && this.allowedCities.some(c => city.toLowerCase().includes(c))) {
    return true;
  }

  // Check state match
  if (state && this.allowedStates.some(s => state.toLowerCase().includes(s))) {
    return true;
  }

  // Check special zones
  for (const zone of this.specialZones) {
    const distance = calculateDistance(lat, lng, zone.lat, zone.lng);
    if (distance <= zone.radiusKm) {
      return true;
    }
  }

  // Check main radius
  const distance = calculateDistance(lat, lng, this.center.lat, this.center.lng);
  return distance <= this.radiusKm;
};

// Helper function to calculate distance
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return degrees * (Math.PI / 180);
}

const ServiceArea = mongoose.model('ServiceArea', ServiceAreaSchema);

export default ServiceArea;