import { createServer } from 'http';
import pg from 'pg';
import { config } from './lib/config.ts';
import { createApp } from './app.ts';
import { createIo } from './lib/io.ts';
import { startNotifyService } from './services/notifyService.ts';
import { listTickets, submitTicket, getTicket } from './services/ticketService.ts';
import logger from './lib/logger.ts';
import { startTicketWorker } from './workers/ticketWorker.ts';
import { postgresTicketRepo } from './repositories/ticketRepo.ts';
import { enqueueTicket } from './queues/ticketQueue.ts';

const app = createApp({
  listTickets: () => listTickets({ getAllTicketsFn: postgresTicketRepo.getAllTickets.bind(postgresTicketRepo) }),
  submitTicket: (input) => submitTicket(input, {
    createTicketFn: postgresTicketRepo.createTicket.bind(postgresTicketRepo),
    enqueueTicketFn: enqueueTicket,
  }),
  getTicket: (id) => getTicket(id, {
    getTicketWithPhasesByIdFn: postgresTicketRepo.getTicketWithPhasesById.bind(postgresTicketRepo),
  }),
});

const server = createServer(app);

const io = createIo(server, {
  getEventsByTicketId: postgresTicketRepo.getEventsByTicketId.bind(postgresTicketRepo),
});

const notify = startNotifyService(io, {
  getLatestEventByTicketId: postgresTicketRepo.getLatestEventByTicketId.bind(postgresTicketRepo),
  createClient: () => new pg.Client({ connectionString: config.databaseUrl }),
});

const worker = startTicketWorker();

server.listen(config.port, () => {
  logger.info({ port: config.port }, 'Server started');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Shutting down');
  worker.stop();
  void worker.done.finally(() => notify.stop()).finally(() => server.close(() => process.exit(0)));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
