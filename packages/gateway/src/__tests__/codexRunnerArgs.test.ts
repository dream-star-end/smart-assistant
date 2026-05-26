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

  it('extraConfig argv splices BEFORE positional args (threadId / stdin sentinel)', () => {
    // Platform context injection appends `-c key=value` pairs that must
    // precede the positional args clap parses last (threadId for resume,
    // `-` for stdin). If a future refactor moves them after the positional,
    // codex's resume parser would mis-attribute them.
    const args = buildCodexCliArgs({
      threadId: 'thr_x',
      extraConfig: ['-c', 'model_instructions_file="/tmp/x.md"'],
    })
    const dashIdx = args.indexOf('-')
    const tidIdx = args.indexOf('thr_x')
    const cIdx = args.indexOf('-c')
    assert.ok(
      cIdx >= 0 && tidIdx >= 0 && dashIdx >= 0,
      `expected all positions, got ${args.join(' ')}`,
    )
    assert.ok(cIdx < tidIdx, '-c override must precede threadId')
    assert.ok(tidIdx < dashIdx, 'threadId must precede stdin sentinel')
  })

  it('extraConfig argv splices BEFORE the `-` stdin sentinel on fresh exec', () => {
    const args = buildCodexCliArgs({ extraConfig: ['-c', 'k=v'] })
    const dashIdx = args.indexOf('-')
    const cIdx = args.indexOf('-c')
    assert.ok(cIdx >= 0 && dashIdx >= 0)
    assert.ok(cIdx < dashIdx, '-c override must precede stdin sentinel')
  })

  it('extraConfig empty/undefined produces same argv as omitted', () => {
    const a = buildCodexCliArgs({})
    const b = buildCodexCliArgs({ extraConfig: [] })
    const c = buildCodexCliArgs({ extraConfig: undefined })
    assert.deepEqual(a, b)
    assert.deepEqual(a, c)
  })

  it('never emits --full-auto or approval_policy override (replaced by bypass)', () => {
    for (const opts of [
      {},
      { threadId: 't1' },
      { model: 'gpt-5.5' },
      { model: 'x', threadId: 'y' },
    ]) {
      const args = buildCodexCliArgs(opts)
      assert.equal(
        args.includes('--full-auto'),
        false,
        `--full-auto should be gone (${JSON.stringify(opts)})`,
      )
      assert.equal(
        args.some((a) => a.includes('approval_policy')),
        false,
        `approval_policy override should be gone (${JSON.stringify(opts)})`,
      )
    }
  })
})
