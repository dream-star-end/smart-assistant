/**
 * Fail-open contract for the efficiency hook runner.
 * Run: npx tsx --test packages/gateway/src/__tests__/efficiencyHookFailOpen.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-eff-failopen-'))
const SRC_DIR = dirname(fileURLToPath(new URL('../efficiencyHookConfig.ts', import.meta.url)))
const RUNNER = join(SRC_DIR, 'efficiencyHookRunner.cjs')

const {
  atomicWriteJsonFile,
  buildCcbEfficiencySettings,
  buildCursorEfficiencyHooks,
  resolveEfficiencyHookCommand,
} = await import('../efficiencyHookConfig.js')

function runRunner(opts: {
  protocol: 'ccb' | 'cursor'
  script?: string
  stdin?: string
  timeoutMs?: number
  actionPolicy?: string
}): { status: number | null; stdout: string; stderr: string; elapsedMs: number } {
  const started = Date.now()
  const args = [RUNNER, `--protocol=${opts.protocol}`, '--mode=deny']
  if (opts.script) args.push(`--script=${opts.script}`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAUDE_HOME: TEST_HOME,
    OPENCLAUDE_EFFICIENCY_HOOK_TIMEOUT_MS: String(opts.timeoutMs ?? 1500),
  }
  if (opts.actionPolicy !== undefined) {
    env.OPENCLAUDE_ACTION_POLICY = opts.actionPolicy
  } else {
    delete env.OPENCLAUDE_ACTION_POLICY
  }
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    input: opts.stdin ?? '{"command":"true"}\n',
    timeout: 8000,
    env,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    elapsedMs: Date.now() - started,
  }
}

function writeFixture(name: string, body: string): string {
  const path = join(TEST_HOME, name)
  writeFileSync(path, body)
  return path
}

function auditText(): string {
  const p = join(TEST_HOME, '.efficiency-guard', 'audit.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function failOpenCount(): number {
  const p = join(TEST_HOME, '.efficiency-guard', 'fail-open.count')
  if (!existsSync(p)) return 0
  return parseInt(readFileSync(p, 'utf8'), 10) || 0
}

function failClosedCount(): number {
  const p = join(TEST_HOME, '.efficiency-guard', 'fail-closed.count')
  if (!existsSync(p)) return 0
  return parseInt(readFileSync(p, 'utf8'), 10) || 0
}

function assertAllowed(protocol: 'ccb' | 'cursor', stdout: string, status: number | null) {
  assert.equal(status, 0, `runner must exit 0, got ${status}: ${stdout}`)
  const obj = JSON.parse(stdout.trim())
  if (protocol === 'cursor') {
    assert.equal(obj.permission, 'allow')
  } else {
    assert.equal(obj.hookSpecificOutput.permissionDecision, 'allow')
  }
}

function assertFailClosed(protocol: 'ccb' | 'cursor', stdout: string, status: number | null) {
  assert.equal(status, 0, `runner must exit 0 (never exit 2), got ${status}: ${stdout}`)
  const obj = JSON.parse(stdout.trim())
  if (protocol === 'cursor') {
    assert.equal(obj.permission, 'deny')
    assert.equal(obj.requiresHumanApproval, true)
  } else {
    assert.equal(obj.hookSpecificOutput.permissionDecision, 'ask')
  }
}

describe('engine hook command config switches cleanly between efficiency-only and action-policy modes', () => {
  it('efficiency-only mode keeps failClosed:false and 4s timeout; action-policy mode sets Cursor failClosed:true and 6s timeout (>5s runner max)', () => {
    const ccbOff = buildCcbEfficiencySettings('deny', false)
    const preOff = (ccbOff as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> } })
      .hooks.PreToolUse[0]
    assert.match(preOff.hooks[0].command, /efficiencyHookRunner\.cjs/)
    assert.match(preOff.hooks[0].command, /--protocol=ccb/)
    assert.equal(preOff.hooks[0].timeout, 4)
    assert.doesNotMatch(preOff.hooks[0].command, /sleep_ge_60|while true/)

    const hooksOff = buildCursorEfficiencyHooks('deny', false) as {
      hooks: { beforeShellExecution: Array<{ command: string; timeout: number; failClosed: boolean }> }
    }
    assert.match(hooksOff.hooks.beforeShellExecution[0].command, /efficiencyHookRunner\.cjs/)
    assert.equal(hooksOff.hooks.beforeShellExecution[0].failClosed, false)
    assert.equal(hooksOff.hooks.beforeShellExecution[0].timeout, 4)

    const ccbOn = buildCcbEfficiencySettings('deny', true)
    const preOn = (ccbOn as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> } })
      .hooks.PreToolUse[0]
    assert.equal(preOn.hooks[0].timeout, 6)

    const hooksOn = buildCursorEfficiencyHooks('deny', true) as {
      hooks: { beforeShellExecution: Array<{ command: string; timeout: number; failClosed: boolean }> }
    }
    assert.match(hooksOn.hooks.beforeShellExecution[0].command, /efficiencyHookRunner\.cjs/)
    assert.equal(hooksOn.hooks.beforeShellExecution[0].failClosed, true)
    assert.equal(hooksOn.hooks.beforeShellExecution[0].timeout, 6)
    assert.ok(resolveEfficiencyHookCommand('ccb', 'warn')?.includes('efficiencyHookRunner.cjs'))
  })
})

describe('efficiency-only mode (OPENCLAUDE_ACTION_POLICY=off): four hook-chain faults fail-open with a signal', () => {
  it('missing inner script → allow + audit + counter', () => {
    const before = failOpenCount()
    const out = runRunner({
      protocol: 'ccb',
      script: join(TEST_HOME, 'no-such-hook.cjs'),
      actionPolicy: 'off',
    })
    assertAllowed('ccb', out.stdout, out.status)
    assert.match(out.stderr, /fail-open/)
    assert.match(out.stderr, /nonzero_exit|tsx_missing|spawn_error|timeout/)
    assert.ok(failOpenCount() > before)
    assert.match(auditText(), /"event":"fail_open"/)
    assert.match(auditText(), /"elapsedMs":\d+/)
  })

  it('nonzero inner exit → allow + audit + counter', () => {
    const script = writeFixture('exit1.cjs', 'process.stdout.write("not used\\n"); process.exit(1);\n')
    const before = failOpenCount()
    const out = runRunner({ protocol: 'cursor', script, actionPolicy: 'off' })
    assertAllowed('cursor', out.stdout, out.status)
    assert.match(out.stderr, /fail-open/)
    assert.match(out.stderr, /nonzero_exit:1/)
    assert.ok(failOpenCount() > before)
    assert.match(auditText(), /nonzero_exit:1/)
  })

  it('invalid JSON stdout → allow + audit + counter', () => {
    const script = writeFixture('badjson.cjs', 'process.stdout.write("this is not json\\n"); process.exit(0);\n')
    const before = failOpenCount()
    const out = runRunner({ protocol: 'ccb', script, actionPolicy: 'off' })
    assertAllowed('ccb', out.stdout, out.status)
    assert.match(out.stderr, /invalid_json/)
    assert.ok(failOpenCount() > before)
    assert.match(auditText(), /invalid_json/)
  })

  it('hung inner script times out quickly → allow + audit + counter', () => {
    const pidFile = join(TEST_HOME, 'hang.pid')
    const script = writeFixture(
      'hang.cjs',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    )
    const before = failOpenCount()
    const out = runRunner({ protocol: 'cursor', script, timeoutMs: 250, actionPolicy: 'off' })
    assertAllowed('cursor', out.stdout, out.status)
    assert.ok(out.elapsedMs < 2000, `timeout must be ms-level, took ${out.elapsedMs}ms`)
    assert.match(out.stderr, /timeout/)
    assert.ok(failOpenCount() > before)
    assert.match(auditText(), /timeout/)

    // Regression: the hung inner must not be left behind as an orphan. Before
    // the fix, the timeout path called finishFail() without the child, so the
    // SIGKILL branch was dead code and one `node hang.cjs` leaked per run.
    assert.ok(existsSync(pidFile), 'inner should have started and written its pid')
    const innerPid = Number(readFileSync(pidFile, 'utf8'))
    let alive = true
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(innerPid, 0)
        spawnSync('sleep', ['0.05'])
      } catch {
        alive = false
      }
    }
    if (alive) {
      try {
        process.kill(innerPid, 'SIGKILL')
      } catch {
        /* cleanup is best-effort */
      }
    }
    assert.equal(alive, false, `inner pid ${innerPid} still alive after runner timeout`)
  })
})

