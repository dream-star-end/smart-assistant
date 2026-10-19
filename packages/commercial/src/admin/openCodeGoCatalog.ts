import {
  OPENCODE_GO_EXTRA_MODELS,
  getStaticProvider,
  staticProviderOutputConfigEfforts,
} from '@openclaude/protocol'
/**
 * OCV5-425 OpenCode Go catalog data and the selfhost operation that applies it
 * (scripts/ocv5-425/catalog.ts). The apply runs inside the caller's transaction and refuses any
 * drift from the reviewed rows. Routing and effort tiers come from protocol (OPENCODE_GO_EXTRA_MODELS,
 * the opencodego spec's modelOutputConfigEfforts); this file only adds what the catalog stores.
 *
 * Prices: https://opencode.ai/docs/go/ (fetched 2026-10-15, cross-checked with
 * https://models.dev/api.json `opencode-go`), USD per 1M tokens. Selfhost fen convention
 * (migrations 0286/0288): floor(usd * 100 / 2); a non-zero price that floors to 0 is stored as 1.
 * Tiered models use the cheaper tier and cap the context window at the tier boundary so a
 * single per-token price is exact. DeepSeek V4 Pro uses the Peak (higher) price.
 */
import type { PoolClient } from 'pg'

export interface GoUsd {
  input: string
  output: string
  cacheRead: string
  cacheWrite: string | null
}

export interface GoCatalogModel {
  modelId: string
  upstreamModelId: string
  displayName: string
  contextWindow: number
  supportsThinking: boolean
  usd: GoUsd
  sortOrder: number
  defaultEffort: string | null
}

