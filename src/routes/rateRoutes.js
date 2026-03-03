import { Router }             from 'express';
import {
  getRates,
  createRate,
  updateRate,
  deleteRate,
} from '../controllers/rateController.js';

const router = Router();

router.route('/')
  .get(getRates)     // list / filter
  .post(createRate); // create

router.route('/:id')
  .put(updateRate)
  .delete(deleteRate);

export default router;
