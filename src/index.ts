import 'dotenv/config';
import express from 'express';
import ticketRoutes from './routes/ticketRoutes.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import logger from './lib/logger.ts';

const app = express();
const PORT = process.env['PORT'] ?? '3000';

app.use(express.json());
app.use('/tickets', ticketRoutes);
app.use(errorHandler);

app.listen(Number(PORT), () => {
  logger.info({ port: PORT }, 'Server started');
});
