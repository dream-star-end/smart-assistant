/**
 * CCB spawn wiring oracle: bind the unique spawnOpts inside the real start
 * path, and run a real default LocalBackend child that prints whitelist env.
 * Not a generic reviewer — only the session/trace spawn contract.
 */
import './subprocessRunnerSpawnEnvIsolate.js'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  SubprocessRunner,
  __setCcbSpawnForTests,
} from '../../subprocessRunner.js'

const FIXTURE_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'ccb-spawn-env-probe.js',
)
const FIXTURE_DIR = dirname(FIXTURE_ENTRY)

export const PARENT_WRONG = {
  OC_SESSION_KEY: 'a9-parent-oc-session',
  OPENCLAUDE_SESSION_KEY: 'a9-parent-openclaude-session',
  OPENCLAUDE_TRACE_ID: 'a9-parent-trace',
} as const

export const PROVIDER_WRONG = {
  OC_SESSION_KEY: 'a9-provider-oc-session',
  OPENCLAUDE_SESSION_KEY: 'a9-provider-openclaude-session',
  OPENCLAUDE_TRACE_ID: 'a9-provider-trace',
  OCV5_A9_CASE: '',
} as const

export type CcbSpawnWiring = {
  startMethodName: string
  spawnOptsName: string
  providerSpreadIndex: number
  ocSessionKeyIndex: number
  openclaudeSessionKeyIndex: number
  ocSessionKeyCount: number
  traceHelperSpreadIndex: number
  traceHelperSpreadCount: number
}

export class SpawnWiringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpawnWiringError'
  }
}

export type SpawnEnvProbe = {
  marker: string
  pid: number
  ppid: number
  case: string
  OC_SESSION_KEY: string | null
  OPENCLAUDE_SESSION_KEY: string | null
  OPENCLAUDE_TRACE_ID: string | null
  OPENCLAUDE_TRACE_ID_PRESENT: boolean
}

function methodName(member: ts.ClassElement): string | undefined {
  if (!ts.isMethodDeclaration(member) || !member.name) return undefined
  if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isPrivateIdentifier(member.name)) {
    return member.name.text
  }
  return undefined
}

function containingMethod(node: ts.Node): ts.MethodDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isMethodDeclaration(cur)) return cur
    if (ts.isClassDeclaration(cur) || ts.isSourceFile(cur)) return undefined
    cur = cur.parent
  }
  return undefined
}

function containingClass(node: ts.Node): ts.ClassDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isClassDeclaration(cur)) return cur
    if (ts.isSourceFile(cur)) return undefined
    cur = cur.parent
  }
  return undefined
}

function className(cls: ts.ClassDeclaration): string | undefined {
  return cls.name?.text
}

function isThisOptsAccess(expr: ts.Expression, field: string): boolean {
  return (
    ts.isPropertyAccessExpression(expr)
    && expr.name.text === field
    && ts.isPropertyAccessExpression(expr.expression)
    && expr.expression.name.text === 'opts'
    && expr.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  )
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function isIdentifierNamed(expr: ts.Expression, name: string): boolean {
  return ts.isIdentifier(expr) && expr.text === name
}

function isTraceHelperCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false
  if (!isIdentifierNamed(expr.expression, '_buildCcbSpawnTraceEnv')) return false
  if (expr.arguments.length !== 1) return false
  return isThisOptsAccess(expr.arguments[0]!, 'traceId')
}

function isBackendSpawnOf(expr: ts.Expression, spawnOptsName: string): expr is ts.CallExpression {
  if (!ts.isCallExpression(expr)) return false
  if (expr.arguments.length !== 1) return false
  if (!isIdentifierNamed(expr.arguments[0]!, spawnOptsName)) return false
  if (!ts.isPropertyAccessExpression(expr.expression)) return false
  if (expr.expression.name.text !== 'spawn') return false
  return isIdentifierNamed(expr.expression.expression, 'backend')
}

