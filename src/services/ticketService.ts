import { createTicket, getTicketById, updateTicketStatus } from '../repositories/ticketRepo.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';

export class NotFoundError extends Error {
  readonly code = 404;
  readonly error = 'NOT_FOUND';
  constructor(id: string) {
    super(`Ticket ${id} not found`);
  }
}

export async function submitTicket(input: TicketInput): Promise<Ticket> {
  return createTicket(input);
}

export async function getTicket(id: string): Promise<Ticket> {
  const ticket = await getTicketById(id);
  if (!ticket) throw new NotFoundError(id);
  return ticket;
}

export async function updateTicket(id: string, status: Ticket['status']): Promise<Ticket> {
  return updateTicketStatus(id, status);
}
