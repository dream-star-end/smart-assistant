/** Cursor account-pool credential selection shared by native and Sand routes.
 * The existing root-owned oc-cursor wrapper remains the single authority for
 * quota-class filtering, rotation and per-key Sand metadata. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cursorModelById } from '@openclaude/protocol'
import { paths } from '@openclaude/storage'
import { probeEnvFacts } from '../envProbe.js'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'cursorCredentialSelection' })
const HOT_WRAPPER = '/run/oc/platform/current/bin/oc-cursor'
const IMAGE_WRAPPER = '/usr/local/bin/oc-cursor'
const KEY_NAME_SOURCE = String.raw`api-key(?:\.(?:[2-9]|[1-9][0-9]+))?`
const KEY_NAME_RE = new RegExp(`^${KEY_NAME_SOURCE}$`)
// 0257 — trailing `<api_key|session> <machineId|->` columns are optional so a
// pre-0257 wrapper build (no .credential-kind support) still parses as api_key.
const SELECTION_RE = new RegExp(
  `^oc-cursor: selected_slot ([1-9][0-9]*) (${KEY_NAME_SOURCE}) (sand|native) (legacy|gen-[0-9a-f]{24}) ([0-9]+) ([0-9a-f]{16})(?: (api_key|session) (-|[a-z0-9]{16,64}))?$`,
  'm',
)

export type CursorCredentialKind = 'api_key' | 'session'

export interface CursorCredentialSelection {
  slot: number
  keyName: string
  sandEnabled: boolean
  poolGeneration: string
  accountId: string
  keyFingerprint: string
  /** `session` slots hold a Cursor account session accessToken (Sand-only). */
  credentialKind: CursorCredentialKind
  /** Persisted Cursor machine id for `session` slots; null for `api_key`. */
  machineId: string | null
}

function wrapperBin(): string {
  const override = process.env.OC_CURSOR_WRAPPER_BIN?.trim()
  if (override) return override
  return existsSync(HOT_WRAPPER) ? HOT_WRAPPER : IMAGE_WRAPPER
}

/** Container owner uid for the wrapper's sticky per-user Sand slot selection.
 * Not a secret (a plain integer the sandbox supervisor injects); resolved via
 * the env probe so a hollowed process env still falls back to PID 1. */
export function cursorSelectionUserId(
  env: NodeJS.ProcessEnv = process.env,
  facts: () => { uid: string | null } = probeEnvFacts,
): string | null {
  const direct = env.OC_USER_ID?.trim() ?? ''
  if (/^\d{1,12}$/.test(direct)) return direct
  try {
    return facts().uid
  } catch {
    return null
  }
}

function selectorEnv(
  agentId: string,
  sessionKey: string,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/run/oc/platform/current/bin:/usr/local/bin:/usr/bin:/bin',
    OPENCLAUDE_HOME: paths.home,
    OC_AGENT_ID: agentId,
    OC_SESSION_KEY: sessionKey,
    ...extra,
  }
  const userId = cursorSelectionUserId()
  if (userId) env.OC_USER_ID = userId
  for (const key of ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function modelArgs(modelId: string | undefined): string[] {
  const model = cursorModelById(modelId)
  if (!model) throw new Error(`CURSOR_CREDENTIAL_MODEL_NOT_ALLOWED:${String(modelId)}`)
  return model.upstreamModel === null ? [] : ['--model', model.upstreamModel]
}

export function selectCursorCredential(opts: {
  agentId: string
  sessionKey: string
  agentBaseDir: string
  model: string | undefined
}): CursorCredentialSelection {
  const result = spawnSync(
    wrapperBin(),
    [...modelArgs(opts.model), '--', '__openclaude_cursor_select__'],
    {
      cwd: existsSync(opts.agentBaseDir) ? opts.agentBaseDir : process.cwd(),
      env: selectorEnv(opts.agentId, opts.sessionKey, { OPENCLAUDE_CURSOR_SELECT_ONLY: '1' }),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  )
  const matched = SELECTION_RE.exec(result.stdout ?? '')
  if (result.status !== 0 || !matched) {
    const detail = String(result.stderr ?? '').trim().split(/\r?\n/).slice(-1)[0] ?? 'unknown'
    throw new Error(`CURSOR_CREDENTIAL_SELECTION_FAILED:${detail.slice(0, 240)}`)
  }
  const slot = Number(matched[1])
  const keyName = matched[2]
  if (!Number.isSafeInteger(slot) || slot < 1 || !KEY_NAME_RE.test(keyName)) {
    throw new Error('CURSOR_CREDENTIAL_SELECTION_MALFORMED')
  }
  const sandEnabled = matched[3] === 'sand'
  const credentialKind: CursorCredentialKind = matched[7] === 'session' ? 'session' : 'api_key'
  const machineId = credentialKind === 'session' && matched[8] && matched[8] !== '-' ? matched[8] : null
  // The wrapper already fails closed on these, but the gateway must not trust
  // a half-formed line: a session slot is only usable on the Sand plane and
  // only with its persisted machine id.
  if (credentialKind === 'session' && (!sandEnabled || machineId === null)) {
    throw new Error('CURSOR_CREDENTIAL_SELECTION_MALFORMED')
  }
  return {
    slot,
    keyName,
    sandEnabled,
    poolGeneration: matched[4],
    accountId: matched[5],
    keyFingerprint: matched[6],
    credentialKind,
    machineId,
  }
}

export function recordCursorCredentialResult(opts: {
  agentId: string
  sessionKey: string
  agentBaseDir: string
  model: string | undefined
  selection: CursorCredentialSelection
  result: 'ok' | 'fail'
}): void {
  if (!KEY_NAME_RE.test(opts.selection.keyName)) return
  const recorded = spawnSync(
    wrapperBin(),
    [...modelArgs(opts.model), '--', '__openclaude_cursor_record__'],
    {
      cwd: existsSync(opts.agentBaseDir) ? opts.agentBaseDir : process.cwd(),
      env: selectorEnv(opts.agentId, opts.sessionKey, {
        OPENCLAUDE_CURSOR_SELECTED_KEY: opts.selection.keyName,
        OPENCLAUDE_CURSOR_POOL_GENERATION: opts.selection.poolGeneration,
        OPENCLAUDE_CURSOR_ACCOUNT_ID: opts.selection.accountId,
        OPENCLAUDE_CURSOR_KEY_FINGERPRINT: opts.selection.keyFingerprint,
        OPENCLAUDE_CURSOR_RECORD_RESULT: opts.result,
      }),
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  )
  if (recorded.status !== 0) {
    log.warn('cursor credential result recorder failed', {
      slot: opts.selection.slot,
      result: opts.result,
      status: recorded.status,
    })
  }
}

export function cursorSandEnabledForSelection(
  modelId: string | undefined,
  selection: CursorCredentialSelection,
): boolean {
  const model = cursorModelById(modelId)
  // Cursor Auto is a CLI-side router, not a concrete InferenceService model.
  return selection.sandEnabled && model?.upstreamModel !== null && model !== undefined
}
