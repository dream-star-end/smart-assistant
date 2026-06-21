import * as assert from 'node:assert/strict'
/**
 * Regression tests for `buildClaudeCliArgs` — the pure CLI argv builder used by
 * `SubprocessRunner.start()` to spawn the official `claude` subprocess.
 *
 * The load-bearing invariant these tests pin down:
 *
 *   `--permission-prompt-tool stdio` MUST be present in EVERY mode.
 *
 * That stdio channel is how `claude` emits `can_use_tool` control_requests on
 * stdout (verified against official Claude Code 2.1.178). The gateway bridges
 * those to the web permission UI and answers over stdin. If it regresses,
 * interactive tools (AskUserQuestion, ExitPlanMode, …) — which stay ask-immune
 * even under bypassPermissions — would have no responder and surface as tool
 * errors.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/claudeCliArgs.test.ts
 */
import { describe, it } from 'node:test'
import { buildClaudeCliArgs } from '../subprocessRunner.js'

/** Helper: does args contain the two tokens `flag value` adjacent, in order? */
function hasFlagWithValue(args: readonly string[], flag: string, value: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) return true
  }
  return false
}

describe('buildClaudeCliArgs', () => {
  it('emits the fixed stream-json prefix (no runtime/entry — official binary)', () => {
    const args = buildClaudeCliArgs({})
    assert.deepEqual(args.slice(0, 5), [
      '-p',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose',
    ])
  })

  it('always emits --permission-prompt-tool stdio, even with no permissionMode', () => {
    const args = buildClaudeCliArgs({})
    assert.ok(
      hasFlagWithValue(args, '--permission-prompt-tool', 'stdio'),
      'stdio permission prompting must be on in the default/unset mode path',
    )
    assert.equal(args.includes('--permission-mode'), false)
    assert.equal(args.includes('--dangerously-skip-permissions'), false)
  })

  it('bypassPermissions emits stdio AND --dangerously-skip-permissions together', () => {
    const args = buildClaudeCliArgs({ permissionMode: 'bypassPermissions' })
    assert.ok(hasFlagWithValue(args, '--permission-mode', 'bypassPermissions'))
    assert.ok(args.includes('--dangerously-skip-permissions'))
    assert.ok(
      hasFlagWithValue(args, '--permission-prompt-tool', 'stdio'),
      'stdio prompting must remain on in bypassPermissions — required for AskUserQuestion/ExitPlanMode',
    )
  })

  it('non-bypass permission modes emit stdio without --dangerously-skip-permissions', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto']) {
      const args = buildClaudeCliArgs({ permissionMode: mode })
      assert.ok(hasFlagWithValue(args, '--permission-mode', mode))
      assert.ok(hasFlagWithValue(args, '--permission-prompt-tool', 'stdio'))
      assert.equal(args.includes('--dangerously-skip-permissions'), false)
    }
  })

  it('passes effort via the official --effort flag', () => {
    const args = buildClaudeCliArgs({ effortLevel: 'xhigh' })
    assert.ok(hasFlagWithValue(args, '--effort', 'xhigh'))
  })

  it('translates effortLevel=ultracode → --effort xhigh + --settings {"ultracode":true}', () => {
    // 'ultracode' is NOT a valid --effort value (the CLI warns + ignores it).
    // It is xhigh reasoning + the ultracode session setting (Workflow 编排).
    const args = buildClaudeCliArgs({ effortLevel: 'ultracode' })
    assert.ok(hasFlagWithValue(args, '--effort', 'xhigh'), 'ultracode must map to --effort xhigh')
    assert.ok(
      hasFlagWithValue(args, '--settings', JSON.stringify({ ultracode: true })),
      'ultracode must enable the ultracode session setting via --settings',
    )
    // The raw, CLI-rejected value must never reach --effort.
    assert.equal(hasFlagWithValue(args, '--effort', 'ultracode'), false)
  })

  it('omits --effort when effortLevel is falsy (model default)', () => {
    for (const e of [null, undefined, '']) {
      const args = buildClaudeCliArgs({ effortLevel: e as string | undefined })
      assert.equal(args.includes('--effort'), false, `effort=${String(e)} should not emit --effort`)
    }
  })

  it('appends optional flags as adjacent flag/value pairs when provided', () => {
    const args = buildClaudeCliArgs({
      model: 'claude-opus-4-6',
      effortLevel: 'max',
      permissionMode: 'bypassPermissions',
      extraPromptFile: '/tmp/prompt.md',
      mcpConfigFile: '/tmp/mcp.json',
      addDir: '/var/data/agents/main',
      resumeSessionId: 'sess-abc123',
    })
    assert.ok(hasFlagWithValue(args, '--model', 'claude-opus-4-6'))
    assert.ok(hasFlagWithValue(args, '--effort', 'max'))
    assert.ok(hasFlagWithValue(args, '--permission-mode', 'bypassPermissions'))
    assert.ok(args.includes('--dangerously-skip-permissions'))
    assert.ok(hasFlagWithValue(args, '--permission-prompt-tool', 'stdio'))
    assert.ok(hasFlagWithValue(args, '--append-system-prompt-file', '/tmp/prompt.md'))
    assert.ok(hasFlagWithValue(args, '--mcp-config', '/tmp/mcp.json'))
    assert.ok(hasFlagWithValue(args, '--add-dir', '/var/data/agents/main'))
    assert.ok(hasFlagWithValue(args, '--resume', 'sess-abc123'))
    // No trailing empty positional — stream-json reads the prompt from stdin.
    assert.notEqual(args[args.length - 1], '')
  })

  it('omits --resume when resumeSessionId is null/undefined/empty', () => {
    for (const sid of [null, undefined, '']) {
      const args = buildClaudeCliArgs({ resumeSessionId: sid })
      assert.equal(args.includes('--resume'), false, `resumeSessionId=${String(sid)} → no --resume`)
    }
  })

  it('omits optional flags entirely when their values are falsy', () => {
    const args = buildClaudeCliArgs({})
    for (const flag of [
      '--model',
      '--effort',
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

  it('puts --add-dir last so its variadic arg never swallows stray tokens', () => {
    // Official claude declares `--add-dir <directories...>` variadic; if any
    // token followed it (e.g. an old trailing '' prompt placeholder) it would be
    // eaten as an empty dir and warned on ("Please provide a directory path.").
    const args = buildClaudeCliArgs({
      addDir: '/var/data/agents/main',
      resumeSessionId: 'x',
      mcpConfigFile: '/tmp/mcp.json',
    })
    assert.equal(args[args.length - 2], '--add-dir')
    assert.equal(args[args.length - 1], '/var/data/agents/main')
  })
})
