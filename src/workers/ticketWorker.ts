import { FatalPhaseError } from '../lib/errors.ts';
import logger from '../lib/logger.ts';
import { receiveTickets, deleteTicketMessage, changeMessageVisibility } from '../queues/ticketQueue.ts';
import { runPhase } from '../services/aiService.ts';
import {
  claimPhaseForProcessing,
  completePhaseSuccess,
  failPhaseAttempt,
  getTicketById,
  getTicketPhasesByTicketId,
  transitionTicketStatus,
  updateTicketStatus,
} from '../repositories/ticketRepo.ts';
import type { Ticket } from '../schemas/ticketSchema.ts';
import type { TicketPhase } from '../schemas/phaseSchema.ts';

type TicketStatus = Ticket['status'];
type PhaseName = TicketPhase['phase'];

type RepoDeps = {
  getTicketByIdFn?: typeof getTicketById;
  getTicketPhasesByTicketIdFn?: typeof getTicketPhasesByTicketId;
  transitionTicketStatusFn?: typeof transitionTicketStatus;
  updateTicketStatusFn?: typeof updateTicketStatus;
  claimPhaseForProcessingFn?: typeof claimPhaseForProcessing;
  completePhaseSuccessFn?: typeof completePhaseSuccess;
  failPhaseAttemptFn?: typeof failPhaseAttempt;
};

type QueueDeps = {
  changeMessageVisibilityFn?: (receiptHandle: string, delaySeconds: number) => Promise<void>;
  deleteMessageFn?: (receiptHandle: string) => Promise<void>;
};

type PhaseDeps = {
  processPhaseFn?: (ticketId: string, phase: PhaseName) => Promise<unknown>;
};

export type WorkerDeps = RepoDeps & QueueDeps & PhaseDeps;

type ResolvedDeps = Required<RepoDeps> & Required<QueueDeps> & Required<PhaseDeps>;

function resolveDeps(deps: WorkerDeps): ResolvedDeps {
  return {
    getTicketByIdFn: deps.getTicketByIdFn ?? getTicketById,
    getTicketPhasesByTicketIdFn: deps.getTicketPhasesByTicketIdFn ?? getTicketPhasesByTicketId,
    transitionTicketStatusFn: deps.transitionTicketStatusFn ?? transitionTicketStatus,
    updateTicketStatusFn: deps.updateTicketStatusFn ?? updateTicketStatus,
    claimPhaseForProcessingFn: deps.claimPhaseForProcessingFn ?? claimPhaseForProcessing,
    completePhaseSuccessFn: deps.completePhaseSuccessFn ?? completePhaseSuccess,
    failPhaseAttemptFn: deps.failPhaseAttemptFn ?? failPhaseAttempt,
    changeMessageVisibilityFn: deps.changeMessageVisibilityFn ?? changeMessageVisibility,
    deleteMessageFn: deps.deleteMessageFn ?? deleteTicketMessage,
    processPhaseFn: deps.processPhaseFn ?? runPhase,
  };
}

function isTerminalStatus(status: TicketStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function findNextPhase(phases: TicketPhase[]): PhaseName | null {
  const triage = phases.find(phase => phase.phase === 'triage');
  const draft = phases.find(phase => phase.phase === 'draft');

  if (!triage || !draft) return null;

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
    await deps.failPhaseAttemptFn(ticketId, phase);
    await deps.transitionTicketStatusFn(ticketId, ['queued', 'processing'], 'failed');
    await deps.changeMessageVisibilityFn(receiptHandle, 0);
    return;
  }

  logger.error({ err: phaseError, ticketId, phase }, 'Phase processing failed');
  const failedPhase = await deps.failPhaseAttemptFn(ticketId, phase);

  if (!failedPhase) {
    await deps.updateTicketStatusFn(ticketId, 'failed');
    await deps.changeMessageVisibilityFn(receiptHandle, 0);
    return;
  }

  if (failedPhase.attempts >= 3) {
    await deps.transitionTicketStatusFn(ticketId, ['queued', 'processing'], 'failed');
    await deps.changeMessageVisibilityFn(receiptHandle, 0);
  } else {
    await deps.transitionTicketStatusFn(ticketId, ['processing'], 'queued');
    await deps.changeMessageVisibilityFn(receiptHandle, backoffSeconds(failedPhase.attempts));
  }
}

async function orchestratePhases(
  ticketId: string,
  receiptHandle: string,
  deps: ResolvedDeps,
): Promise<void> {
  while (true) {
    const phases = await deps.getTicketPhasesByTicketIdFn(ticketId);
    const nextPhase = findNextPhase(phases);

    if (!nextPhase) {
      await deps.transitionTicketStatusFn(ticketId, ['processing'], 'completed');
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
      const output = await deps.processPhaseFn(ticketId, nextPhase);
      await deps.completePhaseSuccessFn(ticketId, nextPhase, output);
      logger.info({ ticketId, phase: nextPhase }, 'Phase completed');
    } catch (phaseError) {
      await handlePhaseError(phaseError, ticketId, nextPhase, receiptHandle, deps);
      return;
    }
  }
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
    const failed = await resolved.transitionTicketStatusFn(ticketId, ['queued', 'processing'], 'failed');
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
