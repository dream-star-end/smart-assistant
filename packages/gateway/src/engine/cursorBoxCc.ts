/** Grok Bot box-resident official Claude Code, selected through the Cursor account pool.
 * The pool still picks the account. This module only decides when that
 * account's sandbox should own the CLI, and how stdin/stdout cross the exec
 * daemon without putting the user line on the command line. */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CursorCredentialSelection } from './cursorCredentialSelection.js'
import { readCursorApiKey } from './cursorSandRelay.js'
import {
  CursorSandBoxResolver,
  type CursorSandBoxPolicy,
} from './cursorSandBox.js'
import {
  BOX_CC_CWD,
  BOX_CC_REMOTE_CLAUDE,
  type BoxCcControl,
} from './cursorBoxCcExec.js'

export {
  BOX_CC_CWD,
  BOX_CC_HOME,
  BOX_CC_LAUNCH_SCRIPT,
  BOX_CC_REMOTE_CLAUDE,
  BOX_CC_WRITE_SCRIPT,
  boxCcControlSummary,
  boxCcLaunchExec,
  boxCcSpawnFifo,
  boxCcWriteExec,
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
  return selection.sandEnabled
    && selection.credentialKind === 'session'
    && selection.machineId !== null
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
 * The box process uses the login the user configures inside the box. */
export function stripBoxCcParentAuth(
  env: Record<string, string>,
  controlPath: string,
): Record<string, string> {
  const next = { ...env }
  for (const key of STRIPPED_PARENT_AUTH) delete next[key]
  next.OC_BOX_CC_CONTROL = controlPath
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
}): Promise<string> {
  if (!cursorBoxCcSelectionEligible(input.selection)) {
    throw new Error('BOX_CC_SESSION_REQUIRED')
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
  }
  const dir = input.dir ?? join(tmpdir(), 'oc-box-cc')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `control-${createHash('sha256').update(input.sessionKey).digest('hex').slice(0, 12)}.json`)
  writeFileSync(path, JSON.stringify(control), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function bridgeDirForLogs(): string {
  return dirname(boxCcBridgePath())
}
