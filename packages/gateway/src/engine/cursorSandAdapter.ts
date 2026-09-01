/** Cursor Sand engine: CCB supplies the local agent/tool loop while a
 * capability-scoped loopback relay speaks Cursor InferenceService/Stream. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  cursorModelById,
} from '@openclaude/protocol'
import type { EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type {
  EngineExternalBillingEvent,
  PartialSnapshot,
  PhantomSignals,
  TurnSummary,
} from './engineEvents.js'
import type { EngineCreateOpts } from './registry.js'
import { CcbAdapter } from './ccbAdapter.js'
import { CursorSandRelay } from './cursorSandRelay.js'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'cursorSandAdapter' })
const DEFAULT_SAND_SIDECAR = '/run/oc/cursor-auth/.sand-mode'
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const EMPTY_SNAPSHOT: PartialSnapshot = {
  assistantText: '',
  thinkingText: '',
  completedTools: [],
  assistantSegments: [],
  thinkingSegments: [],
  runtimeEvents: [],
}
const EMPTY_PHANTOM: PhantomSignals = { apiState: 'unknown', skipReason: null }

function readSandSidecar(path = process.env.OC_CURSOR_SAND_SIDECAR ?? DEFAULT_SAND_SIDECAR): string {
  if (path !== DEFAULT_SAND_SIDECAR) {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  }
  const result = spawnSync(
    '/usr/bin/sudo',
    ['-n', '/bin/cat', DEFAULT_SAND_SIDECAR],
    { encoding: 'utf8', maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : ''
}

export function cursorSandEnabledForModel(
  modelId: string | undefined,
  sidecar = readSandSidecar(),
): boolean {
  if (!modelId) return false
  const model = cursorModelById(modelId)
  if (!model?.upstreamModel || !model.upstreamModel.startsWith('claude-fable-5')) return false
  for (const raw of sidecar.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [slot, enabled, ...extra] = line.split(/\s+/)
    if (extra.length === 0 && slot === 'api-key' && enabled === '1') return true
  }
  return false
}

function appendNoProxy(current: string | undefined, ...hosts: string[]): string {
  const values = (current ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  for (const host of hosts) if (!values.includes(host)) values.push(host)
  return values.join(',')
}

/** CCB adapter with Cursor's external-billing/session identity at its boundary. */
export class CursorSandAdapter extends CcbAdapter {
  override readonly engineId = 'cursor'
  override readonly capabilities: EngineCapabilities = {
    billingMode: 'external',
    supportsEffort: false,
    resumeKind: 'cursor-session',
    needsServerRequestId: false,
    historyMode: 'native-resume',
    permissionModel: 'native',
    emitsCallUsage: true,
    emitsToolInputDeltas: true,
    // Cursor has no side-effect-free Sand compaction/export surface. Model
    // switches must fail closed and reopen instead of running a hidden agent
    // turn with tools and no server-owned billing identity.
    supportsNativeCompact: false,
    multimodalInput: 'native',
  }

  private readonly providerEnv: Record<string, string>
  private readonly relay: CursorSandRelay
  private readonly submitDelegate?: (params: TurnParams) => EngineTurnRun
  private activeCancel: (() => boolean) | null = null
  private lifecycleGeneration = 0
  private lifecycleClosed = false
  private shutdownPromise: Promise<void> | null = null
  private prepareInFlight: { generation: number; promise: Promise<void> } | null = null
  private readonly pendingLifecycle = new Set<Promise<unknown>>()
  private lifecycleTail: Promise<void> = Promise.resolve()

  constructor(
    opts: EngineCreateOpts,
    relay = new CursorSandRelay(),
    submitDelegate?: (params: TurnParams) => EngineTurnRun,
  ) {
    const providerEnv: Record<string, string> = {}
    super({ ...opts, providerEnvOverride: providerEnv, authorityEngine: 'cursor' })
    this.providerEnv = providerEnv
    this.relay = relay
    this.submitDelegate = submitDelegate
  }

  private assertLifecycle(generation: number): void {
    if (this.lifecycleClosed || generation !== this.lifecycleGeneration) {
      throw new Error('CURSOR_SAND_ADAPTER_SHUTDOWN')
    }
  }

  private trackLifecycle<T>(promise: Promise<T>): Promise<T> {
    this.pendingLifecycle.add(promise)
    void promise.then(
      () => this.pendingLifecycle.delete(promise),
      () => this.pendingLifecycle.delete(promise),
    )
    return promise
  }

