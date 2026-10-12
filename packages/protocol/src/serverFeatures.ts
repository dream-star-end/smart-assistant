/**
 * Server-side feature flags that the web UI needs to see.
 *
 * Flags are env predicates on the selfhost master. The master forwards each one
 * that is on into the user container (`serverFeatureContainerEnv`), and the
 * container gateway serves them at `GET /api/features` (proxied by the master
 * like the other per-user container routes). The web reads them once per login
 * and treats anything it cannot read as off.
 *
 * Adding a flag: add it to SERVER_FEATURE_ENV. The master forwarding, the
 * container route and the web parser all derive from this table.
 */

export const SERVER_FEATURE_ENV = {
  /** P5b: 「记住这条 / 存为项目技能」 on finished assistant messages. */
  chips: 'OC_P5_CHIPS',
  /** P5c: one-click scheduled recipes on the project home. */
  recipeSchedule: 'OC_P5_RECIPE_SCHEDULE',
  /** P5: suggest a project for unfiled chats (used by a later change). */
  unfiledSuggest: 'OC_P5_UNFILED_SUGGEST',
} as const

export type ServerFeatureKey = keyof typeof SERVER_FEATURE_ENV
export type ServerFeatures = Readonly<Record<ServerFeatureKey, boolean>>

const KEYS = Object.keys(SERVER_FEATURE_ENV) as ServerFeatureKey[]

export const SERVER_FEATURES_OFF: ServerFeatures = Object.freeze(
  Object.fromEntries(KEYS.map((k) => [k, false])) as Record<ServerFeatureKey, boolean>,
)

/** 1 / true / yes / on (case-insensitive, trimmed) are on; anything else is off. */
export function isEnvFlagOn(value: string | undefined | null): boolean {
  const v = (value ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

export function readServerFeatures(
  env: Readonly<Record<string, string | undefined>>,
): ServerFeatures {
  return Object.fromEntries(
    KEYS.map((k) => [k, isEnvFlagOn(env[SERVER_FEATURE_ENV[k]])]),
  ) as Record<ServerFeatureKey, boolean>
}

/** Container env entries the master adds for flags that are on (`OC_P5_CHIPS=1`, …). */
export function serverFeatureContainerEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return KEYS.filter((k) => isEnvFlagOn(env[SERVER_FEATURE_ENV[k]])).map(
    (k) => `${SERVER_FEATURE_ENV[k]}=1`,
  )
}

/**
 * Parse a `GET /api/features` body. Fails closed: only a literal `true` under
 * `features.<key>` turns a flag on; unknown keys are ignored.
 */
export function parseServerFeatures(body: unknown): ServerFeatures {
  const raw =
    body && typeof body === 'object' ? (body as { features?: unknown }).features : undefined
  if (!raw || typeof raw !== 'object') return SERVER_FEATURES_OFF
  const r = raw as Record<string, unknown>
  return Object.fromEntries(KEYS.map((k) => [k, r[k] === true])) as Record<
    ServerFeatureKey,
    boolean
  >
}
