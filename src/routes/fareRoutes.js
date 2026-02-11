import { Router } from 'express';
import { createFare } from '../controllers/fareController.js';
import { apiProfiler } from '../middlewares/apiProfiler.js';

const router = Router();

// POST /api/fares/calc  ← PROFILER ENABLED
router.post(
  '/calc',
  apiProfiler('FARE_CALC'),
  createFare
);

// health check
router.get('/ping', (req, res) => res.json({ ok: true }));

export default router;
