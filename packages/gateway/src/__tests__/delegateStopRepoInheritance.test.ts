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

const handleDelegateTask = extractMethodBody(SERVER_TS, 'handleDelegateTask')
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
    handleDelegateTask,
    /peerId:\s*sourceAgent\s*\|\|\s*'system'/,
    'delegate identity/routing peerId must stay sourceAgent',
  )
  assert.match(
    handleDelegateTask,
    /repoSessionId:\s*progressTarget\?\.peerId\s*\?\?\s*delegateParent\?\.repoSessionId/,
    'validated parent webchat peerId or parent delegate repo binding must be passed only as repoSessionId',
  )
  assert.doesNotMatch(
    handleDelegateTask,
    /peerId:\s*progressTarget\?\.peerId/,
    'delegate session must not impersonate the parent webchat peerId',
  )

  const resolveIdx = handleDelegateTask.indexOf('_resolveDelegateProgressTarget')
  const getOrCreateIdx = handleDelegateTask.indexOf('this.sessions.getOrCreate')
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
    handleDelegateTask,
    /const\s+delegateParent\s*=\s*this\._resolveDelegateParent/,
    'delegate runs must resolve a parent session key and repo binding separately from webchat progress',
  )
  assert.match(
    SERVER_TS,
    /parent\.channel !== 'webchat' && parent\.channel !== 'delegate'/,
    'nested delegate children must be allowed to register under delegate parent sessions',
  )
  assert.match(
    handleDelegateTask,
    /const\s+unregisterDelegation\s*=\s*this\._registerActiveDelegation\([\s\S]*delegateParent\?\.sessionKey[\s\S]*sessionKey[\s\S]*\)/,
    'validated parent delegates must be registered while submit is in flight',
  )
  assert.match(
    handleDelegateTask,
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

test('delegate toolset restrictions are intersected with target agent ceiling', () => {
  assert.match(
    SERVER_TS,
    /function\s+effectiveDelegateToolsets\(/,
    'gateway must use a helper for delegate toolset intersection',
  )
  assert.match(
    SERVER_TS,
    /targetAgent\.toolsets[\s\S]*this\.deps\.config\.defaults\.toolsets/,
    'delegate toolset ceiling must use target agent toolsets or global config defaults',
  )
  assert.match(
    SERVER_TS,
    /requested\.filter\(\(toolset\) => ceiling\.includes\(toolset\)\)/,
    'requested delegate toolsets must be intersected with the target ceiling',
  )
  assert.match(
    SERVER_TS,
    /delegate toolsets not allowed for agent/,
    'empty delegate toolset intersection must be rejected instead of falling back to all tools',
  )
  assert.doesNotMatch(
    handleDelegateTask,
    /toolsets \? \{ \.\.\.targetAgent, toolsets \} : targetAgent/,
    'delegate toolsets must not blindly replace target agent configuration',
  )
})

test('delegate admission has a best-effort cgroup memory pressure guard', () => {
  assert.match(SERVER_TS, /OPENCLAUDE_DELEGATE_MEMORY_PRESSURE_RATIO/)
  assert.match(SERVER_TS, /DELEGATE_MEMORY_PRESSURE_DEFAULT_RATIO\s*=\s*0\.85/)
  assert.match(SERVER_TS, /\/sys\/fs\/cgroup\/memory\.current/)
  assert.match(SERVER_TS, /\/sys\/fs\/cgroup\/memory\.max/)
  assert.match(handleDelegateTask, /readDelegateMemoryPressure\(\)/)
  assert.match(
    handleDelegateTask,
    /this\.sendError\(\s*res,\s*503,[\s\S]*delegate resource pressure/,
  )
})
