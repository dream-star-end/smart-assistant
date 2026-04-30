import * as assert from 'node:assert/strict'
/**
 * Regression tests for `buildCodexCliArgs` — pure argv builder used by
 * `CodexRunner.runTurn()` to spawn `codex exec [resume]`.
 *
 * Load-bearing invariants:
 *   1. `--dangerously-bypass-approvals-and-sandbox` is present on BOTH the
 *      fresh `exec` and the multi-turn `exec resume` paths. If this regresses,
 *      codex falls back to its default sandbox + approval policy and silently
 *      blocks any model action that escapes the workspace — there is no UI to
 *      surface or answer the resulting prompt.
 *   2. Neither `--full-auto` nor `-c approval_policy=...` appear; both are
 *      redundant or conflicting once bypass is set, and historical versions
 *      mixed them in a way that masked which knob was actually in effect.
 *   3. Resume path puts the threadId after the flag list, before the trailing
 *      `-` (stdin sentinel). Codex's resume subcommand parses positionally —
 *      argv reordering caused multi-turn breakage in the past.
 */
import { describe, it } from 'node:test'
import { buildCodexCliArgs } from '../codexRunner.js'

describe('buildCodexCliArgs', () => {
  it('fresh-exec path includes the bypass flag and no legacy permission flags', () => {
    const args = buildCodexCliArgs({})
    assert.deepEqual(args, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ])
  })

  it('resume path includes the bypass flag and threadId comes before stdin sentinel', () => {
    const args = buildCodexCliArgs({ threadId: 'thread_abc' })
    assert.deepEqual(args, [
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'thread_abc',
      '-',
    ])
  })

  it('model is appended via --model when provided', () => {
    const args = buildCodexCliArgs({ model: 'gpt-5.5' })
    assert.ok(
      args.indexOf('--model') >= 0 && args[args.indexOf('--model') + 1] === 'gpt-5.5',
      `expected --model gpt-5.5 in args, got ${args.join(' ')}`,
    )
  })

  it('never emits --full-auto or approval_policy override (replaced by bypass)', () => {
    for (const opts of [{}, { threadId: 't1' }, { model: 'gpt-5.5' }, { model: 'x', threadId: 'y' }]) {
      const args = buildCodexCliArgs(opts)
      assert.equal(args.includes('--full-auto'), false, `--full-auto should be gone (${JSON.stringify(opts)})`)
      assert.equal(
        args.some((a) => a.includes('approval_policy')),
        false,
        `approval_policy override should be gone (${JSON.stringify(opts)})`,
      )
    }
  })
})
