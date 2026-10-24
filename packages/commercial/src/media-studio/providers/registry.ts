// OCV5-591 A2-0 — provider registry. Built once from config; never throws: a bad entry, an unknown
// adapter or a missing key only makes that instance unavailable (and is reported by id, never with
// the key, its file path or its env name).

import { readFileSync } from 'node:fs'
import { z } from 'zod'

import {
  MEDIA_KINDS,
  type MediaKind,
  type MediaOp,
  type MediaProvider,
  MediaProviderError,
  type MediaRequest,
  type MediaResult,
  type MediaRunContext,
  type ModelInfo,
  type ProviderReason,
  type ProviderStatus,
  type StudioUser,
  defaultModelFor,
  kindOf,
  supportsOp,
} from './types.js'

export const MAX_PROVIDER_ENTRIES = 32
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const KEY_RE = /^[\x21-\x7e]{1,512}$/
/** Literal secrets are refused outright: keys belong in a file (keyFile) or the environment (keyEnv). */
const SECRET_FIELDS = ['key', 'apiKey', 'api_key', 'token', 'secret', 'password'] as const

const EntrySchema = z
  .object({
    id: z.string().regex(ID_RE),
    adapter: z.string().regex(ID_RE),
    enabled: z.boolean().default(true),
    priority: z.number().int().min(0).max(1000).default(100),
    label: z.string().trim().min(1).max(40).optional(),
    models: z.array(z.string().min(1).max(64)).max(32).optional(),
    defaultModel: z.string().min(1).max(64).optional(),
    keyFile: z
      .string()
      .regex(/^\/[^\0]*$/)
      .max(512)
      .optional(),
    keyEnv: z.string().regex(ENV_NAME_RE).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export type ProviderEntry = z.infer<typeof EntrySchema>

/** Without OC_STUDIO_PROVIDERS: today's switches decide (OC_IMAGE2_ENABLED, Muse bridge, MiniMax key). */
export const DEFAULT_PROVIDER_ENTRIES: readonly ProviderEntry[] = [
  { id: 'gpt-image', adapter: 'gpt-image', enabled: true, priority: 10 },
  { id: 'muse-image', adapter: 'muse-image', enabled: true, priority: 20 },
  { id: 'muse-video', adapter: 'muse-video', enabled: true, priority: 10 },
  { id: 'minimax-speech', adapter: 'minimax-speech', enabled: true, priority: 10 },
  // Music: deliberately no default provider (user decision 2026-10-23 09:44).
]

export type KeyResolution = { key: string } | { missing: 'MISSING_KEY' | 'KEY_UNREADABLE' }

/** What an adapter builds; the registry wraps it with config, key and op/model checks. */
export interface AdapterImpl {
  /** null → ready as far as the adapter is concerned. */
  status(user?: StudioUser): ProviderStatus | null
  estimateMaxCost(req: MediaRequest, model: ModelInfo): bigint
  affinity?(): string | null
  run(
    ctx: MediaRunContext,
    req: MediaRequest,
    model: ModelInfo,
  ): Promise<Omit<MediaResult, 'overReservation'>>
}

export interface AdapterFactory<D = unknown> {
  adapter: string
  kind: MediaKind
  label: string
  /** Every model the adapter knows (may depend on deps, e.g. the Image 2 allowlist); config can only narrow it. */
  models(deps: D): readonly ModelInfo[]
  optionsSchema?: z.ZodType
  /**
   * Key used when the entry names neither keyFile nor keyEnv. Return undefined when the adapter
   * needs no key of its own (it rides an existing subsystem, e.g. the Image 2 relay accounts).
   */
  defaultKey?(deps: D): KeyResolution | undefined
  create(input: {
    entry: ProviderEntry
    key: string | undefined
    deps: D
    options: unknown
  }): AdapterImpl
}

export interface ProvidersView {
  kinds: Array<{
    kind: MediaKind
    state: 'ready' | 'offline' | 'unconfigured'
    reason?: 'NO_PROVIDER'
    providers: Array<{
      id: string
      label: string
      state: ProviderStatus['state']
      reason?: ProviderReason
      models: ModelInfo[]
    }>
  }>
}

export interface ProviderRegistry {
  list(): MediaProvider[]
  get(id: string): MediaProvider | undefined
  /**
   * Providers for an op: ready ones (`prefer` first, then priority, then id); with includeOffline,
   * offline ones follow — they can be queued with their affinity and fail over at the A1 affinity
   * deadline. unconfigured / disabled providers are never candidates.
   */
  candidates(
    kind: MediaKind,
    op: MediaOp,
    user: StudioUser,
    opts?: { prefer?: string; exclude?: readonly string[]; includeOffline?: boolean },
  ): MediaProvider[]
  describe(user: StudioUser): ProvidersView
}

/**
 * Parse OC_STUDIO_PROVIDERS. undefined/blank → null (use the defaults). Unparseable JSON or a
 * non-array → [] (nothing configured): falling back to defaults could re-enable an instance the
 * operator meant to switch off.
 */
export function parseProviderConfig(
  raw: string | undefined,
  warn: (msg: string) => void,
): Array<ProviderEntry | { invalid: string }> | null {
  if (raw === undefined || raw.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn('OC_STUDIO_PROVIDERS is not valid JSON; no media providers are configured')
    return []
  }
  if (!Array.isArray(parsed)) {
    warn('OC_STUDIO_PROVIDERS must be a JSON array; no media providers are configured')
    return []
  }
  if (parsed.length > MAX_PROVIDER_ENTRIES) {
    warn(`OC_STUDIO_PROVIDERS has more than ${MAX_PROVIDER_ENTRIES} entries; extra entries ignored`)
  }
  return parsed.slice(0, MAX_PROVIDER_ENTRIES).map((item, i) => {
    const rawId =
      item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id
        : ''
    const label = ID_RE.test(rawId) ? rawId : `#${i}`
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const secret = SECRET_FIELDS.find((f) => f in (item as object))
      if (secret) {
        warn(
          `media provider ${label}: literal "${secret}" is not allowed; use keyFile or keyEnv. Entry disabled`,
        )
        return { invalid: label }
      }
    }
    const res = EntrySchema.safeParse(item)
    if (!res.success) {
      const fields = [...new Set(res.error.issues.map((x) => x.path.join('.') || '(entry)'))]
      warn(`media provider ${label}: invalid fields ${fields.join(', ')}. Entry disabled`)
      return { invalid: label }
    }
    return res.data
  })
}

export function resolveEntryKey(
  entry: Pick<ProviderEntry, 'keyFile' | 'keyEnv'>,
  env: NodeJS.ProcessEnv,
  read: (path: string) => string,
): KeyResolution | undefined {
  if (entry.keyFile) {
    let raw: string
    try {
      raw = read(entry.keyFile)
    } catch {
      return { missing: 'KEY_UNREADABLE' }
    }
    const key = raw.trim()
    return KEY_RE.test(key) ? { key } : { missing: 'KEY_UNREADABLE' }
  }
  if (entry.keyEnv) {
    const key = env[entry.keyEnv]?.trim()
    if (!key) return { missing: 'MISSING_KEY' }
    return KEY_RE.test(key) ? { key } : { missing: 'KEY_UNREADABLE' }
  }
  return undefined
}

function stateRank(s: ProviderStatus['state']): number {
  return s === 'ready' ? 0 : s === 'offline' ? 1 : 2
}

class UnavailableProvider implements MediaProvider {
  constructor(
    readonly id: string,
    readonly adapter: string,
    readonly kind: MediaKind,
    readonly label: string,
    readonly priority: number,
    private readonly known: ModelInfo[],
    private readonly why: ProviderStatus,
  ) {}
  models(): ModelInfo[] {
    return this.known
  }
  status(): ProviderStatus {
    return this.why
  }
  estimateMaxCost(): bigint {
    return 0n
  }
  affinity(): string | null {
    return null
  }
  async run(): Promise<never> {
    throw new MediaProviderError(
      'PROVIDER_UNAVAILABLE',
      false,
      `media provider ${this.id} is not available`,
    )
  }
}

class ConfiguredProvider implements MediaProvider {
  constructor(
    readonly id: string,
    readonly adapter: string,
    readonly kind: MediaKind,
    readonly label: string,
    readonly priority: number,
    private readonly known: ModelInfo[],
    private readonly impl: AdapterImpl,
  ) {}
  models(): ModelInfo[] {
    return this.known
  }
  status(user?: StudioUser): ProviderStatus {
    return this.impl.status(user) ?? { state: 'ready' }
  }
  private pick(req: MediaRequest): ModelInfo {
    if (kindOf(req.op) !== this.kind || !supportsOp(this, req.op, req.model)) {
      throw new MediaProviderError(
        'UNSUPPORTED_OP',
        false,
        `media provider ${this.id} cannot run ${req.op}${req.model ? ` with ${req.model}` : ''}`,
      )
    }
    const model = req.model
      ? this.known.find((m) => m.id === req.model)
      : defaultModelFor(this, req.op)
    if (!model) throw new MediaProviderError('UNSUPPORTED_OP', false, `no model for ${req.op}`)
    return model
  }
  estimateMaxCost(req: MediaRequest): bigint {
    return this.impl.estimateMaxCost(req, this.pick(req))
  }
  affinity(): string | null {
    return this.impl.affinity?.() ?? null
  }
  async run(ctx: MediaRunContext, req: MediaRequest) {
    const model = this.pick(req)
    const st = this.status()
    // offline providers may still be handed work: the queue's affinity deadline fails it over (A1 §3).
    if (st.state === 'unconfigured' || st.state === 'disabled') {
      throw new MediaProviderError(
        'PROVIDER_UNAVAILABLE',
        false,
        `media provider ${this.id} is not available`,
      )
    }
    const bound = this.impl.estimateMaxCost(req, model)
    if (bound > ctx.maxCostCredits) {
      throw new MediaProviderError(
        'RESERVATION_TOO_SMALL',
        false,
        `media provider ${this.id} needs a reservation of ${bound} credits`,
      )
    }
    const out = await this.impl.run(ctx, req, model)
    return { ...out, overReservation: out.costCredits > ctx.maxCostCredits }
  }
}

function narrowModels(
  all: readonly ModelInfo[],
  entry: ProviderEntry,
  warn: (msg: string) => void,
): ModelInfo[] {
  let models = all.map((m) => ({ ...m, ops: [...m.ops] }))
  if (entry.models) {
    const known = new Set(models.map((m) => m.id))
    for (const id of entry.models) {
      if (!known.has(id))
        warn(`media provider ${entry.id}: unknown model ${JSON.stringify(id)} ignored`)
    }
    const keep = new Set(entry.models)
    models = models.filter((m) => keep.has(m.id))
  }
  if (entry.defaultModel) {
    if (models.some((m) => m.id === entry.defaultModel)) {
      models = models.map((m) => ({ ...m, isDefault: m.id === entry.defaultModel }))
    } else {
      warn(
        `media provider ${entry.id}: defaultModel is not one of its models; keeping the built-in default`,
      )
    }
  }
  return models
}

export function createProviderRegistry<D>(input: {
  /** null → DEFAULT_PROVIDER_ENTRIES. */
  entries: Array<ProviderEntry | { invalid: string }> | null
  factories: readonly AdapterFactory<D>[]
  deps: D
  env?: NodeJS.ProcessEnv
  readFile?: (path: string) => string
  warn: (msg: string) => void
}): ProviderRegistry {
  const env = input.env ?? process.env
  const read = input.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  const byAdapter = new Map(input.factories.map((f) => [f.adapter, f]))
  const providers: MediaProvider[] = []
  const seen = new Set<string>()

  for (const e of input.entries ?? DEFAULT_PROVIDER_ENTRIES) {
    if ('invalid' in e) continue // already reported by parseProviderConfig; nothing to show without a kind
    if (seen.has(e.id)) {
      input.warn(`media provider ${e.id}: duplicate id ignored`)
      continue
    }
    seen.add(e.id)
    const factory = byAdapter.get(e.adapter) as AdapterFactory<never> | undefined
    if (!factory) {
      input.warn(
        `media provider ${e.id}: unknown adapter ${JSON.stringify(e.adapter)}; entry ignored`,
      )
      continue
    }
    const label = e.label ?? factory.label
    const models = narrowModels(factory.models(input.deps as never), e, input.warn)
    const unavailable = (why: ProviderStatus) =>
      providers.push(
        new UnavailableProvider(e.id, e.adapter, factory.kind, label, e.priority, models, why),
      )
    if (!e.enabled) {
      unavailable({ state: 'disabled', reason: 'DISABLED_BY_CONFIG' })
      continue
    }
    if (models.length === 0) {
      input.warn(`media provider ${e.id}: no usable models; entry disabled`)
      unavailable({ state: 'disabled', reason: 'INVALID_CONFIG' })
      continue
    }
    let options: unknown = e.options ?? {}
    if (factory.optionsSchema) {
      const parsed = factory.optionsSchema.safeParse(options)
      if (!parsed.success) {
        input.warn(`media provider ${e.id}: invalid options; entry disabled`)
        unavailable({ state: 'disabled', reason: 'INVALID_CONFIG' })
        continue
      }
      options = parsed.data
    } else if (e.options && Object.keys(e.options).length > 0) {
      input.warn(`media provider ${e.id}: adapter takes no options; entry disabled`)
      unavailable({ state: 'disabled', reason: 'INVALID_CONFIG' })
      continue
    }
    const key = resolveEntryKey(e, env, read) ?? factory.defaultKey?.(input.deps as never)
    if (key && 'missing' in key) {
      if (key.missing === 'KEY_UNREADABLE')
        input.warn(`media provider ${e.id}: key is not readable`)
      unavailable({ state: 'unconfigured', reason: key.missing })
      continue
    }
    try {
      const impl = factory.create({ entry: e, key: key?.key, deps: input.deps as never, options })
      providers.push(
        new ConfiguredProvider(e.id, e.adapter, factory.kind, label, e.priority, models, impl),
      )
    } catch {
      input.warn(`media provider ${e.id}: adapter failed to start; entry disabled`)
      unavailable({ state: 'disabled', reason: 'INVALID_CONFIG' })
    }
  }

  const ordered = (list: MediaProvider[], prefer?: string) =>
    [...list].sort(
      (a, b) =>
        Number(b.id === prefer) - Number(a.id === prefer) ||
        a.priority - b.priority ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )

  return {
    list: () => [...providers],
    get: (id) => providers.find((p) => p.id === id),
    candidates(kind, op, user, opts) {
      const exclude = new Set(opts?.exclude ?? [])
      const usable = providers.filter(
        (p) => p.kind === kind && !exclude.has(p.id) && supportsOp(p, op),
      )
      const inState = (state: ProviderStatus['state']) =>
        ordered(
          usable.filter((p) => p.status(user).state === state),
          opts?.prefer,
        )
      return opts?.includeOffline ? [...inState('ready'), ...inState('offline')] : inState('ready')
    },
    describe(user) {
      return {
        kinds: MEDIA_KINDS.map((kind) => {
          const list = ordered(providers.filter((p) => p.kind === kind)).map((p) => {
            const st = p.status(user)
            return {
              id: p.id,
              label: p.label,
              state: st.state,
              ...(st.reason ? { reason: st.reason } : {}),
              models: p.models().map((m) => ({ ...m, ops: [...m.ops] })),
            }
          })
          if (list.length === 0) {
            return {
              kind,
              state: 'unconfigured' as const,
              reason: 'NO_PROVIDER' as const,
              providers: [],
            }
          }
          const best = Math.min(...list.map((p) => stateRank(p.state)))
          const state = best === 0 ? 'ready' : best === 1 ? 'offline' : 'unconfigured'
          return { kind, state, providers: list }
        }),
      }
    },
  }
}
