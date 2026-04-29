import * as assert from 'node:assert/strict'
/**
 * Regression tests for `buildCcbCliArgs` — the pure CLI argv builder used by
 * `SubprocessRunner.start()` to spawn the CCB subprocess.
 *
 * The load-bearing invariant these tests pin down:
 *
 *   `--permission-prompt-tool stdio` MUST be present in EVERY mode.
 *
 * If this regresses for bypassPermissions (OpenClaude's default), CCB's
 * permissions.ts step 1e returns `behavior:'ask'` for bypass-immune
 * interactive tools (AskUserQuestion, ExitPlanMode, …) and without a
 * permission-prompt-tool, that ask falls through `getCanUseToolFn`'s
 * fallback branch and toolExecution.ts surfaces it as a deny with the raw
 * ask-message ("Answer questions?") as the tool error — the exact bug this
 * fix is regression-protecting against.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/subprocessRunnerArgs.test.ts
 */
import { describe, it } from 'node:test'
import { buildCcbCliArgs } from '../subprocessRunner.js'

const BASE = {
  runtime: 'bun',
  entry: 'src/entrypoints/cli.tsx',
}

/** Helper: does args contain the two tokens `flag value` adjacent, in order? */
function hasFlagWithValue(args: readonly string[], flag: string, value: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) return true
  }
  return false
}

