import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import routes from './routes/index.js';
import { logger } from './utils/logger.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 5000);

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(pinoHttp({ logger }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api', routes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ message: 'Invalid format' });
    return;
  }

  logger.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

app.listen(port, () => {
  logger.info(`API running on port ${port}`);
});
