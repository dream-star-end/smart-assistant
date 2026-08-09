export enum ShellEvaluationRequest {
  REJECTED = 'rejected',
  STARTED = 'started',
  QUEUED = 'queued'
}

export enum ShellEvaluationDecision {
  STALE = 'stale',
  COMMIT = 'commit',
  RETRY = 'retry',
  ROLLBACK = 'rollback'
}

export enum ShellRollbackDecision {
  STALE = 'stale',
  COMPLETE = 'complete',
  RETRY = 'retry'
}

enum ShellEvaluationPhase {
  INACTIVE = 'inactive',
  IDLE = 'idle',
  EVALUATING = 'evaluating',
  ROLLING_BACK = 'rolling-back'
}

/**
 * Serializes native-shell evaluation and rollback within one main-frame
 * navigation. A busy generation coalesces any number of lifecycle signals
 * into at most one pending retry.
 */
export class ShellEvaluationClock {
  private generation: number = -1;
  private phase: ShellEvaluationPhase = ShellEvaluationPhase.INACTIVE;
  private pending: boolean = false;

  beginGeneration(generation: number): void {
    this.generation = generation;
    this.phase = ShellEvaluationPhase.IDLE;
    this.pending = false;
  }

  invalidate(): void {
    this.generation = -1;
    this.phase = ShellEvaluationPhase.INACTIVE;
    this.pending = false;
  }

  request(generation: number): ShellEvaluationRequest {
    if (generation !== this.generation || this.phase === ShellEvaluationPhase.INACTIVE) {
      return ShellEvaluationRequest.REJECTED;
    }
    if (this.phase !== ShellEvaluationPhase.IDLE) {
      this.pending = true;
      return ShellEvaluationRequest.QUEUED;
    }

    this.phase = ShellEvaluationPhase.EVALUATING;
    return ShellEvaluationRequest.STARTED;
  }

  completeEvaluation(
    generation: number,
    requiresRollback: boolean
  ): ShellEvaluationDecision {
    if (generation !== this.generation || this.phase !== ShellEvaluationPhase.EVALUATING) {
      return ShellEvaluationDecision.STALE;
    }
    if (this.pending) {
      this.pending = false;
      return ShellEvaluationDecision.RETRY;
    }
    if (requiresRollback) {
      this.phase = ShellEvaluationPhase.ROLLING_BACK;
      return ShellEvaluationDecision.ROLLBACK;
    }

    this.phase = ShellEvaluationPhase.IDLE;
    return ShellEvaluationDecision.COMMIT;
  }

  completeRollback(generation: number): ShellRollbackDecision {
    if (generation !== this.generation || this.phase !== ShellEvaluationPhase.ROLLING_BACK) {
      return ShellRollbackDecision.STALE;
    }
    if (this.pending) {
      this.pending = false;
      this.phase = ShellEvaluationPhase.EVALUATING;
      return ShellRollbackDecision.RETRY;
    }

    this.phase = ShellEvaluationPhase.IDLE;
    return ShellRollbackDecision.COMPLETE;
  }

  cancel(generation: number): void {
    if (generation !== this.generation) {
      return;
    }
    this.phase = ShellEvaluationPhase.IDLE;
    this.pending = false;
  }
}
