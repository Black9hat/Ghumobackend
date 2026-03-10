// src/routes/driverEarningsRoutes.js
// Routes for /api/admin/driver-earnings/* (used by Driverearningsmanagement admin page)

import express from 'express';
import { verifyAdminToken } from '../middlewares/adminAuth.js';
import {
  getDriverEarningsPlans,
  createDriverEarningsPlan,
  updateDriverEarningsPlan,
  deleteDriverEarningsPlan,
  getDriverSubscriptions,
} from '../controllers/driverEarningsController.js';

const router = express.Router();

// Plan CRUD
router.get('/admin/driver-earnings/plans', verifyAdminToken, getDriverEarningsPlans);
router.post('/admin/driver-earnings/plans', verifyAdminToken, createDriverEarningsPlan);
router.put('/admin/driver-earnings/plans/:planId', verifyAdminToken, updateDriverEarningsPlan);
router.delete('/admin/driver-earnings/plans/:planId', verifyAdminToken, deleteDriverEarningsPlan);

// Subscriptions (active DriverPlans with payment completed)
router.get('/admin/driver-earnings/subscriptions', verifyAdminToken, getDriverSubscriptions);

export default router;
