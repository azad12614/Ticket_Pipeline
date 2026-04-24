import type { Request, Response, NextFunction } from 'express';
import { ticketInputSchema } from '../schemas/ticketSchema.ts';
import { submitTicket, getTicket } from '../services/ticketService.ts';

export async function submitTicketHandler(
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

  const ticket = await submitTicket(result.data);
  res.status(202).json({ ticketId: ticket.id, status: ticket.status });
}

export async function getTicketStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ticket = await getTicket(req.params['id'] ?? '');
    res.status(200).json({ ticketId: ticket.id, status: ticket.status, phases: {} });
  } catch (err) {
    next(err);
  }
}
