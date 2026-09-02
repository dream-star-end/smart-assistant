/** Cursor account-pool credential selection shared by native and Sand routes.
 * The existing root-owned oc-cursor wrapper remains the single authority for
 * quota-class filtering, rotation and per-key Sand metadata. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cursorModelById } from '@openclaude/protocol'
import { paths } from '@openclaude/storage'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'cursorCredentialSelection' })
const HOT_WRAPPER = '/run/oc/platform/current/bin/oc-cursor'
const IMAGE_WRAPPER = '/usr/local/bin/oc-cursor'
const KEY_NAME_SOURCE = String.raw`api-key(?:\.(?:[2-9]|[1-9][0-9]+))?`
const KEY_NAME_RE = new RegExp(`^${KEY_NAME_SOURCE}$`)
const SELECTION_RE = new RegExp(
  `^oc-cursor: selected_slot ([1-9][0-9]*) (${KEY_NAME_SOURCE}) (sand|native) (legacy|gen-[0-9a-f]{24}) ([0-9]+) ([0-9a-f]{16})$`,
  'm',
)

export interface CursorCredentialSelection {
  slot: number
  keyName: string
  sandEnabled: boolean
  poolGeneration: string
  accountId: string
  keyFingerprint: string
}

function wrapperBin(): string {
  const override = process.env.OC_CURSOR_WRAPPER_BIN?.trim()
  if (override) return override
  return existsSync(HOT_WRAPPER) ? HOT_WRAPPER : IMAGE_WRAPPER
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
  return {
    slot,
    keyName,
    sandEnabled: matched[3] === 'sand',
    poolGeneration: matched[4],
    accountId: matched[5],
    keyFingerprint: matched[6],
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
