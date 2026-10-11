/** Grok Bot box-resident official Claude Code, selected through the Cursor account pool.
 * The pool still picks the account. This module only decides when that
 * account's sandbox should own the CLI, and how stdin/stdout cross the exec
 * daemon without putting the user line on the command line. */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BoxExecTargetError, boxLoginUrlFromEnv, requestBoxExecTarget, type BoxExecTargetFromMaster } from './boxLoginClient.js'
import type { CursorCredentialSelection } from './cursorCredentialSelection.js'
import { readCursorApiKey } from './cursorSandRelay.js'
import {
  CursorSandBoxResolver,
  type CursorSandBoxPolicy,
} from './cursorSandBox.js'
import {
  BOX_CC_CWD,
  BOX_CC_REMOTE_CLAUDE,
  isBoxClaudeCatalogModel,
  type BoxCcControl,
} from './cursorBoxCcExec.js'

export {
  BOX_CC_CWD,
  BOX_CC_HOME,
  BOX_CC_LAUNCH_SCRIPT,
  BOX_CC_REMOTE_CLAUDE,
  BOX_CC_STOP_SCRIPT,
  BOX_CC_WRITE_SCRIPT,
  boxCcControlSummary,
  boxCcLaunchExec,
  boxCcSpawnFifo,
  boxCcStopExec,
  boxCcWriteExecs,
  boxOfficialClaudeModel,
  encodeExecRequest,
  isBoxClaudeCatalogModel,
  parseExecFrames,
  remoteClaudeArgs,
  type BoxCcControl,
  type BoxCcExecRequest,
  type ExecFrame,
} from './cursorBoxCcExec.js'

export function cursorBoxCcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_CURSOR_SAND_BOX_CC === '1'
}

/** Session slots are the logged-in Cursor accounts that own a Grok Bot box.
 * API-key slots stay on the existing in-container Sand loop. */
export function cursorBoxCcSelectionEligible(selection: CursorCredentialSelection): boolean {
  if (selection.masterBox === true) return true
  return selection.sandEnabled
    && selection.credentialKind === 'session'
    && selection.machineId !== null
}

/** An interactive Box session (box-claude-*) on this container gets its Box from the master
 * (masterBoxCredentialSelection) instead of a pool slot: Box exec needs only the account's own
 * credential and egress, which the master holds; the container pool additionally requires the Sand
 * relay to be installed. Needs the container's master route; otherwise the pool path stays. */
export function cursorBoxCcFromMaster(model: string | undefined, remote: boolean,
  env: NodeJS.ProcessEnv = process.env): boolean {
  return !remote && cursorBoxCcEnabled(env) && isBoxClaudeCatalogModel(model) && boxLoginUrlFromEnv(env) !== null
}

export function boxCcFifoPath(sessionKey: string): string {
  const id = createHash('sha256').update(sessionKey).digest('hex').slice(0, 16)
  return `/tmp/oc-box-cc-${id}.fifo`
}

export function boxCcBridgePath(): string {
  const self = fileURLToPath(import.meta.url)
  return self.replace(/cursorBoxCc\.(ts|js)$/, 'cursorBoxCcBridge.$1')
}

const STRIPPED_PARENT_AUTH = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
] as const

/** The local bridge must not inherit the container's Anthropic route.
 * The box process uses the login the user configures inside the box.
 * Every Box Claude turn runs the interactive session (operator rule 2026-10-11:
 * Box Claude logins never serve product turns through `claude -p`). The bridge
 * keeps only the master's Box login endpoint, derived here before the route is
 * stripped, so it can ask which login to launch under and report its windows. */
export function stripBoxCcParentAuth(
  env: Record<string, string>,
  controlPath: string,
): Record<string, string> {
  const loginUrl = boxLoginUrlFromEnv(env)
  const next = { ...env }
  // An inherited login endpoint is never trusted: only the one derived above.
  for (const key of [...STRIPPED_PARENT_AUTH, 'OC_BOX_LOGIN_URL']) delete next[key]
  next.OC_BOX_CC_CONTROL = controlPath
  next.OC_BOX_CC_RUNNER = 'interactive'
  if (loginUrl) next.OC_BOX_LOGIN_URL = loginUrl
  return next
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export async function writeBoxCcControlFile(input: {
  selection: CursorCredentialSelection
  sessionKey: string
  dir?: string
  fetchImpl?: FetchFn
  readPolicy?: () => CursorSandBoxPolicy | null
  readToken?: () => Buffer
  /** The master's Box exec endpoint (tests); default: boxLoginClient.requestBoxExecTarget. */
  requestExecTarget?: () => Promise<BoxExecTargetFromMaster>
  retryDelayMs?: number
}): Promise<string> {
  if (!cursorBoxCcSelectionEligible(input.selection)) {
    throw new Error('BOX_CC_SESSION_REQUIRED')
  }
  if (input.selection.masterBox === true) {
    const ask = input.requestExecTarget ?? (() => requestBoxExecTarget())
    let target: BoxExecTargetFromMaster
    try {
      target = await ask()
    } catch (err) {
      // A Cursor control hiccup on the master's side is worth one more try before the turn fails;
      // an entitlement refusal is final.
      if (!(err instanceof BoxExecTargetError) || err.code !== 'BOX_EXEC_TARGET_UNAVAILABLE') throw err
      await new Promise((r) => setTimeout(r, input.retryDelayMs ?? 1_000))
      target = await ask()
    }
    return writeControl({
      execUrl: target.execUrl,
      execToken: target.execToken,
      networkToken: target.networkToken,
      remoteClaude: BOX_CC_REMOTE_CLAUDE,
      fifo: boxCcFifoPath(input.sessionKey),
      cwd: BOX_CC_CWD,
      accountId: target.accountId,
    }, input.sessionKey, input.dir)
  }
  const generation = input.selection.poolGeneration.startsWith('gen-')
    ? input.selection.poolGeneration
    : undefined
  const token = (input.readToken ?? (() => readCursorApiKey(
    input.selection.keyName,
    generation,
    input.selection.keyFingerprint,
  )))().toString('utf8').trim()
  const resolver = new CursorSandBoxResolver({
    accountId: input.selection.accountId,
    credentialKind: 'session',
    fetchImpl: input.fetchImpl ?? fetch,
    ...(input.readPolicy ? { readPolicy: input.readPolicy } : {}),
  })
  const execTarget = await resolver.resolveExec(
    token,
    input.selection.machineId as string,
    new AbortController().signal,
  )
  const control: BoxCcControl = {
    execUrl: execTarget.execUrl,
    execToken: execTarget.execToken,
    networkToken: execTarget.networkToken,
    remoteClaude: BOX_CC_REMOTE_CLAUDE,
    fifo: boxCcFifoPath(input.sessionKey),
    cwd: BOX_CC_CWD,
    // Which Cursor account's Box logins the bridge asks the master to choose from.
    accountId: input.selection.accountId,
  }
  return writeControl(control, input.sessionKey, input.dir)
}

function writeControl(control: BoxCcControl, sessionKey: string, dirOverride: string | undefined): string {
  const dir = dirOverride ?? join(tmpdir(), 'oc-box-cc')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `control-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 12)}.json`)
  writeFileSync(path, JSON.stringify(control), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function bridgeDirForLogs(): string {
  return dirname(boxCcBridgePath())
}
