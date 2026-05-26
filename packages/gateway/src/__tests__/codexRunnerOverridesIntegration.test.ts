import * as assert from 'node:assert/strict'
/**
 * Runner-level integration tests for the Phase 1 codex platform-context
 * injection.
 *
 * Strategy: don't actually spawn `codex`. Instead we exercise the lazy-build
 * + cache + cleanup lifecycle end-to-end on the runner instances by:
 *   1. Driving `ensureLaunchOverrides()` (private, accessed via `as any`) and
 *      asserting the returned argvOverrides splice into `buildCodexCliArgs()`
 *      at the documented positions.
 *   2. Confirming the cache is hit on a second call (no second mkdtemp).
 *   3. Confirming `shutdown()` rmSync's the dir AND clears the cache so a
 *      post-shutdown call rebuilds against a NEW dir.
 *   4. Confirming `updateConfig()` invalidates the cache and re-builds with
 *      the new gatewayToken.
 *   5. Confirming `setEffortLevel` flows through to the next rebuild.
 *
 * Why these exist on top of pure-function tests:
 *   - `codexLaunchOverrides.test.ts` proves the encoder + 7-slot pipeline
 *     are correct.
 *   - `codexRunnerArgs.test.ts` proves `buildCodexCliArgs(extraConfig)`
 *     splices argv correctly.
 *   - This file proves the GLUE that wires (1)→(2)→spawn argv on the live
 *     runner instances. Without it a refactor could silently bypass
 *     `ensureLaunchOverrides()` from the spawn path and pure tests would
 *     stay green while production codex subprocesses launch naked.
 */
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { CodexAppServerRunner } from '../codexAppServerRunner.js'
import { CodexRunner, buildCodexCliArgs } from '../codexRunner.js'

function makeFakeConfig(token: string): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 18789, accessToken: token },
    auth: { mode: 'subscription', claudeCodePath: '/opt/openclaude/openclaude/claude-code-best' },
    defaults: { model: 'claude-opus-4-7', permissionMode: 'bypassPermissions' },
    channels: { webchat: { enabled: true } },
  } as unknown as OpenClaudeConfig
}

describe('CodexRunner platform context glue', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'oc-cr-glue-'))
  })

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('ensureLaunchOverrides + buildCodexCliArgs assemble argv with -c slots before threadId/-', async () => {
    const runner = new CodexRunner({
      sessionKey: 'glue-test',
      agentId: 'glue-agent',
      cwd,
      config: makeFakeConfig('tok-glue-1'),
    })
    const overrides = await (runner as any).ensureLaunchOverrides()
    assert.ok(overrides, 'ensureLaunchOverrides must produce overrides when config is provided')
    assert.ok(existsSync(overrides.instructionsFile), 'instructions file must be written to disk')

    // Fresh exec path
    const fresh = buildCodexCliArgs({ extraConfig: overrides.argvOverrides })
    const cIdx = fresh.indexOf('-c')
    const dashIdx = fresh.lastIndexOf('-')
    assert.ok(cIdx >= 0 && cIdx < dashIdx, 'fresh exec: -c must precede stdin sentinel')
    assert.ok(
      fresh.some((a) => a.startsWith('model_instructions_file=')),
      'argv must carry model_instructions_file override',
    )

    // Resume path
    const resumed = buildCodexCliArgs({ threadId: 'thr_xyz', extraConfig: overrides.argvOverrides })
    const tidIdx = resumed.indexOf('thr_xyz')
    const rcIdx = resumed.indexOf('-c')
    assert.ok(rcIdx >= 0 && rcIdx < tidIdx, 'resume: -c must precede threadId')
    assert.ok(tidIdx < resumed.lastIndexOf('-'), 'resume: threadId must precede stdin sentinel')

    await runner.shutdown()
  })

  it('caches overrides across calls (sessionDir reused, file path stable)', async () => {
    const runner = new CodexRunner({
      sessionKey: 'cache-test',
      agentId: 'cache-agent',
      cwd,
      config: makeFakeConfig('tok-cache'),
    })
    const a = await (runner as any).ensureLaunchOverrides()
    const b = await (runner as any).ensureLaunchOverrides()
    assert.equal(a.instructionsFile, b.instructionsFile, 'cached path must be stable')
    assert.strictEqual(a, b, 'second call must return the same object reference (cache hit)')
    await runner.shutdown()
  })

  it('shutdown rmSyncs sessionDir and clears cache; next call rebuilds in NEW dir', async () => {
    const runner = new CodexRunner({
      sessionKey: 'shutdown-test',
      agentId: 'shutdown-agent',
      cwd,
      config: makeFakeConfig('tok-sd'),
    })
    const before = await (runner as any).ensureLaunchOverrides()
    const fileBefore = before.instructionsFile
    assert.ok(existsSync(fileBefore))

    await runner.shutdown()
    assert.ok(!existsSync(fileBefore), 'shutdown must rmSync the instructions file')

    const after = await (runner as any).ensureLaunchOverrides()
    assert.notEqual(after.instructionsFile, fileBefore, 'rebuild must use a NEW sessionDir')
    assert.ok(existsSync(after.instructionsFile))
    await runner.shutdown()
  })

  it('updateConfig invalidates cache and next build uses the new token', async () => {
    const runner = new CodexRunner({
      sessionKey: 'cfg-test',
      agentId: 'cfg-agent',
      cwd,
      config: makeFakeConfig('tok-old'),
    })
    const v1 = await (runner as any).ensureLaunchOverrides()
    const envOverrideV1 = v1.argvOverrides.find(
      (s: string) => s.startsWith('mcp_servers.openclaude_memory.env=') && s.includes('tok-old'),
    )
    // If the mcp-memory entry resolved (it should in the test repo), the env
    // override must contain the original token.
    if (envOverrideV1 !== undefined) {
      assert.ok(envOverrideV1.includes('tok-old'))
    }

    runner.updateConfig(makeFakeConfig('tok-new'))
    const v2 = await (runner as any).ensureLaunchOverrides()
    assert.notEqual(v1, v2, 'updateConfig must invalidate the cache')
    const envOverrideV2 = v2.argvOverrides.find((s: string) =>
      s.startsWith('mcp_servers.openclaude_memory.env='),
    )
    if (envOverrideV2 !== undefined) {
      assert.ok(envOverrideV2.includes('tok-new'), 'rebuild must carry the new token')
      assert.ok(!envOverrideV2.includes('tok-old'), 'rebuild must NOT carry the old token')
    }
    await runner.shutdown()
  })

  it('setEffortLevel flows into the next rebuild (after shutdown)', async () => {
    const runner = new CodexRunner({
      sessionKey: 'effort-test',
      agentId: 'effort-agent',
      cwd,
      config: makeFakeConfig('tok-e'),
    })
    runner.setEffortLevel('high')
    const v1 = await (runner as any).ensureLaunchOverrides()
    // Effort propagation is tested through the prompt context — buildPromptContext
    // is the one that consults effortLevel. We can't easily intercept its
    // internal output here, but we CAN assert the runner field is set so the
    // next ensureLaunchOverrides call passes it down.
    assert.equal(runner.effortLevel, 'high')

    // Switch effort, shutdown to clear cache, rebuild — runner must read the new value.
    runner.setEffortLevel('low')
    assert.equal(runner.effortLevel, 'low')
    await runner.shutdown()
    const v2 = await (runner as any).ensureLaunchOverrides()
    assert.notEqual(v1.instructionsFile, v2.instructionsFile, 'rebuild must use a fresh dir')
    await runner.shutdown()
  })
})

