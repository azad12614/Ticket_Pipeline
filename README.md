# AI Ticket Processing Pipeline

Node.js + TypeScript service that processes customer support tickets through an asynchronous, two-phase AI pipeline. The worker consumes SQS messages, runs two AI phases (triage + draft) via Portkey, persists results to Postgres, and emits real-time events via Socket.io using Postgres LISTEN/NOTIFY.

## Architecture

```
POST /tickets
     │
     ▼
  Postgres ──► SQS (main queue)
                    │
                    ▼
               Worker (long-poll)
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
     Phase 1: Triage    Phase 2: Draft
     (Portkey → AI)     (Portkey → AI)
          │                   │
          └─────────┬─────────┘
                    ▼
             ticket_events
                    │
          PG LISTEN/NOTIFY
                    │
                    ▼
             Socket.io emit
```

**Design highlights**

- Worker uses visibility-timeout backoff instead of automatic re-enqueue to avoid duplicate processing.
- Phase rows are created at ticket submission so the API shape is stable immediately.
- Completed phases are idempotent-guarded (`UNIQUE(ticket_id, phase)` and status checks).
- Socket.io events are emitted from DB-triggered events (`ticket_events` INSERT) to guarantee full replay and decouple worker from realtime delivery.

## Stack

| Layer      | Technology                   |
| ---------- | ---------------------------- |
| Runtime    | Node.js + TypeScript (ESM)   |
| HTTP       | Express 5                    |
| Database   | PostgreSQL                   |
| Queue      | AWS SQS (LocalStack in dev)  |
| AI Gateway | Portkey (provider fallback)  |
| Real-time  | Socket.io + PG LISTEN/NOTIFY |
| Validation | Zod                          |
| Logging    | Pino                         |
| Tests      | Vitest                       |

## Project layout

See the `src/` folder for the main application code. Major areas:

- **routes/** — Express route definitions
- **controllers/** — request/response handling
- **services/** — ticket orchestration, AI calls, notify service
- **repositories/** — SQL access for tickets, phases, events
- **queues/** — SQS helpers (enqueue, receive, delete, visibility)
- **workers/** — SQS long-poll loop and phase orchestration
- **schemas/** — Zod schemas for request/response and AI outputs
- **lib/** — `config.ts`, `db.ts`, `io.ts`, `logger.ts`, `errors.ts`
- **scripts/** — helpers for LocalStack and local testing

## Quick start

Prerequisites:

- Node.js 22+
- Docker

1. Install deps

```bash
npm install
```

2. Copy environment file

```bash
cp .env.example .env
```

3. Start infrastructure (Postgres, LocalStack, etc.)

```bash
docker compose up -d
```

4. Migrate DB and (queues are provisioned by docker-compose)

If you brought up infrastructure with `docker compose up -d`, the `localstack-setup` service in the compose file will provision the SQS queues automatically. If you did not use `docker compose`, run the setup script manually.

```bash
npm run migrate
# Optional (only if you didn't use `docker compose` or want to re-provision):
# bash scripts/setup-localstack.sh
```

5. Start the app (dev)

```bash
npm run dev
```

Notes:

- `SQS_ENDPOINT` and `SQS_QUEUE_URL` are used for LocalStack in development.
- Keep secrets out of the repo; use `.env` and CI secrets for deployments.

## Environment variables

Copy from `.env.example` and set values appropriate for your environment. Important vars:

- `DATABASE_URL` — Postgres connection string
- `PORT` — HTTP port (default 3000)
- `SQS_QUEUE_URL` / `SQS_ENDPOINT` — for LocalStack or AWS
- `PORTKEY_API_KEY` / `PORTKEY_CONFIG` — Portkey credentials

## Testing & local workflows

Submit a ticket and watch its events locally:

```bash
# interactive (recommended)
npm run submit

# inline
npm run submit -- "Cannot login" "Locked out for 3 days, need password reset"

# direct (if you prefer running the script file)
node scripts/ticket-submit.ts "Cannot login" "Locked out for 3 days, need password reset"
```

Watch an existing ticket's events:

```bash
npm run watch -- <ticketId>

# or directly
node scripts/ticket-watch.ts <ticketId>
```

Fetch ticket status/result:

```bash
curl -s http://localhost:3000/tickets/<id> | jq
```

Run unit tests:

```bash
npm test
```

## API

### POST /tickets

Submit a ticket for async processing. Returns `202` with ticket metadata.

Request body:

```json
{ "subject": "string", "body": "string" }
```

Response `202` example:

```json
{ "id": "uuid", "status": "queued", "createdAt": "ISO8601" }
```

### GET /tickets/:id

Returns ticket status and phase outputs. Example shape:

```json
{
  "id": "uuid",
  "subject": "string",
  "status": "completed",
  "createdAt": "ISO8601",
  "phases": {
    "triage": {
      "status": "success",
      "output": {
        /* triage JSON */
      }
    },
    "draft": {
      "status": "success",
      "output": {
        /* draft JSON */
      }
    }
  }
}
```

## Socket.io

Connect to the server and emit `subscribe` with a ticket ID to receive `ticket:event` messages. The server replays full event history on subscribe so late joins and reconnects receive complete context.

Client example:

```js
const s = io('http://localhost:3000');
s.on('connect', () => s.emit('subscribe', ticketId));
s.on('ticket:event', event => console.log(event));
```

Event types include `ticket_created`, `phase_started`, `phase_completed`, `phase_failed`, `retry_scheduled`, `dlq_routed`, and `ticket_completed`.

## AI pipeline

AI calls are routed through Portkey which can fall back across providers. Zod schemas validate AI outputs; validation failures are treated as fatal for a phase (no retry). Transient network/5xx errors are retried with exponential backoff.

Phases:

- **Triage** — classifies category, priority, sentiment, escalation, routing target, and summary.
- **Draft** — crafts customer reply, internal note, and next actions; uses triage output as context.

## Development reset

```bash
# Recreate infra and start services
docker compose down -v && docker compose up -d

# Run migrations
npm run migrate

# LocalStack queues are provisioned automatically when using docker-compose.
# If you did not use docker-compose or need to re-provision, run:
# bash scripts/setup-localstack.sh

# Start the app
npm run dev
```

## Contributing

File issues or PRs; keep changes focused and include tests for new behavior.

---

If you'd like, I can also:

- update README links to specific files in the repo,
- add a short developer quickstart for first-time contributors, or
- generate a minimal diagram file for the architecture.