const rows: Array<Omit<GoCatalogModel, 'upstreamModelId'>> = [
  {
    modelId: 'deepseek-v4-pro-go',
    displayName: 'DeepSeek V4 Pro (Go)',
    contextWindow: 1_000_000,
    supportsThinking: true,
    usd: { input: '1.32', output: '3.96', cacheRead: '0.044', cacheWrite: null },
    sortOrder: 300,
    defaultEffort: null,
  },
  {
    modelId: 'claude-haiku-5-5-go',
    displayName: 'Claude Haiku 5.5 (Go)',
    contextWindow: 100_000,
    supportsThinking: false,
    usd: { input: '0.10', output: '0.50', cacheRead: '0.01', cacheWrite: '0.125' },
    sortOrder: 301,
    defaultEffort: 'high',
  },
  {
    modelId: 'kimi-k3-go',
    displayName: 'Kimi K3 (Go)',
    contextWindow: 1_048_576,
    supportsThinking: true,
    usd: { input: '3.00', output: '15.00', cacheRead: '0.30', cacheWrite: null },
    sortOrder: 302,
    defaultEffort: null,
  },
  {
    modelId: 'minimax-m2.7-go',
    displayName: 'MiniMax M2.7 (Go)',
    contextWindow: 204_800,
    supportsThinking: true,
    usd: { input: '0.30', output: '1.20', cacheRead: '0.06', cacheWrite: '0.375' },
    sortOrder: 303,
    defaultEffort: null,
  },
  {
    modelId: 'minimax-m3-go',
    displayName: 'MiniMax M3 (Go)',
    contextWindow: 200_000,
    supportsThinking: true,
    usd: { input: '0.30', output: '1.20', cacheRead: '0.06', cacheWrite: null },
    sortOrder: 304,
    defaultEffort: null,
  },
  {
    modelId: 'space-bunny-go',
    displayName: 'Space Bunny (Go)',
    contextWindow: 1_048_576,
    supportsThinking: true,
    usd: { input: '0.15', output: '0.60', cacheRead: '0.03', cacheWrite: null },
    sortOrder: 305,
    defaultEffort: null,
  },
  {
    modelId: 'qwen3.8-max-go',
    displayName: 'Qwen3.8 Max (Go)',
    contextWindow: 262_144,
    supportsThinking: true,
    usd: { input: '2.00', output: '6.00', cacheRead: '0.25', cacheWrite: '2.50' },
    sortOrder: 306,
    defaultEffort: null,
  },
  {
    modelId: 'qwen3.8-flash-go',
    displayName: 'Qwen3.8 Flash (Go)',
    contextWindow: 1_000_000,
    supportsThinking: true,
    usd: { input: '0.15', output: '0.47', cacheRead: '0.016', cacheWrite: '0.20' },
    sortOrder: 307,
    defaultEffort: null,
  },
  {
    modelId: 'qwen3.7-plus-go',
    displayName: 'Qwen3.7 Plus (Go)',
    contextWindow: 200_000,
    supportsThinking: true,
    usd: { input: '0.40', output: '1.60', cacheRead: '0.04', cacheWrite: '0.50' },
    sortOrder: 308,
    defaultEffort: null,
  },
  // Phase 2 (chat completions bridge). Thinking stays upstream; free preview models cost 0.
  {
    modelId: 'glm-5.3-go',
    displayName: 'GLM-5.3 (Go)',
    contextWindow: 1_000_000,
    supportsThinking: false,
    usd: { input: '1.40', output: '4.40', cacheRead: '0.26', cacheWrite: null },
    sortOrder: 309,
    defaultEffort: null,
  },
  {
    modelId: 'glm-5.2-go',
    displayName: 'GLM-5.2 (Go)',
    contextWindow: 1_000_000,
    supportsThinking: false,
    usd: { input: '1.40', output: '4.40', cacheRead: '0.26', cacheWrite: null },
    sortOrder: 310,
    defaultEffort: null,
  },
  {
    modelId: 'glm-5.3-flash-go',
    displayName: 'GLM-5.3 Flash (Go)',
    contextWindow: 1_000_000,
    supportsThinking: false,
    usd: { input: '0.15', output: '0.50', cacheRead: '0.03', cacheWrite: null },
    sortOrder: 311,
    defaultEffort: null,
  },
  {
    modelId: 'kimi-k2.7-code-go',
    displayName: 'Kimi K2.7 Code (Go)',
    contextWindow: 262_144,
    supportsThinking: false,
    usd: { input: '0.95', output: '4.00', cacheRead: '0.19', cacheWrite: null },
    sortOrder: 312,
    defaultEffort: null,
  },
  {
    modelId: 'kimi-k2.6-go',
    displayName: 'Kimi K2.6 (Go)',
    contextWindow: 262_144,
    supportsThinking: false,
    usd: { input: '0.95', output: '4.00', cacheRead: '0.16', cacheWrite: null },
    sortOrder: 313,
    defaultEffort: null,
  },
  {
    modelId: 'mimo-v2.6-pro-go',
    displayName: 'MiMo V2.6 Pro (Go)',
    contextWindow: 1_048_576,
    supportsThinking: false,
    usd: { input: '0.435', output: '0.87', cacheRead: '0.003625', cacheWrite: null },
    sortOrder: 314,
    defaultEffort: null,
  },
  {
    modelId: 'mimo-v2.5-pro-go',
    displayName: 'MiMo V2.5 Pro (Go)',
    contextWindow: 1_048_576,
    supportsThinking: false,
    usd: { input: '0.435', output: '0.87', cacheRead: '0.003625', cacheWrite: null },
    sortOrder: 315,
    defaultEffort: null,
  },
  {
    modelId: 'mimo-v2.6-flash-go',
    displayName: 'MiMo V2.6 Flash (Go)',
    contextWindow: 1_048_576,
    supportsThinking: false,
    usd: { input: '0.14', output: '0.28', cacheRead: '0.0028', cacheWrite: null },
    sortOrder: 316,
    defaultEffort: null,
  },
  {
    modelId: 'mimo-v2.5-go',
    displayName: 'MiMo V2.5 (Go)',
    contextWindow: 1_000_000,
    supportsThinking: false,
    usd: { input: '0.14', output: '0.28', cacheRead: '0.0028', cacheWrite: null },
    sortOrder: 317,
    defaultEffort: null,
  },
  {
    modelId: 'hy4-preview-go',
    displayName: 'Hy4 Preview (Go)',
    contextWindow: 1_024_000,
    supportsThinking: false,
    usd: { input: '0.834', output: '2.501', cacheRead: '0.042', cacheWrite: null },
    sortOrder: 318,
    defaultEffort: null,
  },
  {
    modelId: 'hy3-go',
    displayName: 'Hy3 (Go)',
    contextWindow: 192_000,
    supportsThinking: false,
    usd: { input: '0.14', output: '0.58', cacheRead: '0.035', cacheWrite: null },
    sortOrder: 319,
    defaultEffort: null,
  },
  {
    modelId: 'longcat-2.0-go',
    displayName: 'LongCat 2.0 (Go)',
    contextWindow: 1_000_000,
    supportsThinking: false,
    usd: { input: '0.30', output: '1.20', cacheRead: '0.006', cacheWrite: null },
    sortOrder: 320,
    defaultEffort: null,
  },
  {
    modelId: 'longcat-2.5-preview-free-go',
    displayName: 'LongCat 2.5 Preview Free (Go)',
    contextWindow: 1_000_000,
    supportsThinking: false,
    usd: { input: '0', output: '0', cacheRead: '0', cacheWrite: null },
    sortOrder: 321,
    defaultEffort: null,
  },
  {
    modelId: 'step-5-preview-free-go',
    displayName: 'Step 5 Preview Free (Go)',
    contextWindow: 1_000_000,
    supportsThinking: false,
    usd: { input: '0', output: '0', cacheRead: '0', cacheWrite: null },
    sortOrder: 322,
    defaultEffort: null,
  },
  // 2026-10-20 page (fetched 01:38 Taipei): paid Step 5 Preview and two limited-time free models.
  {
    modelId: 'step-5-preview-go',
    displayName: 'Step 5 Preview (Go)',
    contextWindow: 1_000_000,
    supportsThinking: false,
    usd: { input: '1.00', output: '2.70', cacheRead: '0.10', cacheWrite: null },
    sortOrder: 329,
    defaultEffort: null,
  },
  {
    modelId: 'minimax-m3.1-flash-free-go',
    displayName: 'MiniMax M3.1 Flash Free (Go)',
    contextWindow: 1_000_000,
    supportsThinking: false,
    usd: { input: '0', output: '0', cacheRead: '0', cacheWrite: null },
    sortOrder: 330,
    defaultEffort: null,
  },
  {
    modelId: 'beam-free-go',
    displayName: 'Beam Free (Go)',
    contextWindow: 1_048_576,
    supportsThinking: false,
    usd: { input: '0', output: '0', cacheRead: '0', cacheWrite: null },
    sortOrder: 331,
    defaultEffort: null,
  },
  // Phase 3 (Responses bridge). Grok ≤200K and Luna ≤272K tiers: windows capped at the boundary.
  {
    modelId: 'opencode-grok-4.7',
    displayName: 'Grok 4.7 (Go)',
    contextWindow: 200_000,
    supportsThinking: false,
    usd: { input: '2.00', output: '6.00', cacheRead: '0.50', cacheWrite: null },
    sortOrder: 323,
    defaultEffort: null,
  },
  {
    modelId: 'opencode-grok-4.6',
    displayName: 'Grok 4.6 (Go)',
    contextWindow: 200_000,
    supportsThinking: false,
    usd: { input: '2.00', output: '6.00', cacheRead: '0.50', cacheWrite: null },
    sortOrder: 324,
    defaultEffort: null,
  },
  {
    modelId: 'opencode-gpt-6-luna',
    displayName: 'GPT-6 Luna (Go)',
    contextWindow: 272_000,
    supportsThinking: false,
    usd: { input: '0.10', output: '0.50', cacheRead: '0.01', cacheWrite: '0.125' },
    sortOrder: 325,
    defaultEffort: null,
  },
  {
    modelId: 'opencode-gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna (Go)',
    contextWindow: 272_000,
    supportsThinking: false,
    usd: { input: '0.20', output: '1.20', cacheRead: '0.02', cacheWrite: '0.25' },
    sortOrder: 326,
    defaultEffort: null,
  },
  {
    modelId: 'muse-spark-1.3-go',
    displayName: 'Muse Spark 1.3 Contributor (Go)',
    contextWindow: 1_048_576,
    supportsThinking: false,
    usd: { input: '0.10', output: '0.20', cacheRead: '0.002', cacheWrite: null },
    sortOrder: 327,
    defaultEffort: null,
  },
  {
    modelId: 'muse-spark-1.2-go',
    displayName: 'Muse Spark 1.2 Contributor (Go)',
    contextWindow: 1_048_576,
    supportsThinking: false,
    usd: { input: '0.10', output: '0.20', cacheRead: '0.002', cacheWrite: null },
    sortOrder: 328,
    defaultEffort: null,
  },
]