function startCallsInternal(startMethod: ts.MethodDeclaration): boolean {
  let ok = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      && ts.isIdentifier(node.expression.name)
      && node.expression.name.text === '_startInternal'
    ) {
      ok = true
    }
    ts.forEachChild(node, visit)
  }
  if (startMethod.body) visit(startMethod.body)
  return ok
}

function defaultBackendSpawnCount(method: ts.MethodDeclaration, spawnOptsName: string): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node) && isBackendSpawnOf(node.whenFalse, spawnOptsName)) {
      count += 1
    }
    if (
      ts.isIfStatement(node)
      && node.elseStatement
      && ts.isExpressionStatement(node.elseStatement)
      && isBackendSpawnOf(node.elseStatement.expression, spawnOptsName)
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  if (method.body) visit(method.body)
  return count
}

export function inspectCcbSpawnWiring(
  source: string,
): { ok: true; wiring: CcbSpawnWiring } | { ok: false; reason: string } {
  const sf = ts.createSourceFile(
    'subprocessRunner.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

  const runnerClasses: ts.ClassDeclaration[] = []
  const visitClasses = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && className(node) === 'SubprocessRunner') {
      runnerClasses.push(node)
    }
    ts.forEachChild(node, visitClasses)
  }
  visitClasses(sf)
  if (runnerClasses.length !== 1) {
    return { ok: false, reason: `expected exactly one SubprocessRunner class, got ${runnerClasses.length}` }
  }
  const runnerClass = runnerClasses[0]!

  const methods = new Map<string, ts.MethodDeclaration>()
  for (const member of runnerClass.members) {
    const name = methodName(member)
    if (!name || !ts.isMethodDeclaration(member)) continue
    if (methods.has(name)) {
      return { ok: false, reason: `SubprocessRunner method ${name} is ambiguous` }
    }
    methods.set(name, member)
  }
  const startMethod = methods.get('start')
  if (!startMethod) return { ok: false, reason: 'SubprocessRunner.start() not found' }

  const spawnOptsDecls: ts.VariableDeclaration[] = []
  const visitDecls = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'spawnOpts') {
      const cls = containingClass(node)
      const method = containingMethod(node)
      if (cls === runnerClass && method) spawnOptsDecls.push(node)
    }
    ts.forEachChild(node, visitDecls)
  }
  visitDecls(runnerClass)
  if (spawnOptsDecls.length !== 1) {
    return {
      ok: false,
      reason: `expected unique spawnOpts in SubprocessRunner start path, got ${spawnOptsDecls.length}`,
    }
  }
  const spawnOptsDecl = spawnOptsDecls[0]!
  const owner = containingMethod(spawnOptsDecl)
  if (!owner) return { ok: false, reason: 'spawnOpts is not inside a method' }
  const ownerName = methodName(owner)
  if (ownerName !== 'start' && ownerName !== '_startInternal') {
    return { ok: false, reason: `spawnOpts is in ${ownerName ?? '<unknown>'}, not the start path` }
  }
  if (ownerName === '_startInternal' && !startCallsInternal(startMethod)) {
    return { ok: false, reason: 'start() does not call _startInternal(); spawnOpts is not on the real start path' }
  }

  const init = spawnOptsDecl.initializer
  if (!init || !ts.isObjectLiteralExpression(init)) {
    return { ok: false, reason: 'spawnOpts initializer is not an object literal' }
  }

  const envProp = init.properties.find((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false
    return propertyNameText(prop.name) === 'env'
  })
  if (!envProp || !ts.isPropertyAssignment(envProp) || !ts.isObjectLiteralExpression(envProp.initializer)) {
    return { ok: false, reason: 'spawnOpts.env object literal not found' }
  }

  let providerSpreadIndex = -1
  let ocSessionKeyIndex = -1
  let openclaudeSessionKeyIndex = -1
  let ocSessionKeyCount = 0
  const traceHelperSpreadIndices: number[] = []
  let ocSessionFromSessionKey = false
  let openclaudeSessionFromSessionKey = false

  envProp.initializer.properties.forEach((prop, index) => {
    if (ts.isSpreadAssignment(prop)) {
      if (isIdentifierNamed(prop.expression, 'finalizedProviderEnv')) {
        providerSpreadIndex = index
      }
      if (isTraceHelperCall(prop.expression)) {
        traceHelperSpreadIndices.push(index)
      }
      return
    }
    if (!ts.isPropertyAssignment(prop)) return
    const name = propertyNameText(prop.name)
    if (name === 'OC_SESSION_KEY') {
      ocSessionKeyCount += 1
      ocSessionKeyIndex = index
      ocSessionFromSessionKey = isThisOptsAccess(prop.initializer, 'sessionKey')
    }
    if (name === 'OPENCLAUDE_SESSION_KEY') {
      openclaudeSessionKeyIndex = index
      openclaudeSessionFromSessionKey = isThisOptsAccess(prop.initializer, 'sessionKey')
    }
  })

  if (providerSpreadIndex < 0) {
    return { ok: false, reason: 'spawnOpts.env does not spread finalizedProviderEnv' }
  }
  if (ocSessionKeyCount !== 1) {
    return { ok: false, reason: `OC_SESSION_KEY must appear exactly once in spawnOpts.env (got ${ocSessionKeyCount})` }
  }
  if (ocSessionKeyIndex < 0 || openclaudeSessionKeyIndex < 0) {
    return { ok: false, reason: 'session alias properties missing from spawnOpts.env' }
  }
  if (!ocSessionFromSessionKey || !openclaudeSessionFromSessionKey) {
    return { ok: false, reason: 'session aliases must both be this.opts.sessionKey' }
  }
  if (ocSessionKeyIndex <= providerSpreadIndex || openclaudeSessionKeyIndex <= providerSpreadIndex) {
    return { ok: false, reason: 'finalizedProviderEnv must spread before both session aliases' }
  }
  if (traceHelperSpreadIndices.length !== 1) {
    return {
      ok: false,
      reason: `spawnOpts.env must directly spread _buildCcbSpawnTraceEnv(this.opts.traceId) exactly once (got ${traceHelperSpreadIndices.length})`,
    }
  }

  const spawnCount = defaultBackendSpawnCount(owner, 'spawnOpts')
  if (spawnCount !== 1) {
    return {
      ok: false,
      reason: `default backend.spawn(spawnOpts) must appear exactly once in ${ownerName} (got ${spawnCount})`,
    }
  }

  return {
    ok: true,
    wiring: {
      startMethodName: ownerName,
      spawnOptsName: 'spawnOpts',
      providerSpreadIndex,
      ocSessionKeyIndex,
      openclaudeSessionKeyIndex,
      ocSessionKeyCount,
      traceHelperSpreadIndex: traceHelperSpreadIndices[0]!,
      traceHelperSpreadCount: 1,
    },
  }
}

