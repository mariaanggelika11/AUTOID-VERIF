import { Router } from 'express';
import { parseBarcode } from '../controllers/barcode.controller.js';
import { compareFace } from '../controllers/face.controller.js';

const router = Router();

router.post('/barcode', parseBarcode);
router.post('/face', compareFace);

export default router;
