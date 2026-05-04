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
   - [3.11 TypeScript Conventions](#311-typescript-conventions)
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
│   └── ticketRoutes.ts
├── controllers/     # Request/response handling, calls services
│   └── ticketController.ts
├── services/        # Business logic
│   ├── ticketService.ts
│   ├── aiService.ts
│   └── notifyService.ts  # PG LISTEN → Socket.io emit
├── repositories/    # DB access layer (all SQL lives here)
│   └── ticketRepo.ts     # tickets, phases, events — single file
├── queues/          # SQS producer & consumer
│   └── ticketQueue.ts    # enqueue, receive, delete, visibility
├── schemas/         # Zod validation schemas
│   ├── ticketSchema.ts
│   ├── phaseSchema.ts
│   ├── eventSchema.ts
│   ├── triageSchema.ts
│   └── draftSchema.ts
├── workers/         # SQS worker long-poll loop
│   └── ticketWorker.ts
├── middleware/      # Express middleware
│   └── errorHandler.ts
├── lib/             # Shared utilities
│   ├── logger.ts    # Pino instance
│   ├── db.ts        # Postgres connection pool
│   ├── config.ts    # Zod-validated env vars
│   ├── errors.ts    # FatalPhaseError
│   └── io.ts        # Socket.io server factory + subscribe handler
└── index.ts         # Entry point — wires HTTP, Socket.io, notifyService, worker
```

---

### 3.3 Queue Architecture

Worker long-polls the main queue (20s wait, one message at a time). On pickup: reads `ticket_phases` from Postgres fresh, determines which phase to run, executes it. On phase success: deletes SQS message, loops back to poll. On phase failure (retryable, attempt < 3): calls `ChangeMessageVisibility` with exponential backoff delay — message stays in queue, SQS re-delivers automatically. On fatal failure (Zod validation): deletes SQS message manually, marks phase and ticket failed immediately — no retry. On attempt exhaustion (3 deliveries): SQS native `RedrivePolicy` moves message to DLQ automatically.

**Retry flow — no manual re-enqueue.** Worker never sends a new SQS message on failure. It only adjusts visibility timeout on the existing message. This ensures message is never lost between a delete and a re-send.

DLQ consumer is a **separate process**. It reads from the DLQ, sets `ticket.status = 'failed'`, writes a `dlq_routed` event to `ticket_events`, and emits `ticket.failed` via Socket.io.

LocalStack provisioned via `uv` + `venv`. Main queue linked to DLQ via `RedrivePolicy` with `maxReceiveCount: 3`. See README for setup commands.


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

### 3.8 Socket.io Real-Time Strategy

**Transport:** WebSocket / Socket.io (default namespace `/`)

**Event delivery pipeline:**

```
ticket_events INSERT
      ↓
DB trigger: notify_ticket_event()
      ↓
pg_notify('ticket_events', ticketId)
      ↓
notifyService dedicated pg.Client (LISTEN ticket_events)
      ↓
fetch latest event row for ticketId
      ↓
io.to('ticket:<ticketId>').emit('ticket:event', rawEventRow)
```

**Subscription flow:**

1. Client connects to Socket.io (`/`)
2. Client emits `subscribe` with `ticketId`
3. Server: joins socket to room `ticket:<ticketId>`, replays all existing `ticket_events` rows for that ticket in chronological order (handles late join + reconnect)

**Room naming:** `ticket:<ticketId>` (colon separator)

**Single socket event name:** `ticket:event` — payload is the raw `TicketEvent` row from DB:

```ts
{
  id: string         // UUIDv7
  ticket_id: string
  phase: 'triage' | 'draft' | null
  event_type: 'ticket_created' | 'phase_started' | 'phase_completed' | 'phase_failed'
            | 'retry_scheduled' | 'fallback_triggered' | 'dlq_routed'
            | 'ticket_completed' | 'ticket_failed'
  payload: unknown | null   // event-specific data (attempt, backoff_seconds, reason, etc.)
  created_at: Date
}
```

**NOTIFY channel:** Single global `ticket_events` — all tickets share one channel, ticketId in payload disambiguates.

**No clients connected:** No-op. DB is source of truth. Client reconnects and replays via `subscribe`.

**Emitter failures:** Wrapped in try/catch — emit error is logged and swallowed. Ticket processing is never affected.

**Auth:** None. UUIDv7 ticketId is unguessable — acts as capability token.

**CORS:** `*` — internal service, no browser origin restrictions needed.

**Backpressure:** None. Max ~7 events per ticket lifetime.

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

**GET /tickets** — List tickets

- Response 200: `{ tickets[] }` — each item has `id`, `status`, `created_at`
- Excludes soft-archived tickets by default (`WHERE archived_at IS NULL`)
- Filtering, pagination, and `?archived=true` deferred (non-MVP)

**POST /tickets/retry/:ticketId** — Re-enqueue a DLQ-routed ticket

- Requires latest event to be `dlq_routed` — returns 400 `not_dlq_routed` otherwise
- Returns 409 `already_retried` if latest event is already `retry_scheduled`
- Returns 400 `already_completed` if all phases are `success`
- Resets failed phase rows to `started`/`attempts=0`; completed phases untouched
- Response 202: `{ status: "requeued" }`

**Error shape (all endpoints):** `{ "error": "CODE", "message": "...", "code": 4xx }`

| Scenario                          | Code |
| --------------------------------- | ---- |
| Missing or invalid request fields | 400  |
| Ticket not found                  | 404  |
| Retry on non-DLQ-routed ticket    | 400  |
| Already retried (retry_scheduled) | 409  |
| All phases already succeeded      | 400  |
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

### 3.11 TypeScript Conventions

Four hard rules applied across all `.ts` files:

- **No `as` type assertions** — Use Zod `safeParse`, type guards, or `satisfies` to narrow `unknown`. Unsafe casts hide runtime shape mismatches.
- **`as const` instead of enums** — TypeScript enums emit runtime JS and have surprising semantics. `as const` objects are plain values with inferred literal types.
- **Type aliases, not interfaces** — Use `type Foo = { ... }`. Interfaces allow declaration merging; aliases don't — prevents accidental augmentation.
- **`unknown` not `any`** — `any` disables the type checker. `unknown` forces a narrowing step before use.

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
| Epic 5 — **Done** (DB trigger, io.ts, notifyService.ts, 12 unit tests)               | Real-time updates — Sprint 3                                  |
| Epic 6 — all tasks                                                                    | Full observability, DLQ consumer, replay service — Sprint 3–4 |

---

## Epic 1 — Project Foundation & Infrastructure

**Priority:** Critical | **Story Points:** 21 | **Sprint:** 1

### Overview

Establish foundational infrastructure: PostgreSQL with 3-table normalized schema, LocalStack SQS with DLQ, layer-based Node.js + TypeScript project scaffold, and Pino structured logging with PII sanitization.

---

## Epic 2 — REST API Layer

**Priority:** Critical | **Story Points:** 13 | **Sprint:** 1

### Overview

Implement four REST endpoints. No versioning. No auth. Returns 202 immediately on ticket submission, persists to Postgres before enqueueing to SQS, and supports list filtering, pagination, and manual replay.

---

## Epic 3 — Async Worker & Queue Processing

**Priority:** Critical | **Story Points:** 21 | **Sprint:** 2

### Overview

Implement the SQS long-polling consumer that reads Postgres phase checkpoints and orchestrates phase execution. Implements exponential backoff + jitter retries (max 3 attempts), routes to DLQ on exhaustion, re-enqueues after Phase 1 success, and handles graceful shutdown on SIGTERM.

---

## Epic 4 — AI Pipeline (Phase 1 & Phase 2)

**Priority:** Critical | **Story Points:** 34 | **Sprint:** 2–3

### Overview

Implement Phase 1 (triage) and Phase 2 (resolution draft) using Portkey as the unified AI gateway. All outputs enforced via tool use and validated with Zod schemas before writing to Postgres. Portkey handles provider fallback (Claude → GPT-4o → Gemini) transparently.

---

## Epic 5 — Real-Time Socket.io Layer

**Priority:** High | **Story Points:** 13 | **Sprint:** 3

### Overview

Socket.io server on default namespace `/`. Event delivery via PostgreSQL LISTEN/NOTIFY — a DB trigger fires `pg_notify` on every `ticket_events` INSERT, a dedicated `pg.Client` listens and emits to the correct Socket.io room. Worker is not involved in event emission. Single socket event name `ticket:event` with raw `TicketEvent` row as payload. Full event replay on subscribe handles late joins and reconnects.

**Key design decisions:**

| Decision | Choice | Rationale |
| --- | --- | --- |
| Transport | WebSocket / Socket.io | Project requirement |
| Event delivery | PG LISTEN/NOTIFY | No Redis, covers all insert paths including `ticket_created` which originates outside the worker |
| NOTIFY trigger | DB trigger on `ticket_events` INSERT | Only place that fires for 100% of event inserts regardless of call site |
| NOTIFY channel | Single global `ticket_events` | ticketId in payload disambiguates |
| Push payload | Raw `TicketEvent` row | Single source of truth, no custom per-event shapes |
| Socket event name | Single `ticket:event` | `event_type` field in payload carries the type |
| Subscription | Client emits `subscribe` → server joins `ticket:<id>` | |
| Missed events | Full replay from `ticket_events` on subscribe | Handles reconnect, late join — no client cursor needed |
| Auth | None | UUIDv7 unguessable — capability token |
| CORS | `*` | Internal service |
| Emitter failures | try/catch, log, continue | Socket error must never affect ticket processing |
| No clients connected | No-op | DB is source of truth |

### Files Delivered

| File | Purpose |
| --- | --- |
| `migrations/005_notify_trigger.sql` | DB trigger + `notify_ticket_event()` function |
| `src/lib/io.ts` | `createIo(httpServer, deps?)` — Socket.io server, `subscribe` handler, replay |
| `src/services/notifyService.ts` | `startNotifyService(io, deps?)` — PG LISTEN, fetch latest event, emit to room |
| `src/lib/io.test.ts` | 5 tests: room join, replay order, empty replay, event name, isolation |
| `src/services/notifyService.test.ts` | 7 tests: connect/LISTEN, emit on notify, null event, error silencing, empty payload, room isolation |


---

## Epic 6 — Observability, Retry & DLQ

**Priority:** High | **Story Points:** 13 | **Sprint:** 3–4

### Overview

Implement structured observability across all pipeline stages. Every phase execution, retry decision, fallback trigger, and final outcome is logged via Pino and written to `ticket_events`. A separate DLQ consumer updates ticket state on exhaustion. Manual replay is supported via the API.

**PII rule:** `body` field and any email-containing fields stripped from all Pino output via serializers.

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

---

## 10. Testing Strategy

**Framework:** Vitest  
**Scope:** Unit tests only  
**Coverage target:** ≥ 80% on changed modules

### What Gets Mocked

| Dependency         | Mock Approach                                                                        |
| ------------------ | ------------------------------------------------------------------------------------ |
| PostgreSQL pool    | Injected fake repo via `ITicketRepo` — no `vi.mock` needed                          |
| SQS (LocalStack)   | Injected fake queue fns via `WorkerDeps` — `changeMessageVisibilityFn`, `deleteMessageFn` |
| Portkey AI Gateway | Injected fake `PortkeyClient` via `AiService` constructor                           |
| Socket.io          | Injected fake `io` stub via `startNotifyService(io, deps)`                          |
| PG LISTEN client   | Injected fake `pg.Client` via `createClient` dep in `startNotifyService`            |

### Test Coverage Per Epic

| Epic   | Key Units Under Test                                                              |
| ------ | --------------------------------------------------------------------------------- |
| Epic 2 | Route handlers, input validation, error handler (`ticketRoutes.test.ts`)          |
| Epic 3 | Phase orchestrator, retry logic, backoff, skip guard (`ticketWorker.test.ts`)     |
| Epic 4 | `triageTicket`, `draftResolution`, Zod validation, network error (`aiService.test.ts`) |
| Epic 5 | Subscribe + replay handler (`io.test.ts`), LISTEN → emit pipeline (`notifyService.test.ts`) |

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
