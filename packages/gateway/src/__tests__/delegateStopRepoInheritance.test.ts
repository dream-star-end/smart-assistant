import { gatewayMethodBody, readGatewaySource } from './helpers/gatewaySource.js'
import { readSessionManagerSource, sessionManagerMethodBody } from './helpers/sessionManagerSource.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// server.ts + the modules split out of it (FINDINGS §7.6 S3: delegate runtime moved to delegateRuntime.ts)
const SERVER_TS = readGatewaySource()
// sessionManager.ts + the modules split out of it (FINDINGS §7.6 M1/M2)
const SESSION_MANAGER_TS = readSessionManagerSource()

function extractMethodBody(source: string, methodName: string): string {
  // `(` after the name: the Gateway's route io adapters list `name: (...args) => …` too
  const startRe = new RegExp(`^  (private|public|protected)?\\s*(async\\s+)?${methodName}\\(`, 'm')
  const startMatch = startRe.exec(source)
  if (!startMatch) throw new Error(`method ${methodName} not found in source`)
  const startIdx = startMatch.index
  const rest = source.slice(startIdx + startMatch[0].length)
  const nextRe = /^ {2}(private|public|protected|async|static)\b/m
  const nextMatch = nextRe.exec(rest)
  const endIdx = nextMatch ? startIdx + startMatch[0].length + nextMatch.index : source.length
  return source.slice(startIdx, endIdx)
}

// P2 债C:委派执行核心先从 HTTP 端点抽到 _runDelegateTask; 3ad3d58ef 再拆出
// _runDelegateTaskCore(resume claim 包在薄包装里)。身份/repo 绑定/资源闸护栏都在
// Core 体里,扫包装会假红。另守包装仍 dispatch 到 Core,避免接线被拆掉。
// FINDINGS §7.6 S3: the delegate runtime lives in delegateRuntime.ts; the class keeps forwarders.
const delegateWrapper = gatewayMethodBody('_runDelegateTask')
const delegateCore = gatewayMethodBody('_runDelegateTaskCore')
const handleStop = gatewayMethodBody('handleStop') // FINDINGS §7.6 S6: handleStop lives in wsConnection.ts
const getOrCreate =
  sessionManagerMethodBody('getOrCreate') +
  sessionManagerMethodBody('_getOrCreateExclusive')