export const GO_CATALOG_MODELS: readonly GoCatalogModel[] = rows.map((row) => {
  const upstreamModelId = OPENCODE_GO_EXTRA_MODELS[row.modelId]
  if (!upstreamModelId) throw new Error(`${row.modelId} is not in OPENCODE_GO_EXTRA_MODELS`)
  return { ...row, upstreamModelId }
})

/** USD decimal string → fen per the selfhost convention, in integer arithmetic. */
export function usdToFen(usd: string | null): number {
  if (usd === null) return 0
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd)
  if (!match) throw new Error(`bad USD price ${usd}`)
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'))
  const fen = Math.floor((micro * 100) / 2 / 1_000_000)
  return fen === 0 && micro > 0 ? 1 : fen
}

export function goPricingFen(model: GoCatalogModel) {
  return {
    input: usdToFen(model.usd.input),
    output: usdToFen(model.usd.output),
    cacheRead: usdToFen(model.usd.cacheRead),
    cacheWrite: usdToFen(model.usd.cacheWrite),
  }
}

export function goEfforts(upstreamModelId: string): readonly string[] {
  return staticProviderOutputConfigEfforts(getStaticProvider('opencodego'), upstreamModelId) ?? []
}

export function goCapabilityProfile(model: { upstreamModelId: string; supportsThinking: boolean }) {
  return {
    supports_vision: false,
    reasoning: { supported: [...goEfforts(model.upstreamModelId)], codex_model_default: null },
    ccb: { capability_zero: true, supports_thinking: model.supportsThinking },
  }
}

