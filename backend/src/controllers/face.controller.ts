import type { Request, Response } from 'express';
import { z } from 'zod';
import { compareFaceWithDataset } from '../services/face.service.js';
import { logger } from '../utils/logger.js';

const faceSchema = z.object({
  image: z.string().startsWith('data:image/')
});

export async function compareFace(req: Request, res: Response) {
  const body = faceSchema.parse(req.body);
  const result = await compareFaceWithDataset(body.image);

  req.log.info(
    {
      endpoint: 'POST /api/face',
      request: {
        image: {
          type: 'data-url',
          length: body.image.length
        }
      },
      response: result
    },
    'API_RESPONSE_FACE_MATCH'
  );

  res.json(result);
}
