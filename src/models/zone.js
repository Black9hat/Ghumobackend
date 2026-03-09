import mongoose from 'mongoose';

const coordinateSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  { _id: false }
);

const zoneSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  type: {
    type: String,
    enum: ['city', 'cluster', 'area'],
    required: true,
  },
  polygon: {
    type: [coordinateSchema],
    required: true,
    validate: {
      validator: (arr) => arr.length >= 3,
      message: 'A polygon must have at least 3 coordinates.',
    },
  },
  serviceEnabled: {
    type: Boolean,
    default: true,
  },
  surgeMultiplier: {
    type: Number,
    default: 1,
    min: 1,
  },
  driverIncentive: {
    type: Number,
    default: 0,
    min: 0,
  },
  vehicleTypes: {
    type: [String],
    enum: ['Bike', 'Auto', 'Car', 'Premium Car', 'XL'],
    default: ['Bike', 'Auto', 'Car', 'Premium Car', 'XL'],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Zone = mongoose.model('Zone', zoneSchema);

export default Zone;
