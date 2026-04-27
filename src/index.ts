import 'dotenv/config';
import { config } from './lib/config.ts';
import { createApp } from './app.ts';
import { submitTicket, getTicket } from './services/ticketService.ts';
import logger from './lib/logger.ts';
import { startTicketWorker } from './workers/ticketWorker.ts';

const app = createApp({ submitTicket, getTicket });
const worker = startTicketWorker();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Server started');
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
