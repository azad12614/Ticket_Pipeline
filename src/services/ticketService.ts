import { enqueueTicket } from '../queues/ticketQueue.ts';
import {
  createTicket,
  getTicketWithPhasesById,
  updateTicketStatus,
  type TicketWithPhases,
} from '../repositories/ticketRepo.ts';
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
  enqueueTicketFn?: (ticketId: string) => void;
}

export async function submitTicket(
  input: TicketInput,
  deps: SubmitTicketDeps = {},
): Promise<Ticket> {
  const createTicketFn = deps.createTicketFn ?? createTicket;
  const enqueueTicketFn = deps.enqueueTicketFn ?? enqueueTicket;

  const ticket = await createTicketFn(input);
  enqueueTicketFn(ticket.id);
  return ticket;
}

export async function getTicket(id: string): Promise<TicketWithPhases> {
  const ticket = await getTicketWithPhasesById(id);
  if (!ticket) throw new NotFoundError(id);
  return ticket;
}

export async function updateTicket(id: string, status: Ticket['status']): Promise<Ticket> {
  return updateTicketStatus(id, status);
}
