import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
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
  output: unknown;
};

export type TicketWithPhases = Ticket & {
  phases: Record<TicketPhase['phase'], TicketPhaseView>;
  events: TicketEvent[];
};

export type ITicketRepo = {
  getAllTickets(): Promise<Pick<Ticket, 'id' | 'status' | 'created_at'>[]>;
  createTicket(input: TicketInput): Promise<Ticket>;
  getTicketById(id: string): Promise<Ticket | null>;
  getTicketPhasesByTicketId(ticketId: string): Promise<TicketPhase[]>;
  getTicketWithPhasesById(id: string): Promise<TicketWithPhases | null>;
  updateTicketStatus(id: string, status: Ticket['status']): Promise<Ticket>;
  transitionTicketStatus(
    id: string,
    fromStatuses: Ticket['status'][],
    toStatus: Ticket['status'],
  ): Promise<Ticket | null>;
  completeTicket(ticketId: string): Promise<Ticket | null>;
  failTicket(ticketId: string): Promise<Ticket | null>;
  claimPhaseForProcessing(
    ticketId: string,
    phase: TicketPhase['phase'],
  ): Promise<TicketPhase | null>;
  completePhaseSuccess(
    ticketId: string,
    phase: TicketPhase['phase'],
    output: unknown,
    eventPayload?: unknown,
  ): Promise<TicketPhase | null>;
  failPhaseAttempt(
    ticketId: string,
    phase: TicketPhase['phase'],
    reason?: string,
  ): Promise<TicketPhase | null>;
  insertEvent(
    ticketId: string,
    eventType: TicketEvent['event_type'],
    phase: TicketEvent['phase'],
    payload: unknown,
  ): Promise<void>;
  getEventsByTicketId(ticketId: string): Promise<TicketEvent[]>;
};

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`[${label}] ${result.error.message}`);
  return result.data;
}

