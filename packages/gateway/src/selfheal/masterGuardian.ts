import type { Logger } from '../logger.js'
import { createLogger } from '../logger.js'
import {
  type HostActionConfig,
  type HostActionReceipt,
  executeHostOpcode,
  hostActionConfigFromEnv,
} from './hostAction.js'

const log = createLogger({ module: 'selfheal-master-guardian' })
const OPCODE = 'ensure-v5-active-master-v1'
const DEFAULT_INTERVAL_MS = 30_000

export interface SelfhealMasterGuardianOpts {
  hostAction: HostActionConfig
  intervalMs?: number
  execute?: (opcode: string, config: HostActionConfig) => Promise<HostActionReceipt>
  log?: Logger
}

export function masterGuardianConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HostActionConfig | null {
  if (env.OC_SELFHEAL_MASTER_GUARDIAN_ENABLED !== '1') return null
  return hostActionConfigFromEnv(env)
}

function remoteAction(receipt: HostActionReceipt): string | undefined {
  if (!receipt.detail || typeof receipt.detail !== 'object') return undefined
  const detail = (receipt.detail as { detail?: unknown }).detail
  if (!detail || typeof detail !== 'object') return undefined
  const action = (detail as { action?: unknown }).action
  return typeof action === 'string' ? action : undefined
}

/**
 * Independent serving-master guardian.
 *
 * It deliberately does not consume V5 incidents: the V5 reconciler cannot
 * dispatch a repair while the serving master itself is down. The remote fixed
 * opcode owns all state derivation and mutation fencing; this loop only sends
 * that parameter-free request from the independently running personal gateway.
 */
export class SelfhealMasterGuardian {
  private readonly intervalMs: number
  private readonly execute: NonNullable<SelfhealMasterGuardianOpts['execute']>
  private readonly log: Logger
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  private ticking = false

  constructor(private readonly opts: SelfhealMasterGuardianOpts) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.execute = opts.execute ?? executeHostOpcode
    this.log = opts.log ?? log
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopped = false
    this.log.info('selfheal active-master guardian started', {
      intervalMs: this.intervalMs,
      host: this.opts.hostAction.host,
    })
    this.scheduleNext(0)
  }

  stop(): void {
    this.stopped = true
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.tick()
    }, delayMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    await this.runOnce()
    this.scheduleNext(this.intervalMs)
  }

  /** One deterministic iteration; public for tests and supervised drills. */
  async runOnce(): Promise<boolean> {
    if (this.stopped || this.ticking) return false
    this.ticking = true
    try {
      const receipt = await this.execute(OPCODE, this.opts.hostAction)
      const action = remoteAction(receipt)
      const ctx = {
        opcode: receipt.opcode,
        outcome: receipt.outcome,
        exit: receipt.exit,
        durationMs: receipt.durationMs,
        action,
      }
      if (receipt.outcome === 'completed' && action === 'noop') {
        this.log.debug('selfheal active-master guardian healthy', ctx)
      } else if (receipt.outcome === 'completed') {
        this.log.warn('selfheal active-master guardian restored serving unit', ctx)
      } else if (receipt.outcome === 'rejected') {
        this.log.info('selfheal active-master guardian stood down', ctx)
      } else {
        this.log.error('selfheal active-master guardian action failed', ctx)
      }
      return true
    } catch (err) {
      this.log.error('selfheal active-master guardian tick error', undefined, err)
      return true
    } finally {
      this.ticking = false
    }
  }
}
