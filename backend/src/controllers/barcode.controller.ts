import type { Request, Response } from 'express';
import { z } from 'zod';
import { InvalidBarcodeError, parseAamvaBarcode } from '../services/barcode.service.js';
import { logger } from '../utils/logger.js';

const barcodeSchema = z.object({
  raw: z.string().min(10)
});

export async function parseBarcode(req: Request, res: Response) {
  const body = barcodeSchema.parse(req.body);
  try {
    const data = parseAamvaBarcode(body.raw);
    const response = { data };

    req.log.info({ endpoint: 'POST /api/barcode', response }, 'API_RESPONSE_BARCODE');
    res.json(response);
  } catch (error) {
    if (error instanceof InvalidBarcodeError) {
      const response = { message: error.message };
      logger.warn({ endpoint: 'POST /api/barcode', response }, 'API_RESPONSE_BARCODE_ERROR');
      res.status(422).json(response);
      return;
    }

    throw error;
  }
}
