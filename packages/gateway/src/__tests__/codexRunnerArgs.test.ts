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
import { buildCodexCliArgs, codexReasoningEffortConfig } from '../codexRunner.js'

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

  // ── v1.0.200 — reasoning effort (gpt-5.5 / codex models) ──────────────────
  //
  // effort 从前端单独通道 (RESEARCH slot) 改成 codex argv 主通道,理由:
  //   - codex CLI 接受 `-c model_reasoning_effort="<low|medium|high|xhigh>"`,
  //     比往 prompt 里塞 hint 更可靠;
  //   - app-server 与 exec 两条 spawn 路径要共用同一个归一规则,helper 抽出来。
  //
  // 这里测的是 effortLevel → argv 的纯映射:
  //   - 直通档位 low/medium/high/xhigh 原样发;
  //   - `max` 是协议级遗留,显式映射成 codex 的最高档 xhigh(不是默默丢);
  //   - undefined / 非法值 → 空数组(让 codex 用 CLI 默认)。
  it('effortLevel=low → argv contains -c model_reasoning_effort="low"', () => {
    const args = buildCodexCliArgs({ effortLevel: 'low' })
    const idx = args.indexOf('model_reasoning_effort="low"')
    assert.ok(idx >= 0, `expected effort -c slot; got ${args.join(' ')}`)
    assert.equal(args[idx - 1], '-c')
  })

  it('effortLevel=medium → argv contains -c model_reasoning_effort="medium"', () => {
    const args = buildCodexCliArgs({ effortLevel: 'medium' })
    const idx = args.indexOf('model_reasoning_effort="medium"')
    assert.ok(idx >= 0, `expected effort -c slot; got ${args.join(' ')}`)
    assert.equal(args[idx - 1], '-c')
  })

  it('effortLevel=high / xhigh pass through verbatim', () => {
    const high = buildCodexCliArgs({ effortLevel: 'high' })
    assert.ok(high.includes('model_reasoning_effort="high"'))
    const xhigh = buildCodexCliArgs({ effortLevel: 'xhigh' })
    assert.ok(xhigh.includes('model_reasoning_effort="xhigh"'))
  })

  it('effortLevel=max → explicit map to xhigh (NOT silent ignore)', () => {
    // boss decision per Codex review #2: max 是历史协议值,前端 UI 已不暴露,
    // 但残留 session / agent profile 里可能仍有它。silent ignore 会让用户感知
    // 不到档位掉档,显式映射到 codex 接受的最高档 xhigh 保留意图。
    const args = buildCodexCliArgs({ effortLevel: 'max' })
    assert.ok(
      args.includes('model_reasoning_effort="xhigh"'),
      `max must map to xhigh; got ${args.join(' ')}`,
    )
    assert.ok(!args.includes('model_reasoning_effort="max"'))
  })

  it('effortLevel undefined / null / "" / unknown → no effort arg', () => {
    for (const v of [undefined, null, '', 'minimal', 'none', 'turbo'] as const) {
      const args = buildCodexCliArgs({ effortLevel: v as any })
      assert.ok(
        !args.some((a) => typeof a === 'string' && a.startsWith('model_reasoning_effort=')),
        `effortLevel=${String(v)} must produce no effort arg; got ${args.join(' ')}`,
      )
    }
  })

  it('effortLevel=medium + threadId → full positional order: flags → effort → threadId → -', () => {
    const args = buildCodexCliArgs({ effortLevel: 'medium', threadId: 'thread_xyz' })
    assert.deepEqual(args, [
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--full-auto',
      '-c',
      'approval_policy="never"',
      '-c',
      'model_reasoning_effort="medium"',
      'thread_xyz',
      '-',
    ])
  })

  it('effort arg precedes positional threadId / stdin sentinel', () => {
    const args = buildCodexCliArgs({ effortLevel: 'high', threadId: 'thr_p' })
    const effortIdx = args.indexOf('model_reasoning_effort="high"')
    const tidIdx = args.indexOf('thr_p')
    const dashIdx = args.lastIndexOf('-')
    assert.ok(effortIdx > 0 && tidIdx > effortIdx && dashIdx > tidIdx)
  })
})

describe('codexReasoningEffortConfig', () => {
  it('returns empty array for missing / empty / invalid input', () => {
    assert.deepEqual(codexReasoningEffortConfig(undefined), [])
    assert.deepEqual(codexReasoningEffortConfig(null), [])
    assert.deepEqual(codexReasoningEffortConfig(''), [])
    assert.deepEqual(codexReasoningEffortConfig('turbo'), [])
    assert.deepEqual(codexReasoningEffortConfig('minimal'), [])
  })

  it('returns -c slot for direct levels', () => {
    assert.deepEqual(codexReasoningEffortConfig('low'), ['-c', 'model_reasoning_effort="low"'])
    assert.deepEqual(codexReasoningEffortConfig('medium'), [
      '-c',
      'model_reasoning_effort="medium"',
    ])
    assert.deepEqual(codexReasoningEffortConfig('high'), ['-c', 'model_reasoning_effort="high"'])
    assert.deepEqual(codexReasoningEffortConfig('xhigh'), ['-c', 'model_reasoning_effort="xhigh"'])
  })

  it('max → xhigh explicit map', () => {
    assert.deepEqual(codexReasoningEffortConfig('max'), ['-c', 'model_reasoning_effort="xhigh"'])
  })
})
