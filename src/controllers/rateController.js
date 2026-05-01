import asyncHandler from 'express-async-handler';
import Rate         from '../models/Rate.js';

/* GET /api/rates?state=xx&city=yy&vehicleType=zz */
export const getRates = asyncHandler(async (req, res) => {
  const rates = await Rate.find(req.query);
  res.json(rates);
});

/* POST /api/rates  (create) */
export const createRate = asyncHandler(async (req, res) => {
  const rate = await Rate.create(req.body);
  res.status(201).json(rate);
});

/* PUT /api/rates/:id  (full replace) */
export const updateRate = asyncHandler(async (req, res) => {
  const rate = await Rate.findByIdAndUpdate(req.params.id, req.body, { new:true, runValidators:true });
  if (!rate) return res.status(404).json({ message:'Rate not found' });
  res.json(rate);
});

/* DELETE /api/rates/:id */
export const deleteRate = asyncHandler(async (req, res) => {
  const rate = await Rate.findByIdAndDelete(req.params.id);
  if (!rate) return res.status(404).json({ message:'Rate not found' });
  res.json({ message:'Rate deleted' });
});