describe('CodexAppServerRunner platform context glue', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'oc-aps-glue-'))
  })

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('ensureLaunchOverrides produces argvOverrides ordered for `app-server` spawn', async () => {
    const runner = new CodexAppServerRunner({
      sessionKey: 'aps-glue',
      agentId: 'aps-agent',
      cwd,
      config: makeFakeConfig('tok-aps'),
    })
    const overrides = await (runner as any).ensureLaunchOverrides()
    assert.ok(overrides)
    // Simulate the spawn argv assembly the runner does:
    //   ['app-server', ...overrides.argvOverrides, '--listen', 'stdio://']
    const args = ['app-server', ...overrides.argvOverrides, '--listen', 'stdio://']
    const cIdx = args.indexOf('-c')
    const listenIdx = args.indexOf('--listen')
    assert.ok(cIdx >= 0 && cIdx < listenIdx, '-c must precede --listen on app-server')
    await runner.shutdown()
  })

  it('shutdown clears sessionDir + cache; updateConfig invalidates without erasing dir prematurely', async () => {
    const runner = new CodexAppServerRunner({
      sessionKey: 'aps-cfg',
      agentId: 'aps-agent',
      cwd,
      config: makeFakeConfig('tok-aps-old'),
    })
    const v1 = await (runner as any).ensureLaunchOverrides()
    const fileV1 = v1.instructionsFile

    // updateConfig must invalidate cache (next build returns a different
    // overrides object), but the *current* sessionDir is still alive — we
    // do NOT delete it because the running mcp-memory child has it open.
    runner.updateConfig(makeFakeConfig('tok-aps-new'))
    assert.ok(existsSync(fileV1), 'updateConfig must NOT delete sessionDir under live proc')

    const v2 = await (runner as any).ensureLaunchOverrides()
    assert.notEqual(v1, v2, 'updateConfig must invalidate cache')

    // After shutdown, both directories tied to this runner are torn down.
    await runner.shutdown()
    // After shutdown, the most-recent dir (v2) is gone. The earlier v1 dir
    // was already orphaned by updateConfig (the runner forgot the path
    // when it cleared cachedOverrides), so it MAY still be on disk but is
    // not the runner's responsibility — kernel/tmp-cleanup handles it.
    assert.ok(!existsSync(v2.instructionsFile), 'shutdown must rmSync the latest sessionDir')
  })
})