describe('action-policy enabled (default / on): runner & inner faults NEVER fail-open to allow', () => {
  it('missing inner script via real runner → CCB ask + Cursor deny (never allow)', () => {
    const before = failClosedCount()
    const ccb = runRunner({ protocol: 'ccb', script: join(TEST_HOME, 'no-such-policy-hook.cjs') })
    assertFailClosed('ccb', ccb.stdout, ccb.status)
    assert.match(ccb.stderr, /fail-closed/)

    const cursor = runRunner({ protocol: 'cursor', script: join(TEST_HOME, 'no-such-policy-hook.cjs') })
    assertFailClosed('cursor', cursor.stdout, cursor.status)
    assert.match(cursor.stderr, /fail-closed/)
    assert.ok(failClosedCount() >= before + 2)
    assert.match(auditText(), /"event":"fail_closed"/)
  })

  it('nonzero exit & invalid JSON stdout via real runner → CCB ask + Cursor deny', () => {
    const exitScript = writeFixture('policy-exit1.cjs', 'process.exit(1);\n')
    const badJsonScript = writeFixture('policy-badjson.cjs', 'process.stdout.write("not json\\n");\n')

    const ccbExit = runRunner({ protocol: 'ccb', script: exitScript, actionPolicy: 'on' })
    assertFailClosed('ccb', ccbExit.stdout, ccbExit.status)
    assert.match(ccbExit.stderr, /nonzero_exit:1/)

    const cursorBad = runRunner({ protocol: 'cursor', script: badJsonScript, actionPolicy: 'on' })
    assertFailClosed('cursor', cursorBad.stdout, cursorBad.status)
    assert.match(cursorBad.stderr, /invalid_json/)
  })

  it('hung inner script times out via real runner → CCB ask + Cursor deny and kills orphan child', () => {
    const pidFile = join(TEST_HOME, 'policy-hang.pid')
    const script = writeFixture(
      'policy-hang.cjs',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    )
    const ccb = runRunner({ protocol: 'ccb', script, timeoutMs: 250 })
    assertFailClosed('ccb', ccb.stdout, ccb.status)
    assert.ok(ccb.elapsedMs < 2000, `timeout must be ms-level, took ${ccb.elapsedMs}ms`)
    assert.match(ccb.stderr, /timeout/)

    const cursor = runRunner({ protocol: 'cursor', script, timeoutMs: 250 })
    assertFailClosed('cursor', cursor.stdout, cursor.status)
    assert.match(cursor.stderr, /timeout/)

    assert.ok(existsSync(pidFile))
    const innerPid = Number(readFileSync(pidFile, 'utf8'))
    let alive = true
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(innerPid, 0)
        spawnSync('sleep', ['0.05'])
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, `inner pid ${innerPid} still alive after policy timeout`)
  })

  it('inner policy evaluation exception fails closed (CCB ask / Cursor deny) without downgrading efficiency deny', async () => {
    const { handlePreToolHookInput } = await import('../efficiencyPreToolHook.js')
    const brokenPolicy = {
      ok: true as const,
      source: 'file' as const,
      path: '/tmp/broken.yaml',
      warnings: [],
      get policy(): never {
        throw new Error('boom during action policy read')
      },
    }

    const ccb = await handlePreToolHookInput(
      { tool_name: 'Bash', tool_input: { command: 'echo safe' } },
      'ccb',
      'warn',
      { actionPolicyEnabled: true, loadedPolicy: brokenPolicy },
    )
    assert.equal((ccb.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'ask')

    const cursor = await handlePreToolHookInput(
      { command: 'echo safe' },
      'cursor',
      'warn',
      { actionPolicyEnabled: true, loadedPolicy: brokenPolicy },
    )
    assert.equal(cursor.permission, 'deny')
    assert.equal(cursor.requiresHumanApproval, true)

    // Existing efficiency deny MUST still win over synthesized policy ask
    const strictCcb = await handlePreToolHookInput(
      { tool_name: 'Bash', tool_input: { command: 'sleep 600' } },
      'ccb',
      'deny',
      { actionPolicyEnabled: true, loadedPolicy: brokenPolicy },
    )
    assert.equal((strictCcb.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'deny')
  })

  it('real runner + real inner hook fail-closed on invalid JSON and empty stdin when policy enabled, fail-open when policy off', () => {
    const distRunner = join(SRC_DIR, '../dist/efficiencyHookRunner.cjs')
    const runnerPath = existsSync(distRunner) ? distRunner : RUNNER
    const runReal = (protocol: 'ccb' | 'cursor', input: string, actionPolicy?: string) =>
      spawnSync(process.execPath, [runnerPath, `--protocol=${protocol}`, '--mode=deny'], {
        encoding: 'utf8',
        input,
        timeout: 8000,
        env: {
          ...process.env,
          OPENCLAUDE_HOME: TEST_HOME,
          OPENCLAUDE_EFFICIENCY_HOOK_TIMEOUT_MS: '5000',
          ...(actionPolicy !== undefined ? { OPENCLAUDE_ACTION_POLICY: actionPolicy } : {}),
        },
      })

    // Invalid JSON stdin
    const ccbInvalidOn = runReal('ccb', '{not-valid-json\n', 'on')
    assertFailClosed('ccb', ccbInvalidOn.stdout ?? '', ccbInvalidOn.status)
    const cursorInvalidOn = runReal('cursor', '{not-valid-json\n', 'on')
    assertFailClosed('cursor', cursorInvalidOn.stdout ?? '', cursorInvalidOn.status)
    const ccbInvalidOff = runReal('ccb', '{not-valid-json\n', 'off')
    assertAllowed('ccb', ccbInvalidOff.stdout ?? '', ccbInvalidOff.status)

    // Empty stdin (must NEVER silently fall back to {} -> allow when Action Policy is enabled)
    const ccbEmptyOn = runReal('ccb', '', 'on')
    assertFailClosed('ccb', ccbEmptyOn.stdout ?? '', ccbEmptyOn.status)
    const cursorEmptyOn = runReal('cursor', '   \n', 'on')
    assertFailClosed('cursor', cursorEmptyOn.stdout ?? '', cursorEmptyOn.status)
    const ccbEmptyOff = runReal('ccb', '', 'off')
    assertAllowed('ccb', ccbEmptyOff.stdout ?? '', ccbEmptyOff.status)
    const cursorEmptyOff = runReal('cursor', '', 'off')
    assertAllowed('cursor', cursorEmptyOff.stdout ?? '', cursorEmptyOff.status)
  })
})

describe('precompiled inner is preferred over tsx', () => {
  it('same-dir efficiencyPreToolHook.js is selected, allow JSON, no fail_open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-eff-precompiled-'))
    const home = mkdtempSync(join(tmpdir(), 'oc-eff-precompiled-home-'))
    copyFileSync(RUNNER, join(dir, 'efficiencyHookRunner.cjs'))
    writeFileSync(
      join(dir, 'efficiencyPreToolHook.js'),
      [
        "'use strict'",
        "const used = process.execArgv.includes('--conditions=openclaude-precompiled')",
        'process.stdout.write(JSON.stringify({',
        '  hookSpecificOutput: {',
        "    hookEventName: 'PreToolUse',",
        "    permissionDecision: 'allow',",
        "    additionalContext: used ? 'precompiled' : 'plain'",
        '  }',
        "}) + '\\n')",
      ].join('\n'),
    )
    const beforeAudit = existsSync(join(home, '.efficiency-guard', 'audit.jsonl'))
      ? readFileSync(join(home, '.efficiency-guard', 'audit.jsonl'), 'utf8')
      : ''
    const result = spawnSync(process.execPath, [join(dir, 'efficiencyHookRunner.cjs'), '--protocol=ccb', '--mode=warn'], {
      encoding: 'utf8',
      input: '{"tool_name":"Bash","tool_input":{"command":"ls"}}\n',
      timeout: 8000,
      env: { ...process.env, OPENCLAUDE_HOME: home },
    })
    assertAllowed('ccb', result.stdout ?? '', result.status)
    const obj = JSON.parse((result.stdout ?? '').trim())
    assert.equal(obj.hookSpecificOutput.additionalContext, 'precompiled')
    assert.doesNotMatch(result.stderr ?? '', /fail-open/)
    const auditPath = join(home, '.efficiency-guard', 'audit.jsonl')
    const afterAudit = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : ''
    assert.equal(afterAudit.slice(beforeAudit.length), '', 'must not append fail_open')
  })

  it('only .ts next to a copied runner still runs through tsx', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-eff-tsx-fallback-'))
    const home = mkdtempSync(join(tmpdir(), 'oc-eff-tsx-home-'))
    copyFileSync(RUNNER, join(dir, 'efficiencyHookRunner.cjs'))
    writeFileSync(
      join(dir, 'efficiencyPreToolHook.ts'),
      'process.stdout.write(JSON.stringify({permission:"allow",agent_message:"tsx-fallback"})+"\\n")\n',
    )
    const nodeModules = join(SRC_DIR, '../../../node_modules')
    symlinkSync(nodeModules, join(dir, 'node_modules'))
    const result = spawnSync(process.execPath, [join(dir, 'efficiencyHookRunner.cjs'), '--protocol=cursor', '--mode=warn'], {
      encoding: 'utf8',
      input: '{"command":"true"}\n',
      timeout: 8000,
      env: {
        ...process.env,
        OPENCLAUDE_HOME: home,
        OPENCLAUDE_EFFICIENCY_HOOK_TIMEOUT_MS: '4000',
        // tsx keeps its compile cache under os.tmpdir(); a long-lived host cache
        // (63k entries on v5-dev) alone doubled the cold start past the 4s budget.
        TMPDIR: home,
      },
    })
    assertAllowed('cursor', result.stdout ?? '', result.status)
    assert.equal(JSON.parse((result.stdout ?? '').trim()).agent_message, 'tsx-fallback')
    assert.doesNotMatch(result.stderr ?? '', /fail-open/)
  })
})

