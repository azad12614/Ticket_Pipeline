# AI-Powered Support Ticket Processing Pipeline

## Technical PRD

| Field        | Details                       |
| ------------ | ----------------------------- |
| **Version**  | 1.0.0                         |
| **Status**   | Final                         |
| **Audience** | Backend Engineers, DevOps, QA |
| **Date**     | April 2026                    |

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Tech Stack](#2-tech-stack)
3. [Architecture Decisions](#3-architecture-decisions)
   - [3.1 Database Schema](#31-database-schema)
   - [3.2 Folder Structure](#32-folder-structure)
   - [3.3 Queue Architecture](#33-queue-architecture)
   - [3.4 AI Provider Fallback Chain](#34-ai-provider-fallback-chain)
   - [3.5 Output Validation](#35-output-validation)
   - [3.6 Prompt Design Principles](#36-prompt-design-principles)
   - [3.7 Retry Strategy](#37-retry-strategy)
   - [3.8 Socket.io Room Strategy](#38-socketio-room-strategy)
   - [3.9 API Contract](#39-api-contract)
   - [3.10 Environment Variables](#310-environment-variables)
4. [Build Order](#4-build-order)
5. [Epic 1 — Project Foundation & Infrastructure](#epic-1--project-foundation--infrastructure)
6. [Epic 2 — REST API Layer](#epic-2--rest-api-layer)
7. [Epic 3 — Async Worker & Queue Processing](#epic-3--async-worker--queue-processing)
8. [Epic 4 — AI Pipeline (Phase 1 & Phase 2)](#epic-4--ai-pipeline-phase-1--phase-2)
9. [Epic 5 — Real-Time Socket.io Layer](#epic-5--real-time-socketio-layer)
10. [Epic 6 — Observability, Retry & DLQ](#epic-6--observability-retry--dlq)
11. [Testing Strategy](#10-testing-strategy)
12. [Summary](#11-summary)

---

## 1. System Overview

A Node.js backend service that processes customer support tickets through a 2-phase AI pipeline.

- **Phase 1 — Triage:** AI classifies the ticket and produces: category, priority, sentiment, escalation flag, routing target, and a concise summary.
- **Phase 2 — Resolution Draft:** Using the original ticket and Phase 1 output, AI generates: a customer-facing reply, an internal support note, and recommended next actions.

The system responds to submissions immediately (< 200ms), processes asynchronously via SQS, pushes real-time updates via Socket.io, and retries failed phases automatically with exponential backoff. Completed phases are never re-executed.

---

## 2. Tech Stack

| Concern           | Decision                                             |
| ----------------- | ---------------------------------------------------- |
| Runtime           | Node.js v24 + TypeScript                             |
| Package Manager   | npm                                                  |
| Database          | PostgreSQL (self-hosted)                             |
| Queue             | AWS SQS via LocalStack (uv + venv for local setup)   |
| AI Gateway        | Portkey — Claude (primary) → GPT-4o → Gemini 1.5 Pro |
| Output Validation | Zod + Tool Use (enforced via Portkey)                |
| Real-Time         | Socket.io — per-ticket rooms                         |
| Logging           | Pino (structured JSON), pino-pretty in dev           |
| Testing           | Vitest (unit tests only)                             |
| Worker            | Long-polling SQS consumer (no Lambda)                |
| Auth              | None — internal service                              |
| Soft-Archive      | node-cron — daily job, `archived_at` column          |

---

## 3. Architecture Decisions

### 3.1 Database Schema

Three-table normalized design. See migration files for full SQL.

**Key constraints:**

- `UNIQUE(ticket_id, phase)` on `ticket_phases` — enforces phase idempotency; also acts as race guard against concurrent workers
- `ticket_events` is insert-only — no UPDATE or DELETE permitted
- `ticket_events.ticket_id` uses `ON DELETE RESTRICT` — a ticket cannot be deleted while audit records exist
- `ticket_phases.ticket_id` uses `ON DELETE CASCADE` — phase rows are operational state, not audit records
- Phase rows created at submission time in same transaction as ticket insert — stable API shape from the moment ticket exists
- `attempts` incremented atomically on phase claim (before execution) — a worker crash counts as a consumed attempt
- `archived_at IS NULL` filter excludes soft-archived tickets from default list queries
- Soft-archive: a daily `node-cron` job sets `archived_at = NOW()` on tickets where `created_at < NOW() - INTERVAL '90 days'` and `archived_at IS NULL`

---

### 3.2 Folder Structure

```
src/
├── routes/          # Express route definitions (no logic)
├── controllers/     # Request/response handling, calls services
├── services/        # Business logic
│   ├── ticketService.ts
│   ├── aiService.ts
│   ├── phaseService.ts
│   └── replayService.ts
├── repositories/    # DB access layer (all SQL lives here)
│   ├── ticketRepo.ts
│   ├── phaseRepo.ts
│   └── eventRepo.ts
├── queues/          # SQS producer & consumer
│   ├── producer.ts
│   └── consumer.ts
├── sockets/         # Socket.io setup & event emitters
│   ├── socketServer.ts
│   └── emitter.ts
├── schemas/         # Zod validation schemas
│   ├── triageSchema.ts
│   └── draftSchema.ts
├── workers/         # SQS worker long-poll loop
│   └── ticketWorker.ts
├── middleware/      # Express middleware
│   ├── errorHandler.ts
│   └── validateRequest.ts
├── lib/             # Shared utilities
│   ├── logger.ts    # Pino instance with PII serializers
│   ├── db.ts        # Postgres connection pool
│   └── sqs.ts       # SQS client (LocalStack-aware)
└── index.ts         # Entry point
```

---

### 3.3 Queue Architecture

Worker long-polls the main queue (20s wait, one message at a time). On pickup: reads `ticket_phases` from Postgres fresh, determines which phase to run, executes it. On phase success: deletes SQS message, loops back to poll. On phase failure (retryable, attempt < 3): calls `ChangeMessageVisibility` with exponential backoff delay — message stays in queue, SQS re-delivers automatically. On fatal failure (Zod validation): deletes SQS message manually, marks phase and ticket failed immediately — no retry. On attempt exhaustion (3 deliveries): SQS native `RedrivePolicy` moves message to DLQ automatically.

**Retry flow — no manual re-enqueue.** Worker never sends a new SQS message on failure. It only adjusts visibility timeout on the existing message. This ensures message is never lost between a delete and a re-send.

DLQ consumer is a **separate process**. It reads from the DLQ, sets `ticket.status = 'failed'`, writes a `dlq_routed` event to `ticket_events`, and emits `ticket.failed` via Socket.io.

LocalStack provisioned via `uv` + `venv`. Main queue linked to DLQ via `RedrivePolicy` with `maxReceiveCount: 3`. See README for setup commands.

**SQS visibility timeout:** 300 seconds initial. Worker extends via `ChangeMessageVisibility` every 4 minutes during long AI calls to prevent re-delivery while processing. `receiptHandle` is passed as direct parameter into the phase orchestrator for this purpose.

---

### 3.4 AI Provider Fallback Chain

Portkey handles provider routing. The worker calls one unified Portkey endpoint — it never calls AI providers directly.

Portkey configured with `strategy.mode = "fallback"` targeting Anthropic → OpenAI → Google in order. All provider API keys stored in env vars, never hardcoded.

Two plain exported functions — no shared interface: `triageTicket(ticket)` in `aiService (triage).ts`, `draftResolution(ticket, triage)` in `aiService (draft).ts`. Both call Portkey — never AI providers directly. No interface: nothing is polymorphic, Portkey handles provider switching transparently.

Every Portkey request includes metadata: `{ ticketId, phase, attempt }` for Portkey's observability dashboard and cross-system tracing via `x-portkey-trace-id`.

**AI call timeout:** 30 seconds per call. A timeout is treated as a retryable network failure, not a fatal Zod validation failure.

---

### 3.5 Output Validation

Tool use is enforced via Portkey to guarantee structured JSON output from all three providers. Responses are then validated with Zod before being written to Postgres.

**Phase 1 — `triageOutputSchema` fields:**

- `category`: `billing | technical | account | general | other`
- `priority`: `critical | high | medium | low`
- `sentiment`: `positive | neutral | negative | frustrated`
- `escalation`: boolean
- `routing_target`: `support | billing-team | technical-team | account-team`
- `summary`: string, min 10 chars, max 300 chars

**Phase 2 — `draftOutputSchema` fields:**

- `customerReply`: string, min 50 chars, max 2000 chars
- `internalNote`: string, min 20 chars, max 1000 chars
- `nextActions`: array of strings, 1–5 items

**Validation rule:** Use `safeParse` (not `parse`) — errors are handled gracefully, never thrown. If Zod validation fails, the phase is immediately marked `failed` and routed to DLQ. Zod failure is **fatal and not retryable** — retrying with identical input produces the same malformed output.

---

### 3.6 Prompt Design Principles

Exact prompt text lives in code (`aiService (triage).ts`, `aiService (draft).ts`). These principles define what each prompt must achieve.

**Phase 1 — Triage Prompt:**

- **Receives:** Raw ticket subject and body
- **Must return:** All 6 fields of `triageSchema` via tool use — no free-form text
- **Principle:** Classify strictly from the allowed enums — do not invent categories
- **Principle:** Summary must be one sentence, factual, under 300 characters

**Phase 2 — Resolution Prompt:**

- **Receives:** Original ticket subject and body + full Phase 1 structured output (injected as JSON)
- **Must return:** All 3 fields of `draftSchema` via tool use
- **Principle:** Customer reply must be warm, professional, and address the specific issue — not generic
- **Principle:** Internal note must reference the triage category, priority, and escalation flag
- **Principle:** Next actions must be specific and actionable (1–5 items)

---

### 3.7 Retry Strategy

Attempt 1: immediate. Attempt 2: ~2s delay (`2^1 * 1000 + jitter`). Attempt 3: ~4s delay (`2^2 * 1000 + jitter`). Attempt 4: SQS `RedrivePolicy` exhausted (`maxReceiveCount: 3`) → message auto-moved to DLQ. Jitter is `random(0, 500)ms`.

Backoff implemented via `ChangeMessageVisibility(receiptHandle, delaySeconds)` on the existing message — not via re-enqueue. Delay converts ms to seconds for the SQS call.

**Retry rules:**

- Retryable: network error, timeout (30s), rate limit (429), provider unavailable (5xx)
- Fatal (no retry): Zod validation failure, invalid ticket state — message deleted manually, phase marked failed immediately
- SQS message deleted only on: successful phase completion OR fatal (Zod) failure
- On retryable failure: message stays in queue, visibility set to backoff delay, SQS re-delivers
- Phase `attempts` incremented atomically in Postgres on claim (before execution) — crash counts as consumed attempt
- A completed phase is never re-executed, even if the message is re-delivered

---

### 3.8 Socket.io Room Strategy

```
ticket:{ticketId}   → client that submitted the ticket (individual updates)
```

**Events emitted to `ticket:{ticketId}` room:**

- `ticket.queued` — on submission: `{ ticketId, timestamp }`
- `phase.started` — on pickup: `{ ticketId, phase, attempt, timestamp }`
- `phase.completed` — on success: `{ ticketId, phase, timestamp }`
- `phase.failed` — on failure: `{ ticketId, phase, attempt, error, timestamp }`
- `phase.retrying` — on retry schedule: `{ ticketId, phase, attempt, nextRetryIn, timestamp }`
- `ticket.completed` — full output: `{ ticketId, phase1Output, phase2Output, timestamp }`
- `ticket.failed` — on DLQ route: `{ ticketId, reason, timestamp }`

**Rules:**

- Emitter is wrapped in try/catch — socket failure must never crash the worker
- Socket.io server does not crash if no clients are connected to a room
- CORS restricted to internal network (not wildcard)

---

### 3.9 API Contract

**POST /tickets** — Submit a new ticket

- Request body: `subject` (string, required), `body` (string, required)
- Response 202: `{ ticketId, status: "queued" }`

**GET /tickets/:id** — Get ticket status, phase outputs, and audit events

- Response 200: `{ ticketId, status, phases: { triage?, draft? }, events[] }`
- `phases` keyed by phase name; each entry has `status`, `attempts`, and `output` (only when `status = success`)
- `events` last 20 in chronological order (deferred — US-1.3)
- Response 404 if ticket not found

**GET /tickets** — List tickets with filtering and pagination

- Query: `?status=`, `?archived=true` (default false), `?page=` (default 1), `?limit=` (default 20, max 100)
- Response 200: `{ tickets[], total, page, limit }`
- Excludes soft-archived tickets by default

**POST /tickets/:id/replay** — Re-enqueue a failed ticket

- Only accepts tickets with `status = failed` — returns 409 otherwise
- Resets `ticket.status` to `queued`, failed phase `status` to `started`, and failed phase `attempts` to `0`; completed phases untouched
- Response 200: `{ ticketId, status: "queued" }`

**Error shape (all endpoints):** `{ "error": "CODE", "message": "...", "code": 4xx }`

| Scenario                          | Code |
| --------------------------------- | ---- |
| Missing or invalid request fields | 400  |
| Ticket not found                  | 404  |
| Replay on non-failed ticket       | 409  |
| Unhandled server error            | 500  |

---

### 3.10 Environment Variables

All configuration is externalized. No hardcoded values anywhere in the codebase.

| Variable            | Purpose                    | Example                                                      |
| ------------------- | -------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`      | Postgres connection string | `postgresql://user:pass@localhost:5432/tickets`              |
| `SQS_QUEUE_URL`     | Main SQS queue URL         | `http://localhost:4566/000000000000/ticket-processing-queue` |
| `SQS_DLQ_URL`       | Dead letter queue URL      | `http://localhost:4566/000000000000/ticket-processing-dlq`   |
| `SQS_ENDPOINT`      | LocalStack endpoint        | `http://localhost:4566`                                      |
| `PORTKEY_API_KEY`   | Portkey gateway API key    | `pk-...`                                                     |
| `PORTKEY_CONFIG`    | Portkey config ID (fallback chain + model selection managed in Portkey dashboard) | `pc-...` |
| `PORT`              | Express server port        | `3000`                                                       |
| `LOG_LEVEL`         | Pino log level             | `info`                                                       |

---

## 4. Build Order

Strict dependency order — each layer must be complete and passing before the next starts.

### MVP Build Sequence

| Layer                              | Description                                                                             | Epic Tasks                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **1 — Data Foundation**            | DB schema, migrations, Postgres pool, SQS client, Pino                                  | E1-T1, E1-T2, E1-T3, E1-T4, E1-T5, E1-T7, E1-T8, E1-T10 |
| **2 — API Surface**                | Express, `POST /tickets`, `GET /tickets/:id` _(event history excluded until Epic 6)_    | E2-T1, E2-T2, E2-T3                                     |
| **3 — Worker Core**                | SQS consumer, phase checkpoint reader, orchestrator, retry backoff, DLQ routing         | E3-T1, E3-T2, E3-T3, E3-T4, E3-T5                       |
| **4 — AI Phase 1**                 | Portkey setup, `triageSchema`, Phase 1 adapter, Zod failure flow                        | E4-T1, E4-T3, E4-T4, E4-T5, E4-T8                       |
| **5 — Phase Handoff + AI Phase 2** | Phase 1 → Phase 2 re-enqueue, `draftSchema`, Phase 2 adapter, Phase 1 completion guard | E3-T3 _(handoff)_, E4-T6, E4-T7, E4-T12                 |

### Deferred — Non-MVP

| Task(s)                                                                               | Notes                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| E1-T9 soft-archive cron, E1-T11 README, E1-T12 seed                                   | Add before broad rollout — not blocking core pipeline         |
| E2-T4 list/filter endpoint, E2-T5 replay endpoint, E2-T6 full test suite              | E2-T5 depends on DLQ consumer (E6-T4)                         |
| E3-T6 visibility timeout extension, E3-T7 graceful shutdown                           | Production polish — Sprint 4                                  |
| E4-T2 fallback config, E4-T9 cost logging, E4-T10 adapter tests, E4-T11 fallback test | Resilience + observability — Sprint 3                         |
| Epic 5 — all tasks                                                                    | Real-time updates — Sprint 3                                  |
| Epic 6 — all tasks                                                                    | Full observability, DLQ consumer, replay service — Sprint 3–4 |

---

## Epic 1 — Project Foundation & Infrastructure

**Priority:** Critical | **Story Points:** 21 | **Sprint:** 1

### Overview

Establish foundational infrastructure: PostgreSQL with 3-table normalized schema, LocalStack SQS with DLQ, layer-based Node.js + TypeScript project scaffold, and Pino structured logging with PII sanitization.

### Acceptance Criteria

- [ ] PostgreSQL running locally, accessible from Node.js via connection pool
- [ ] All 3 tables exist with correct types, FKs, indexes, and constraints
- [ ] `UNIQUE(ticket_id, phase)` constraint enforced on `ticket_phases`
- [ ] `archived_at` column present on `tickets` table
- [ ] Migration scripts are idempotent and run cleanly on a fresh Postgres instance
- [ ] LocalStack SQS running with main queue and DLQ provisioned
- [ ] DLQ linked to main queue via `RedrivePolicy` with `maxReceiveCount: 3`
- [ ] SQS queue URLs and all credentials configurable via environment variables
- [ ] Node.js project scaffolded with exact folder structure (including `controllers/` and `middleware/`)
- [ ] Pino configured with structured JSON output, correct log levels, and `ticketId` context binding
- [ ] PII serializer strips `body` and email fields from all Pino output
- [ ] `.env.example` documents all 10 required environment variables
- [ ] Daily `node-cron` job archives tickets older than 90 days
- [ ] README contains every manual setup command needed to run the service locally

### Definition of Done

- [ ] DB migration verified on a fresh Postgres instance from scratch
- [ ] LocalStack queues verified: `aws sqs list-queues --endpoint-url http://localhost:4566`
- [ ] DLQ `maxReceiveCount` confirmed as 3 via queue attributes check
- [ ] Pino JSON output validated: includes `timestamp`, `level`, `ticketId` — no `body` field
- [ ] ESLint + Prettier pass with zero errors
- [ ] `.env.example` reviewed and matches all 10 consumed env vars
- [ ] No hardcoded credentials anywhere in the codebase
- [ ] README tested end-to-end on a clean machine by someone not involved in writing it

### Subtasks

| ID     | Task                                                                                | Pts | Status  |
| ------ | ----------------------------------------------------------------------------------- | --- | ------- |
| E1-T1  | Initialize Node.js v24 + TypeScript project with ESLint and Prettier                | 2   | Backlog |
| E1-T2  | Scaffold layer-based folder structure (all 11 directories)                          | 1   | Backlog |
| E1-T3  | Set up PostgreSQL locally and configure connection pool (`lib/db.ts`)               | 2   | Backlog |
| E1-T4  | Implement DB schema: tickets (with `archived_at`), ticket_phases, ticket_events     | 3   | Backlog |
| E1-T5  | Write migration scripts (up/down) for all three tables                              | 2   | Backlog |
| E1-T6  | Set up LocalStack via uv + venv and provision main SQS queue + DLQ                  | 3   | Backlog |
| E1-T7  | Configure SQS client (`lib/sqs.ts`) with LocalStack endpoint via env vars           | 2   | Backlog |
| E1-T8  | Integrate Pino with `ticketId` context binding and PII serializer (`lib/logger.ts`) | 2   | Backlog |
| E1-T9  | Implement daily `node-cron` soft-archive job                                        | 2   | Backlog |
| E1-T10 | Configure `.env` management and write `.env.example`                                | 1   | Backlog |
| E1-T11 | Write full README with manual setup instructions (Postgres + LocalStack + uv)       | 2   | Backlog |
| E1-T12 | Write seed script for local development (`seed.ts`)                                 | 1   | Backlog |

### Checklist

- [ ] `tickets`, `ticket_phases`, `ticket_events` tables created with correct column types
- [ ] `archived_at TIMESTAMPTZ` column on `tickets`, nullable
- [ ] FK: `ticket_phases.ticket_id → tickets.id ON DELETE CASCADE`
- [ ] FK: `ticket_events.ticket_id → tickets.id ON DELETE RESTRICT`
- [ ] `UNIQUE(ticket_id, phase)` constraint on `ticket_phases`
- [ ] LocalStack DLQ linked with `RedrivePolicy` `maxReceiveCount: 3`
- [ ] Pino log includes: `timestamp`, `level`, `ticketId`, `phase`, `attempt`
- [ ] Pino serializer confirmed: `body` field absent from all log output
- [ ] `node-cron` job tested: sets `archived_at` on tickets older than 90 days
- [ ] Connection pool max connections configurable via env
- [ ] Migrations committed and peer-reviewed

### Kanban

| Backlog                  | In Progress | Review | Done |
| ------------------------ | ----------- | ------ | ---- |
| E1-T1: Project init      | —           | —      | —    |
| E1-T2: Folder structure  | —           | —      | —    |
| E1-T3: Postgres pool     | —           | —      | —    |
| E1-T4: DB schema         | —           | —      | —    |
| E1-T5: Migrations        | —           | —      | —    |
| E1-T6: LocalStack SQS    | —           | —      | —    |
| E1-T7: SQS client        | —           | —      | —    |
| E1-T8: Pino setup        | —           | —      | —    |
| E1-T9: Soft-archive cron | —           | —      | —    |
| E1-T11: README           | —           | —      | —    |

---

## Epic 2 — REST API Layer

**Priority:** Critical | **Story Points:** 13 | **Sprint:** 1

### Overview

Implement four REST endpoints. No versioning. No auth. Returns 202 immediately on ticket submission, persists to Postgres before enqueueing to SQS, and supports list filtering, pagination, and manual replay.

### Acceptance Criteria

- [ ] `POST /tickets` validates required fields: `subject`, `body` — returns 400 on missing fields
- [ ] `POST /tickets` returns 202 immediately; ticket persisted to Postgres before SQS enqueue
- [ ] If Postgres write fails, SQS is not called — no orphan queue messages
- [ ] `GET /tickets/:id` returns ticket, phase statuses, and last 20 events in chronological order
- [ ] `GET /tickets/:id` returns 404 with error shape if ticket not found
- [ ] `GET /tickets/:id` includes phase output only when phase `status = completed`
- [ ] `GET /tickets` supports filters: `?status=`, `?archived=` and pagination `?page=`, `?limit=`
- [ ] `GET /tickets` excludes soft-archived tickets by default (`archived_at IS NULL`)
- [ ] `POST /tickets/:id/replay` only works on tickets with `status: "failed"` — returns 409 otherwise
- [ ] `POST /tickets/:id/replay` resets only the failed phase — completed phases untouched
- [ ] All errors return `{ error, message, code }` JSON — never HTML
- [ ] All routes log request/response with Pino including `ticketId`

### Definition of Done

- [ ] All endpoints return correct HTTP status codes for happy path and all error cases
- [ ] Input validation returns 400 with field-level error details
- [ ] DB writes verified with unit tests (mocked Postgres)
- [ ] SQS message confirmed sent (mocked SQS) on ticket submission
- [ ] `POST /tickets/:id/replay` rejected with 409 when ticket is not in `failed` state
- [ ] All route handlers covered by unit tests

### Subtasks

| ID    | Task                                                                       | Pts | Status  |
| ----- | -------------------------------------------------------------------------- | --- | ------- |
| E2-T1 | Set up Express app with middleware: JSON body parser, global error handler | 2   | Backlog |
| E2-T2 | Implement `POST /tickets` with Zod input validation                        | 3   | Backlog |
| E2-T3 | Implement `GET /tickets/:id` with phase + event join query                 | 2   | Backlog |
| E2-T4 | Implement `GET /tickets` with filtering and offset pagination              | 2   | Backlog |
| E2-T5 | Implement `POST /tickets/:id/replay` with state guard                      | 2   | Backlog |
| E2-T6 | Write unit tests for all route handlers and controllers                    | 2   | Backlog |

### Checklist

- [ ] `POST /tickets` returns 202 (not 200, not 201)
- [ ] Ticket written to DB before SQS enqueue — DB failure rolls back, no orphan SQS message
- [ ] `GET /tickets/:id` phase output absent when phase is not `completed`
- [ ] `GET /tickets` default: `archived_at IS NULL`, default limit 20, max limit 100
- [ ] Replay endpoint resets failed phase to `pending`, ticket to `queued`
- [ ] Replay endpoint leaves completed phases untouched
- [ ] Global error handler returns JSON for all error types including unhandled exceptions
- [ ] All Pino logs include `ticketId` in context

### Kanban

| Backlog                    | In Progress | Review | Done |
| -------------------------- | ----------- | ------ | ---- |
| E2-T1: Express setup       | —           | —      | —    |
| E2-T2: POST /tickets       | —           | —      | —    |
| E2-T3: GET /tickets/:id    | —           | —      | —    |
| E2-T4: GET /tickets (list) | —           | —      | —    |
| E2-T5: Replay endpoint     | —           | —      | —    |
| E2-T6: Unit tests          | —           | —      | —    |

---

## Epic 3 — Async Worker & Queue Processing

**Priority:** Critical | **Story Points:** 21 | **Sprint:** 2

### Overview

Implement the SQS long-polling consumer that reads Postgres phase checkpoints and orchestrates phase execution. Implements exponential backoff + jitter retries (max 3 attempts), routes to DLQ on exhaustion, re-enqueues after Phase 1 success, and handles graceful shutdown on SIGTERM.

### Acceptance Criteria

- [ ] Worker polls SQS via long-polling (20s wait time) and processes one message at a time
- [ ] Worker reads `ticket_phases` fresh from Postgres on every job pickup — no in-memory state
- [ ] Completed phases are skipped — never re-executed, even on re-delivery
- [ ] On phase failure: attempt count incremented atomically in Postgres, event written to `ticket_events`
- [ ] Retry uses exponential backoff with jitter: `2^attempt * 1000 + random(0,500)ms`
- [ ] After 3 failed attempts: job routed to DLQ, ticket status set to `failed`
- [ ] Phase 1 success triggers immediate re-enqueue for Phase 2
- [ ] Worker extends SQS visibility timeout (300s) before it expires on long AI calls
- [ ] Worker gracefully shuts down on SIGTERM — finishes current job before stopping
- [ ] Worker loop continues after individual job failures — does not crash

### Definition of Done

- [ ] Worker tested against LocalStack SQS with real messages
- [ ] Postgres state verified after each phase transition
- [ ] Completed phase confirmed never re-executed: verified by unit test
- [ ] Retry backoff timings verified in logs
- [ ] DLQ routing verified after 3 failed attempts
- [ ] Graceful shutdown tested: in-flight job completes before process exits
- [ ] Worker loop survives a job failure without crashing

### Subtasks

| ID    | Task                                                                     | Pts | Status  |
| ----- | ------------------------------------------------------------------------ | --- | ------- |
| E3-T1 | Implement SQS long-polling consumer loop (`queues/consumer.ts`)          | 3   | Backlog |
| E3-T2 | Implement Postgres phase checkpoint reader (`repositories/phaseRepo.ts`) | 2   | Backlog |
| E3-T3 | Implement phase orchestrator with completed-phase skip guard             | 3   | Backlog |
| E3-T4 | Implement retry scheduler with exponential backoff + jitter              | 3   | Backlog |
| E3-T5 | Implement DLQ routing on attempt exhaustion                              | 2   | Backlog |
| E3-T6 | Implement SQS visibility timeout extension for long-running AI calls     | 2   | Backlog |
| E3-T7 | Implement graceful shutdown handler on SIGTERM                           | 2   | Backlog |
| E3-T8 | Write unit tests for orchestrator, retry logic, and phase skip guard     | 4   | Backlog |

### Checklist

- [ ] Worker never re-runs a `completed` phase
- [ ] `ticket_events` row written for every state transition (started, completed, failed, retry, dlq)
- [ ] `ticket_phases.attempts` incremented atomically in Postgres on phase claim (before execution)
- [ ] SQS message deleted only on success or fatal (Zod) failure — never on retryable failure
- [ ] Retryable failure uses `ChangeMessageVisibility` with backoff delay — no new message enqueued
- [ ] DLQ routing via native `RedrivePolicy` after `maxReceiveCount: 3` deliveries
- [ ] DLQ consumer reads DLQ message — includes `ticketId` and `failedPhase`
- [ ] Visibility timeout extended before it expires on long AI calls
- [ ] Worker loop continues after individual job failures
- [ ] Phase 1 success immediately re-enqueues `{ ticketId }` for Phase 2

### Kanban

| Backlog                   | In Progress | Review | Done |
| ------------------------- | ----------- | ------ | ---- |
| E3-T1: SQS consumer       | —           | —      | —    |
| E3-T2: Phase checkpoint   | —           | —      | —    |
| E3-T3: Phase orchestrator | —           | —      | —    |
| E3-T4: Retry scheduler    | —           | —      | —    |
| E3-T5: DLQ routing        | —           | —      | —    |
| E3-T6: Visibility timeout | —           | —      | —    |
| E3-T7: Graceful shutdown  | —           | —      | —    |
| E3-T8: Unit tests         | —           | —      | —    |

---

## Epic 4 — AI Pipeline (Phase 1 & Phase 2)

**Priority:** Critical | **Story Points:** 34 | **Sprint:** 2–3

### Overview

Implement Phase 1 (triage) and Phase 2 (resolution draft) using Portkey as the unified AI gateway. All outputs enforced via tool use and validated with Zod schemas before writing to Postgres. Portkey handles provider fallback (Claude → GPT-4o → Gemini) transparently.

### Acceptance Criteria

- [ ] `aiService (triage)` calls Portkey with tool use schema matching `triageSchema` exactly
- [ ] `aiService (draft)` receives Phase 1 output as structured JSON context and validates with `draftSchema`
- [ ] Zod `safeParse` used — errors handled gracefully, never thrown
- [ ] Zod validation failure: phase marked `failed` immediately, no retry (fatal)
- [ ] Network/timeout failure: phase re-enters retry queue (retryable)
- [ ] AI call timeout: 30 seconds, configured at Portkey SDK level
- [ ] Portkey fallback chain: Claude → GPT-4o → Gemini
- [ ] All Portkey requests include metadata: `{ ticketId, phase, attempt }`
- [ ] `x-portkey-trace-id` extracted and included in every AI-related Pino log event
- [ ] Phase outputs stored as JSON in `ticket_phases.output`
- [ ] Phase 2 never executes if Phase 1 has not completed successfully
- [ ] Token usage logged per call (for cost monitoring)
- [ ] AI call duration logged in ms via Pino on every request

### Definition of Done

- [ ] Phase 1 output validated against `triageSchema` before DB write — all 6 fields present
- [ ] Phase 2 output validated against `draftSchema` before DB write — all 3 fields present
- [ ] Portkey fallback tested: Claude disabled → OpenAI serves request correctly
- [ ] Zod validation failure correctly triggers phase failure (not retry) — verified by unit test
- [ ] Tool use schema confirmed to match Zod schema exactly (no drift)
- [ ] Unit tests cover: valid output, invalid output (Zod fail), network failure, timeout

### Subtasks

| ID     | Task                                                                     | Pts | Status  |
| ------ | ------------------------------------------------------------------------ | --- | ------- |
| E4-T1  | Set up Portkey SDK and configure virtual keys for all 3 providers        | 3   | Backlog |
| E4-T2  | Configure Portkey fallback strategy in gateway config                    | 2   | Backlog |
| E4-T3  | Define `AIProviderAdapter` interface in TypeScript                       | 1   | Backlog |
| E4-T4  | Implement `triageSchema` Zod schema                                      | 2   | Backlog |
| E4-T5  | Implement Phase 1 adapter with tool use prompt and Zod validation        | 5   | Backlog |
| E4-T6  | Implement `draftSchema` Zod schema                                      | 2   | Backlog |
| E4-T7  | Implement Phase 2 adapter with Phase 1 context injection                 | 5   | Backlog |
| E4-T8  | Implement Zod failure → phase failure flow (skip retry)                  | 2   | Backlog |
| E4-T9  | Log AI call duration, provider used, token counts, and trace ID via Pino | 2   | Backlog |
| E4-T10 | Write unit tests for both adapters (mocked Portkey)                      | 4   | Backlog |
| E4-T11 | Test fallback chain: Claude → OpenAI → Gemini sequence                   | 3   | Backlog |
| E4-T12 | Add Phase 1 completion guard in phase orchestrator before Phase 2        | 3   | Backlog |

### Checklist

- [ ] Portkey virtual keys stored in `.env`, never hardcoded
- [ ] Tool use schema matches `triageSchema` and `draftSchema` exactly
- [ ] Phase 2 prompt template injects Phase 1 output as structured JSON context
- [ ] `safeParse` used in both adapters — no uncaught Zod throws
- [ ] AI call timeout set to 30s at Portkey SDK level
- [ ] Token usage logged per call for cost monitoring
- [ ] `x-portkey-trace-id` included in every AI-related log event
- [ ] Phase 2 blocked until Phase 1 `status = completed` — enforced in orchestrator

### Kanban

| Backlog                 | In Progress | Review | Done |
| ----------------------- | ----------- | ------ | ---- |
| E4-T1: Portkey setup    | —           | —      | —    |
| E4-T2: Fallback config  | —           | —      | —    |
| E4-T4: triageSchema     | —           | —      | —    |
| E4-T5: Phase 1 adapter  | —           | —      | —    |
| E4-T6: draftSchema     | —           | —      | —    |
| E4-T7: Phase 2 adapter  | —           | —      | —    |
| E4-T8: Zod failure flow | —           | —      | —    |
| E4-T10: Unit tests      | —           | —      | —    |
| E4-T11: Fallback test   | —           | —      | —    |

---

## Epic 5 — Real-Time Socket.io Layer

**Priority:** High | **Story Points:** 13 | **Sprint:** 3

### Overview

Implement Socket.io server with per-ticket rooms. Emit 7 lifecycle events at the correct pipeline stages. The worker calls the emitter after every state change. The emitter is wrapped in try/catch — socket failures never crash the worker.

### Acceptance Criteria

- [ ] Socket.io server starts alongside Express on the same HTTP server and port
- [ ] Client can join `ticket:{ticketId}` room to receive updates for their ticket
- [ ] All 7 event types emitted at the correct pipeline stage
- [ ] `ticket.completed` includes full Phase 1 and Phase 2 output
- [ ] `ticket.completed` emitted to per-ticket room with full Phase 1 and Phase 2 output
- [ ] Socket.io server does not crash if no clients are connected to a room
- [ ] Emitter module importable by worker without circular dependencies

### Definition of Done

- [ ] All 7 event types verified with unit tests (mocked socket)
- [ ] Per-ticket room isolation confirmed: emitting to `ticket:A` does not reach `ticket:B` subscriber
- [ ] Worker emitter calls do not block or slow down phase processing
- [ ] All events include `timestamp` field (ISO string)
- [ ] `ticket.completed` payload matches Phase 1 and Phase 2 Zod output schemas exactly

### Subtasks

| ID    | Task                                                                     | Pts | Status  |
| ----- | ------------------------------------------------------------------------ | --- | ------- |
| E5-T1 | Set up Socket.io server attached to Express HTTP server                  | 2   | Backlog |
| E5-T2 | Implement room join handler for `ticket:{ticketId}` room                 | 2   | Backlog |
| E5-T3 | Implement emitter module with all 7 event types (`sockets/emitter.ts`)   | 3   | Backlog |
| E5-T4 | Integrate emitter calls into worker after every phase state change       | 2   | Backlog |
| E5-T5 | Write unit tests: verify all 7 events emitted at correct pipeline stages | 3   | Backlog |
| E5-T6 | Verify per-ticket room isolation (no cross-ticket data leakage)          | 1   | Backlog |

### Checklist

- [ ] Socket.io CORS configured for internal network (not wildcard)
- [ ] Emitter wrapped in try/catch — socket failure cannot crash worker
- [ ] All 7 events include `timestamp` field (ISO string)
- [ ] `ticket.completed` payload: full Phase 1 + Phase 2 output
- [ ] No circular dependency between `workers/ticketWorker.ts` and `sockets/emitter.ts`

### Kanban

| Backlog                   | In Progress | Review | Done |
| ------------------------- | ----------- | ------ | ---- |
| E5-T1: Socket.io server   | —           | —      | —    |
| E5-T2: Room handlers      | —           | —      | —    |
| E5-T3: Emitter module     | —           | —      | —    |
| E5-T4: Worker integration | —           | —      | —    |
| E5-T5: Unit tests         | —           | —      | —    |
| E5-T6: Room isolation     | —           | —      | —    |

---

## Epic 6 — Observability, Retry & DLQ

**Priority:** High | **Story Points:** 13 | **Sprint:** 3–4

### Overview

Implement structured observability across all pipeline stages. Every phase execution, retry decision, fallback trigger, and final outcome is logged via Pino and written to `ticket_events`. A separate DLQ consumer updates ticket state on exhaustion. Manual replay is supported via the API.

### Required Pino Log Events

8 required event types with their fields and log levels:

| Event                | Level | Fields                                                 |
| -------------------- | ----- | ------------------------------------------------------ |
| `phase_started`      | info  | ticketId, phase, attempt                               |
| `phase_completed`    | info  | ticketId, phase, attempt, durationMs, provider         |
| `phase_failed`       | warn  | ticketId, phase, attempt, error                        |
| `retry_scheduled`    | warn  | ticketId, phase, attempt, nextRetryIn                  |
| `fallback_triggered` | warn  | ticketId, phase, attempt, failedProvider, nextProvider |
| `dlq_routed`         | error | ticketId, phase, totalAttempts                         |
| `ticket_completed`   | info  | ticketId, totalDurationMs                              |
| `ticket_failed`      | error | ticketId, failedPhase                                  |

**PII rule:** `body` field and any email-containing fields are stripped from all Pino output via serializers. Never appears in any log event.

### Acceptance Criteria

- [ ] Every Pino log event matches the 8 required event types above
- [ ] Every log event is also written as a row in `ticket_events` with matching payload
- [ ] `ticket_events` write is atomic with phase status update (same DB transaction)
- [ ] DLQ consumer (separate process) reads DLQ, sets `ticket.status = failed`, writes `dlq_routed` event
- [ ] `GET /tickets/:id` returns last 20 events in chronological order
- [ ] `POST /tickets/:id/replay` only accepts `status = failed` tickets — returns 409 otherwise
- [ ] Replay resets `ticket.status` to `queued`, failed phase `status` to `started`, and failed phase `attempts` to `0`
- [ ] Replay does not reset completed phases — checkpointing preserved
- [ ] `x-portkey-trace-id` included in every AI-related log event

### Definition of Done

- [ ] Full log trace verified for a successful ticket: all 8 log event types present
- [ ] Full log trace verified for a 3x failed ticket: retry + DLQ events present
- [ ] `ticket_events` table queried after a full run — all transitions present and match logs
- [ ] Replay tested: failed ticket re-runs only failed phase, not completed phase
- [ ] DLQ consumer confirmed as separate process from main worker
- [ ] Pino output piped through `pino-pretty` in dev, raw JSON in CI

### Subtasks

| ID    | Task                                                                                      | Pts | Status  |
| ----- | ----------------------------------------------------------------------------------------- | --- | ------- |
| E6-T1 | Implement `ticket_events` write helper (called after every transition)                    | 2   | Backlog |
| E6-T2 | Add structured Pino log calls to worker for all 8 event types                             | 2   | Backlog |
| E6-T3 | Add Portkey trace ID extraction and inclusion in Pino logs                                | 1   | Backlog |
| E6-T4 | Implement DLQ consumer (separate process) that updates ticket status to `failed`          | 2   | Backlog |
| E6-T5 | Implement replay service with phase checkpoint preservation (`services/replayService.ts`) | 2   | Backlog |
| E6-T6 | Write unit tests for replay service (state guards, reset logic)                           | 2   | Backlog |
| E6-T7 | Add `pino-pretty` as dev dependency; configure CI to use raw JSON                         | 2   | Backlog |

### Checklist

- [ ] `ticket_events` written in same DB transaction as phase status update
- [ ] DLQ consumer is a separate worker process (not the main worker)
- [ ] Replay returns 409 if ticket is not in `failed` state
- [ ] Replay resets only the failed phase — completed phases untouched
- [ ] Portkey trace ID logged on every AI call
- [ ] No `body` or email data in any log event — confirmed by log review
- [ ] Log volume per ticket: ~15 events (success), ~30 events (3x retry)
- [ ] `pino-pretty` added as dev dependency

### Kanban

| Backlog                 | In Progress | Review | Done |
| ----------------------- | ----------- | ------ | ---- |
| E6-T1: Event writer     | —           | —      | —    |
| E6-T2: Pino log calls   | —           | —      | —    |
| E6-T3: Trace ID logging | —           | —      | —    |
| E6-T4: DLQ consumer     | —           | —      | —    |
| E6-T5: Replay service   | —           | —      | —    |
| E6-T6: Unit tests       | —           | —      | —    |
| E6-T7: pino-pretty      | —           | —      | —    |

---

## 10. Testing Strategy

**Framework:** Vitest  
**Scope:** Unit tests only  
**Coverage target:** ≥ 80% on changed modules

### What Gets Mocked

| Dependency         | Mock Approach                                                                       |
| ------------------ | ----------------------------------------------------------------------------------- |
| PostgreSQL         | `vi.mock('../lib/db')` — mock pool and query responses                              |
| SQS (LocalStack)   | `vi.mock('../lib/sqs')` — mock `sendMessage`, `receiveMessage`, `deleteMessage`     |
| Portkey AI Gateway | `vi.mock('../adapters/AIProviderAdapter')` — mock `triageTicket`, `draftResolution` |
| Socket.io          | `vi.mock('../sockets/emitter')` — mock all emit functions                           |
| node-cron          | `vi.mock('node-cron')` — mock schedule registration                                 |

### Test Coverage Per Epic

| Epic   | Key Units Under Test                                                   |
| ------ | ---------------------------------------------------------------------- |
| Epic 1 | DB schema constraints (migration), Pino PII serializer, cron job logic |
| Epic 2 | Route handlers, input validation, error handler, replay state guard    |
| Epic 3 | Phase orchestrator, retry scheduler, backoff calculation, skip guard   |
| Epic 4 | Phase 1 adapter, Phase 2 adapter, Zod validation, timeout handling     |
| Epic 5 | Emitter module, room targeting, event payload shapes                   |
| Epic 6 | Event writer, DLQ consumer, replay service reset logic                 |

---

## 11. Summary

| Epic      | Title                               | Points  | Priority | Sprint        |
| --------- | ----------------------------------- | ------- | -------- | ------------- |
| 1         | Project Foundation & Infrastructure | 21      | Critical | 1             |
| 2         | REST API Layer                      | 13      | Critical | 1             |
| 3         | Async Worker & Queue Processing     | 21      | Critical | 2             |
| 4         | AI Pipeline (Phase 1 & Phase 2)     | 34      | Critical | 2–3           |
| 5         | Real-Time Socket.io Layer           | 13      | High     | 3             |
| 6         | Observability, Retry & DLQ          | 13      | High     | 3–4           |
| **Total** |                                     | **115** |          | **4 Sprints** |

---

_End of Document — Version 1.0.0_
