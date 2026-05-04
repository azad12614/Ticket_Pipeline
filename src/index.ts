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
import { enqueueTicket, sqsClient, QUEUE_URL } from './queues/ticketQueue.ts';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { pool } from './lib/db.ts';
import { startDlqConsumer } from './consumers/dlqConsumer.ts';

const app = createApp({
  listTickets: () =>
    listTickets({ getAllTicketsFn: postgresTicketRepo.getAllTickets.bind(postgresTicketRepo) }),
  submitTicket: input =>
    submitTicket(input, {
      createTicketFn: postgresTicketRepo.createTicket.bind(postgresTicketRepo),
      enqueueTicketFn: enqueueTicket,
      insertEventFn: postgresTicketRepo.insertEvent.bind(postgresTicketRepo),
    }),
  getTicket: id =>
    getTicket(id, {
      getTicketWithPhasesByIdFn:
        postgresTicketRepo.getTicketWithPhasesById.bind(postgresTicketRepo),
    }),
  retry: {
    getTicketByIdFn: postgresTicketRepo.getTicketById.bind(postgresTicketRepo),
    getLatestEventByTicketIdFn: postgresTicketRepo.getLatestEventByTicketId.bind(postgresTicketRepo),
    getTicketWithPhasesByIdFn: postgresTicketRepo.getTicketWithPhasesById.bind(postgresTicketRepo),
    resetFailedPhasesFn: postgresTicketRepo.resetFailedPhases.bind(postgresTicketRepo),
    updateTicketStatusFn: postgresTicketRepo.updateTicketStatus.bind(postgresTicketRepo),
    transitionTicketStatusFn: postgresTicketRepo.transitionTicketStatus.bind(postgresTicketRepo),
    insertEventFn: postgresTicketRepo.insertEvent.bind(postgresTicketRepo),
    enqueueTicketFn: enqueueTicket,
  },
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
const dlqConsumer = startDlqConsumer({
  insertEventFn: postgresTicketRepo.insertEvent.bind(postgresTicketRepo),
  failTicketFn: postgresTicketRepo.failTicket.bind(postgresTicketRepo),
  enqueueTicketFn: enqueueTicket,
});

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function checkDependencies(retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // DB check
      await pool.query('SELECT 1');
      // SQS check: queue attributes
      await sqsClient.send(
        new GetQueueAttributesCommand({ QueueUrl: QUEUE_URL, AttributeNames: ['QueueArn'] }),
      );
      logger.info('Dependency checks passed');
      return;
    } catch (err) {
      logger.error({ err, attempt }, 'Dependency check failed');
      if (attempt < retries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

void (async () => {
  try {
    await checkDependencies();
  } catch (err) {
    logger.error({ err }, 'Startup dependency check failed — aborting');
    process.exit(1);
  }

  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server started');
  });
})();

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Shutting down');
  worker.stop();
  dlqConsumer.stop();
  void worker.done.finally(() => notify.stop()).finally(() => server.close(() => process.exit(0)));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
