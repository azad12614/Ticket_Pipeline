import 'dotenv/config';
import express from 'express';
import ticketRoutes from './routes/ticketRoutes.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import logger from './lib/logger.ts';
import { startTicketWorker } from './workers/ticketWorker.ts';

const app = express();
const PORT = process.env['PORT'] ?? '3000';

app.use(express.json());
app.use('/tickets', ticketRoutes);
app.use(errorHandler);

const worker = startTicketWorker();

const server = app.listen(Number(PORT), () => {
  logger.info({ port: PORT }, 'Server started');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Shutting down');
  worker.stop();
  void worker.done.finally(() => {
    server.close(() => {
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