export class PostgresTicketRepo implements ITicketRepo {
  constructor(private readonly db: Pool) {}

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private buildPhaseView(phases: TicketPhase[]): TicketWithPhases['phases'] {
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

  private async insertEventWith(
    db: Pool | PoolClient,
    ticketId: string,
    eventType: TicketEvent['event_type'],
    phase: TicketEvent['phase'],
    payload: unknown,
  ): Promise<void> {
    await db.query(
      `INSERT INTO ticket_events (id, ticket_id, phase, event_type, payload) VALUES ($1, $2, $3, $4, $5)`,
      [
        uuidv7(),
        ticketId,
        phase ?? null,
        eventType,
        payload != null ? JSON.stringify(payload) : null,
      ],
    );
  }

  async insertEvent(
    ticketId: string,
    eventType: TicketEvent['event_type'],
    phase: TicketEvent['phase'],
    payload: unknown,
  ): Promise<void> {
    await this.insertEventWith(this.db, ticketId, eventType, phase, payload);
  }

  async getEventsByTicketId(ticketId: string): Promise<TicketEvent[]> {
    const result = await this.db.query(
      'SELECT * FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at ASC',
      [ticketId],
    );
    return result.rows.map(row => parseOrThrow(ticketEventSchema, row, 'getEventsByTicketId'));
  }

  async getAllTickets(): Promise<Pick<Ticket, 'id' | 'status' | 'created_at'>[]> {
    const result = await this.db.query(
      'SELECT id, status, created_at FROM tickets ORDER BY created_at DESC',
    );
    const schema = ticketSchema.pick({ id: true, status: true, created_at: true });
    return result.rows.map(row => parseOrThrow(schema, row, 'getAllTickets'));
  }

  async getTicketById(id: string): Promise<Ticket | null> {
    const result = await this.db.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (!result.rows[0]) return null;
    return parseOrThrow(ticketSchema, result.rows[0], 'getTicketById');
  }

  async getTicketPhasesByTicketId(ticketId: string): Promise<TicketPhase[]> {
    const result = await this.db.query(
      'SELECT * FROM ticket_phases WHERE ticket_id = $1 ORDER BY phase ASC',
      [ticketId],
    );
    return result.rows.map(row =>
      parseOrThrow(ticketPhaseSchema, row, 'getTicketPhasesByTicketId'),
    );
  }

  async getTicketWithPhasesById(id: string): Promise<TicketWithPhases | null> {
    const result = await this.db.query(
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

    const ticket = parseOrThrow(ticketSchema, row, 'getTicketWithPhasesById:ticket');
    const phasesRaw: unknown = row.phases_data;
    const eventsRaw: unknown = row.events_data;

    if (!Array.isArray(phasesRaw))
      throw new Error('getTicketWithPhasesById: phases_data is not an array');
    if (!Array.isArray(eventsRaw))
      throw new Error('getTicketWithPhasesById: events_data is not an array');

    const phases = phasesRaw.map(p =>
      parseOrThrow(ticketPhaseSchema, p, 'getTicketWithPhasesById:phase'),
    );
    const events = eventsRaw.map(e =>
      parseOrThrow(ticketEventSchema, e, 'getTicketWithPhasesById:event'),
    );
    return { ...ticket, phases: this.buildPhaseView(phases), events };
  }

  async updateTicketStatus(id: string, status: Ticket['status']): Promise<Ticket> {
    const result = await this.db.query('UPDATE tickets SET status=$2 WHERE id=$1 RETURNING *', [
      id,
      status,
    ]);
    if (!result.rows[0]) throw new Error(`Ticket ${id} not found`);
    return parseOrThrow(ticketSchema, result.rows[0], 'updateTicketStatus');
  }

  async transitionTicketStatus(
    id: string,
    fromStatuses: Ticket['status'][],
    toStatus: Ticket['status'],
  ): Promise<Ticket | null> {
    const result = await this.db.query(
      'UPDATE tickets SET status=$3 WHERE id=$1 AND status = ANY($2::ticket_status[]) RETURNING *',
      [id, fromStatuses, toStatus],
    );
    if (!result.rows[0]) return null;
    return parseOrThrow(ticketSchema, result.rows[0], 'transitionTicketStatus');
  }

  async createTicket(input: TicketInput): Promise<Ticket> {
    return this.withTransaction(async client => {
      const id = uuidv7();
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
      await this.insertEventWith(client, id, 'ticket_created', null, null);
      return parseOrThrow(ticketSchema, ticketInsert.rows[0], 'createTicket');
    });
  }

  async completeTicket(ticketId: string): Promise<Ticket | null> {
    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE tickets SET status='completed' WHERE id=$1 AND status='processing' RETURNING *`,
        [ticketId],
      );
      if (!result.rows[0]) return null;
      await this.insertEventWith(client, ticketId, 'ticket_completed', null, null);
      return parseOrThrow(ticketSchema, result.rows[0], 'completeTicket');
    });
  }

  async failTicket(ticketId: string): Promise<Ticket | null> {
    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE tickets SET status='failed' WHERE id=$1 AND status=ANY($2::ticket_status[]) RETURNING *`,
        [ticketId, ['queued', 'processing']],
      );
      if (!result.rows[0]) return null;
      await this.insertEventWith(client, ticketId, 'ticket_failed', null, null);
      return parseOrThrow(ticketSchema, result.rows[0], 'failTicket');
    });
  }

  async claimPhaseForProcessing(
    ticketId: string,
    phase: TicketPhase['phase'],
  ): Promise<TicketPhase | null> {
    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ticket_phases
         SET status = 'progress', attempts = attempts + 1, started_at = NOW(), completed_at = NULL
         WHERE ticket_id = $1
           AND phase = $2
           AND status = ANY($3::phase_status[])
         RETURNING *`,
        [ticketId, phase, ['started', 'failure']],
      );
      if (!result.rows[0]) return null;
      const claimed = parseOrThrow(ticketPhaseSchema, result.rows[0], 'claimPhaseForProcessing');
      await this.insertEventWith(client, ticketId, 'phase_started', phase, {
        attempt: claimed.attempts,
      });
      return claimed;
    });
  }

  async completePhaseSuccess(
    ticketId: string,
    phase: TicketPhase['phase'],
    output: unknown,
    eventPayload?: unknown,
  ): Promise<TicketPhase | null> {
    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ticket_phases
         SET status = 'success', output = $3, completed_at = NOW()
         WHERE ticket_id = $1
           AND phase = $2
           AND status = 'progress'
         RETURNING *`,
        [ticketId, phase, JSON.stringify(output)],
      );
      if (!result.rows[0]) return null;
      await this.insertEventWith(client, ticketId, 'phase_completed', phase, eventPayload ?? null);
      return parseOrThrow(ticketPhaseSchema, result.rows[0], 'completePhaseSuccess');
    });
  }

  async failPhaseAttempt(
    ticketId: string,
    phase: TicketPhase['phase'],
    reason?: string,
  ): Promise<TicketPhase | null> {
    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ticket_phases
         SET status = 'failure', output = NULL, completed_at = NOW()
         WHERE ticket_id = $1
           AND phase = $2
           AND status = 'progress'
         RETURNING *`,
        [ticketId, phase],
      );
      if (!result.rows[0]) return null;
      const failed = parseOrThrow(ticketPhaseSchema, result.rows[0], 'failPhaseAttempt');
      await this.insertEventWith(
        client,
        ticketId,
        'phase_failed',
        phase,
        reason ? { reason } : null,
      );
      return failed;
    });
  }
}

export const postgresTicketRepo: ITicketRepo = new PostgresTicketRepo(pool);
