// zone.js — Mongoose Schema
// Supports: city > cluster > area hierarchy, exclusion zones, surge, vehicle types

import mongoose from 'mongoose';

const CoordSchema = new mongoose.Schema(
  { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
  { _id: false }
);

const ExclusionSchema = new mongoose.Schema({
  name:    { type: String, default: 'Excluded Area' },
  polygon: { type: [CoordSchema], required: true },
});

const ZoneSchema = new mongoose.Schema({
  name:           { type: String, required: true, trim: true },

  // type hierarchy:  city > cluster > area
  type:           { type: String, enum: ['city', 'cluster', 'area'], default: 'cluster' },

  // parentId links clusters → city, areas → cluster
  parentId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },

  polygon:        { type: [CoordSchema], required: true, validate: { validator: v => v.length >= 3, message: 'Polygon needs at least 3 points' } },
  exclusionZones: { type: [ExclusionSchema], default: [] },

  serviceEnabled: { type: Boolean, default: true },
  surgeMultiplier:{ type: Number, default: 1, min: 1 },
  driverIncentive:{ type: Number, default: 0, min: 0 },
  vehicleTypes:   { type: [String], enum: ['Bike','Auto','Car','Premium Car','XL'], default: ['Bike','Auto','Car','Premium Car','XL'] },

  // OSM / Nominatim source reference (for auto-generated clusters)
  osmId:          { type: String, default: null },
  osmType:        { type: String, default: null },   // 'relation' | 'way' | 'node'

  createdAt:      { type: Date, default: Date.now },
  updatedAt:      { type: Date, default: Date.now },
});

ZoneSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });

export default mongoose.model('Zone', ZoneSchema);
