import * as assert from 'node:assert/strict'
/**
 * Regression tests for `buildCodexCliArgs` — pure argv builder used by
 * `CodexRunner.runTurn()` to spawn `codex exec [resume]`.
 *
 * v3 invariants (differ from master):
 *   1. `--full-auto` is present on BOTH fresh `exec` and `exec resume` paths.
 *      Resume rejects bare `--sandbox`, and `--full-auto` is the only sandbox
 *      flag both subcommands accept.
 *   2. `-c approval_policy="never"` is set so codex never asks for approval —
 *      gateway has no UI to answer (sendPermissionResponse is a no-op).
 *   3. Resume path puts the threadId after the flag list, before the trailing
 *      `-` (stdin sentinel). Codex's resume subcommand parses positionally —
 *      argv reordering caused multi-turn breakage in the past.
 *   4. Phase 1 platform-context overrides splice via `extraConfig` BEFORE the
 *      trailing positionals so codex parses them as `-c key=value` opts, not
 *      as positional resume args.
 */
import { describe, it } from 'node:test'
import { buildCodexCliArgs } from '../codexRunner.js'

describe('buildCodexCliArgs', () => {
  it('fresh-exec path: --full-auto + -c approval_policy="never" + stdin sentinel', () => {
    const args = buildCodexCliArgs({})
    assert.deepEqual(args, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--full-auto',
      '-c',
      'approval_policy="never"',
      '-',
    ])
  })

  it('resume path: same base flags + threadId before stdin sentinel', () => {
    const args = buildCodexCliArgs({ threadId: 'thread_abc' })
    assert.deepEqual(args, [
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--full-auto',
      '-c',
      'approval_policy="never"',
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
    const args = buildCodexCliArgs({
      threadId: 'thr_x',
      extraConfig: ['-c', 'model_instructions_file="/tmp/x.md"'],
    })
    const dashIdx = args.lastIndexOf('-')
    const tidIdx = args.indexOf('thr_x')
    // Platform-context `-c` slot — find by value, not first index, since v3
    // has multiple `-c` slots (approval_policy is also `-c`).
    const miIdx = args.indexOf('model_instructions_file="/tmp/x.md"')
    assert.ok(miIdx >= 0 && tidIdx >= 0 && dashIdx >= 0)
    assert.ok(miIdx < tidIdx, 'platform-context override must precede threadId')
    assert.ok(tidIdx < dashIdx, 'threadId must precede stdin sentinel')
  })

  it('extraConfig argv splices BEFORE the `-` stdin sentinel on fresh exec', () => {
    const args = buildCodexCliArgs({ extraConfig: ['-c', 'k=v'] })
    const dashIdx = args.lastIndexOf('-')
    const kvIdx = args.indexOf('k=v')
    assert.ok(kvIdx >= 0 && dashIdx >= 0)
    assert.ok(kvIdx < dashIdx, 'extra override must precede stdin sentinel')
  })

  it('extraConfig empty/undefined produces same argv as omitted', () => {
    const a = buildCodexCliArgs({})
    const b = buildCodexCliArgs({ extraConfig: [] })
    const c = buildCodexCliArgs({ extraConfig: undefined })
    assert.deepEqual(a, b)
    assert.deepEqual(a, c)
  })

  it('extraConfig preserves v3 approval_policy slot — splice must NOT replace it', () => {
    const args = buildCodexCliArgs({
      extraConfig: ['-c', 'model_instructions_file="/tmp/x.md"'],
    })
    assert.ok(
      args.includes('approval_policy="never"'),
      `v3 approval_policy slot must survive splice; got ${args.join(' ')}`,
    )
    assert.ok(
      args.includes('model_instructions_file="/tmp/x.md"'),
      'platform-context slot must be present after splice',
    )
  })
})
