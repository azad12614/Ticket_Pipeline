# AI-Powered Support Ticket Processing Pipeline

## Non-Technical PRD

| Field        | Details                                                      |
| ------------ | ------------------------------------------------------------ |
| **Version**  | 1.0.0                                                        |
| **Status**   | Final                                                        |
| **Audience** | Product Managers, Stakeholders, Customer Success, Leadership |
| **Date**     | April 2026                                                   |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Goals & Success Metrics](#3-goals--success-metrics)
4. [How It Works](#4-how-it-works)
5. [Epic 1 — Platform Foundation](#5-epic-1--platform-foundation)
6. [Epic 2 — Ticket Submission & Management](#6-epic-2--ticket-submission--management)
7. [Epic 3 — Background Processing](#7-epic-3--background-processing)
8. [Epic 4 — AI Analysis & Response Drafting](#8-epic-4--ai-analysis--response-drafting)
9. [Epic 5 — Live Status Updates](#9-epic-5--live-status-updates)
10. [Epic 6 — Error Handling & Recovery](#10-epic-6--error-handling--recovery)
11. [Timeline & Rollout](#11-timeline--rollout)
12. [Risks & Open Questions](#12-risks--open-questions)

---

## 1. Executive Summary

Support teams spend significant time reading, categorizing, and drafting responses to customer tickets — work that is repetitive, time-consuming, and inconsistently done across agents. This project builds an intelligent backend system that automatically analyzes every incoming support ticket and produces:

1. A **structured summary** of what the ticket is about, how urgent it is, and who should handle it
2. A **draft response** ready for an agent to review, personalize, and send

The system works silently in the background, never making the customer wait, and gives agents a head start on every single ticket.

---

## 2. Problem Statement

### Today's Reality

Support agents spend roughly 30–40% of their time on mechanical tasks before they can even begin resolving a ticket:

- Reading and re-reading tickets to understand the issue
- Manually categorizing tickets (billing? technical? account issue?)
- Assigning priority based on gut feel, not consistent criteria
- Drafting replies from scratch every time, even for common issues
- Routing tickets to the right team — often incorrectly on the first pass

### The Cost

- **Slower resolution times** — customers wait longer than necessary
- **Inconsistency** — two agents categorize the same ticket differently
- **Agent fatigue** — repetitive tasks reduce quality on complex work
- **Misrouting** — wrong team assignment wastes everyone's time

### The Opportunity

AI can handle all of this mechanical work instantly and consistently, freeing agents to focus entirely on solving problems and building customer relationships.

---

## 3. Goals & Success Metrics

### Primary Goals

- Automatically analyze and categorize 100% of incoming tickets without agent input
- Produce a draft customer response for every ticket before an agent opens it
- Ensure no ticket is ever lost or stuck silently — full visibility at every step
- Maintain service even when AI providers have outages

### Success Metrics

| Metric                             | Target                            |
| ---------------------------------- | --------------------------------- |
| Ticket triage completion time      | < 30 seconds from submission      |
| Full pipeline completion time      | < 60 seconds from submission      |
| System acknowledgement time        | < 200 milliseconds                |
| Ticket processing success rate     | ≥ 95% without manual intervention |
| System uptime                      | 99.9%                             |
| Tickets lost due to system failure | Zero                              |

### What This Is NOT

- This does not replace agents — AI drafts are always reviewed before sending
- This does not make decisions about customer accounts — it advises, not decides
- This does not interact directly with customers — all responses go through agents first

---

## 4. How It Works

Here is the complete journey of a ticket through the system:

```
1. Customer submits a support ticket
         ↓
2. System acknowledges instantly (< 200ms) — customer never waits
         ↓
3. AI reads the ticket and produces a structured analysis:
   • What type of issue is this?        (Category)
   • How urgent is it?                  (Priority)
   • Is the customer frustrated?        (Sentiment)
   • Should this skip the normal queue? (Escalation)
   • Who should handle it?              (Routing target)
   • One-sentence description           (Summary)
         ↓
4. AI uses that analysis to draft:
   • A customer-facing reply (warm, professional, specific to the issue)
   • An internal note for the agent (context, suggested approach)
   • Recommended next steps (1–5 specific actions)
         ↓
5. Agent opens the ticket and sees everything ready to go
         ↓
6. Agent reviews, edits if needed, and sends
```

Throughout this entire process, the system sends live updates so the support dashboard always reflects exactly what stage a ticket is in.

---

## 5. Epic 1 — Platform Foundation

**Priority:** Must Have | **Sprint:** 1 | **Effort:** Large

### What This Is

Before any AI processing can happen, the system needs a solid foundation: a reliable place to store tickets and their progress, a reliable work queue, structured logging, and data that is retained and archived correctly.

### Why It Matters

If the foundation is shaky — data gets lost, work disappears from the queue, logs are unclear — every other part of the system becomes unreliable. This epic ensures no ticket is ever lost and every action is always visible.

### User Stories

---

#### US-1.1 — Ticket Persistence

**Scope:** MVP

**As a support agent, I want every submitted ticket stored safely so that no ticket is ever lost.**

##### Acceptance Criteria

- [x] Every submitted ticket is saved to the database before any processing begins
- [x] Each ticket is assigned a unique identifier the moment it is received
- [x] Ticket status is updated at every stage of the pipeline
- [x] Tickets remain in the database even if processing fails

##### Definition of Done

- [x] Ticket data confirmed present in the database after submission
- [x] Unique ID generated for every ticket — no duplicates
- [x] Status field updates verified at each pipeline stage
- [x] Failed tickets remain in the database with their failure state recorded

---

#### US-1.2 — Per-Phase Tracking

**Scope:** MVP

**As a support agent, I want each AI processing step tracked independently so that a failed step can be retried without repeating work that already succeeded.**

##### Acceptance Criteria

- [x] Each phase (analysis and drafting) has its own independently tracked status
- [x] Both phase rows are created when the ticket is submitted
- [x] A phase that has completed successfully is never re-run, even on re-processing
- [x] How many times each phase has been attempted is recorded
- [x] Phase output is stored and linked to the originating ticket

##### Definition of Done

- [x] Phase tracking confirmed independent: Phase 1 and Phase 2 have separate status records
- [x] Completed phase confirmed never re-executed — verified by test
- [x] Attempt count increments correctly on each retry
- [x] Phase output retrievable from the ticket status endpoint when complete
- [x] Phase rows exist up front so the status endpoint always has a stable shape

---

#### US-1.3 — Audit Trail

**Scope:** Non-MVP — Sprint 3–4

**As a support agent, I want every action on a ticket permanently recorded so that the full processing history is always available.**

##### Acceptance Criteria

- [ ] Every state change produces an immutable audit record — no edits, no deletes
- [ ] Each audit record includes the event type, timestamp, and relevant context
- [ ] Full history is accessible via the ticket status endpoint
- [ ] Audit records are returned in chronological order

##### Definition of Done

- [ ] Audit records confirmed insert-only — update and delete operations blocked
- [ ] All pipeline state changes produce audit records
- [ ] Full history visible via API for a test ticket
- [ ] Events returned in correct chronological order

---

#### US-1.4 — Data Retention & Soft-Archive

**Scope:** Non-MVP — Sprint 3–4

**As a support agent, I want old tickets automatically archived so that my active queue stays clean while data is retained for compliance.**

##### Acceptance Criteria

- [ ] Tickets older than 90 days are automatically marked as archived each day
- [ ] Archived tickets are excluded from default list views
- [ ] Archived tickets remain accessible when explicitly requested
- [ ] No ticket data is permanently deleted

##### Definition of Done

- [ ] Daily archive job confirmed running and archiving correct tickets
- [ ] Default list query confirmed to exclude archived tickets
- [ ] Archived tickets retrievable with explicit filter
- [ ] No data loss confirmed — archived ticket data fully intact

---

### Kanban

| Backlog              | In Progress | Review | Done                         |
| -------------------- | ----------- | ------ | ---------------------------- |
| US-1.3: Audit trail  | —           | —      | US-1.1: Ticket persistence   |
| US-1.4: Soft-archive | —           | —      | US-1.2: Per-phase tracking   |

---

## 6. Epic 2 — Ticket Submission & Management

**Priority:** Must Have | **Sprint:** 1 | **Effort:** Medium

### What This Is

The entry point for the entire system — how tickets arrive, how agents check status, how the team lists and filters tickets, and how failed tickets can be retried without developer intervention.

### Why It Matters

First impressions matter. The system must acknowledge every ticket immediately. Support teams need to check any ticket's status at any time, filter their queue efficiently, and recover failed tickets without logging a support request with engineering.

### User Stories

---

#### US-2.1 — Immediate Submission Acknowledgement

**Scope:** MVP

**As a customer, I want my ticket submission acknowledged immediately so that I know my request was received.**

##### Acceptance Criteria

- [x] Ticket submission returns a confirmation in under 200 milliseconds
- [x] Response includes a unique ticket ID for tracking
- [x] Response clearly communicates that processing is happening in the background
- [x] Customer is never left waiting while AI processing runs

##### Definition of Done

- [x] Response time confirmed under 200ms in testing
- [x] Unique ticket ID confirmed present in every response
- [x] Submission confirmed not to block while AI runs
- [x] Missing required fields return a helpful error message (not a crash)

---

#### US-2.2 — Ticket Status Check

**Scope:** MVP _(event history excluded — deferred to US-1.3)_

**As a support agent, I want to check the current status of any ticket so that I know where it is in the pipeline.**

##### Acceptance Criteria

- [x] Any ticket can be looked up by its ID at any time
- [x] Status response shows the current stage clearly
- [x] Response includes the output of each AI phase when it is complete
- [ ] Full history of every action taken on the ticket is included
- [x] A clear error is returned for invalid ticket IDs

##### Definition of Done

- [x] Status endpoint returns correct current stage for tickets in all states
- [x] Phase outputs present in response when phases are complete
- [x] Phase outputs absent when phases are not yet complete
- [ ] Full history returned in correct chronological order
- [x] 404 response confirmed for unknown ticket IDs

---

#### US-2.3 — Ticket List & Filtering

**Scope:** Non-MVP — Sprint 3–4

**As a support agent, I want to list and filter tickets so that I can manage my queue efficiently.**

##### Acceptance Criteria

- [ ] Tickets can be filtered by status (queued, processing, completed, failed)
- [ ] Archived tickets are excluded by default but can be included with a filter
- [ ] Results are paginated — large lists do not slow down the system
- [ ] Default page size is 20 tickets per page

##### Definition of Done

- [ ] Filter by status confirmed working for all status values
- [ ] Default list confirmed to exclude archived tickets
- [ ] Archived filter (`?archived=true`) confirmed to include archived tickets
- [ ] Pagination confirmed: `page` and `limit` parameters work correctly

---

#### US-2.4 — Manual Retry

**Scope:** Non-MVP — Sprint 3–4

**As a support agent, I want to manually retry a failed ticket so that I can recover tickets without developer intervention.**

##### Acceptance Criteria

- [ ] Any ticket in a failed state can be manually re-queued for processing
- [ ] Only the failed step is retried — completed steps are not repeated
- [ ] Retry is rejected with a clear error if the ticket is not in a failed state
- [ ] Ticket status updates to reflect that processing has resumed

##### Definition of Done

- [ ] Retry confirmed to re-queue only the failed phase — completed phase untouched
- [ ] Retry confirmed rejected for tickets not in failed state
- [ ] Ticket status updates to queued after successful retry request
- [ ] Retry tested on a ticket with Phase 1 complete and Phase 2 failed — only Phase 2 retried

---

### Kanban

| Backlog                         | In Progress | Review | Done                              |
| ------------------------------- | ----------- | ------ | --------------------------------- |
| US-2.3: Ticket list & filtering | —           | —      | US-2.1: Immediate acknowledgement |
| US-2.4: Manual retry            | —           | —      | US-2.2: Ticket status check       |

---

## 7. Epic 3 — Background Processing

**Priority:** Must Have | **Sprint:** 2 | **Effort:** Large

### What This Is

The background processing engine that picks up submitted tickets, figures out what still needs to be done, runs the appropriate AI phase, and manages retries when things fail — all without any manual intervention.

### Why It Matters

This is the heart of the system. It must be reliable above all else — no tickets dropped, no work duplicated, no silent failures. It picks up exactly where it left off if a ticket partially processed before a failure.

### User Stories

---

#### US-3.1 — Asynchronous Processing

**Scope:** MVP

**As a customer, I want my ticket to be processed in the background so that I am not left waiting while AI runs.**

##### Acceptance Criteria

- [x] Ticket submission returns immediately — AI processing happens in the background
- [x] Background processing begins automatically after submission — no manual trigger
- [x] Multiple tickets can be processed without interfering with each other

##### Definition of Done

- [x] Submission response confirmed before background processing begins
- [x] Background worker confirmed picking up and processing tickets automatically
- [x] Worker confirmed stable processing tickets one at a time without interference

---

#### US-3.2 — Phase Handoff

**Scope:** MVP

**As a support agent, I want the response draft to start automatically after analysis completes so that I receive the full AI output without waiting for manual steps.**

##### Acceptance Criteria

- [x] Phase 2 starts automatically and immediately when Phase 1 completes successfully
- [x] Phase 2 never starts if Phase 1 has not completed
- [x] The handoff between phases requires no manual action

##### Definition of Done

- [x] Phase 2 confirmed to start automatically after Phase 1 success
- [x] Phase 2 confirmed blocked when Phase 1 has not completed
- [x] Zero manual steps required between phases

---

#### US-3.3 — Automatic Retry

**Scope:** MVP _(needs-attention queue excluded — deferred to US-6.2)_

**As a customer, I want my ticket retried automatically if something goes wrong so that a temporary failure does not permanently delay my support request.**

##### Acceptance Criteria

- [x] Failed phases are retried automatically — no manual trigger required
- [x] Retries use increasing wait times to avoid overloading the AI provider
- [x] Retry attempts are recorded and visible on the ticket
- [x] After 3 failed attempts, the ticket is moved to a needs-attention state

##### Definition of Done

- [x] Automatic retry confirmed without manual intervention
- [x] Retry wait times confirmed: ~2 seconds, then ~4 seconds, then give up
- [x] Attempt count visible on ticket status endpoint after retries
- [x] After 3 failures, ticket status confirmed set to failed

---

#### US-3.4 — No Work Duplication

**Scope:** MVP

**As a support agent, I want completed processing steps never repeated so that the system does not produce duplicate work when re-processing a ticket.**

##### Acceptance Criteria

- [x] A phase already marked as completed is never re-run
- [x] This holds true even after system restarts or re-delivery of a queue message
- [x] Only the failed or pending phase is executed on re-processing

##### Definition of Done

- [x] Completed phase confirmed never re-executed after system restart
- [x] Checkpoint read fresh from database on every job pickup — no reliance on memory
- [x] Duplicate prevention confirmed by unit test

---

#### US-3.5 — Graceful Shutdown

**Scope:** Non-MVP — Sprint 4

**As a support agent, I want tickets that are being processed to complete even when the system restarts so that no ticket is lost during maintenance.**

##### Acceptance Criteria

- [ ] When the system is asked to stop, it finishes its current job first
- [ ] No in-flight ticket is dropped on graceful shutdown
- [ ] Worker stops accepting new jobs immediately on shutdown signal

##### Definition of Done

- [ ] Graceful shutdown tested: in-flight ticket completes before worker stops
- [ ] No ticket lost or corrupted during shutdown
- [ ] Worker stops polling for new jobs immediately after shutdown signal

---

### Kanban

| Backlog                   | In Progress | Review | Done                        |
| ------------------------- | ----------- | ------ | --------------------------- |
| US-3.5: Graceful shutdown | —           | —      | US-3.1: Async processing    |
| —                         | —           | —      | US-3.2: Phase handoff       |
| —                         | —           | —      | US-3.3: Automatic retry     |
| —                         | —           | —      | US-3.4: No work duplication |

---

## 8. Epic 4 — AI Analysis & Response Drafting

**Priority:** Must Have | **Sprint:** 2–3 | **Effort:** X-Large

### What This Is

The intelligence core of the system. Two distinct AI-powered steps that transform a raw customer message into structured insight and a ready-to-use response draft. Uses three AI providers as automatic backups.

### Why It Matters

This is the product's primary value. Everything else in the system exists to reliably deliver these two AI outputs to agents. The AI must be consistent, accurate, and resilient.

### Provider Resilience — Three-Layer Safety Net

```
Primary:   Claude (Anthropic)  — best quality, used first
Backup 1:  GPT-4o (OpenAI)    — used if Claude is unavailable
Backup 2:  Gemini (Google)     — used if both Claude and OpenAI are unavailable
```

This switching happens automatically. Agents never know which provider was used — they just receive the output.

### User Stories

---

#### US-4.1 — AI Ticket Triage (Phase 1)

**Scope:** MVP

**As a support agent, I want every ticket automatically analyzed by AI so that I can act on it immediately without reading the full ticket.**

##### Acceptance Criteria

- [ ] Every ticket receives an AI analysis with all 6 required fields
- [ ] The 6 fields are: category, priority, sentiment, escalation flag, routing target, and summary
- [ ] Analysis is produced within 30 seconds of ticket submission
- [ ] Analysis output is stored and accessible via the ticket status endpoint

##### Definition of Done

- [ ] All 6 fields confirmed present for every processed ticket
- [ ] Each field confirmed to contain a valid, structured value (not free text)
- [ ] Analysis stored in the database and retrievable via API
- [ ] Processing time confirmed under 30 seconds in testing

---

#### US-4.2 — AI Resolution Draft (Phase 2)

**Scope:** MVP

**As a support agent, I want an AI-generated response draft so that I can review and send it with minimal editing.**

##### Acceptance Criteria

- [ ] Every ticket receives a resolution draft with all 3 required outputs
- [ ] The 3 outputs are: customer-facing reply, internal support note, and recommended next actions
- [ ] The draft uses the Phase 1 analysis as context — not just the raw ticket
- [ ] Phase 2 never runs until Phase 1 has fully completed

##### Definition of Done

- [ ] All 3 output fields confirmed present for every processed ticket
- [ ] Customer reply confirmed to address the specific issue (not generic)
- [ ] Internal note confirmed to reference the triage category and priority
- [ ] Phase 2 confirmed blocked when Phase 1 is not complete

---

#### US-4.3 — Output Quality Guarantee

**Scope:** MVP _(manual review workflow excluded — deferred to US-6.2)_

**As a support agent, I want AI outputs validated before they reach me so that I only see well-structured, usable data.**

##### Acceptance Criteria

- [ ] AI output is checked against a strict format before being accepted
- [ ] Malformed or incomplete output is rejected — not silently stored
- [ ] A rejected output triggers the phase failure and retry flow
- [ ] If all retry attempts produce invalid output, the ticket is flagged for manual review

##### Definition of Done

- [ ] Validation confirmed to reject incomplete AI output
- [ ] Malformed response confirmed to trigger failure handling (not partial storage)
- [ ] Invalid output confirmed never written to the database
- [ ] Manual review flag confirmed set after validation failures exhaust retries

---

#### US-4.4 — AI Provider Fallback

**Scope:** Non-MVP — Sprint 3

**As a support agent, I want the system to keep processing tickets even when the primary AI provider is unavailable so that my queue is never blocked by outages.**

##### Acceptance Criteria

- [ ] If Claude is unavailable, the system automatically falls back to GPT-4o
- [ ] If GPT-4o is also unavailable, the system falls back to Gemini
- [ ] Fallback switching happens automatically — no manual action required
- [ ] Agents receive the same output regardless of which provider was used

##### Definition of Done

- [ ] Fallback chain tested: Claude disabled → GPT-4o serves request correctly
- [ ] Provider switch logged for monitoring and cost tracking
- [ ] Agents confirmed to receive identical output structure from all providers
- [ ] System confirmed to continue processing during primary provider outage

---

### Kanban

| Backlog                            | In Progress | Review | Done |
| ---------------------------------- | ----------- | ------ | ---- |
| US-4.1: AI triage (Phase 1)        | —           | —      | —    |
| US-4.2: Resolution draft (Phase 2) | —           | —      | —    |
| US-4.3: Output quality guarantee   | —           | —      | —    |
| US-4.4: AI provider fallback       | —           | —      | —    |

---

## 9. Epic 5 — Live Status Updates

**Priority:** High | **Sprint:** 3 | **Effort:** Medium

### What This Is

A real-time notification system that pushes status updates to the support dashboard as they happen — no page refreshing, no polling, no wondering whether the system is working.

### Why It Matters

Without live updates, agents and ops teams are flying blind. They would have to manually check each ticket's status repeatedly. Live updates make the system feel alive and trustworthy.

### User Stories

---

#### US-5.1 — Phase Lifecycle Notifications

**Scope:** Non-MVP — Sprint 3

**As a support agent, I want real-time notifications when a phase starts, completes, or fails so that I can monitor my ticket as it processes.**

##### Acceptance Criteria

- [ ] Live update sent when ticket is received and queued
- [ ] Live update sent when AI analysis begins
- [ ] Live update sent when AI analysis completes
- [ ] Live update sent when response drafting begins
- [ ] Live update sent when response drafting completes — includes full AI output
- [ ] Live update sent if any phase fails or is retried

##### Definition of Done

- [ ] All 7 update types confirmed appearing in real time without page refresh
- [ ] Final update confirmed to include the complete AI output (both phases)
- [ ] Retry update confirmed to include the attempt number and wait time
- [ ] System confirmed stable when no clients are connected

---

#### US-5.2 — Per-Ticket Subscription

**Scope:** Non-MVP — Sprint 3

**As a support agent, I want to receive updates only for tickets I am monitoring so that I am not flooded with updates from other tickets.**

##### Acceptance Criteria

- [ ] Agent A's updates are not visible to Agent B
- [ ] Each client subscribes to exactly one ticket's updates after submission
- [ ] Agent receives all updates for their ticket from submission to completion

##### Definition of Done

- [ ] Confirmed: Agent A cannot receive Agent B's ticket updates
- [ ] Subscription confirmed to deliver all events from queued through completed
- [ ] Isolation confirmed with two simultaneous clients in testing

---

#### US-5.3 — Ops Dashboard Visibility

**Scope:** Non-MVP — Sprint 3

**As an ops team member, I want to see activity across all tickets so that I can monitor the pipeline at a team level.**

##### Acceptance Criteria

- [ ] Ops dashboard receives summary notifications for all tickets in their team
- [ ] Ops notifications do not include full AI output — summary only
- [ ] Ops can see which tickets are completed, in-progress, or failed

##### Definition of Done

- [ ] Ops dashboard confirmed to receive summary events for all team tickets
- [ ] Full AI output confirmed absent from ops channel
- [ ] Ops visibility confirmed for completed, in-progress, and failed states

---

### Kanban

| Backlog                               | In Progress | Review | Done |
| ------------------------------------- | ----------- | ------ | ---- |
| US-5.1: Phase lifecycle notifications | —           | —      | —    |
| US-5.2: Per-ticket subscription       | —           | —      | —    |
| US-5.3: Ops dashboard visibility      | —           | —      | —    |

---

## 10. Epic 6 — Error Handling & Recovery

**Priority:** High | **Sprint:** 3–4 | **Effort:** Medium

### What This Is

The safety net that ensures no ticket is ever silently lost, every failure is visible, and the ops team always has the tools to recover — including a full audit trail, a needs-attention queue, and manual replay capability.

### Why It Matters

Production systems fail. AI providers have outages. Networks hiccup. The question is not whether something will go wrong — it is whether the team will know about it and be able to fix it without losing customer data.

### User Stories

---

#### US-6.1 — Full Audit Trail

**Scope:** Non-MVP — Sprint 3–4

**As a support agent, I want a full history of every action taken on a ticket so that I can understand exactly what happened during processing.**

##### Acceptance Criteria

- [ ] Every state change produces a permanent, timestamped audit record
- [ ] Audit records are never edited or deleted
- [ ] Full history is visible via the ticket status endpoint
- [ ] The audit trail includes: phase starts, completions, failures, retries, fallbacks, and final outcomes

##### Definition of Done

- [ ] Full audit trail verified for a successful ticket — all expected events present
- [ ] Full audit trail verified for a failed ticket — retry and failure events present
- [ ] Audit records confirmed insert-only — no update or delete operations permitted
- [ ] All events visible via API in chronological order

---

#### US-6.2 — Needs-Attention Queue

**Scope:** Non-MVP — Sprint 3–4

**As an ops team member, I want tickets that have exhausted all retries to be clearly visible so that I can act on them without hunting through logs.**

##### Acceptance Criteria

- [ ] After 3 failed attempts, a ticket is marked as failed and clearly visible to ops
- [ ] Failed ticket includes which step failed and how many times it was attempted
- [ ] Failed tickets do not disappear — they persist in a reviewable state
- [ ] Ops team can find all failed tickets by filtering on status

##### Definition of Done

- [ ] Failed ticket confirmed visible via list endpoint filtered by `?status=failed`
- [ ] Attempt count and failed phase confirmed present on failed ticket
- [ ] Ticket confirmed to remain in database in failed state — not deleted
- [ ] Ops confirmed able to identify failed tickets without accessing raw logs

---

#### US-6.3 — Phase 1 Preservation on Phase 2 Failure

**Scope:** Non-MVP — Sprint 3–4

**As a support agent, I want Phase 1 output preserved even if Phase 2 fails permanently so that I still have triage data to act on.**

##### Acceptance Criteria

- [ ] If Phase 2 fails permanently, Phase 1 output remains intact and accessible
- [ ] Agent can still see the ticket category, priority, and routing target even without a draft response
- [ ] Phase 1 is never re-run just because Phase 2 failed

##### Definition of Done

- [ ] Phase 1 output confirmed accessible via API after Phase 2 permanent failure
- [ ] Phase 1 confirmed not re-executed after Phase 2 failure
- [ ] Ticket status reflects partial completion (Phase 1 done, Phase 2 failed)

---

#### US-6.4 — Structured Logging

**Scope:** Non-MVP — Sprint 3–4

**As a support agent, I want every processing event logged so that my team can diagnose issues quickly without losing visibility into what happened.**

##### Acceptance Criteria

- [ ] Every pipeline event produces a structured log entry
- [ ] Logs include: event type, timestamp, ticket ID, phase, attempt number, and outcome
- [ ] No customer personally identifiable information (PII) appears in any log
- [ ] Log levels are used correctly: info for normal flow, warn for retries, error for failures

##### Definition of Done

- [ ] All 8 required log event types confirmed present in a full pipeline run
- [ ] Zero PII confirmed in any log output — body and email fields absent
- [ ] Log levels verified: retries use warn, failures use error, success uses info
- [ ] Logs readable without additional tooling in development

---

### Kanban

| Backlog                       | In Progress | Review | Done |
| ----------------------------- | ----------- | ------ | ---- |
| US-6.1: Full audit trail      | —           | —      | —    |
| US-6.2: Needs-attention queue | —           | —      | —    |
| US-6.3: Phase 1 preservation  | —           | —      | —    |
| US-6.4: Structured logging    | —           | —      | —    |

---

## 11. Timeline & Rollout

### Sprint Plan

| Sprint       | Duration | What Gets Built                           | Milestone                                          |
| ------------ | -------- | ----------------------------------------- | -------------------------------------------------- |
| **Sprint 1** | Week 1–2 | Foundation + REST API                     | System accepts, stores, and retrieves tickets      |
| **Sprint 2** | Week 3–4 | Worker + AI Triage (Phase 1)              | Tickets are automatically triaged by AI            |
| **Sprint 3** | Week 5–6 | Resolution Draft (Phase 2) + Live Updates | Full pipeline live, agents see drafts in real time |
| **Sprint 4** | Week 7–8 | Reliability + Observability + Polish      | Production-ready with full safety net              |

### Rollout Strategy

1. **Internal testing (Sprint 3 end):** Process a batch of historical tickets through the pipeline. Support team rates the output quality.
2. **Soft launch (Sprint 4 start):** Enable for 10% of incoming tickets. Agents opt in to see AI output.
3. **Broad rollout (Sprint 4 end):** Enable for all tickets. AI output surfaced by default on every ticket.

---

## 12. Risks & Open Questions

### Risks

| Risk                                              | Likelihood | Impact | Mitigation                                                                               |
| ------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------- |
| AI output quality insufficient for agent use      | Medium     | High   | Quality review gate in Sprint 3 with support team sign-off required before broad rollout |
| All three AI providers unavailable simultaneously | Low        | High   | Tickets queue safely and are processed when service resumes — no data loss               |
| Processing takes too long (> 30s per ticket)      | Medium     | Medium | Time limits configured per phase; slow tickets flagged for investigation                 |
| Costs exceed budget if AI usage spikes            | Medium     | Medium | Token usage logged per call; budget alerts configured in AI gateway                      |

### Open Questions

- What is the maximum acceptable processing time before an agent notices a delay? (Suggested: 30 seconds for Phase 1, 60 seconds total)
- Should agents be able to rate the quality of AI drafts for future improvement tracking?
- Should failed tickets in the needs-attention state trigger a Slack or email alert to ops?
- Is there a category of ticket (e.g., legal, sensitive accounts) that should bypass AI processing entirely?
- What is the data retention policy for AI outputs stored in the database beyond 90 days?

---

_End of Document — Version 1.0.0_