describe('happy path is unchanged', () => {
  it('valid deny from inner still denies (exit 0)', () => {
    const script = writeFixture(
      'deny.cjs',
      'process.stdout.write(JSON.stringify({permission:"deny",agent_message:"nope"})+"\\n");\n',
    )
    const out = runRunner({ protocol: 'cursor', script })
    assert.equal(out.status, 0)
    assert.equal(JSON.parse(out.stdout.trim()).permission, 'deny')
  })

  it('malformed payload allows only when action-policy is off; fails closed when action-policy is on', async () => {
    const { handlePreToolHookInput } = await import('../efficiencyPreToolHook.js')
    const outOff = await handlePreToolHookInput('not-json', 'ccb', 'deny', { actionPolicyEnabled: false })
    assert.equal((outOff.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'allow')

    const outCcbOn = await handlePreToolHookInput('not-json', 'ccb', 'deny', { actionPolicyEnabled: true })
    assert.equal((outCcbOn.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'ask')

    const outCursorOn = await handlePreToolHookInput('not-json', 'cursor', 'deny', { actionPolicyEnabled: true })
    assert.equal(outCursorOn.permission, 'deny')
    assert.equal(outCursorOn.requiresHumanApproval, true)
  })
})

describe('atomic JSON writes', () => {
  it('replace is rename-based: target is complete JSON, never a partial leftover', () => {
    const target = join(TEST_HOME, 'settings.json')
    writeFileSync(target, '{"stale":true}')
    atomicWriteJsonFile(target, { hooks: { PreToolUse: [] } }, 0o600)
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    assert.deepEqual(parsed, { hooks: { PreToolUse: [] } })
    assert.equal(existsSync(`${target}.tmp`), false)
  })
})
