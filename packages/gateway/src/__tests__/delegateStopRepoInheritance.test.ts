import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_TS = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8')
const SESSION_MANAGER_TS = readFileSync(join(__dirname, '..', 'sessionManager.ts'), 'utf-8')

function extractMethodBody(source: string, methodName: string): string {
  const startRe = new RegExp(`^  (private|public|protected)?\\s*(async\\s+)?${methodName}\\b`, 'm')
  const startMatch = startRe.exec(source)
  if (!startMatch) throw new Error(`method ${methodName} not found in source`)
  const startIdx = startMatch.index
  const rest = source.slice(startIdx + startMatch[0].length)
  const nextRe = /^ {2}(private|public|protected|async|static)\b/m
  const nextMatch = nextRe.exec(rest)
  const endIdx = nextMatch ? startIdx + startMatch[0].length + nextMatch.index : source.length
  return source.slice(startIdx, endIdx)
}

// P2 债C:委派执行核心已从 HTTP 端点 handleDelegateTask 抽到 _runDelegateTask(HTTP 壳
// 与内部硬编排两调用方共用)。下面的身份/repo 绑定/资源闸结构护栏断言都在核心体里,故提取核心。
const delegateCore = extractMethodBody(SERVER_TS, '_runDelegateTask')
const handleStop = extractMethodBody(SERVER_TS, 'handleStop')
const getOrCreate = extractMethodBody(SESSION_MANAGER_TS, 'getOrCreate')

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
    /peerId:\s*progressTarget\?\.peerId/,
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
    /this\._interruptDelegationsForParent\(\s*live\.sessionKey\s*\)/,
    'agent-less stop fallback must propagate stop to child delegates',
  )
  assert.match(
    handleStop,
    /this\._interruptDelegationsForParent\(\s*sessionKey\s*\)/,
    'direct stop must propagate stop to child delegates',
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
    /interruptClientTurn\([\s\S]*_runningClientMessageId\s*!==\s*clientMessageId[\s\S]*return this\.interrupt\(sessionKey\)/,
    'SessionManager must reject stale turn ids and interrupt only the exact browser turn owner',
  )
  assert.match(
    handleStop,
    /if \(clientMessageId\)[\s\S]*live\.sessionKey\.endsWith\(suffix\)[\s\S]*interruptClientTurn\([\s\S]*live\.sessionKey[\s\S]*clientMessageId[\s\S]*\)/,
    'Stop must scan the peer across assistants by exact clientMessageId',
  )
  assert.match(
    handleStop,
    /if \(clientMessageId\)[\s\S]*_interruptDelegationsForParent\(live\.sessionKey\)/,
    'an exact leader Stop must cascade to active delegates and hidden reviewer descendants',
  )
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
