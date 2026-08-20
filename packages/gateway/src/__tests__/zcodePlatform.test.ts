import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  cleanupZcodePlatformArtifacts,
  createZcodePlatformArtifacts,
  readZcodeReasoningParts,
} from '../engine/zcodePlatform.js'

const require = createRequire(import.meta.url)
const HOOK = path.resolve(
  process.cwd(),
  'packages/commercial/agent-sandbox/platform-runtime/bin/oc-zcode-hook',
)

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

describe('zcode platform artifacts', () => {
  test('registers mcp-memory without placing bearer contents in platform config and cleans all credentials', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'oc-zcode-platform-home-'))
    const oldHome = process.env.OPENCLAUDE_HOME
    const oldHook = process.env.OC_ZCODE_HOOK_COLLECTOR_BIN
    const oldAllow = process.env.OC_ZCODE_TEST_ALLOW_UNTRUSTED_HOOK
    process.env.OPENCLAUDE_HOME = home
    process.env.OC_ZCODE_HOOK_COLLECTOR_BIN = HOOK
    process.env.OC_ZCODE_TEST_ALLOW_UNTRUSTED_HOOK = '1'
    let contextDir = ''
    try {
      const artifacts = createZcodePlatformArtifacts({
        agentId: 'main',
        sessionKey: 'agent:main:webchat:dm:zcode-platform-test',
        gatewayPort: 18789,
        gatewayToken: 'bearer-must-not-enter-config',
        delegationDepth: 0,
      })
      contextDir = artifacts.contextDir
      assert.ok(artifacts.platformConfigFile)
      assert.ok(artifacts.hookJournalFile)
      const raw = readFileSync(artifacts.platformConfigFile!, 'utf8')
      const config = JSON.parse(raw) as any
      const env = config.mcp.servers.openclaude_memory.env as Record<string, string>
      assert.equal(raw.includes('bearer-must-not-enter-config'), false)
      assert.equal(
        readFileSync(env.OPENCLAUDE_GATEWAY_TOKEN_FILE, 'utf8'),
        'bearer-must-not-enter-config',
      )
      assert.equal(lstatSync(env.OPENCLAUDE_GATEWAY_TOKEN_FILE).mode & 0o777, 0o600)
      assert.ok(artifacts.advertisedMcpTools.includes('skill_search'))
      assert.equal(config.hooks.events.PreToolUse[0].hooks[0].command, '/usr/local/bin/node')
      cleanupZcodePlatformArtifacts(artifacts)
      assert.equal(existsSync(contextDir), false)
    } finally {
      if (contextDir) rmSync(contextDir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      restore('OPENCLAUDE_HOME', oldHome)
      restore('OC_ZCODE_HOOK_COLLECTOR_BIN', oldHook)
      restore('OC_ZCODE_TEST_ALLOW_UNTRUSTED_HOOK', oldAllow)
    }
  })

  test('collector records bounded tool hooks and always returns a neutral hook response', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oc-zcode-context-'))
    chmodSync(dir, 0o700)
    const journal = path.join(dir, 'tool-events.jsonl')
    writeFileSync(journal, '', { mode: 0o600 })
    try {
      const input = JSON.stringify({
        hookEventName: 'PostToolUse',
        sessionId: 'sess_hook_test',
        toolCallId: 'call_1',
        toolName: 'Bash',
        toolInput: { command: 'printf ok' },
        toolResponse: { stdout: 'ok', exitCode: 0 },
        toolResultPreview: 'ok',
        timestamp: new Date().toISOString(),
      })
      const out = spawnSync(process.execPath, ['--experimental-default-type=module', HOOK, journal], {
        input,
        encoding: 'utf8',
      })
      assert.equal(out.status, 0)
      assert.equal(out.stdout.trim(), '{}')
      assert.equal(out.stderr, '')
      const row = JSON.parse(readFileSync(journal, 'utf8').trim())
      assert.equal(row.hookEventName, 'PostToolUse')
      assert.equal(row.toolName, 'Bash')
      assert.deepEqual(row.toolResponse, { stdout: 'ok', exitCode: 0 })

      const invalid = spawnSync(process.execPath, ['--experimental-default-type=module', HOOK, '/tmp/not-a-zcode-context/events'], {
        input,
        encoding: 'utf8',
      })
      assert.equal(invalid.status, 0)
      assert.equal(invalid.stdout.trim(), '{}')
      assert.equal(invalid.stderr, '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reasoning reader is readonly, attributed to the current assistant message, and fail-soft', (t) => {
    let DatabaseSync: any
    try {
      ;({ DatabaseSync } = require('node:sqlite'))
    } catch {
      t.skip('node:sqlite requires Node 22')
      return
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'oc-zcode-reasoning-'))
    const dbPath = path.join(dir, 'db.sqlite')
    const db = new DatabaseSync(dbPath)
    const boundary = Date.now()
    try {
      db.exec(`
        CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
        CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
      `)
      db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(
        'msg_old',
        'sess_current',
        boundary - 500,
        JSON.stringify({ role: 'assistant' }),
        0,
      )
      db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(
        'part_old',
        'msg_old',
        'sess_current',
        boundary - 500,
        JSON.stringify({ type: 'reasoning', text: 'must-not-cross-turns' }),
        0,
      )
      const now = boundary + 10
      db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(
        'msg_a',
        'sess_current',
        now,
        JSON.stringify({ role: 'assistant' }),
        0,
      )
      db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(
        'part_reason',
        'msg_a',
        'sess_current',
        now,
        JSON.stringify({ type: 'reasoning', text: 'reasoning-visible', time: { start: now } }),
        0,
      )
    } finally {
      db.close()
    }
    try {
      const parts = readZcodeReasoningParts({
        databaseFile: dbPath,
        sessionId: 'sess_current',
        startedAt: boundary,
      })
      assert.equal(parts.length, 1)
      assert.equal(parts[0]?.id, 'part_reason')
      assert.equal(parts[0]?.text, 'reasoning-visible')
      assert.equal(typeof parts[0]?.ts, 'number')
      assert.equal(parts[0]?.truncated, false)
      assert.deepEqual(
        readZcodeReasoningParts({
          databaseFile: `${dbPath}.missing`,
          sessionId: 'sess_current',
          startedAt: 0,
        }),
        [],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
