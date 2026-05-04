import { Router } from 'express';
import type { TicketRepo } from '../repositories/ticketRepo.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RetryRouterDeps = {
  getTicketByIdFn: TicketRepo['getTicketById'];
  getLatestEventByTicketIdFn: TicketRepo['getLatestEventByTicketId'];
  getTicketWithPhasesByIdFn: TicketRepo['getTicketWithPhasesById'];
  resetFailedPhasesFn: TicketRepo['resetFailedPhases'];
  updateTicketStatusFn: TicketRepo['updateTicketStatus'];
  transitionTicketStatusFn: TicketRepo['transitionTicketStatus'];
  insertEventFn: TicketRepo['insertEvent'];
  enqueueTicketFn: (ticketId: string) => Promise<void>;
};

export function createRetryRouter(deps: RetryRouterDeps): Router {
  const router = Router();

  router.post('/retry/:ticketId', async (req, res, next) => {
    try {
      const ticketId = typeof req.params.ticketId === 'string' ? req.params.ticketId : '';
      if (!ticketId || !UUID_RE.test(ticketId))
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid ticket id' });

      const ticket = await deps.getTicketByIdFn(ticketId);
      if (!ticket) return res.status(404).json({ error: 'ticket_not_found' });

      const allowForce = req.query.force === 'true';
      const latest = await deps.getLatestEventByTicketIdFn(ticketId);

      if (!allowForce && latest?.event_type === 'retry_scheduled') {
        return res
          .status(409)
          .json({ error: 'already_retried', message: 'Ticket was already manually retried' });
      }

      const tw = await deps.getTicketWithPhasesByIdFn(ticketId);
      if (!allowForce) {
        if (latest?.event_type !== 'dlq_routed') {
          return res.status(400).json({
            error: 'not_dlq_routed',
            message: 'Latest event is not dlq_routed. Use ?force=true to override.',
          });
        }

        if (tw) {
          const phaseStatuses = Object.values(tw.phases).map(p => p.status);
          const allSuccess = phaseStatuses.every(s => s === 'success');
          const anyInProgress = phaseStatuses.some(s => s === 'progress');

          if (allSuccess) {
            return res
              .status(400)
              .json({ error: 'already_completed', message: 'Ticket phases are already completed' });
          }
          if (anyInProgress) {
            return res
              .status(400)
              .json({ error: 'phase_in_progress', message: 'A phase is currently in progress' });
          }
        }
      }

      await deps.resetFailedPhasesFn(ticketId);

      if (allowForce) {
        await deps.updateTicketStatusFn(ticketId, 'queued');
      } else {
        await deps.transitionTicketStatusFn(ticketId, ['failed'], 'queued');
      }

      await deps.enqueueTicketFn(ticketId);

      const actor = req.ip || req.get('X-Forwarded-For') || 'unknown';
      await deps.insertEventFn(ticketId, 'retry_scheduled', null, {
        by: 'ops',
        actor,
        force: allowForce,
        manual: true,
      });

      return res.status(202).json({ status: 'requeued' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
