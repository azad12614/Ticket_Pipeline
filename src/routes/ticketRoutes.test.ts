import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import type { AppDeps } from '../app.ts';
import type { TicketInput, Ticket } from '../schemas/ticketSchema.ts';
import type { TicketWithPhases } from '../repositories/ticketRepo.ts';
import { v7 as uuidv7 } from 'uuid';

function makeInMemoryService(): AppDeps {
  const store = new Map<string, TicketWithPhases>();

  return {
    async listTickets() {
      return [...store.values()].map(t => ({ id: t.id, status: t.status, created_at: t.created_at }));
    },

    async submitTicket(input: TicketInput): Promise<Ticket> {
      const id = uuidv7();
      const ticket: TicketWithPhases = {
        id,
        subject: input.subject,
        body: input.body,
        status: 'queued',
        archived_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        phases: {
          triage: { status: 'started', attempts: 0, output: null },
          draft: { status: 'started', attempts: 0, output: null },
        },
        events: [],
      };
      store.set(id, ticket);
      return ticket;
    },

    async getTicket(id: string): Promise<TicketWithPhases> {
      const ticket = store.get(id);
      if (!ticket)
        throw { code: 404, error: 'NOT_FOUND', message: `Ticket ${id} not found` };
      return ticket;
    },
  };
}

describe('POST /tickets', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = makeInMemoryService();
  });

  // US-2.1: immediate acknowledgement
  it('returns 202 with ticketId and queued status for valid input', async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post('/tickets')
      .send({ subject: 'Login broken', body: 'Cannot log in since yesterday' });

    expect(res.status).toBe(202);
    expect(res.body.ticketId).toBeDefined();
    expect(res.body.status).toBe('queued');
  });

  // US-1.1: ticket persisted before processing — GET returns it after POST
  it('persists the ticket so it is retrievable immediately after submission', async () => {
    const app = createApp(deps);

    const post = await request(app)
      .post('/tickets')
      .send({ subject: 'Billing error', body: 'Charged twice this month' });

    const get = await request(app).get(`/tickets/${post.body.ticketId}`);

    expect(get.status).toBe(200);
    expect(get.body.ticketId).toBe(post.body.ticketId);
    expect(get.body.status).toBe('queued');
  });

  // US-1.1: unique ID per submission
  it('assigns a different ticketId to each submission', async () => {
    const app = createApp(deps);

    const res1 = await request(app)
      .post('/tickets')
      .send({ subject: 'A', body: 'B' });
    const res2 = await request(app)
      .post('/tickets')
      .send({ subject: 'C', body: 'D' });

    expect(res1.body.ticketId).not.toBe(res2.body.ticketId);
  });

  // US-1.2: both phase rows created at submission — visible in status response
  it('creates triage and draft phase rows at submission with started status', async () => {
    const app = createApp(deps);

    const post = await request(app)
      .post('/tickets')
      .send({ subject: 'Feature request', body: 'Add dark mode' });

    const get = await request(app).get(`/tickets/${post.body.ticketId}`);

    expect(get.body.phases.triage).toEqual({ status: 'started', attempts: 0, output: null });
    expect(get.body.phases.draft).toEqual({ status: 'started', attempts: 0, output: null });
  });

  // US-2.1: validation — missing subject
  it('returns 400 VALIDATION_ERROR when subject is missing', async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post('/tickets')
      .send({ body: 'No subject here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  // US-2.1: validation — missing body
  it('returns 400 VALIDATION_ERROR when body is missing', async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post('/tickets')
      .send({ subject: 'No body' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  // US-2.1: validation — empty subject
  it('returns 400 VALIDATION_ERROR when subject is an empty string', async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post('/tickets')
      .send({ subject: '', body: 'Body here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('GET /tickets/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = makeInMemoryService();
  });

  // US-2.2: unknown ticket ID → 404
  it('returns 404 NOT_FOUND for an unknown ticket id', async () => {
    const app = createApp(deps);
    const res = await request(app).get(`/tickets/${uuidv7()}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  // US-2.2: phase output is null when phase not yet complete
  it('returns null output for phases not yet processed', async () => {
    const app = createApp(deps);

    const post = await request(app)
      .post('/tickets')
      .send({ subject: 'Crash on startup', body: 'App crashes immediately on open' });

    const get = await request(app).get(`/tickets/${post.body.ticketId}`);

    expect(get.body.phases.triage.output).toBeNull();
    expect(get.body.phases.draft.output).toBeNull();
  });

  // US-2.2: full shape of status response
  it('returns ticketId, status, and both phases in the status response', async () => {
    const app = createApp(deps);

    const post = await request(app)
      .post('/tickets')
      .send({ subject: 'Export fails', body: 'CSV export returns empty file' });

    const get = await request(app).get(`/tickets/${post.body.ticketId}`);

    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      ticketId: post.body.ticketId,
      status: 'queued',
      phases: {
        triage: expect.objectContaining({ status: 'started' }),
        draft: expect.objectContaining({ status: 'started' }),
      },
    });
  });
});