describe('buildCcbCliArgs', () => {
  it('always emits --permission-prompt-tool stdio, even with no permissionMode', () => {
    const args = buildCcbCliArgs({ ...BASE })
    assert.ok(
      hasFlagWithValue(args, '--permission-prompt-tool', 'stdio'),
      'stdio permission prompting must be on in the default/unset mode path',
    )
    // In the default mode path, permission-related CLI surface is minimal:
    // no --permission-mode, no --dangerously-skip-permissions.
    assert.equal(args.includes('--permission-mode'), false)
    assert.equal(args.includes('--dangerously-skip-permissions'), false)
  })

  it('bypassPermissions emits stdio AND --dangerously-skip-permissions together', () => {
    // This is the exact scenario that originally regressed: in the old code
    // the bypassPermissions branch pushed --dangerously-skip-permissions but
    // SKIPPED --permission-prompt-tool stdio via an `else` guard. This test
    // pins the fix in place.
    const args = buildCcbCliArgs({ ...BASE, permissionMode: 'bypassPermissions' })
    assert.ok(
      hasFlagWithValue(args, '--permission-mode', 'bypassPermissions'),
      'bypassPermissions mode should still pass --permission-mode through',
    )
    assert.ok(
      args.includes('--dangerously-skip-permissions'),
      'bypassPermissions mode must also pass --dangerously-skip-permissions',
    )
    assert.ok(
      hasFlagWithValue(args, '--permission-prompt-tool', 'stdio'),
      'stdio prompting must remain on in bypassPermissions — required for AskUserQuestion/ExitPlanMode',
    )
  })

  it('non-bypass permission modes emit stdio without --dangerously-skip-permissions', () => {
    // Every non-bypass mode CCB supports. Each should push the mode flag + stdio,
    // but NEVER --dangerously-skip-permissions (that's bypass-only).
    for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto']) {
      const args = buildCcbCliArgs({ ...BASE, permissionMode: mode })
      assert.ok(
        hasFlagWithValue(args, '--permission-mode', mode),
        `should pass --permission-mode ${mode}`,
      )
      assert.ok(
        hasFlagWithValue(args, '--permission-prompt-tool', 'stdio'),
        `should pass --permission-prompt-tool stdio for mode=${mode}`,
      )
      assert.equal(
        args.includes('--dangerously-skip-permissions'),
        false,
        `mode=${mode} must NOT include --dangerously-skip-permissions`,
      )
    }
  })

  it('emits the expected fixed prefix for a bun runtime', () => {
    const args = buildCcbCliArgs({ ...BASE })
    assert.deepEqual(args.slice(0, 7), [
      'run',
      'src/entrypoints/cli.tsx',
      '-p',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose',
    ])
  })

  it('uses --experimental-strip-types instead of `run` for non-bun runtimes', () => {
    const args = buildCcbCliArgs({ ...BASE, runtime: 'node' })
    assert.equal(args[0], '--experimental-strip-types')
    assert.equal(args[1], 'src/entrypoints/cli.tsx')
  })

  it('appends optional flags in the documented order when provided', () => {
    const args = buildCcbCliArgs({
      ...BASE,
      model: 'claude-opus-4-6',
      permissionMode: 'bypassPermissions',
      extraPromptFile: '/tmp/prompt.md',
      mcpConfigFile: '/tmp/mcp.json',
      addDir: '/var/data/agents/main',
      resumeSessionId: 'sess-abc123',
    })
    // Verify each optional pair is present — we don't lock the *absolute*
    // order of optional flags (that's an implementation detail) but we do
    // verify the flag/value pairs stay adjacent.
    assert.ok(hasFlagWithValue(args, '--model', 'claude-opus-4-6'))
    assert.ok(hasFlagWithValue(args, '--permission-mode', 'bypassPermissions'))
    assert.ok(args.includes('--dangerously-skip-permissions'))
    assert.ok(hasFlagWithValue(args, '--permission-prompt-tool', 'stdio'))
    assert.ok(hasFlagWithValue(args, '--append-system-prompt-file', '/tmp/prompt.md'))
    assert.ok(hasFlagWithValue(args, '--mcp-config', '/tmp/mcp.json'))
    assert.ok(hasFlagWithValue(args, '--add-dir', '/var/data/agents/main'))
    assert.ok(hasFlagWithValue(args, '--resume', 'sess-abc123'))
    // Trailing empty placeholder is required — CCB stream-json takes prompt
    // over stdin but Commander requires the positional arg to exist.
    assert.equal(args[args.length - 1], '')
  })

  it('omits --resume when resumeSessionId is null/undefined/empty', () => {
    for (const sid of [null, undefined, '']) {
      const args = buildCcbCliArgs({ ...BASE, resumeSessionId: sid })
      assert.equal(args.includes('--resume'), false, `resumeSessionId=${String(sid)} should not produce --resume`)
    }
  })

  it('omits optional flags entirely when their values are falsy', () => {
    const args = buildCcbCliArgs({ ...BASE })
    for (const flag of [
      '--model',
      '--permission-mode',
      '--dangerously-skip-permissions',
      '--append-system-prompt-file',
      '--mcp-config',
      '--add-dir',
      '--resume',
    ]) {
      assert.equal(args.includes(flag), false, `${flag} must be omitted when unset`)
    }
  })

  it('emits --setting-sources user when restrictedMemorySources=true', () => {
    // v3 商业版容器 leak fix: CCB 默认会从 cwd 父链扫描 Project/Local CLAUDE.md,
    // 把镜像内 /opt/openclaude/CLAUDE.md (个人版 dev rules) 注入系统提示。
    // 启用后只读 User memory = ${CLAUDE_CONFIG_DIR}/CLAUDE.md = 平台 baseline ro mount。
    const args = buildCcbCliArgs({ ...BASE, restrictedMemorySources: true })
    assert.ok(
      hasFlagWithValue(args, '--setting-sources', 'user'),
      'restrictedMemorySources=true must emit --setting-sources user',
    )
    // placeholder '' 必须仍是最后一个 arg(setting-sources 在它之前)
    assert.equal(args[args.length - 1], '')
  })

  it('omits --setting-sources entirely when restrictedMemorySources is false/undefined', () => {
    for (const v of [false, undefined]) {
      const args = buildCcbCliArgs({ ...BASE, restrictedMemorySources: v })
      assert.equal(
        args.includes('--setting-sources'),
        false,
        `restrictedMemorySources=${String(v)} must NOT emit --setting-sources (个人版/dev 行为不变)`,
      )
    }
  })

  it('always terminates args with the empty prompt placeholder', () => {
    // Several shapes — the empty string always trails.
    for (const input of [
      { ...BASE },
      { ...BASE, permissionMode: 'bypassPermissions' },
      { ...BASE, resumeSessionId: 'x' },
      { ...BASE, addDir: '/tmp' },
      { ...BASE, restrictedMemorySources: true },
    ]) {
      const args = buildCcbCliArgs(input)
      assert.equal(args[args.length - 1], '', `last arg must be '' for input ${JSON.stringify(input)}`)
    }
  })
})
