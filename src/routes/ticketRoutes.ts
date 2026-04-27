import { Router } from 'express';
import { makeSubmitTicketHandler, makeGetTicketStatusHandler } from '../controllers/ticketController.ts';
import type { TicketControllerDeps } from '../controllers/ticketController.ts';

export function createTicketRouter(deps: TicketControllerDeps): Router {
  const router = Router();
  router.post('/', makeSubmitTicketHandler(deps));
  router.get('/:id', makeGetTicketStatusHandler(deps));
  return router;
}