/** Gemini 4 keeps its OCV5-423 profile; only reasoning.supported gains its effort tiers. */
export const GEMINI_GO_MODEL_ID = 'gemini-4-argon-contributor'
export function geminiCapabilityProfile() {
  return {
    supports_vision: false,
    reasoning: { supported: [...goEfforts(GEMINI_GO_MODEL_ID)], codex_model_default: null },
    ccb: { capability_zero: true, supports_thinking: false },
  }
}
/** No effort keeps the bridge's previous fixed LOW. */
export const GEMINI_DEFAULT_EFFORT = 'low'

const ACTOR = 3
type Mode = 'on' | 'off'

interface LiveEntry {
  entry_id: string
  engine: string
  provider_id: string
  upstream_model_id: string | null
  context_window: number
  capability_profile: unknown
  capability_schema_version: number
  state: string
  lock_version: number
}

async function liveEntry(db: PoolClient, modelId: string): Promise<LiveEntry | null> {
  const r = await db.query<LiveEntry>(
    `SELECT entry_id::text, engine, provider_id, upstream_model_id, context_window, capability_profile,
       capability_schema_version, state, lock_version
     FROM model_catalog WHERE model_id=$1 AND state IN ('staged','active','disabled')
     ORDER BY (state='active') DESC, entry_id DESC FOR UPDATE`,
    [modelId],
  )
  if (r.rows.length > 1) throw new Error(`${modelId}: more than one live catalog entry`)
  return r.rows[0] ?? null
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const canonicalJson = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalJson)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value as object)
            .sort()
            .map((k) => [k, canonicalJson((value as Record<string, unknown>)[k])]),
        )
      : value

async function applyGoModel(db: PoolClient, model: (typeof GO_CATALOG_MODELS)[number], mode: Mode) {
  const on = mode === 'on'
  const off = mode === 'off'
  const profile = goCapabilityProfile(model)
  const fen = goPricingFen(model)
  const entry = await liveEntry(db, model.modelId)
  const price = (
    await db.query('SELECT * FROM model_pricing WHERE model_id=$1 FOR UPDATE', [model.modelId])
  ).rows[0]
  if (!entry) {
    if (off) return
    if (price) throw new Error(`${model.modelId}: refuses existing unbound pricing`)
    const alias = await db.query('SELECT 1 FROM model_aliases WHERE alias=$1', [model.modelId])
    if (alias.rowCount) throw new Error(`${model.modelId}: refuses existing alias`)
    const staged = await db.query<{ id: string }>(
      'SELECT fn_model_stage_version($1,$2,$3,$4,$5,$6::jsonb,$7,$8) AS id',
      [
        model.modelId,
        'ccb',
        'opencodego',
        model.upstreamModelId,
        model.contextWindow,
        JSON.stringify(profile),
        1,
        ACTOR,
      ],
    )
    await db.query('SELECT fn_model_activate_entry($1,0,$2)', [staged.rows[0]!.id, ACTOR])
    await db.query(
      `INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,cache_read_per_mtok,
         cache_write_per_mtok,multiplier,enabled,visibility,sort_order,default_effort,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,1,true,'public',$7,$8,$9)`,
      [
        model.modelId,
        model.displayName,
        fen.input,
        fen.output,
        fen.cacheRead,
        fen.cacheWrite,
        model.sortOrder,
        model.defaultEffort,
        ACTOR,
      ],
    )
    return
  }
  if (
    entry.engine !== 'ccb' ||
    entry.provider_id !== 'opencodego' ||
    entry.upstream_model_id !== model.upstreamModelId ||
    entry.context_window !== model.contextWindow ||
    !same(canonicalJson(entry.capability_profile), canonicalJson(profile)) ||
    entry.capability_schema_version !== 1
  )
    throw new Error(`${model.modelId}: refuses drifted catalog`)
  if (!price) throw new Error(`${model.modelId}: catalog entry without pricing`)
  if (
    Number(price.input_per_mtok) !== fen.input ||
    Number(price.output_per_mtok) !== fen.output ||
    Number(price.cache_read_per_mtok) !== fen.cacheRead ||
    Number(price.cache_write_per_mtok) !== fen.cacheWrite ||
    Number(price.multiplier) !== 1
  )
    throw new Error(`${model.modelId}: refuses drifted pricing`)
  if (on && entry.state !== 'active')
    await db.query('SELECT fn_model_activate_entry($1,$2,$3)', [
      entry.entry_id,
      entry.lock_version,
      ACTOR,
    ])
  if (off && entry.state === 'active')
    await db.query('SELECT fn_model_disable_entry($1,$2,$3)', [
      entry.entry_id,
      entry.lock_version,
      ACTOR,
    ])
  await db.query(
    `UPDATE model_pricing SET enabled=$2, visibility=$3, updated_by=$4, updated_at=clock_timestamp(),
       lock_version=lock_version+1 WHERE model_id=$1 AND (enabled IS DISTINCT FROM $2 OR visibility IS DISTINCT FROM $3)`,
    [model.modelId, on, on ? 'public' : 'hidden', ACTOR],
  )
}

