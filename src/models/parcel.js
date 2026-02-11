// src/models/Parcel.js
import mongoose from 'mongoose';

const parcelSchema = new mongoose.Schema({
  state: String,
  city: String,
  vehicleType: String,
  category: String,
  distanceKm: Number,
  weight: Number,
  pickupLat: Number,
  pickupLng: Number,
  dropLat: Number,
  dropLng: Number,
  receiverName: String,
  receiverPhone: String,
  notes: String,
  payment: String,
  cost: Number,
  photoUrl: String,
}, {
  timestamps: true,
});

const Parcel = mongoose.model('Parcel', parcelSchema);
export default Parcel;
