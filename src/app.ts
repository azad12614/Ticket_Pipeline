import express from 'express';
import helmet from 'helmet';
import { createTicketRouter } from './routes/ticketRoutes.ts';
import retryRouter from './routes/retry.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import type { TicketControllerDeps } from './controllers/ticketController.ts';

export type AppDeps = TicketControllerDeps;

export function createApp(deps: AppDeps): express.Application {
  const app = express();
  app.use(express.json());
  app.use(helmet());
  app.use('/tickets', createTicketRouter(deps));
  app.use('/tickets', retryRouter);
  app.use(errorHandler);
  return app;
}
