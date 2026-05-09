import * as assert from 'node:assert/strict'
/**
 * End-to-end spawn-argv integration tests.
 *
 * Covers the gap left by `codexRunnerOverridesIntegration.test.ts` (which
 * drives `ensureLaunchOverrides()` + `buildCodexCliArgs()` directly): this file
 * actually walks through `runTurn()` / `ensureSpawned()` and intercepts the
 * production `_spawnFn` call to inspect the EXACT argv that would be handed
 * to a real `codex` binary.
 *
 * Why it matters: the `__setCodexSpawnForTests` injection point is the only
 * way to prove that overrides flow through the production path. If a future
 * refactor drops the `await this.ensureLaunchOverrides()` call (or builds
 * overrides but forgets to splice them into the spawn argv), the lifecycle
 * tests would still go green — only this file catches that regression.
 *
 * Strategy: replace `_spawnFn` with a stub that:
 *   1. Captures the (cmd, args, opts) tuple.
 *   2. Returns a fake EventEmitter-shaped child process that emits 'close 0'
 *      on next tick so the runner's promise settles cleanly.
 * After each test, restore the default spawn via `__setCodexSpawnForTests(null)`.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  CodexAppServerRunner,
  __setCodexAppServerSpawnForTests,
} from '../codexAppServerRunner.js'
import { CodexRunner, __setCodexSpawnForTests } from '../codexRunner.js'

function makeFakeProc(opts: { closeCode?: number; closeDelayMs?: number } = {}): any {
  const ee = new EventEmitter() as any
  ee.killed = false
  ee.pid = 99999
  ee.stdin = new PassThrough()
  ee.stdout = new PassThrough()
  ee.stderr = new PassThrough()
  ee.kill = (sig?: string) => {
    ee.killed = true
    setImmediate(() => ee.emit('close', null, sig ?? 'SIGTERM'))
  }
  // Settle the runner: emit 'close' so finalizeTurn / handleLine get called.
  // We delay slightly so the runner has a chance to attach listeners after
  // _spawnFn returns synchronously.
  setTimeout(() => {
    ee.stdout.end() // signal EOF on stdout
    ee.stderr.end()
    ee.emit('close', opts.closeCode ?? 0, null)
  }, opts.closeDelayMs ?? 5)
  return ee
}

function makeFakeConfig(token: string): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 18789, accessToken: token },
    auth: { mode: 'subscription', claudeCodePath: '/opt/openclaude/openclaude/claude-code-best' },
    defaults: { model: 'claude-opus-4-7', permissionMode: 'bypassPermissions' },
    channels: { webchat: { enabled: true } },
  } as unknown as OpenClaudeConfig
}

describe('CodexRunner runTurn → spawn argv', () => {
  let cwd: string
  const captured: { cmd: string; args: string[]; opts: any }[] = []

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'oc-cr-spawn-'))
    captured.length = 0
    __setCodexSpawnForTests(((cmd: string, args: string[], opts: any) => {
      captured.push({ cmd, args, opts })
      return makeFakeProc()
    }) as any)
  })

  afterEach(() => {
    __setCodexSpawnForTests(null)
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('production runTurn passes -c model_instructions_file=... to spawn (fresh exec)', async () => {
    const runner = new CodexRunner({
      sessionKey: 'spawn-fresh',
      agentId: 'spawn-agent',
      cwd,
      config: makeFakeConfig('tok-spawn-fresh'),
    })
    // Drive a real submit() — runTurn executes, _spawnFn is intercepted.
    await runner.submit('hello').catch(() => {
      /* turn fails to settle "successfully" because fake proc never emits
         the JSON event stream codex would. We don't care — the spawn call
         already happened and was captured before any of that. */
    })

    assert.equal(captured.length, 1, 'spawn must be called exactly once per turn')
    const { cmd, args } = captured[0]!
    assert.equal(cmd, 'codex')
    // First positional must be `exec` (fresh launch path).
    assert.equal(args[0], 'exec')
    // Must contain at least one `-c model_instructions_file=...` pair.
    const cIdx = args.indexOf('-c')
    assert.ok(cIdx >= 0, `argv missing -c: ${JSON.stringify(args)}`)
    const cVal = args[cIdx + 1] ?? ''
    assert.match(
      cVal,
      /^model_instructions_file=".+\/extra-prompt\.md"$/,
      `expected -c model_instructions_file="..."; got: ${cVal}`,
    )
    // The stdin sentinel `-` must come AFTER the -c slots.
    const dashIdx = args.lastIndexOf('-')
    assert.ok(cIdx < dashIdx, '-c must precede stdin sentinel `-`')

    await runner.shutdown()
  })

  it('resume path: -c slots precede threadId, threadId precedes stdin sentinel', async () => {
    const runner = new CodexRunner({
      sessionKey: 'spawn-resume',
      agentId: 'spawn-agent',
      cwd,
      config: makeFakeConfig('tok-spawn-resume'),
    })
    // Force the runner to think it has a thread to resume by poking the field.
    ;(runner as any).threadId = 'thr_test_xyz'

    await runner.submit('continue').catch(() => {
      /* same as above */
    })
    assert.equal(captured.length, 1)
    const { args } = captured[0]!
    // Resume path: ['exec', 'resume', ...base, ...extra, threadId, '-']
    assert.equal(args[0], 'exec')
    assert.equal(args[1], 'resume')
    const tidIdx = args.indexOf('thr_test_xyz')
    const cIdx = args.indexOf('-c')
    assert.ok(cIdx >= 0 && cIdx < tidIdx, '-c must precede threadId on resume')
    assert.ok(tidIdx < args.lastIndexOf('-'), 'threadId must precede stdin sentinel')

    await runner.shutdown()
  })
})

