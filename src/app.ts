import express from 'express';
import helmet from 'helmet';
import { createTicketRouter } from './routes/ticketRoutes.ts';
import { createRetryRouter } from './routes/retry.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import type { TicketControllerDeps } from './controllers/ticketController.ts';
import type { RetryRouterDeps } from './routes/retry.ts';

export type AppDeps = TicketControllerDeps & { retry: RetryRouterDeps };

export function createApp(deps: AppDeps): express.Application {
  const app = express();
  app.use(express.json());
  app.use(helmet());
  app.use('/tickets', createTicketRouter(deps));
  app.use('/tickets', createRetryRouter(deps.retry));
  app.use(errorHandler);
  return app;
}
