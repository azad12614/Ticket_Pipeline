import type { ITicketRepo } from '../repositories/ticketRepo.ts';
import type { TicketWithPhases } from '../repositories/ticketRepo.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';

export class NotFoundError extends Error {
  readonly code = 404;
  readonly error = 'NOT_FOUND';
  constructor(id: string) {
    super(`Ticket ${id} not found`);
  }
}

export type SubmitTicketDeps = {
  createTicketFn: ITicketRepo['createTicket'];
  enqueueTicketFn: (ticketId: string) => Promise<void> | void;
};

export type ListTicketsDeps = {
  getAllTicketsFn: ITicketRepo['getAllTickets'];
};

export type GetTicketDeps = {
  getTicketWithPhasesByIdFn: ITicketRepo['getTicketWithPhasesById'];
};

export async function submitTicket(input: TicketInput, deps: SubmitTicketDeps): Promise<Ticket> {
  const ticket = await deps.createTicketFn(input);
  await deps.enqueueTicketFn(ticket.id);
  return ticket;
}

export async function listTickets(
  deps: ListTicketsDeps,
): Promise<Pick<Ticket, 'id' | 'status' | 'created_at'>[]> {
  return deps.getAllTicketsFn();
}

export async function getTicket(id: string, deps: GetTicketDeps): Promise<TicketWithPhases> {
  const ticket = await deps.getTicketWithPhasesByIdFn(id);
  if (!ticket) throw new NotFoundError(id);
  return ticket;
}
