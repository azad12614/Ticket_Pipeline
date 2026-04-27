import type { Request, Response, NextFunction } from 'express';
import { ticketInputSchema } from '../schemas/ticketSchema.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';
import type { TicketWithPhases } from '../repositories/ticketRepo.ts';

export interface TicketControllerDeps {
  submitTicket: (input: TicketInput) => Promise<Ticket>;
  getTicket: (id: string) => Promise<TicketWithPhases>;
}

export function makeSubmitTicketHandler(deps: TicketControllerDeps) {
  return async function submitTicketHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
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
  };
}

export function makeGetTicketStatusHandler(deps: TicketControllerDeps) {
  return async function getTicketStatusHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const idParam = req.params['id'];
      const id = Array.isArray(idParam) ? (idParam[0] ?? '') : (idParam ?? '');
      const ticket = await deps.getTicket(id);
      res.status(200).json({ ticketId: ticket.id, status: ticket.status, phases: ticket.phases, events: ticket.events });
    } catch (err) {
      next(err);
    }
  };
}
