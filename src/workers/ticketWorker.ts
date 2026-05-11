import { FatalPhaseError } from '../lib/errors.ts';
import logger from '../lib/logger.ts';
import {
  receiveTickets,
  deleteTicketMessage,
  changeMessageVisibility,
} from '../queues/ticketQueue.ts';
import { runPhase, createPortkeyClient } from '../services/aiService.ts';
import type { PhaseResult } from '../services/aiService.ts';
import { postgresTicketRepo, type TicketRepo } from '../repositories/ticketRepo.ts';
import type { Ticket } from '../schemas/ticketSchema.ts';
import type { TicketPhase } from '../schemas/phaseSchema.ts';

type TicketStatus = Ticket['status'];
type PhaseName = TicketPhase['phase'];

export type WorkerDeps = {
  getTicketByIdFn: TicketRepo['getTicketById'];
  getTicketPhasesByTicketIdFn: TicketRepo['getTicketPhasesByTicketId'];
  transitionTicketStatusFn: TicketRepo['transitionTicketStatus'];
  updateTicketStatusFn: TicketRepo['updateTicketStatus'];
  claimPhaseForProcessingFn: TicketRepo['claimPhaseForProcessing'];
  completePhaseSuccessFn: TicketRepo['completePhaseSuccess'];
  failPhaseAttemptFn: TicketRepo['failPhaseAttempt'];
  completeTicketFn: TicketRepo['completeTicket'];
  failTicketFn: TicketRepo['failTicket'];
  insertEventFn: TicketRepo['insertEvent'];
  changeMessageVisibilityFn: (receiptHandle: string, delaySeconds: number) => Promise<void>;
  deleteMessageFn: (receiptHandle: string) => Promise<void>;
  processPhaseFn: (ticketId: string, phase: PhaseName) => Promise<PhaseResult>;
};

