import { Router } from 'express';
import { enqueueTicket } from '../queues/ticketQueue.ts';
import { postgresTicketRepo } from '../repositories/ticketRepo.ts';

const router = Router();

router.post('/retry/:ticketId', async (req, res, next) => {
  try {
    const ticketId = String(req.params.ticketId ?? '');
    if (!ticketId) return res.status(400).json({ error: 'invalid_ticket_id' });

    const ticket = await postgresTicketRepo.getTicketById(ticketId);
    if (!ticket) return res.status(404).json({ error: 'ticket_not_found' });

    const allowForce = req.query.force === 'true';
    const latest = await postgresTicketRepo.getLatestEventByTicketId(ticketId);

    if (!allowForce && latest?.event_type === 'retry_scheduled') {
      return res
        .status(409)
        .json({ error: 'already_retried', message: 'Ticket was already manually retried' });
    }

    const tw = await postgresTicketRepo.getTicketWithPhasesById(ticketId);
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

    await enqueueTicket(ticketId);

    // Ensure ticket status is set so the worker will process the requeued ticket.
    if (allowForce) {
      await postgresTicketRepo.updateTicketStatus?.(ticketId, 'queued');
    } else {
      await postgresTicketRepo.transitionTicketStatus?.(ticketId, ['failed'], 'queued');
    }

    const actor = req.ip || req.get('X-Forwarded-For') || 'unknown';
    await postgresTicketRepo.insertEvent(ticketId, 'retry_scheduled', null, {
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

export default router;