export function assertCcbSpawnWiring(source: string): CcbSpawnWiring {
  const result = inspectCcbSpawnWiring(source)
  if (!result.ok) throw new SpawnWiringError(result.reason)
  return result.wiring
}

function replaceOnce(source: string, needle: string, replacement: string, label: string): string {
  const idx = source.indexOf(needle)
  if (idx < 0) throw new Error(`${label}: needle not found`)
  if (source.indexOf(needle, idx + needle.length) >= 0) throw new Error(`${label}: needle is not unique`)
  return source.slice(0, idx) + replacement + source.slice(idx + needle.length)
}

const TRACE_SPREAD = '..._buildCcbSpawnTraceEnv(this.opts.traceId),'
const PROVIDER_THEN_ALIASES = [
  '          ...finalizedProviderEnv,',
  '          OC_SESSION_KEY: this.opts.sessionKey,',
  '          OPENCLAUDE_SESSION_KEY: this.opts.sessionKey,',
].join('\n')
const ALIASES_THEN_PROVIDER = [
  '          OC_SESSION_KEY: this.opts.sessionKey,',
  '          OPENCLAUDE_SESSION_KEY: this.opts.sessionKey,',
  '          ...finalizedProviderEnv,',
].join('\n')

export function variantDeleteTraceHelper(source: string): string {
  return replaceOnce(source, TRACE_SPREAD, '', 'delete-trace-helper')
}

