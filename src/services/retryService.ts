import type { TicketRepo } from '../repositories/ticketRepo.ts';

export type RetryTicketOpts = {
  force: boolean;
  actor: string;
};

export type RetryTicketResult =
  | { ok: true }
  | { ok: false; code: 404 | 409 | 400; error: string; message: string };

export type RetryTicketDeps = {
  getTicketByIdFn: TicketRepo['getTicketById'];
  getLatestEventByTicketIdFn: TicketRepo['getLatestEventByTicketId'];
  getTicketWithPhasesByIdFn: TicketRepo['getTicketWithPhasesById'];
  resetFailedPhasesFn: TicketRepo['resetFailedPhases'];
  updateTicketStatusFn: TicketRepo['updateTicketStatus'];
  transitionTicketStatusFn: TicketRepo['transitionTicketStatus'];
  insertEventFn: TicketRepo['insertEvent'];
  enqueueTicketFn: (ticketId: string) => Promise<void>;
};

export async function retryTicket(
  ticketId: string,
  opts: RetryTicketOpts,
  deps: RetryTicketDeps,
): Promise<RetryTicketResult> {
  const ticket = await deps.getTicketByIdFn(ticketId);
  if (!ticket) {
    return { ok: false, code: 404, error: 'ticket_not_found', message: 'Ticket not found' };
  }

  const latest = await deps.getLatestEventByTicketIdFn(ticketId);

  if (!opts.force && latest?.event_type === 'retry_scheduled') {
    return {
      ok: false,
      code: 409,
      error: 'already_retried',
      message: 'Ticket was already manually retried',
    };
  }

  if (!opts.force) {
    if (latest?.event_type !== 'dlq_routed') {
      return {
        ok: false,
        code: 400,
        error: 'not_dlq_routed',
        message: 'Latest event is not dlq_routed. Use ?force=true to override.',
      };
    }

    const tw = await deps.getTicketWithPhasesByIdFn(ticketId);
    if (tw) {
      const statuses = Object.values(tw.phases).map(p => p.status);
      if (statuses.every(s => s === 'success')) {
        return {
          ok: false,
          code: 400,
          error: 'already_completed',
          message: 'Ticket phases are already completed',
        };
      }
      if (statuses.some(s => s === 'progress')) {
        return {
          ok: false,
          code: 400,
          error: 'phase_in_progress',
          message: 'A phase is currently in progress',
        };
      }
    }
  }

  await deps.resetFailedPhasesFn(ticketId);

  if (opts.force) {
    await deps.updateTicketStatusFn(ticketId, 'queued');
  } else {
    await deps.transitionTicketStatusFn(ticketId, ['failed'], 'queued');
  }

  await deps.enqueueTicketFn(ticketId);
  await deps.insertEventFn(ticketId, 'retry_scheduled', null, {
    by: 'ops',
    actor: opts.actor,
    force: opts.force,
    manual: true,
  });

  return { ok: true };
}
