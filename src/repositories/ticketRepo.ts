import { v7 as uuidv7 } from 'uuid';
import { pool } from '../lib/db.ts';
import { ticketSchema } from '../schemas/ticketSchema.ts';
import { ticketPhaseSchema } from '../schemas/phaseSchema.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';
import type { TicketPhase } from '../schemas/phaseSchema.ts';

export type TicketPhaseView = {
  status: TicketPhase['status'];
  attempts: number;
  output: unknown | null;
};

export type TicketWithPhases = Ticket & {
  phases: Record<TicketPhase['phase'], TicketPhaseView>;
};

function buildPhaseView(phases: TicketPhase[]): TicketWithPhases['phases'] {
  const phaseView: TicketWithPhases['phases'] = {
    triage: { status: 'started', attempts: 0, output: null },
    draft: { status: 'started', attempts: 0, output: null },
  };

  for (const phase of phases) {
    phaseView[phase.phase] = {
      status: phase.status,
      attempts: phase.attempts,
        output: phase.status === 'success' ? phase.output : null,
    };
  }

  return phaseView;
}

export async function createTicket(input: TicketInput): Promise<Ticket> {
  const client = await pool.connect();
  const id = uuidv7();

  try {
    await client.query('BEGIN');

    const ticketInsert = await client.query(
      'INSERT INTO tickets (id, subject, body) VALUES ($1, $2, $3) RETURNING *',
      [id, input.subject, input.body],
    );

    await client.query(
      `INSERT INTO ticket_phases (id, ticket_id, phase, status, attempts, output)
       VALUES
         ($1, $3, 'triage', 'started', 0, NULL),
         ($2, $3, 'draft', 'started', 0, NULL)`,
      [uuidv7(), uuidv7(), id],
    );

    await client.query('COMMIT');
    return ticketSchema.parse(ticketInsert.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getTicketById(id: string): Promise<Ticket | null> {
  const result = await pool.query('SELECT * FROM tickets WHERE id = $1', [id]);
  if (!result.rows[0]) return null;
  return ticketSchema.parse(result.rows[0]);
}

export async function getTicketPhasesByTicketId(ticketId: string): Promise<TicketPhase[]> {
  const result = await pool.query(
    'SELECT * FROM ticket_phases WHERE ticket_id = $1 ORDER BY phase ASC',
    [ticketId],
  );

  return result.rows.map(row => ticketPhaseSchema.parse(row));
}

export async function getTicketWithPhasesById(id: string): Promise<TicketWithPhases | null> {
  const ticket = await getTicketById(id);
  if (!ticket) return null;

  const phases = await getTicketPhasesByTicketId(id);
  return {
    ...ticket,
    phases: buildPhaseView(phases),
  };
}

export async function updateTicketStatus(id: string, status: Ticket['status']): Promise<Ticket> {
  const result = await pool.query('UPDATE tickets SET status=$2 WHERE id=$1 RETURNING *', [
    id,
    status,
  ]);
  if (!result.rows[0]) {
    throw new Error(`Ticket ${id} not found`);
  }
  return ticketSchema.parse(result.rows[0]);
}

export async function transitionTicketStatus(
  id: string,
  fromStatuses: Ticket['status'][],
  toStatus: Ticket['status'],
): Promise<Ticket | null> {
  const result = await pool.query(
    'UPDATE tickets SET status=$3 WHERE id=$1 AND status = ANY($2::ticket_status[]) RETURNING *',
    [id, fromStatuses, toStatus],
  );
  if (!result.rows[0]) return null;
  return ticketSchema.parse(result.rows[0]);
}

export async function claimPhaseForProcessing(
  ticketId: string,
  phase: TicketPhase['phase'],
): Promise<TicketPhase | null> {
  const result = await pool.query(
    `UPDATE ticket_phases
     SET status = 'progress', attempts = attempts + 1, started_at = NOW(), completed_at = NULL
     WHERE ticket_id = $1
       AND phase = $2
       AND status = ANY($3::phase_status[])
     RETURNING *`,
    [ticketId, phase, ['started', 'failure']],
  );

  if (!result.rows[0]) return null;
  return ticketPhaseSchema.parse(result.rows[0]);
}

export async function completePhaseSuccess(
  ticketId: string,
  phase: TicketPhase['phase'],
  output: unknown,
): Promise<TicketPhase | null> {
  const result = await pool.query(
    `UPDATE ticket_phases
     SET status = 'success', output = $3, completed_at = NOW()
     WHERE ticket_id = $1
       AND phase = $2
       AND status = 'progress'
     RETURNING *`,
    [ticketId, phase, JSON.stringify(output)],
  );

  if (!result.rows[0]) return null;
  return ticketPhaseSchema.parse(result.rows[0]);
}

export async function failPhaseAttempt(
  ticketId: string,
  phase: TicketPhase['phase'],
): Promise<TicketPhase | null> {
  const result = await pool.query(
    `UPDATE ticket_phases
     SET status = 'failure', output = NULL, completed_at = NOW()
     WHERE ticket_id = $1
       AND phase = $2
       AND status = 'progress'
     RETURNING *`,
    [ticketId, phase],
  );

  if (!result.rows[0]) return null;
  return ticketPhaseSchema.parse(result.rows[0]);
}

export interface ITicketRepo {
  createTicket(input: TicketInput): Promise<Ticket>;
  getTicketById(id: string): Promise<Ticket | null>;
  getTicketPhasesByTicketId(ticketId: string): Promise<TicketPhase[]>;
  getTicketWithPhasesById(id: string): Promise<TicketWithPhases | null>;
  updateTicketStatus(id: string, status: Ticket['status']): Promise<Ticket>;
  transitionTicketStatus(id: string, fromStatuses: Ticket['status'][], toStatus: Ticket['status']): Promise<Ticket | null>;
  claimPhaseForProcessing(ticketId: string, phase: TicketPhase['phase']): Promise<TicketPhase | null>;
  completePhaseSuccess(ticketId: string, phase: TicketPhase['phase'], output: unknown): Promise<TicketPhase | null>;
  failPhaseAttempt(ticketId: string, phase: TicketPhase['phase']): Promise<TicketPhase | null>;
}

export const postgresTicketRepo: ITicketRepo = {
  createTicket,
  getTicketById,
  getTicketPhasesByTicketId,
  getTicketWithPhasesById,
  updateTicketStatus,
  transitionTicketStatus,
  claimPhaseForProcessing,
  completePhaseSuccess,
  failPhaseAttempt,
};
