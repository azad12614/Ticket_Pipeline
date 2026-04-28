# AI Ticket Processing Pipeline

Node.js backend that processes customer support tickets through a 2-phase AI pipeline. Tickets are triaged and drafted asynchronously via SQS, with real-time status updates over Socket.io.

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

**Key design decisions:**

- Worker never re-enqueues on failure — adjusts SQS visibility timeout (exponential backoff). Message is never lost between a delete and a re-send.
- Phase rows created at ticket submission — API shape is stable from moment ticket exists.
- Completed phases are never re-run — `UNIQUE(ticket_id, phase)` + status check guards idempotency.
- Socket.io events sourced from DB trigger on `ticket_events` INSERT — worker is not involved in emission. Covers `ticket_created` which originates outside the worker.
- Full event replay on subscribe — late joins and reconnects get full history immediately.

## Stack

| Layer      | Technology                                     |
| ---------- | ---------------------------------------------- |
| Runtime    | Node.js + TypeScript (ESM)                     |
| HTTP       | Express 5                                      |
| Database   | PostgreSQL 16                                  |
| Queue      | AWS SQS (LocalStack in dev)                    |
| AI Gateway | Portkey (Anthropic → OpenAI → Google fallback) |
| Real-time  | Socket.io + PG LISTEN/NOTIFY                   |
| Validation | Zod                                            |
| Logging    | Pino                                           |
| Tests      | Vitest                                         |

## Project Structure

```
src/
├── routes/          # Express route definitions
├── controllers/     # Request/response handling
├── services/
│   ├── ticketService.ts    # Ticket creation
│   ├── aiService.ts        # Phase 1 (triage) + Phase 2 (draft)
│   └── notifyService.ts    # PG LISTEN → Socket.io emit
├── repositories/    # All SQL — tickets, phases, events
├── queues/          # SQS enqueue, receive, delete, visibility
├── workers/         # SQS long-poll loop + phase orchestrator
├── schemas/         # Zod schemas (ticket, phase, event, triage, draft)
├── middleware/      # Error handler
└── lib/
    ├── config.ts    # Zod-validated env vars
    ├── db.ts        # Postgres pool
    ├── io.ts        # Socket.io server + subscribe/replay handler
    ├── logger.ts    # Pino instance
    └── errors.ts    # FatalPhaseError
migrations/          # 005 SQL files + migrate.ts runner
scripts/
├── setup-localstack.sh   # Provision SQS queues in LocalStack
├── ticket-submit.mjs     # Submit ticket + watch live events
└── ticket-watch.mjs      # Watch events for an existing ticket ID
```

## Setup

### Prerequisites

- Node.js 22+
- Docker

### 1. Install dependencies

```bash
npm install
```

### 2. Environment

```bash
cp .env.example .env
```

.env reference:

```
DATABASE_URL=postgresql://ticketuser:ticketpass@localhost:5432/tickets
PORT=3000
LOG_LEVEL=info
NODE_ENV=development

# AWS / SQS
# Set your AWS credentials here. For LocalStack development you can use the
# LocalStack defaults (e.g. "test"), but do not commit real credentials.
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<your-aws-access-key-id>
AWS_SECRET_ACCESS_KEY=<your-aws-secret-access-key>
SQS_ENDPOINT=http://localhost:4566
SQS_QUEUE_URL=http://localhost:4566/000000000000/tickets

PORTKEY_API_KEY=<your-portkey-api-key>
PORTKEY_CONFIG=<your-portkey-config-id>
LOCALSTACK_AUTH_TOKEN=<your-localstack-auth-token>
```

### 3. Start infrastructure

```bash
docker compose up -d
```

### 4. Migrate DB + provision queues

```bash
npm run migrate
bash scripts/setup-localstack.sh
```

### 5. Start server

```bash
npm run dev
```

## Testing

### Submit a ticket and watch live events

```bash
# interactive
node scripts/ticket-submit.mjs

# inline
node scripts/ticket-submit.mjs "Cannot login" "Locked out for 3 days, need password reset"
```

Expected output:

```
Ticket created: 01966b3a-...
Watching events (ctrl+c to stop)...

[14:03:01] ticket_created
[14:04:01] phase_started (triage)
[14:04:03] phase_completed (triage)  {"durationMs":2100,"provider":"anthropic"}
[14:04:03] phase_started (draft)
[14:04:05] phase_completed (draft)   {"durationMs":1800,"provider":"anthropic"}
[14:04:05] ticket_completed
```

### Watch an existing ticket

```bash
node scripts/ticket-watch.mjs <ticketId>
```

### Check ticket result

```bash
curl -s http://localhost:3000/tickets/<id> | jq
```

### Run unit tests

```bash
npm test
```

## API

### `POST /tickets`

Submit a ticket for processing. Returns `202` immediately — processing is async.

**Request:**

```json
{ "subject": "string", "body": "string" }
```

**Response `202`:**

```json
{ "id": "uuid", "status": "queued", "createdAt": "ISO8601" }
```

### `GET /tickets/:id`

Fetch ticket status and AI output.

**Response `200`:**

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
        "category": "technical",
        "priority": "high",
        "sentiment": "frustrated",
        "escalation": false,
        "routing_target": "technical-team",
        "summary": "User locked out for 3 days, needs password reset."
      }
    },
    "draft": {
      "status": "success",
      "output": {
        "customer_reply": "...",
        "internal_note": "...",
        "next_actions": ["..."]
      }
    }
  }
}
```

## Socket.io

Connect to `http://localhost:3000`. Emit `subscribe` with a ticket ID to join its room. All events use the `ticket:event` name.

```js
const s = io('http://localhost:3000');
s.on('connect', () => s.emit('subscribe', ticketId));
s.on('ticket:event', event => console.log(event));
```

**Event types:** `ticket_created`, `phase_started`, `phase_completed`, `phase_failed`, `retry_scheduled`, `dlq_routed`, `ticket_completed`

Full event replay is sent on subscribe — reconnects and late joins receive the complete history.

## AI Pipeline

Portkey routes all AI calls through a fallback chain: **Anthropic Claude → OpenAI GPT-4o → Google Gemini**. Provider switching is transparent — Zod schemas enforce identical output structure from all providers.

**Phase 1 — Triage** (`triageTicket`): classifies category, priority, sentiment, escalation flag, routing target, and summary.

**Phase 2 — Draft** (`draftResolution`): generates customer-facing reply, internal support note, and next actions using Phase 1 output as context.

Both phases use tool use (forced function call) to guarantee structured JSON. Responses validated with Zod before writing to Postgres. A Zod validation failure is fatal — no retry. Network errors and 5xx responses are retryable (max 3 attempts, exponential backoff).

## Daily Reset (dev)

```bash
docker compose down -v && docker compose up -d
npm run migrate
bash scripts/setup-localstack.sh
npm run dev
```
