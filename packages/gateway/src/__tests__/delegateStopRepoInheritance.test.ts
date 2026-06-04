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
    'SessionManager.getOrCreate must expose a separate repo lookup key',
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
    /repoSessionId:\s*progressTarget\?\.peerId/,
    'validated parent webchat peerId must be passed only as repoSessionId',
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
    /private\s+_interruptDelegationsForParent\(/,
    'gateway must expose a helper to interrupt active delegate children',
  )
  assert.match(
    handleDelegateTask,
    /const\s+unregisterDelegation\s*=\s*this\._registerActiveDelegation\([\s\S]*progressTarget\?\.sessionKey[\s\S]*sessionKey[\s\S]*\)/,
    'validated webchat parent delegates must be registered while submit is in flight',
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
    handleStop,
    /const\s+ok\s*=\s*selfInterrupted\s*\|\|\s*delegateInterrupted/,
    'stop should report success when either parent or child delegate was interrupted',
  )
})
