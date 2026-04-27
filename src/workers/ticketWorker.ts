import logger from '../lib/logger.ts';
import { dequeueTicket } from '../queues/ticketQueue.ts';
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

type WorkerDeps = {
  getTicketByIdFn?: typeof getTicketById;
  getTicketPhasesByTicketIdFn?: typeof getTicketPhasesByTicketId;
  transitionTicketStatusFn?: typeof transitionTicketStatus;
  updateTicketStatusFn?: typeof updateTicketStatus;
  claimPhaseForProcessingFn?: typeof claimPhaseForProcessing;
  completePhaseSuccessFn?: typeof completePhaseSuccess;
  failPhaseAttemptFn?: typeof failPhaseAttempt;
  processPhaseFn?: (ticketId: string, phase: PhaseName) => Promise<unknown>;
};

function isTerminalStatus(status: TicketStatus): boolean {
  return status === 'completed' || status === 'failed';
}

async function defaultProcessFn(_ticketId: string): Promise<void> {
  return undefined;
}

function findNextPhase(phases: TicketPhase[]): PhaseName | null {
  const triage = phases.find(phase => phase.phase === 'triage');
  const draft = phases.find(phase => phase.phase === 'draft');

  if (!triage || !draft) return null;

  if (triage.status !== 'success') return 'triage';
  if (draft.status !== 'success') return 'draft';
  return null;
}

export async function processTicketLifecycle(
  ticketId: string,
  deps: WorkerDeps = {},
): Promise<void> {
  const getTicketByIdFn = deps.getTicketByIdFn ?? getTicketById;
  const getTicketPhasesByTicketIdFn = deps.getTicketPhasesByTicketIdFn ?? getTicketPhasesByTicketId;
  const transitionTicketStatusFn = deps.transitionTicketStatusFn ?? transitionTicketStatus;
  const updateTicketStatusFn = deps.updateTicketStatusFn ?? updateTicketStatus;
  const claimPhaseForProcessingFn = deps.claimPhaseForProcessingFn ?? claimPhaseForProcessing;
  const completePhaseSuccessFn = deps.completePhaseSuccessFn ?? completePhaseSuccess;
  const failPhaseAttemptFn = deps.failPhaseAttemptFn ?? failPhaseAttempt;
  const processPhaseFn = deps.processPhaseFn ?? defaultProcessFn;

  const existing = await getTicketByIdFn(ticketId);
  if (!existing) {
    logger.warn({ ticketId }, 'Skipping unknown ticket from queue');
    return;
  }

  if (isTerminalStatus(existing.status)) {
    logger.info({ ticketId, status: existing.status }, 'Skipping terminal ticket');
    return;
  }

  const claimed = await transitionTicketStatusFn(ticketId, ['queued'], 'processing');
  if (!claimed) {
    const current = await getTicketByIdFn(ticketId);
    if (current && !isTerminalStatus(current.status)) {
      logger.warn({ ticketId, status: current.status }, 'Ticket not claimable for processing');
    }
    return;
  }

  try {
    while (true) {
      const phases = await getTicketPhasesByTicketIdFn(ticketId);
      const nextPhase = findNextPhase(phases);

      if (!nextPhase) {
        await transitionTicketStatusFn(ticketId, ['processing'], 'completed');
        return;
      }

      const phaseClaim = await claimPhaseForProcessingFn(ticketId, nextPhase);
      if (!phaseClaim) {
        logger.warn({ ticketId, phase: nextPhase }, 'Phase not claimable for processing');
        return;
      }

      try {
        const output = await processPhaseFn(ticketId, nextPhase);
        await completePhaseSuccessFn(ticketId, nextPhase, output);
      } catch (phaseError) {
        logger.error({ err: phaseError, ticketId, phase: nextPhase }, 'Phase processing failed');
        const failedPhase = await failPhaseAttemptFn(ticketId, nextPhase);

        if (!failedPhase) {
          await updateTicketStatusFn(ticketId, 'failed');
          return;
        }

        if (failedPhase.attempts >= 3) {
          await transitionTicketStatusFn(ticketId, ['queued', 'processing'], 'failed');
        } else {
          await transitionTicketStatusFn(ticketId, ['processing'], 'queued');
        }

        return;
      }
    }
  } catch (error) {
    logger.error({ err: error, ticketId }, 'Ticket processing failed');
    const failed = await transitionTicketStatusFn(ticketId, ['queued', 'processing'], 'failed');
    if (!failed) {
      await updateTicketStatusFn(ticketId, 'failed');
    }
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
        const ticketId = await dequeueTicket(controller.signal);
        await processTicketLifecycle(ticketId, deps);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          break;
        }
        logger.error({ err: error }, 'Worker loop error');
      }
    }
  })();

  return {
    stop: () => controller.abort(),
    done,
  };
}