test('delegate wrapper still dispatches into _runDelegateTaskCore', () => {
  assert.match(
    delegateWrapper,
    /await this\._runDelegateTaskCore\(/,
    '_runDelegateTask must remain the resume-claim wrapper around _runDelegateTaskCore',
  )
  assert.doesNotMatch(
    delegateWrapper,
    /this\.sessions\.getOrCreate/,
    'session spawn belongs in the core, not the resume-claim wrapper',
  )
})

test('delegate sessions inherit repo lookup without rewriting delegate peer identity', () => {
  assert.match(
    SESSION_MANAGER_TS,
    /repoSessionId\?:\s*string/,
    'SessionManager must expose and retain a separate repo lookup key',
  )
  assert.match(
    getOrCreate,
    /const\s+repoSessionId\s*=\s*opts\.repoSessionId\s*\?\?\s*opts\.peerId/,
    'repoSessionId must default to peerId for existing chat sessions',
  )
  assert.match(
    SESSION_MANAGER_TS,
    /sessionId:\s*repoSessionId/,
    'runner repo snapshot lookup must use repoSessionId',
  )
  assert.match(
    SESSION_MANAGER_TS,
    /repoSessionId,\s*\n\s*title:/,
    'AgentSession must store repoSessionId so nested delegates can inherit the same repo binding',
  )
  assert.match(
    SESSION_MANAGER_TS,
    /opts\.repoSessionId && !existing\.repoSessionId/,
    'existing sessions should adopt a first repoSessionId without overwriting it',
  )
  assert.match(
    SESSION_MANAGER_TS,
    /_sessionIdToKey\.set\(\s*opts\.peerId\s*,\s*opts\.sessionKey\s*\)/,
    '_sessionIdToKey must remain keyed by real peerId',
  )
  assert.doesNotMatch(
    SESSION_MANAGER_TS,
    /_sessionIdToKey\.set\(\s*opts\.repoSessionId/,
    'repoSessionId must not mutate the peer/session reverse index',
  )
  assert.match(
    delegateCore,
    /peerId:\s*sourceAgent\s*\|\|\s*'system'/,
    'delegate identity/routing peerId must stay sourceAgent',
  )
  assert.match(
    delegateCore,
    /repoSessionId:\s*progressTarget\?\.peerId\s*\?\?\s*delegateParent\?\.repoSessionId/,
    'validated parent webchat peerId or parent delegate repo binding must be passed only as repoSessionId',
  )
  assert.doesNotMatch(
    delegateCore,
    /^\s*peerId:\s*progressTarget\?\.peerId/m,
    'delegate session must not impersonate the parent webchat peerId',
  )

  const resolveIdx = delegateCore.indexOf('_resolveDelegateProgressTarget')
  const getOrCreateIdx = delegateCore.indexOf('this.sessions.getOrCreate')
  assert.ok(
    resolveIdx >= 0 && getOrCreateIdx > resolveIdx,
    'parent target must be resolved before delegate getOrCreate',
  )
})

test('stop interrupts active delegate children for the stopped parent session', () => {
  assert.match(
    SERVER_TS,
    /_activeDelegationsByParent\s*=\s*new Map<string,\s*Set<string>>/,
    'gateway must track active child delegate sessions by parent sessionKey',
  )
  assert.match(
    SERVER_TS,
    /private\s+_registerActiveDelegation\(/,
    'delegate runs must register their parent-child relationship',
  )
  assert.match(
    SERVER_TS,
    /private\s+_interruptDelegationsForParent\([\s\S]*visited = new Set<string>/,
    'gateway must expose a recursive helper to interrupt active delegate children',
  )
  assert.match(
    delegateCore,
    /const\s+delegateParent\s*=\s*this\._resolveDelegateParent/,
    'delegate runs must resolve a parent session key and repo binding separately from webchat progress',
  )
  assert.match(
    SERVER_TS,
    /parent\.channel !== 'webchat' && parent\.channel !== 'delegate'/,
    'nested delegate children must be allowed to register under delegate parent sessions',
  )
  assert.match(
    delegateCore,
    /const\s+unregisterDelegation\s*=\s*this\._registerActiveDelegation\([\s\S]*delegateParent\?\.sessionKey[\s\S]*sessionKey[\s\S]*\)/,
    'validated parent delegates must be registered while submit is in flight',
  )
  assert.match(
    delegateCore,
    /unregisterDelegation\?\.\(\)/,
    'delegate registration must be removed in finally',
  )
  assert.match(
    handleStop,
    /await interruptDelegationsForReceipt\(this as unknown as DelegateGuardHost,live\.sessionKey\)/,
    'agent-less stop fallback must await durable child delegate Stop receipts',
  )
  assert.match(
    handleStop,
    /await interruptDelegationsForReceipt\(this as unknown as DelegateGuardHost,sessionKey\)/,
    'direct stop must await durable child delegate Stop receipts',
  )
  assert.match(
    SERVER_TS,
    /this\._interruptDelegationsForParent\(childSessionKey, visited\)/,
    'delegate stop must recurse into descendant delegate sessions',
  )
  assert.match(
    handleStop,
    /const\s+ok\s*=\s*selfInterrupted\s*\|\|\s*delegateInterrupted/,
    'stop should report success when either parent or child delegate was interrupted',
  )
})

test('exact browser Stop finds the old assistant turn and cascades through its team tree', () => {
  assert.match(
    SESSION_MANAGER_TS,
    /interruptClientTurn\([\s\S]*_runningClientMessageId\s*!==\s*clientMessageId[\s\S]*return this\.interrupt\(sessionKey,\s*'user'\)/,
    'SessionManager must reject stale turn ids and interrupt only the exact browser turn owner',
  )
  assert.match(
    handleStop,
    /if \(clientMessageId\)[\s\S]*live\.sessionKey\.endsWith\(suffix\)[\s\S]*interruptClientTurn\([\s\S]*live\.sessionKey[\s\S]*clientMessageId[\s\S]*\)/,
    'Stop must scan the peer across assistants by exact clientMessageId',
  )
  assert.match(
    handleStop,
    /if \(clientMessageId\)[\s\S]*await capturedStopReceipt\(/,
    'an exact leader Stop must use the captured durable Stop tree before returning its receipt',
  )
  const captured=readFileSync(join(__dirname,'../boxStopReceipt.ts'),'utf8')
  assert.match(captured,/for\(const child of host\._activeDelegationsByParent\?\.get\(key\) \?\? \[\]\) capture\(child\)/,
    'captured exact Stop must recurse through every active delegate and hidden reviewer descendant')
})

test('delegate handler wires the unified additive toolset resolver (no fatal intersection)', () => {
  // The resolver logic itself lives in toolsetIntent.ts and is exercised
  // behaviorally by resolveDelegateToolsets.test.ts; here we only guard the
  // server.ts wiring + the removal of the old hard-fail path.
  assert.match(
    delegateCore,
    /resolveDelegateToolsets\(\s*targetAgent,\s*this\.deps\.config,/,
    'delegate handler must resolve toolsets via the unified resolver with full config',
  )
  assert.match(
    delegateCore,
    /const\s+delegateIntentText\s*=\s*\[goal,\s*context\]/,
    'delegate handler must derive intent text from goal+context (symmetry with WS path)',
  )
  assert.doesNotMatch(
    SERVER_TS,
    /delegate toolsets not allowed for agent/,
    'empty/unknown delegate toolset requests must degrade to the merged baseline, not a hard 400',
  )
  assert.doesNotMatch(
    delegateCore,
    /toolsets \? \{ \.\.\.targetAgent, toolsets \} : targetAgent/,
    'delegate toolsets must not blindly replace target agent configuration',
  )
})

test('delegate admission has a best-effort cgroup memory pressure guard (bounded queue)', () => {
  assert.match(SERVER_TS, /OPENCLAUDE_DELEGATE_MEMORY_PRESSURE_RATIO/)
  assert.match(SERVER_TS, /DELEGATE_MEMORY_PRESSURE_DEFAULT_RATIO\s*=\s*0\.85/)
  assert.match(SERVER_TS, /\/sys\/fs\/cgroup\/memory\.current/)
  assert.match(SERVER_TS, /\/sys\/fs\/cgroup\/memory\.max/)
  // 内存闸 + 并发闸并入同一个有界排队收口(行为断言见 delegateResourceQueue.test.ts,
  // 这里只守 server.ts 的接线不被回退成"立即 503/429")。
  assert.match(SERVER_TS, /OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS/)
  assert.match(SERVER_TS, /_readDelegateMemoryPressure\(\)/)
  assert.match(delegateCore, /await this\._waitForDelegateCapacity\(/)
  assert.match(delegateCore, /delegate resource pressure/)
  assert.match(delegateCore, /too many concurrent delegations/)
})
