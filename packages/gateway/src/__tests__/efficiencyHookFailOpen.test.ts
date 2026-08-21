/**
 * Fail-open contract for the efficiency hook runner.
 * Run: npx tsx --test packages/gateway/src/__tests__/efficiencyHookFailOpen.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
}): { status: number | null; stdout: string; stderr: string; elapsedMs: number } {
  const started = Date.now()
  const args = [RUNNER, `--protocol=${opts.protocol}`, '--mode=deny']
  if (opts.script) args.push(`--script=${opts.script}`)
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    input: opts.stdin ?? '{"command":"true"}\n',
    timeout: 8000,
    env: {
      ...process.env,
      OPENCLAUDE_HOME: TEST_HOME,
      OPENCLAUDE_EFFICIENCY_HOOK_TIMEOUT_MS: String(opts.timeoutMs ?? 1500),
    },
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

function assertAllowed(protocol: 'ccb' | 'cursor', stdout: string, status: number | null) {
  assert.equal(status, 0, `runner must exit 0, got ${status}: ${stdout}`)
  const obj = JSON.parse(stdout.trim())
  if (protocol === 'cursor') {
    assert.equal(obj.permission, 'allow')
  } else {
    assert.equal(obj.hookSpecificOutput.permissionDecision, 'allow')
  }
}

describe('engine hook command stays on the fail-open runner', () => {
  it('CCB/Cursor commands point at the runner, not a copied regex, and Cursor is failClosed:false', () => {
    const ccb = buildCcbEfficiencySettings('deny')
    const pre = (ccb as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> } })
      .hooks.PreToolUse[0]
    assert.match(pre.hooks[0].command, /efficiencyHookRunner\.cjs/)
    assert.match(pre.hooks[0].command, /--protocol=ccb/)
    assert.equal(pre.hooks[0].timeout, 3)
    assert.doesNotMatch(pre.hooks[0].command, /sleep_ge_60|while true/)

    const hooks = buildCursorEfficiencyHooks('deny') as {
      hooks: { beforeShellExecution: Array<{ command: string; timeout: number; failClosed: boolean }> }
    }
    assert.match(hooks.hooks.beforeShellExecution[0].command, /efficiencyHookRunner\.cjs/)
    assert.equal(hooks.hooks.beforeShellExecution[0].failClosed, false)
    assert.equal(hooks.hooks.beforeShellExecution[0].timeout, 3)
    assert.ok(resolveEfficiencyHookCommand('ccb', 'warn')?.includes('efficiencyHookRunner.cjs'))
  })
})

describe('four hook-chain faults all fail-open with a signal', () => {
  it('missing inner script → allow + audit + counter', () => {
    const before = failOpenCount()
    const out = runRunner({ protocol: 'ccb', script: join(TEST_HOME, 'no-such-hook.cjs') })
    assertAllowed('ccb', out.stdout, out.status)
    assert.match(out.stderr, /fail-open/)
    assert.match(out.stderr, /nonzero_exit|tsx_missing|spawn_error|timeout/)
    assert.ok(failOpenCount() > before)
    assert.match(auditText(), /"event":"fail_open"/)
  })

  it('nonzero inner exit → allow + audit + counter', () => {
    const script = writeFixture('exit1.cjs', 'process.stdout.write("not used\\n"); process.exit(1);\n')
    const before = failOpenCount()
    const out = runRunner({ protocol: 'cursor', script })
    assertAllowed('cursor', out.stdout, out.status)
    assert.match(out.stderr, /fail-open/)
    assert.match(out.stderr, /nonzero_exit:1/)
    assert.ok(failOpenCount() > before)
    assert.match(auditText(), /nonzero_exit:1/)
  })

  it('invalid JSON stdout → allow + audit + counter', () => {
    const script = writeFixture('badjson.cjs', 'process.stdout.write("this is not json\\n"); process.exit(0);\n')
    const before = failOpenCount()
    const out = runRunner({ protocol: 'ccb', script })
    assertAllowed('ccb', out.stdout, out.status)
    assert.match(out.stderr, /invalid_json/)
    assert.ok(failOpenCount() > before)
    assert.match(auditText(), /invalid_json/)
  })

  it('hung inner script times out quickly → allow + audit + counter', () => {
    const script = writeFixture('hang.cjs', 'setInterval(() => {}, 1000);\n')
    const before = failOpenCount()
    const out = runRunner({ protocol: 'cursor', script, timeoutMs: 250 })
    assertAllowed('cursor', out.stdout, out.status)
    assert.ok(out.elapsedMs < 2000, `timeout must be ms-level, took ${out.elapsedMs}ms`)
    assert.match(out.stderr, /timeout/)
    assert.ok(failOpenCount() > before)
    assert.match(auditText(), /timeout/)
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

  it('malformed stdin still allows via handlePreToolHookInput', async () => {
    const { handlePreToolHookInput } = await import('../efficiencyPreToolHook.js')
    const out = await handlePreToolHookInput('not-json', 'ccb', 'deny')
    assert.equal((out.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'allow')
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
