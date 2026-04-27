import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { pool } from '../lib/db.ts';
import { ticketSchema } from '../schemas/ticketSchema.ts';
import { ticketPhaseSchema } from '../schemas/phaseSchema.ts';
import { ticketEventSchema } from '../schemas/eventSchema.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';
import type { TicketPhase } from '../schemas/phaseSchema.ts';
import type { TicketEvent } from '../schemas/eventSchema.ts';

export type TicketPhaseView = {
  status: TicketPhase['status'];
  attempts: number;
  output: unknown | null;
};

export type TicketWithPhases = Ticket & {
  phases: Record<TicketPhase['phase'], TicketPhaseView>;
  events: TicketEvent[];
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

async function insertEventInTx(
  client: PoolClient,
  ticketId: string,
  eventType: TicketEvent['event_type'],
  phase: TicketEvent['phase'],
  payload: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO ticket_events (id, ticket_id, phase, event_type, payload) VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), ticketId, phase ?? null, eventType, payload != null ? JSON.stringify(payload) : null],
  );
}

export async function insertEvent(
  ticketId: string,
  eventType: TicketEvent['event_type'],
  phase: TicketEvent['phase'],
  payload: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO ticket_events (id, ticket_id, phase, event_type, payload) VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), ticketId, phase ?? null, eventType, payload != null ? JSON.stringify(payload) : null],
  );
}

export async function getEventsByTicketId(ticketId: string): Promise<TicketEvent[]> {
  const result = await pool.query(
    'SELECT * FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at ASC',
    [ticketId],
  );
  return result.rows.map(row => ticketEventSchema.parse(row));
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

    await insertEventInTx(client, id, 'ticket_created', null, null);

    await client.query('COMMIT');
    return ticketSchema.parse(ticketInsert.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getAllTickets(): Promise<Pick<Ticket, 'id' | 'status' | 'created_at'>[]> {
  const result = await pool.query('SELECT id, status, created_at FROM tickets ORDER BY created_at DESC');
  return result.rows.map(row => ticketSchema.pick({ id: true, status: true, created_at: true }).parse(row));
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
  const result = await pool.query(
    `SELECT t.*,
      (SELECT COALESCE(json_agg(tp ORDER BY tp.phase), '[]'::json)
       FROM ticket_phases tp WHERE tp.ticket_id = t.id) AS phases_data,
      (SELECT COALESCE(json_agg(te ORDER BY te.created_at ASC), '[]'::json)
       FROM ticket_events te WHERE te.ticket_id = t.id) AS events_data
     FROM tickets t WHERE t.id = $1`,
    [id],
  );

  const row = result.rows[0];
  if (!row) return null;

  const ticket = ticketSchema.parse(row);
  const phases = (row.phases_data as unknown[]).map(p => ticketPhaseSchema.parse(p));
  const events = (row.events_data as unknown[]).map(e => ticketEventSchema.parse(e));

  return { ...ticket, phases: buildPhaseView(phases), events };
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

export async function completeTicket(ticketId: string): Promise<Ticket | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE tickets SET status='completed' WHERE id=$1 AND status='processing' RETURNING *`,
      [ticketId],
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await insertEventInTx(client, ticketId, 'ticket_completed', null, null);
    await client.query('COMMIT');
    return ticketSchema.parse(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function failTicket(ticketId: string): Promise<Ticket | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE tickets SET status='failed' WHERE id=$1 AND status=ANY($2::ticket_status[]) RETURNING *`,
      [ticketId, ['queued', 'processing']],
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await insertEventInTx(client, ticketId, 'ticket_failed', null, null);
    await client.query('COMMIT');
    return ticketSchema.parse(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimPhaseForProcessing(
  ticketId: string,
  phase: TicketPhase['phase'],
): Promise<TicketPhase | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE ticket_phases
       SET status = 'progress', attempts = attempts + 1, started_at = NOW(), completed_at = NULL
       WHERE ticket_id = $1
         AND phase = $2
         AND status = ANY($3::phase_status[])
       RETURNING *`,
      [ticketId, phase, ['started', 'failure']],
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const claimed = ticketPhaseSchema.parse(result.rows[0]);
    await insertEventInTx(client, ticketId, 'phase_started', phase, { attempt: claimed.attempts });
    await client.query('COMMIT');
    return claimed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completePhaseSuccess(
  ticketId: string,
  phase: TicketPhase['phase'],
  output: unknown,
  eventPayload?: unknown,
): Promise<TicketPhase | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE ticket_phases
       SET status = 'success', output = $3, completed_at = NOW()
       WHERE ticket_id = $1
         AND phase = $2
         AND status = 'progress'
       RETURNING *`,
      [ticketId, phase, JSON.stringify(output)],
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await insertEventInTx(client, ticketId, 'phase_completed', phase, eventPayload ?? null);
    await client.query('COMMIT');
    return ticketPhaseSchema.parse(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function failPhaseAttempt(
  ticketId: string,
  phase: TicketPhase['phase'],
  reason?: string,
): Promise<TicketPhase | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE ticket_phases
       SET status = 'failure', output = NULL, completed_at = NOW()
       WHERE ticket_id = $1
         AND phase = $2
         AND status = 'progress'
       RETURNING *`,
      [ticketId, phase],
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const failed = ticketPhaseSchema.parse(result.rows[0]);
    await insertEventInTx(client, ticketId, 'phase_failed', phase, reason ? { reason } : null);
    await client.query('COMMIT');
    return failed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface ITicketRepo {
  getAllTickets(): Promise<Pick<Ticket, 'id' | 'status' | 'created_at'>[]>;
  createTicket(input: TicketInput): Promise<Ticket>;
  getTicketById(id: string): Promise<Ticket | null>;
  getTicketPhasesByTicketId(ticketId: string): Promise<TicketPhase[]>;
  getTicketWithPhasesById(id: string): Promise<TicketWithPhases | null>;
  updateTicketStatus(id: string, status: Ticket['status']): Promise<Ticket>;
  transitionTicketStatus(id: string, fromStatuses: Ticket['status'][], toStatus: Ticket['status']): Promise<Ticket | null>;
  completeTicket(ticketId: string): Promise<Ticket | null>;
  failTicket(ticketId: string): Promise<Ticket | null>;
  claimPhaseForProcessing(ticketId: string, phase: TicketPhase['phase']): Promise<TicketPhase | null>;
  completePhaseSuccess(ticketId: string, phase: TicketPhase['phase'], output: unknown, eventPayload?: unknown): Promise<TicketPhase | null>;
  failPhaseAttempt(ticketId: string, phase: TicketPhase['phase'], reason?: string): Promise<TicketPhase | null>;
  insertEvent(ticketId: string, eventType: TicketEvent['event_type'], phase: TicketEvent['phase'], payload: unknown): Promise<void>;
  getEventsByTicketId(ticketId: string): Promise<TicketEvent[]>;
}

export const postgresTicketRepo: ITicketRepo = {
  getAllTickets,
  createTicket,
  getTicketById,
  getTicketPhasesByTicketId,
  getTicketWithPhasesById,
  updateTicketStatus,
  transitionTicketStatus,
  completeTicket,
  failTicket,
  claimPhaseForProcessing,
  completePhaseSuccess,
  failPhaseAttempt,
  insertEvent,
  getEventsByTicketId,
};
