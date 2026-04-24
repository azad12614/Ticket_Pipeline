import { v7 as uuidv7 } from 'uuid';
import { pool } from '../lib/db.ts';
import { ticketSchema } from '../schemas/ticketSchema.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';

export async function createTicket(input: TicketInput): Promise<Ticket> {
  const id = uuidv7();
  const result = await pool.query(
    'INSERT INTO tickets (id, subject, body) VALUES ($1, $2, $3) RETURNING *',
    [id, input.subject, input.body],
  );
  return ticketSchema.parse(result.rows[0]);
}

export async function getTicketById(id: string): Promise<Ticket | null> {
  const result = await pool.query('SELECT * FROM tickets WHERE id = $1', [id]);
  if (!result.rows[0]) return null;
  return ticketSchema.parse(result.rows[0]);
}

export async function updateTicketStatus(id: string, status: Ticket['status']): Promise<Ticket> {
  const result = await pool.query(
    'UPDATE tickets SET status=$2 WHERE id=$1 RETURNING *',
    [id, status],
  );
  return ticketSchema.parse(result.rows[0]);
}
