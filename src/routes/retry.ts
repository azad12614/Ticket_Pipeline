import { Router } from 'express';
import { retryTicket, type RetryTicketDeps } from '../services/retryService.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RetryRouterDeps = RetryTicketDeps;

export function createRetryRouter(deps: RetryRouterDeps): Router {
  const router = Router();

  router.post('/retry/:ticketId', async (req, res, next) => {
    try {
      const ticketId = typeof req.params.ticketId === 'string' ? req.params.ticketId : '';
      if (!ticketId || !UUID_RE.test(ticketId)) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid ticket id' });
      }

      const force = req.query.force === 'true';
      const actor = req.ip ?? req.get('X-Forwarded-For') ?? 'unknown';

      const result = await retryTicket(ticketId, { force, actor }, deps);

      if (!result.ok) {
        return res.status(result.code).json({ error: result.error, message: result.message });
      }

      return res.status(202).json({ status: 'requeued' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