async function applyGemini(db: PoolClient, mode: Mode) {
  const on = mode === 'on'
  const entry = await liveEntry(db, GEMINI_GO_MODEL_ID)
  if (!entry || entry.state !== 'active')
    throw new Error('Gemini 4 must have an active OCV5-423 entry')
  const target = geminiCapabilityProfile()
  const legacy = { ...target, reasoning: { supported: [], codex_model_default: null } }
  const current = canonicalJson(entry.capability_profile)
  const wanted = on ? target : legacy
  const other = on ? legacy : target
  if (
    entry.engine !== 'ccb' ||
    entry.provider_id !== 'opencodego' ||
    entry.upstream_model_id !== GEMINI_GO_MODEL_ID ||
    entry.context_window !== 1_000_000
  )
    throw new Error('Gemini 4: refuses drifted catalog')
  if (!same(current, canonicalJson(wanted))) {
    if (!same(current, canonicalJson(other)))
      throw new Error('Gemini 4: refuses unknown capability profile')
    await db.query('SELECT fn_model_switch_version($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)', [
      GEMINI_GO_MODEL_ID,
      'ccb',
      'opencodego',
      GEMINI_GO_MODEL_ID,
      1_000_000,
      JSON.stringify(wanted),
      1,
      ACTOR,
      entry.lock_version,
    ])
  }
  await db.query(
    `UPDATE model_pricing SET default_effort=$2, updated_by=$3, updated_at=clock_timestamp(), lock_version=lock_version+1
     WHERE model_id=$1 AND default_effort IS DISTINCT FROM $2`,
    [GEMINI_GO_MODEL_ID, on ? GEMINI_DEFAULT_EFFORT : null, ACTOR],
  )
}

export const OCV5_425_MODEL_IDS: readonly string[] = [
  GEMINI_GO_MODEL_ID,
  ...GO_CATALOG_MODELS.map((m) => m.modelId),
]

/** Apply in the caller's transaction. `database` is the only DB name accepted. */
export async function applyGoCatalog(
  db: PoolClient,
  mode: Mode,
  database = 'openclaude_v5_selfhost',
) {
  const current = await db.query('SELECT current_database() AS db')
  if (current.rows[0]?.db !== database) throw new Error('OCV5-425 refuses any other database')
  await db.query("SELECT pg_advisory_xact_lock(hashtext('ocv5-425-go-catalog'))")
  await applyGemini(db, mode)
  for (const model of GO_CATALOG_MODELS) await applyGoModel(db, model, mode)
}

export async function readGoCatalog(db: PoolClient) {
  const result = await db.query(
    `SELECT c.model_id,c.upstream_model_id,c.context_window,c.state,c.capability_profile->'reasoning'->'supported' AS efforts,
       c.capability_profile->'ccb'->'supports_thinking' AS thinking, p.enabled,p.visibility,p.input_per_mtok,p.output_per_mtok,
       p.cache_read_per_mtok,p.cache_write_per_mtok,p.default_effort,p.sort_order
     FROM model_catalog c JOIN model_pricing p USING(model_id)
     WHERE c.model_id = ANY($1) AND c.state IN ('active','disabled','staged') ORDER BY p.sort_order, c.model_id`,
    [OCV5_425_MODEL_IDS],
  )
  return result.rows
}