describe('CodexAppServerRunner ensureSpawned → spawn argv', () => {
  let cwd: string
  const captured: { cmd: string; args: string[]; opts: any }[] = []

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'oc-aps-spawn-'))
    captured.length = 0
    __setCodexAppServerSpawnForTests(((cmd: string, args: string[], opts: any) => {
      captured.push({ cmd, args, opts })
      return makeFakeProc({ closeDelayMs: 50 })
    }) as any)
  })

  afterEach(() => {
    __setCodexAppServerSpawnForTests(null)
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('production ensureSpawned passes -c model_instructions_file=... before --listen', async () => {
    const runner = new CodexAppServerRunner({
      sessionKey: 'aps-spawn',
      agentId: 'aps-agent',
      cwd,
      config: makeFakeConfig('tok-aps-spawn'),
    })
    // ensureSpawned is private; trigger it via submit. submit will queue the
    // turn and call ensureSpawned which executes _spawnFn synchronously
    // before awaiting any handshake.
    void runner.submit('warm up').catch(() => {
      /* swallow — fake proc never completes initialize handshake */
    })
    // Poll for the captured spawn — drain → ensureSpawned → _spawnFn is async
    // through several microtask hops (mkdtempSync + writeFileSync are sync but
    // buildPromptContext awaits skill loading from disk).
    const deadline = Date.now() + 2000
    while (captured.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(captured.length, 1, 'spawn must be called exactly once on first submit')
    const { cmd, args } = captured[0]!
    assert.equal(cmd, 'codex')
    assert.equal(args[0], 'app-server')
    const cIdx = args.indexOf('-c')
    const listenIdx = args.indexOf('--listen')
    assert.ok(cIdx >= 0, `argv missing -c: ${JSON.stringify(args)}`)
    assert.ok(listenIdx >= 0, `argv missing --listen: ${JSON.stringify(args)}`)
    assert.ok(cIdx < listenIdx, '-c must precede --listen so clap parses positionals correctly')
    const cVal = args[cIdx + 1] ?? ''
    assert.match(
      cVal,
      /^model_instructions_file=".+\/extra-prompt\.md"$/,
      `expected -c model_instructions_file="..."; got: ${cVal}`,
    )

    await runner.shutdown()
  })
})
