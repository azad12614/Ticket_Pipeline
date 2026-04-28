import { FatalPhaseError } from '../lib/errors.ts';
import logger from '../lib/logger.ts';
import {
  receiveTickets,
  deleteTicketMessage,
  changeMessageVisibility,
} from '../queues/ticketQueue.ts';
import { runPhase } from '../services/aiService.ts';
import type { PhaseResult } from '../services/aiService.ts';
import { postgresTicketRepo, type ITicketRepo } from '../repositories/ticketRepo.ts';
import type { Ticket } from '../schemas/ticketSchema.ts';
import type { TicketPhase } from '../schemas/phaseSchema.ts';

type TicketStatus = Ticket['status'];
type PhaseName = TicketPhase['phase'];

type RepoDeps = {
  getTicketByIdFn?: ITicketRepo['getTicketById'];
  getTicketPhasesByTicketIdFn?: ITicketRepo['getTicketPhasesByTicketId'];
  transitionTicketStatusFn?: ITicketRepo['transitionTicketStatus'];
  updateTicketStatusFn?: ITicketRepo['updateTicketStatus'];
  claimPhaseForProcessingFn?: ITicketRepo['claimPhaseForProcessing'];
  completePhaseSuccessFn?: ITicketRepo['completePhaseSuccess'];
  failPhaseAttemptFn?: ITicketRepo['failPhaseAttempt'];
  completeTicketFn?: ITicketRepo['completeTicket'];
  failTicketFn?: ITicketRepo['failTicket'];
  insertEventFn?: ITicketRepo['insertEvent'];
};

type QueueDeps = {
  changeMessageVisibilityFn?: (receiptHandle: string, delaySeconds: number) => Promise<void>;
  deleteMessageFn?: (receiptHandle: string) => Promise<void>;
};

type PhaseDeps = {
  processPhaseFn?: (ticketId: string, phase: PhaseName) => Promise<PhaseResult>;
};

export type WorkerDeps = RepoDeps & QueueDeps & PhaseDeps;

type ResolvedDeps = Required<RepoDeps> & Required<QueueDeps> & Required<PhaseDeps>;

function resolveDeps(deps: WorkerDeps): ResolvedDeps {
  return {
    getTicketByIdFn:
      deps.getTicketByIdFn ?? postgresTicketRepo.getTicketById.bind(postgresTicketRepo),
    getTicketPhasesByTicketIdFn:
      deps.getTicketPhasesByTicketIdFn ??
      postgresTicketRepo.getTicketPhasesByTicketId.bind(postgresTicketRepo),
    transitionTicketStatusFn:
      deps.transitionTicketStatusFn ??
      postgresTicketRepo.transitionTicketStatus.bind(postgresTicketRepo),
    updateTicketStatusFn:
      deps.updateTicketStatusFn ?? postgresTicketRepo.updateTicketStatus.bind(postgresTicketRepo),
    claimPhaseForProcessingFn:
      deps.claimPhaseForProcessingFn ??
      postgresTicketRepo.claimPhaseForProcessing.bind(postgresTicketRepo),
    completePhaseSuccessFn:
      deps.completePhaseSuccessFn ??
      postgresTicketRepo.completePhaseSuccess.bind(postgresTicketRepo),
    failPhaseAttemptFn:
      deps.failPhaseAttemptFn ?? postgresTicketRepo.failPhaseAttempt.bind(postgresTicketRepo),
    completeTicketFn:
      deps.completeTicketFn ?? postgresTicketRepo.completeTicket.bind(postgresTicketRepo),
    failTicketFn: deps.failTicketFn ?? postgresTicketRepo.failTicket.bind(postgresTicketRepo),
    insertEventFn: deps.insertEventFn ?? postgresTicketRepo.insertEvent.bind(postgresTicketRepo),
    changeMessageVisibilityFn: deps.changeMessageVisibilityFn ?? changeMessageVisibility,
    deleteMessageFn: deps.deleteMessageFn ?? deleteTicketMessage,
    processPhaseFn: deps.processPhaseFn ?? runPhase,
  };
}

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
  deps: ResolvedDeps,
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

  if (failedPhase.attempts >= 3) {
    await deps.failTicketFn(ticketId);
    await deps.insertEventFn(ticketId, 'dlq_routed', phase, {
      attempt: failedPhase.attempts,
      reason: 'max_attempts',
    });
    await deps.deleteMessageFn(receiptHandle);
  } else {
    const backoff = backoffSeconds(failedPhase.attempts);
    await deps.transitionTicketStatusFn(ticketId, ['processing'], 'queued');
    await deps.insertEventFn(ticketId, 'retry_scheduled', phase, {
      attempt: failedPhase.attempts,
      backoff_seconds: backoff,
    });
    await deps.changeMessageVisibilityFn(receiptHandle, backoff);
  }
}

const MAX_PHASES = 10;

async function orchestratePhases(
  ticketId: string,
  receiptHandle: string,
  deps: ResolvedDeps,
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
  deps: WorkerDeps = {},
): Promise<void> {
  const resolved = resolveDeps(deps);

  const existing = await resolved.getTicketByIdFn(ticketId);
  if (!existing) {
    logger.warn({ ticketId }, 'Skipping unknown ticket from queue');
    await resolved.deleteMessageFn(receiptHandle);
    return;
  }

  if (isTerminalStatus(existing.status)) {
    logger.info({ ticketId, status: existing.status }, 'Skipping terminal ticket');
    await resolved.deleteMessageFn(receiptHandle);
    return;
  }

  const claimed = await resolved.transitionTicketStatusFn(ticketId, ['queued'], 'processing');
  if (!claimed) {
    const current = await resolved.getTicketByIdFn(ticketId);
    if (current && !isTerminalStatus(current.status)) {
      logger.warn({ ticketId, status: current.status }, 'Ticket not claimable for processing');
    }
    return;
  }

  logger.info({ ticketId }, 'Ticket claimed — processing started');

  try {
    await orchestratePhases(ticketId, receiptHandle, resolved);
  } catch (error) {
    logger.error({ err: error, ticketId }, 'Ticket processing failed');
    const failed = await resolved.failTicketFn(ticketId);
    if (!failed) {
      await resolved.updateTicketStatusFn(ticketId, 'failed');
    }
    await resolved.changeMessageVisibilityFn(receiptHandle, 0);
  }
}

export type WorkerHandle = {
  stop: () => void;
  done: Promise<void>;
};

export function startTicketWorker(deps: WorkerDeps = {}): WorkerHandle {
  const controller = new AbortController();

  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        const messages = await receiveTickets(controller.signal);
        for (const { ticketId, receiptHandle } of messages) {
          await processTicketLifecycle(ticketId, receiptHandle, deps);
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        logger.error({ err: error }, 'Worker loop error');
      }
    }
  })();

  return {
    stop: () => controller.abort(),
    done,
  };
}