  private withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail
    let release!: () => void
    this.lifecycleTail = new Promise<void>((resolvePromise) => { release = resolvePromise })
    return previous.then(operation).finally(release)
  }

  private async prepareRelay(generation = this.lifecycleGeneration): Promise<void> {
    this.assertLifecycle(generation)
    let preparation = this.prepareInFlight
    if (!preparation || preparation.generation !== generation) {
      const promise = (async () => {
        const baseUrl = await this.relay.start()
        this.assertLifecycle(generation)
        const model = this.model ?? ''
        Object.assign(this.providerEnv, {
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_AUTH_TOKEN: 'cursor-sand-loopback',
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_MODEL: model,
          ANTHROPIC_SMALL_FAST_MODEL: model,
          ENABLE_TOOL_SEARCH: 'true',
          _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
          NO_PROXY: appendNoProxy(process.env.NO_PROXY, '127.0.0.1', 'localhost'),
          no_proxy: appendNoProxy(process.env.no_proxy, '127.0.0.1', 'localhost'),
          OPENCLAUDE_CCB_NO_PROXY: appendNoProxy(
            process.env.OPENCLAUDE_CCB_NO_PROXY,
            '127.0.0.1', 'localhost',
          ),
        })
      })()
      preparation = { generation, promise }
      this.prepareInFlight = preparation
      void promise.then(
        () => { if (this.prepareInFlight?.promise === promise) this.prepareInFlight = null },
        () => { if (this.prepareInFlight?.promise === promise) this.prepareInFlight = null },
      )
    }
    await preparation.promise
    this.assertLifecycle(generation)
  }

  override async start(): Promise<void> {
    const generation = this.lifecycleGeneration
    const operation = this.trackLifecycle(this.withLifecycleLock(async () => {
      await this.prepareRelay(generation)
      this.assertLifecycle(generation)
      await super.start()
      this.assertLifecycle(generation)
    }))
    try {
      await operation
      log.info('cursor sand inference runner started', { model: this.model ?? '', endpoint: 'InferenceService/Stream' })
    } catch (error) {
      await this.relay.close()
      throw error
    }
  }

  override async preheat(): Promise<void> {
    const generation = this.lifecycleGeneration
    const operation = this.trackLifecycle(this.withLifecycleLock(async () => {
      await this.prepareRelay(generation)
      this.assertLifecycle(generation)
      await super.preheat()
      this.assertLifecycle(generation)
    }))
    try {
      await operation
    } catch (error) {
      await this.relay.close()
      throw error
    }
  }

  override submitTurn(params: TurnParams): EngineTurnRun {
    const generation = this.lifecycleGeneration
    const startedAt = Date.now()
    let inner: EngineTurnRun | null = null
    let ended = false
    let interrupted = false
    let billingEmitted = false
    let resolveSummary!: (summary: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>((resolvePromise) => {
      resolveSummary = resolvePromise
    })
    const emitBilling = (result: TurnSummary | null, detail?: string): void => {
      if (billingEmitted) return
      billingEmitted = true
      if (!params.requestId || !REQUEST_ID_RE.test(params.requestId)) return
      const errorDetail = detail ?? result?.errorDetail ?? ''
      const unavailable = /auth|credential|unauthorized|forbidden|quota|rate.?limit|usage limit|subscription|\b40[13]\b|\b429\b/i.test(errorDetail)
      const status: EngineExternalBillingEvent['status'] = unavailable
        ? 'unavailable'
        : result?.isError || !result
          ? 'error'
          : 'success'
      const terminalCode: EngineExternalBillingEvent['terminalCode'] | undefined = interrupted
        ? 'USER_CANCELLED'
        : /quota|rate.?limit|usage limit|subscription|\b429\b/i.test(errorDetail)
          ? 'QUOTA_UNAVAILABLE'
          : /auth|credential|unauthorized|forbidden|\b40[13]\b/i.test(errorDetail)
            ? 'AUTH_UNAVAILABLE'
            : status === 'error'
              ? 'ENGINE_ERROR'
              : undefined
      this.emit('external_billing', {
        requestId: params.requestId,
        engine: 'cursor',
        status,
        durationMs: Date.now() - startedAt,
        ...(result ? {
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
            cache_read_input_tokens: result.usage.cacheReadTokens,
            cache_creation_input_tokens: result.usage.cacheCreationTokens,
          },
        } : {}),
        ...(terminalCode ? { terminalCode } : {}),
      } satisfies EngineExternalBillingEvent)
    }
    const clearActiveCancel = (): void => {
      if (this.activeCancel === cancel) this.activeCancel = null
    }
    const cancel = (): boolean => {
      interrupted = true
      ended = true
      if (!inner) return true
      super.interrupt()
      inner.end()
      return true
    }
    this.activeCancel = cancel
    const submitted = this.trackLifecycle(this.withLifecycleLock(async () => {
      try {
        this.assertLifecycle(generation)
        await this.prepareRelay(generation)
        this.assertLifecycle(generation)
        if (ended) {
          emitBilling(null)
          resolveSummary(null)
          clearActiveCancel()
          return
        }
        inner = this.submitDelegate ? this.submitDelegate(params) : super.submitTurn(params)
        void inner.summary.then((result) => {
          emitBilling(result)
          resolveSummary(result)
          clearActiveCancel()
        })
        await inner.submitted
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        emitBilling(null, detail)
        resolveSummary(null)
        clearActiveCancel()
        throw error
      }
    }))
    return {
      submitted,
      summary,
      end(): void {
        ended = true
        inner?.end()
        if (!inner) {
          emitBilling(null)
          resolveSummary(null)
          clearActiveCancel()
        }
      },
      getPartialSnapshot(): PartialSnapshot {
        return inner?.getPartialSnapshot() ?? structuredClone(EMPTY_SNAPSHOT)
      },
      getPhantomSignals(): PhantomSignals {
        return inner?.getPhantomSignals() ?? { ...EMPTY_PHANTOM }
      },
      get finalized(): boolean { return inner?.finalized ?? false },
      get pendingToolCalls(): number { return inner?.pendingToolCalls ?? 0 },
    }
  }

  override interrupt(): boolean {
    return this.activeCancel?.() ?? super.interrupt()
  }

  override async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.lifecycleClosed = true
    this.lifecycleGeneration++
    this.activeCancel?.()
    this.shutdownPromise = (async () => {
      await Promise.allSettled([...this.pendingLifecycle])
      try {
        await super.shutdown()
      } finally {
        await this.relay.close()
      }
    })()
    return this.shutdownPromise
  }
}