export function variantDuplicateTraceHelper(source: string): string {
  return replaceOnce(source, TRACE_SPREAD, `${TRACE_SPREAD}\n          ${TRACE_SPREAD}`, 'duplicate-trace-helper')
}

export function variantWrongSessionAlias(source: string): string {
  return replaceOnce(
    source,
    'OC_SESSION_KEY: this.opts.sessionKey,',
    'OC_SESSION_KEY: this.opts.sessionId,',
    'wrong-session-alias',
  )
}

export function variantProviderAfterSession(source: string): string {
  return replaceOnce(source, PROVIDER_THEN_ALIASES, ALIASES_THEN_PROVIDER, 'provider-after-session')
}

function parseProbeLine(line: string): SpawnEnvProbe | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const row = parsed as Record<string, unknown>
  if (row.marker !== 'OCV5-213-A9-SPAWN-ENV') return null
  if (typeof row.pid !== 'number' || typeof row.ppid !== 'number') return null
  if (typeof row.case !== 'string') return null
  if (typeof row.OPENCLAUDE_TRACE_ID_PRESENT !== 'boolean') return null
  const asStringOrNull = (value: unknown): string | null => {
    if (value === null) return null
    if (typeof value === 'string') return value
    return null
  }
  return {
    marker: 'OCV5-213-A9-SPAWN-ENV',
    pid: row.pid,
    ppid: row.ppid,
    case: row.case,
    OC_SESSION_KEY: asStringOrNull(row.OC_SESSION_KEY),
    OPENCLAUDE_SESSION_KEY: asStringOrNull(row.OPENCLAUDE_SESSION_KEY),
    OPENCLAUDE_TRACE_ID: asStringOrNull(row.OPENCLAUDE_TRACE_ID),
    OPENCLAUDE_TRACE_ID_PRESENT: row.OPENCLAUDE_TRACE_ID_PRESENT,
  }
}

function waitForProbe(
  runner: SubprocessRunner,
  caseMarker: string,
  timeoutMs = 8_000,
  signal?: AbortSignal,
): Promise<SpawnEnvProbe> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stderr = ''
    const timer = setTimeout(() => {
      finish(new Error(`timed out waiting for spawn env probe case=${caseMarker}; stderr=${stderr.slice(0, 800)}`))
    }, timeoutMs)
    const onAbort = () => finish(new Error(`aborted spawn env probe case=${caseMarker}; stderr=${stderr.slice(0, 800)}`))
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (err: Error | null, value?: SpawnEnvProbe) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      runner.off('stderr', onStderr)
      runner.off('exit', onExit)
      runner.off('error', onError)
      if (err) reject(err)
      else resolve(value!)
    }
    const consider = (chunk: string) => {
      stderr += chunk
      for (const line of stderr.split('\n')) {
        const probe = parseProbeLine(line)
        if (probe && probe.case === caseMarker) {
          finish(null, probe)
          return
        }
      }
    }
    const onStderr = (...args: unknown[]) => consider(String(args[0] ?? ''))
    const onExit = (...args: unknown[]) => {
      const info = (args[0] ?? {}) as { code?: number | null }
      setImmediate(() => {
        if (!settled) {
          finish(new Error(
            `child exited before probe case=${caseMarker} code=${info.code ?? 'null'} stderr=${stderr.slice(0, 800)}`,
          ))
        }
      })
    }
    const onError = (...args: unknown[]) => {
      finish(args[0] instanceof Error ? args[0] : new Error(String(args[0])))
    }
    runner.on('stderr', onStderr)
    runner.on('exit', onExit)
    runner.on('error', onError)
  })
}

