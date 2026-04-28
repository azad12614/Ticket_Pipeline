import { enqueueTicket } from '../queues/ticketQueue.ts';
import { postgresTicketRepo, type TicketWithPhases } from '../repositories/ticketRepo.ts';
import type { ITicketRepo } from '../repositories/ticketRepo.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';

export class NotFoundError extends Error {
  readonly code = 404;
  readonly error = 'NOT_FOUND';
  constructor(id: string) {
    super(`Ticket ${id} not found`);
  }
}

type SubmitTicketDeps = {
  createTicketFn?: ITicketRepo['createTicket'];
  enqueueTicketFn?: (ticketId: string) => Promise<void> | void;
};

type ListTicketsDeps = {
  getAllTicketsFn?: ITicketRepo['getAllTickets'];
};

type GetTicketDeps = {
  getTicketWithPhasesByIdFn?: ITicketRepo['getTicketWithPhasesById'];
};

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

export async function listTickets(
  deps: ListTicketsDeps = {},
): Promise<Pick<Ticket, 'id' | 'status' | 'created_at'>[]> {
  const getAllTicketsFn =
    deps.getAllTicketsFn ?? postgresTicketRepo.getAllTickets.bind(postgresTicketRepo);
  return getAllTicketsFn();
}

export async function getTicket(id: string, deps: GetTicketDeps = {}): Promise<TicketWithPhases> {
  const getTicketWithPhasesByIdFn =
    deps.getTicketWithPhasesByIdFn ??
    postgresTicketRepo.getTicketWithPhasesById.bind(postgresTicketRepo);
  const ticket = await getTicketWithPhasesByIdFn(id);
  if (!ticket) throw new NotFoundError(id);
  return ticket;
}
