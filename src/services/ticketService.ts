import { enqueueTicket } from '../queues/ticketQueue.ts';
import { postgresTicketRepo, type TicketWithPhases } from '../repositories/ticketRepo.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';

export class NotFoundError extends Error {
  readonly code = 404;
  readonly error = 'NOT_FOUND';
  constructor(id: string) {
    super(`Ticket ${id} not found`);
  }
}

interface SubmitTicketDeps {
  createTicketFn?: (input: TicketInput) => Promise<Ticket>;
  enqueueTicketFn?: (ticketId: string) => Promise<void> | void;
}

export async function submitTicket(
  input: TicketInput,
  deps: SubmitTicketDeps = {},
): Promise<Ticket> {
  const createTicketFn =
    deps.createTicketFn ?? postgresTicketRepo.createTicket.bind(postgresTicketRepo);
  const enqueueTicketFn = deps.enqueueTicketFn ?? enqueueTicket;

  const ticket = await createTicketFn(input);
  await enqueueTicketFn(ticket.id);
  return ticket;
}

export async function listTickets(): Promise<Pick<Ticket, 'id' | 'status' | 'created_at'>[]> {
  return postgresTicketRepo.getAllTickets();
}

export async function getTicket(id: string): Promise<TicketWithPhases> {
  const ticket = await postgresTicketRepo.getTicketWithPhasesById(id);
  if (!ticket) throw new NotFoundError(id);
  return ticket;
}
