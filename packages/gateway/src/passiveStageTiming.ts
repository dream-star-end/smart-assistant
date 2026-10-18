/** Safe, immutable identifiers only. This helper never receives content or credentials. */
export interface StageIdentity {
  engine: string
  traceId?: string
  sessionKey?: string
  model?: string
  generation?: number
}

export class PassiveStageTiming {
  private readonly identity: Readonly<StageIdentity>
  private readonly startedAt: number
  private readonly seen = new Set<string>()
  constructor(identity: StageIdentity,
    private readonly emit: (fields: StageIdentity & { stage: string; elapsedMs: number }) => void,
    private readonly now = () => performance.now()) {
    this.identity = Object.freeze({ ...identity })
    this.startedAt = now()
  }
  fork(generation: number): PassiveStageTiming {
    return new PassiveStageTiming({ ...this.identity, generation }, this.emit, this.now)
  }
  once(stage: string): void {
    if (this.seen.has(stage)) return
    this.seen.add(stage)
    try {
      this.emit({ ...this.identity, stage, elapsedMs: Math.max(0, this.now() - this.startedAt) })
    } catch {
      // Observability must not alter engine execution, stream delivery or billing.
    }
  }
}