function isTerminalStatus(status: TicketStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function findNextPhase(phases: TicketPhase[], ticketId: string): PhaseName | null {
  const triage = phases.find(phase => phase.phase === 'triage');
  const draft = phases.find(phase => phase.phase === 'draft');

  if (!triage || !draft) {
    throw new Error(`Missing phase rows for ticket ${ticketId} — expected triage and draft`);
  }

  if (triage.status !== 'success') return 'triage';
  if (draft.status !== 'success') return 'draft';
  return null;
}

function backoffSeconds(attempts: number): number {
  return Math.ceil((Math.pow(2, attempts) * 1000 + Math.random() * 500) / 1000);
}

async function handlePhaseError(
  phaseError: unknown,
  ticketId: string,
  phase: PhaseName,
  receiptHandle: string,
  deps: WorkerDeps,
): Promise<void> {
  if (phaseError instanceof FatalPhaseError) {
    logger.error({ err: phaseError, ticketId, phase }, 'Fatal phase error — skipping retry');
    const failedPhase = await deps.failPhaseAttemptFn(ticketId, phase, phaseError.message);
    await deps.failTicketFn(ticketId);
    if (failedPhase) {
      await deps.insertEventFn(ticketId, 'dlq_routed', phase, {
        attempt: failedPhase.attempts,
        reason: 'fatal_error',
      });
    }
    await deps.deleteMessageFn(receiptHandle);
    return;
  }

  logger.error({ err: phaseError, ticketId, phase }, 'Phase processing failed');
  const errorMsg = phaseError instanceof Error ? phaseError.message : String(phaseError);
  const failedPhase = await deps.failPhaseAttemptFn(ticketId, phase, errorMsg);

  if (!failedPhase) {
    await deps.updateTicketStatusFn(ticketId, 'failed');
    await deps.deleteMessageFn(receiptHandle);
    return;
  }

  const backoff = backoffSeconds(failedPhase.attempts);
  await deps.transitionTicketStatusFn(ticketId, ['processing'], 'queued');
  await deps.insertEventFn(ticketId, 'retry_scheduled', phase, {
    attempt: failedPhase.attempts,
    backoff_seconds: backoff,
  });
  await deps.changeMessageVisibilityFn(receiptHandle, backoff);
}

const MAX_PHASES = 10;

async function orchestratePhases(
  ticketId: string,
  receiptHandle: string,
  deps: WorkerDeps,
): Promise<void> {
  for (let i = 0; i < MAX_PHASES; i++) {
    const phases = await deps.getTicketPhasesByTicketIdFn(ticketId);
    const nextPhase = findNextPhase(phases, ticketId);

    if (!nextPhase) {
      await deps.completeTicketFn(ticketId);
      await deps.deleteMessageFn(receiptHandle);
      logger.info({ ticketId }, 'Ticket completed — all phases done');
      return;
    }

    const phaseClaim = await deps.claimPhaseForProcessingFn(ticketId, nextPhase);
    if (!phaseClaim) {
      logger.warn({ ticketId, phase: nextPhase }, 'Phase not claimable for processing');
      return;
    }

    logger.info({ ticketId, phase: nextPhase, attempt: phaseClaim.attempts }, 'Phase started');

    try {
      const { output, durationMs, provider } = await deps.processPhaseFn(ticketId, nextPhase);
      await deps.completePhaseSuccessFn(ticketId, nextPhase, output, { durationMs, provider });
      logger.info({ ticketId, phase: nextPhase, durationMs, provider }, 'Phase completed');
    } catch (phaseError) {
      await handlePhaseError(phaseError, ticketId, nextPhase, receiptHandle, deps);
      return;
    }
  }

  logger.error({ ticketId }, 'Phase loop exceeded max iterations — failing ticket');
  await deps.failTicketFn(ticketId);
  await deps.deleteMessageFn(receiptHandle);
}

export async function processTicketLifecycle(
  ticketId: string,
  receiptHandle: string,
  deps: WorkerDeps,
): Promise<void> {
  const existing = await deps.getTicketByIdFn(ticketId);
  if (!existing) {
    logger.warn({ ticketId }, 'Skipping unknown ticket from queue');
    await deps.deleteMessageFn(receiptHandle);
    return;
  }

  if (isTerminalStatus(existing.status)) {
    logger.info({ ticketId, status: existing.status }, 'Skipping terminal ticket');
    await deps.deleteMessageFn(receiptHandle);
    return;
  }

  const claimed = await deps.transitionTicketStatusFn(ticketId, ['queued'], 'processing');
  if (!claimed) {
    const current = await deps.getTicketByIdFn(ticketId);
    if (current && !isTerminalStatus(current.status)) {
      logger.warn({ ticketId, status: current.status }, 'Ticket not claimable for processing');
    }
    return;
  }

  logger.info({ ticketId }, 'Ticket claimed — processing started');

  try {
    await orchestratePhases(ticketId, receiptHandle, deps);
  } catch (error) {
    logger.error({ err: error, ticketId }, 'Ticket processing failed');
    const failed = await deps.failTicketFn(ticketId);
    if (!failed) {
      await deps.updateTicketStatusFn(ticketId, 'failed');
    }
    await deps.changeMessageVisibilityFn(receiptHandle, 0);
  }
}

export type WorkerHandle = {
  stop: () => void;
  done: Promise<void>;
};

export function startTicketWorker(): WorkerHandle {
  const deps: WorkerDeps = {
    getTicketByIdFn: postgresTicketRepo.getTicketById.bind(postgresTicketRepo),
    getTicketPhasesByTicketIdFn:
      postgresTicketRepo.getTicketPhasesByTicketId.bind(postgresTicketRepo),
    transitionTicketStatusFn: postgresTicketRepo.transitionTicketStatus.bind(postgresTicketRepo),
    updateTicketStatusFn: postgresTicketRepo.updateTicketStatus.bind(postgresTicketRepo),
    claimPhaseForProcessingFn: postgresTicketRepo.claimPhaseForProcessing.bind(postgresTicketRepo),
    completePhaseSuccessFn: postgresTicketRepo.completePhaseSuccess.bind(postgresTicketRepo),
    failPhaseAttemptFn: postgresTicketRepo.failPhaseAttempt.bind(postgresTicketRepo),
    completeTicketFn: postgresTicketRepo.completeTicket.bind(postgresTicketRepo),
    failTicketFn: postgresTicketRepo.failTicket.bind(postgresTicketRepo),
    insertEventFn: postgresTicketRepo.insertEvent.bind(postgresTicketRepo),
    changeMessageVisibilityFn: changeMessageVisibility,
    deleteMessageFn: deleteTicketMessage,
    processPhaseFn: (ticketId, phase) =>
      runPhase(ticketId, phase, { repo: postgresTicketRepo, portkey: createPortkeyClient() }),
  };

  const controller = new AbortController();

  const done = (async () => {
    let errorCount = 0;
    while (!controller.signal.aborted) {
      try {
        const messages = await receiveTickets(controller.signal);
        errorCount = 0;
        for (const { ticketId, receiptHandle } of messages) {
          await processTicketLifecycle(ticketId, receiptHandle, deps);
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        errorCount++;
        const jitter = Math.floor(Math.random() * 300);
        const backoffMs = Math.min(1000 * Math.pow(2, Math.max(0, errorCount - 1)), 30000) + jitter;
        logger.error({ err: error, backoffMs, errorCount }, 'Worker loop error — backing off');
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  })();

  return {
    stop: () => controller.abort(),
    done,
  };
}
