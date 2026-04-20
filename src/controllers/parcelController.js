// src/controllers/parcelController.js
import asyncHandler from 'express-async-handler';
import Rate from '../models/Rate.js';
import Parcel from '../models/parcel.js';
import { calcFare } from '../utils/fareCalc.js';

/**
 * POST /api/parcels/estimate
 * Body → { state, city, vehicleType, category, distanceKm, weight }
 */
export const estimateParcel = asyncHandler(async (req, res) => {
  const {
    state,
    city,
    vehicleType,
    category,
    distanceKm,
    weight,
  } = req.body;

  const rate = await Rate.findOne({
    state: new RegExp(`^${state}$`, 'i'),
    city : new RegExp(`^${city}$`, 'i'),
    vehicleType,
    category,
  });

  if (!rate) {
    return res.status(404).json({ ok: false, message: 'Rate not found' });
  }

  // Validate weight
  const maxKg = rate.maxWeightKg ?? 10;
  const w = Number(weight) || 0;
  if (w > maxKg) {
    return res.status(400).json({
      ok: false,
      message: `Parcel weight exceeds limit (${maxKg} kg max)`,
    });
  }

  const result = calcFare({ rate, distanceKm, weight });

  res.json({
    ok: true,
    cost: result.total,           // ✅ use total from breakdown
    rateId: rate._id,
  });
});

/**
 * POST /api/parcels/create
 * FormData → state, city, vehicleType, category, distanceKm, weight, pickup/drop, photo
 */
export const createParcel = asyncHandler(async (req, res) => {
  const {
    state,
    city,
    vehicleType,
    category,
    distanceKm,
    weight,
    pickupLat,
    pickupLng,
    dropLat,
    dropLng,
    receiverName,
    receiverPhone,
    notes,
    payment,
  } = req.body;

  // Validate required
  if (!pickupLat || !dropLat || !receiverName || !receiverPhone || !req.file) {
    return res.status(400).json({ ok: false, message: 'Missing required fields' });
  }

  // Lookup rate
  const rate = await Rate.findOne({
    state: new RegExp(`^${state}$`, 'i'),
    city: new RegExp(`^${city}$`, 'i'),
    vehicleType,
    category,
  });

  if (!rate) {
    return res.status(404).json({ ok: false, message: 'Rate not found for that city or vehicle' });
  }

  if (category !== 'parcel' || vehicleType !== 'bike') {
    return res.status(400).json({ ok: false, message: 'Only bike parcels are supported' });
  }

  const maxKg = rate.maxWeightKg ?? 10;
  const w = Number(weight) || 0;
  if (w > maxKg) {
    return res.status(400).json({
      ok: false,
      message: `Parcel weight exceeds limit (${maxKg} kg max)`,
    });
  }

  if (!distanceKm || distanceKm <= 0) {
    return res.status(400).json({ ok: false, message: 'Distance must be positive' });
  }

  // ✅ Calculate parcel fare using full breakdown
  const result = calcFare({ rate, distanceKm, weight });

  // Save to DB
  const parcel = await Parcel.create({
    photoUrl: `/uploads/${req.file.filename}`,
    pickup: {
      lat: pickupLat,
      lng: pickupLng,
    },
    drop: {
      lat: dropLat,
      lng: dropLng,
    },
    receiver: {
      name: receiverName,
      phone: receiverPhone,
    },
    state,
    city,
    vehicleType,
    category,
    distanceKm,
    weight,
    notes,
    payment,
    fare: result.total,           // ✅ save total fare
    rateId: rate._id,
    status: 'pending',
  });

  res.status(201).json({
    ok: true,
    parcelId: parcel._id,
    cost: result.total,           // ✅ send total cost back
    message: 'Parcel created. Waiting for driver.',
  });
});