export async function spawnAndReadChildEnv(input: {
  sessionKey: string
  traceId: string | undefined
  caseMarker: string
}): Promise<{ probe: SpawnEnvProbe; childPid: number }> {
  __setCcbSpawnForTests(null)
  const agentBaseDir = mkdtempSync('/tmp/ocv5-213-a9-cwd-')
  const saved: Record<string, string | undefined> = {
    OC_SESSION_KEY: process.env.OC_SESSION_KEY,
    OPENCLAUDE_SESSION_KEY: process.env.OPENCLAUDE_SESSION_KEY,
    OPENCLAUDE_TRACE_ID: process.env.OPENCLAUDE_TRACE_ID,
  }
  process.env.OC_SESSION_KEY = PARENT_WRONG.OC_SESSION_KEY
  process.env.OPENCLAUDE_SESSION_KEY = PARENT_WRONG.OPENCLAUDE_SESSION_KEY
  process.env.OPENCLAUDE_TRACE_ID = PARENT_WRONG.OPENCLAUDE_TRACE_ID

  const config = {
    version: 1,
    provider: 'anthropic',
    gateway: { bind: '127.0.0.1', port: 18799, accessToken: 'a9-spawn-fixture-token' },
    auth: {
      mode: 'subscription',
      claudeCodePath: FIXTURE_DIR,
      claudeCodeEntry: FIXTURE_ENTRY,
      claudeCodeRuntime: 'node',
    },
    defaults: { model: 'none', permissionMode: 'default' },
    channels: { webchat: { enabled: true } },
    terminal: { type: 'local' },
  } as OpenClaudeConfig

  const runner = new SubprocessRunner({
    sessionKey: input.sessionKey,
    agentId: 'main',
    agentBaseDir,
    model: undefined,
    hermeticNoTools: true,
    traceId: input.traceId,
    providerEnvOverride: {
      OC_SESSION_KEY: PROVIDER_WRONG.OC_SESSION_KEY,
      OPENCLAUDE_SESSION_KEY: PROVIDER_WRONG.OPENCLAUDE_SESSION_KEY,
      OPENCLAUDE_TRACE_ID: PROVIDER_WRONG.OPENCLAUDE_TRACE_ID,
      OCV5_A9_CASE: input.caseMarker,
    },
    config,
  })

  const abort = new AbortController()
  try {
    const probePromise = waitForProbe(runner, input.caseMarker, 8_000, abort.signal)
    try {
      await runner.start()
    } catch (err) {
      abort.abort()
      throw err
    }
    const proc = (runner as unknown as { proc: { pid?: number } | null }).proc
    const childPid = proc?.pid
    if (typeof childPid !== 'number' || childPid <= 0) {
      abort.abort()
      throw new Error('default LocalBackend did not publish a real child pid')
    }
    const probe = await probePromise
    if (probe.pid === process.pid) {
      throw new Error(`child pid must differ from parent pid (${process.pid})`)
    }
    if (probe.pid !== childPid) {
      throw new Error(`probe pid ${probe.pid} does not match LocalBackend child pid ${childPid}`)
    }
    return { probe, childPid }
  } finally {
    abort.abort()
    try {
      await runner.shutdown()
    } catch {
      /* still restore env / dirs */
    }
    __setCcbSpawnForTests(null)
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(agentBaseDir, { recursive: true, force: true })
  }
}

export function assertNotInheritedWrongValues(probe: SpawnEnvProbe): void {
  const forbidden = new Set<string>([
    PARENT_WRONG.OC_SESSION_KEY,
    PARENT_WRONG.OPENCLAUDE_SESSION_KEY,
    PARENT_WRONG.OPENCLAUDE_TRACE_ID,
    PROVIDER_WRONG.OC_SESSION_KEY,
    PROVIDER_WRONG.OPENCLAUDE_SESSION_KEY,
    PROVIDER_WRONG.OPENCLAUDE_TRACE_ID,
  ])
  for (const value of [probe.OC_SESSION_KEY, probe.OPENCLAUDE_SESSION_KEY, probe.OPENCLAUDE_TRACE_ID]) {
    if (value !== null) assert.equal(forbidden.has(value), false, `child inherited synthetic wrong value ${value}`)
  }
}
