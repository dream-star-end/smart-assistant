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
    // v3 has multiple `-c` slots (approval_policy + platform context).
    // Scan all values to find model_instructions_file rather than indexing
    // off the first `-c` (which is approval_policy on v3).
    const miFile = args.find((a) => a.startsWith('model_instructions_file='))
    assert.ok(miFile, `argv missing model_instructions_file: ${JSON.stringify(args)}`)
    assert.match(
      miFile!,
      /^model_instructions_file=".+\/extra-prompt\.md"$/,
      `expected model_instructions_file="..."; got: ${miFile}`,
    )
    // v3 keeps approval_policy="never" as its own -c slot.
    assert.ok(
      args.some((a) => a.startsWith('approval_policy=')),
      'v3 approval_policy slot must be preserved',
    )
    // Every `-c` slot must precede the stdin sentinel `-`.
    const dashIdx = args.lastIndexOf('-')
    args.forEach((tok, i) => {
      if (tok === '-c') assert.ok(i < dashIdx, '-c must precede stdin sentinel')
    })
    // v3 hardening: production spawn must NOT leak the gateway token via argv.
    // The mcp_servers.openclaude_memory.env override should reference a
    // tokenFile path, not embed the token literal.
    for (const tok of args) {
      assert.ok(
        !tok.includes('tok-spawn-fresh'),
        `argv leaked gateway token literal in: ${tok}`,
      )
    }
    // And the env override (if present) must use OPENCLAUDE_GATEWAY_TOKEN_FILE,
    // NOT the bare OPENCLAUDE_GATEWAY_TOKEN= key. Use regex to catch TOML's
    // quoted-key inline-table form `"OPENCLAUDE_GATEWAY_TOKEN"="..."`.
    const envOverride = args.find((a) => a.startsWith('mcp_servers.openclaude_memory.env='))
    if (envOverride) {
      assert.ok(
        envOverride.includes('OPENCLAUDE_GATEWAY_TOKEN_FILE'),
        `env override must use TOKEN_FILE; got: ${envOverride}`,
      )
      assert.ok(
        envOverride.includes('OPENCLAUDE_SESSION_KEY'),
        `env override must include OPENCLAUDE_SESSION_KEY for delegate progress routing; got: ${envOverride}`,
      )
      assert.ok(
        envOverride.includes('spawn-fresh'),
        `env override must include the runner session key; got: ${envOverride}`,
      )
      assert.ok(
        !/"OPENCLAUDE_GATEWAY_TOKEN"\s*=/.test(envOverride),
        `env override must NOT carry bare OPENCLAUDE_GATEWAY_TOKEN= (would defeat hardening); got: ${envOverride}`,
      )
    }

    await runner.shutdown()
  })

  it('setEffortLevel("high") → spawn argv has -c model_reasoning_effort="high" before stdin sentinel', async () => {
    // v1.0.200 — gpt-5.5 思考深度通过 codex argv 主通道传,前端 setEffortLevel
    // 写到 runner.effortLevel,下次 spawn 时由 codexReasoningEffortConfig 归一化。
    const runner = new CodexRunner({
      sessionKey: 'spawn-effort-high',
      agentId: 'spawn-agent',
      cwd,
      config: makeFakeConfig('tok-spawn-effort'),
    })
    runner.setEffortLevel('high')
    await runner.submit('hello').catch(() => {})
    assert.equal(captured.length, 1)
    const { args } = captured[0]!
    const effortIdx = args.indexOf('model_reasoning_effort="high"')
    assert.ok(effortIdx > 0, `expected effort -c slot; got ${JSON.stringify(args)}`)
    assert.equal(args[effortIdx - 1], '-c')
    assert.ok(effortIdx < args.lastIndexOf('-'), 'effort must precede stdin sentinel')
    await runner.shutdown()
  })

  it('setEffortLevel("max") → spawn argv carries xhigh (explicit map, not silent ignore)', async () => {
    const runner = new CodexRunner({
      sessionKey: 'spawn-effort-max',
      agentId: 'spawn-agent',
      cwd,
      config: makeFakeConfig('tok-spawn-effort-max'),
    })
    runner.setEffortLevel('max')
    await runner.submit('hello').catch(() => {})
    assert.equal(captured.length, 1)
    const { args } = captured[0]!
    assert.ok(
      args.includes('model_reasoning_effort="xhigh"'),
      `max must surface as xhigh; got ${JSON.stringify(args)}`,
    )
    assert.ok(!args.includes('model_reasoning_effort="max"'))
    await runner.shutdown()
  })

  it('no setEffortLevel → spawn argv has no effort -c slot (codex CLI default applies)', async () => {
    const runner = new CodexRunner({
      sessionKey: 'spawn-effort-none',
      agentId: 'spawn-agent',
      cwd,
      config: makeFakeConfig('tok-spawn-effort-none'),
    })
    await runner.submit('hello').catch(() => {})
    assert.equal(captured.length, 1)
    const { args } = captured[0]!
    assert.ok(
      !args.some((a) => typeof a === 'string' && a.startsWith('model_reasoning_effort=')),
      `no effort set must produce no effort arg; got ${JSON.stringify(args)}`,
    )
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
    assert.ok(tidIdx >= 0, 'resume argv must include threadId')
    // Every `-c` slot (approval_policy + platform context) must precede threadId.
    args.forEach((tok, i) => {
      if (tok === '-c') assert.ok(i < tidIdx, '-c must precede threadId on resume')
    })
    assert.ok(
      args.some((a) => a.startsWith('model_instructions_file=')),
      'resume argv must still carry platform context',
    )
    assert.ok(tidIdx < args.lastIndexOf('-'), 'threadId must precede stdin sentinel')
    // v3 hardening: same argv-leak guard on the resume path.
    for (const tok of args) {
      assert.ok(
        !tok.includes('tok-spawn-resume'),
        `resume argv leaked gateway token literal in: ${tok}`,
      )
    }

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
    // v3 hardening: app-server spawn argv must not leak the gateway token.
    for (const tok of args) {
      assert.ok(
        !tok.includes('tok-aps-spawn'),
        `app-server argv leaked gateway token literal in: ${tok}`,
      )
    }

    await runner.shutdown()
  })

  it('setEffortLevel("high") → app-server argv has -c model_reasoning_effort="high" before --listen', async () => {
    // codex app-server 与 codex exec 共用 codexReasoningEffortConfig helper,这里
    // 验证 helper 接到 ensureSpawned 的 args 数组里且位序正确(所有 -c 必须在
    // --listen 之前,否则 clap 把 stdio:// 当成 -c 的值)。
    const runner = new CodexAppServerRunner({
      sessionKey: 'aps-spawn-effort',
      agentId: 'aps-agent',
      cwd,
      config: makeFakeConfig('tok-aps-effort'),
    })
    runner.setEffortLevel('high')
    void runner.submit('warm up').catch(() => {})
    const deadline = Date.now() + 2000
    while (captured.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(captured.length, 1)
    const { args } = captured[0]!
    const effortIdx = args.indexOf('model_reasoning_effort="high"')
    const listenIdx = args.indexOf('--listen')
    assert.ok(effortIdx > 0, `expected effort -c slot; got ${JSON.stringify(args)}`)
    assert.equal(args[effortIdx - 1], '-c')
    assert.ok(effortIdx < listenIdx, 'effort -c must precede --listen')
    // All `-c` slots must precede --listen.
    args.forEach((tok, i) => {
      if (tok === '-c') assert.ok(i < listenIdx, '-c slot leaked past --listen')
    })
    await runner.shutdown()
  })

  it('setEffortLevel("max") → app-server argv carries xhigh (explicit map)', async () => {
    const runner = new CodexAppServerRunner({
      sessionKey: 'aps-spawn-effort-max',
      agentId: 'aps-agent',
      cwd,
      config: makeFakeConfig('tok-aps-effort-max'),
    })
    runner.setEffortLevel('max')
    void runner.submit('warm up').catch(() => {})
    const deadline = Date.now() + 2000
    while (captured.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(captured.length, 1)
    const { args } = captured[0]!
    assert.ok(
      args.includes('model_reasoning_effort="xhigh"'),
      `max must surface as xhigh; got ${JSON.stringify(args)}`,
    )
    assert.ok(!args.includes('model_reasoning_effort="max"'))
    await runner.shutdown()
  })

  it('no setEffortLevel → app-server argv has no effort -c slot', async () => {
    const runner = new CodexAppServerRunner({
      sessionKey: 'aps-spawn-effort-none',
      agentId: 'aps-agent',
      cwd,
      config: makeFakeConfig('tok-aps-effort-none'),
    })
    void runner.submit('warm up').catch(() => {})
    const deadline = Date.now() + 2000
    while (captured.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(captured.length, 1)
    const { args } = captured[0]!
    assert.ok(
      !args.some((a) => typeof a === 'string' && a.startsWith('model_reasoning_effort=')),
      `no effort set must produce no effort arg; got ${JSON.stringify(args)}`,
    )
    await runner.shutdown()
  })
})
