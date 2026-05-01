// src/routes/driverEarningsRoutes.js
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

router.get('/admin/driver-earnings/plans', verifyAdminToken, getDriverEarningsPlans);
router.post('/admin/driver-earnings/plans', verifyAdminToken, createDriverEarningsPlan);
router.put('/admin/driver-earnings/plans/:planId', verifyAdminToken, updateDriverEarningsPlan);
router.delete('/admin/driver-earnings/plans/:planId', verifyAdminToken, deleteDriverEarningsPlan);
router.get('/admin/driver-earnings/subscriptions', verifyAdminToken, getDriverSubscriptions);

export default router;