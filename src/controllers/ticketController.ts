import type { Request, Response, NextFunction } from 'express';
import { ticketInputSchema } from '../schemas/ticketSchema.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';
import type { TicketWithPhases } from '../repositories/ticketRepo.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TicketControllerDeps = {
  listTickets: () => Promise<Pick<Ticket, 'id' | 'status' | 'created_at'>[]>;
  submitTicket: (input: TicketInput) => Promise<Ticket>;
  getTicket: (id: string) => Promise<TicketWithPhases>;
};

export function makeListTicketsHandler(deps: TicketControllerDeps) {
  return async function listTicketsHandler(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const tickets = await deps.listTickets();
      res.status(200).json({ tickets });
    } catch (err) {
      next(err);
    }
  };
}

export function makeSubmitTicketHandler(deps: TicketControllerDeps) {
  return async function submitTicketHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const result = ticketInputSchema.safeParse(req.body);
      if (!result.success) {
        next({
          code: 400,
          error: 'VALIDATION_ERROR',
          message: result.error.issues[0]?.message ?? 'Invalid input',
        });
        return;
      }
      const ticket = await deps.submitTicket(result.data);
      res.status(202).json({ ticketId: ticket.id, status: ticket.status });
    } catch (err) {
      next(err);
    }
  };
}

export function makeGetTicketStatusHandler(deps: TicketControllerDeps) {
  return async function getTicketStatusHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const raw = req.params['id'];
      const id = typeof raw === 'string' ? raw : '';
      if (!id || !UUID_RE.test(id)) {
        next({ code: 400, error: 'VALIDATION_ERROR', message: 'Invalid ticket id' });
        return;
      }
      const ticket = await deps.getTicket(id);
      res
        .status(200)
        .json({
          ticketId: ticket.id,
          status: ticket.status,
          phases: ticket.phases,
          events: ticket.events,
        });
    } catch (err) {
      next(err);
    }
  };
}
