/**
 * Pure protocol contract tests for `packages/protocol/src/swarm.ts` (OCV5-852).
 *
 * Run: npx tsx --test packages/protocol/src/__tests__/swarm.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type SwarmSnapshot,
  compactSwarmSnapshotToByteBudget,
  extractSwarmMentions,
  isSwarmSnapshot,
  mergeSwarmSnapshotsStrict,
  parseSwarmSlashCommand,
} from '../swarm.js'

describe('parseSwarmSlashCommand', () => {
  it('matches /swarm and /swarm-playbook with or without task text and rejects lookalikes', () => {
    assert.deepEqual(parseSwarmSlashCommand('/swarm'), { matched: true, task: '' })
    assert.deepEqual(parseSwarmSlashCommand('  /SWARM  '), { matched: true, task: '' })
    assert.deepEqual(parseSwarmSlashCommand('/swarm 重构状态机'), { matched: true, task: '重构状态机' })
    assert.deepEqual(parseSwarmSlashCommand('/swarm-playbook'), { matched: true, task: '' })
    assert.deepEqual(parseSwarmSlashCommand('/SWARM-PLAYBOOK 架构深度体检 审查鉴权'), {
      matched: true,
      task: '架构深度体检 审查鉴权',
    })
    assert.deepEqual(parseSwarmSlashCommand('/swarm-playbook\nline1\nline2'), {
      matched: true,
      task: 'line1\nline2',
    })

    assert.equal(parseSwarmSlashCommand('/swarming hello'), null)
    assert.equal(parseSwarmSlashCommand('/swarm-playbooks test'), null)
    assert.equal(parseSwarmSlashCommand('/swarm-steer @worker hi'), null)
    assert.equal(parseSwarmSlashCommand('please run /swarm'), null)
    assert.equal(parseSwarmSlashCommand(''), null)
  })
})

describe('SwarmMemberSnapshot backwards-compatible optional telemetry & workspace fields', () => {
  it('accepts legacy snapshots missing optional fields and preserves new fields across merge & compaction', () => {
    const legacySnap: SwarmSnapshot = {
      swarmId: '11111111-1111-4111-8111-111111111111',
      title: 'Legacy',
      phase: 'running',
      revision: 1,
      updatedAt: 1000,
      members: [
        {
          name: 'coordinator',
          role: 'coordinator',
          status: 'waiting',
          stepCount: 2,
          unreadCount: 0,
        },
      ],
      channels: [{ name: 'main', memberCount: 1, postCount: 0 }],
      posts: [],
      totalPosts: 0,
    }
    assert.equal(isSwarmSnapshot(legacySnap), true)

    const enrichedSnap: SwarmSnapshot = {
      ...legacySnap,
      revision: 2,
      updatedAt: 2000,
      members: [
        {
          name: 'worker-a',
          role: 'worker',
          status: 'working',
          workspace: 'share',
          workspaceBranch: 'oc-swarm/worker-a',
          workspacePath: '.oc-swarm-worktrees/11111111/worker-a',
          stepCount: 5,
          unreadCount: 0,
          inputTokens: 1200,
          outputTokens: 350,
          cacheReadTokens: 84_000,
          thinkingTokens: 1_950,
          toolCalls: 7,
        },
      ],
      posts: [{ seq: 1, agent: 'worker-a', text: '进度汇报', channel: 'main', mentions: [] }],
      totalPosts: 1,
      postsMode: 'delta',
      deltaBaseSeq: 0,
    }
    assert.equal(isSwarmSnapshot(enrichedSnap), true)

    const merged = mergeSwarmSnapshotsStrict(legacySnap, enrichedSnap)
    assert.equal(merged.ok, true)
    if (merged.ok) {
      const w = merged.snapshot.members[0]!
      assert.equal(w.cacheReadTokens, 84_000)
      assert.equal(w.thinkingTokens, 1_950)
      assert.equal(w.workspaceBranch, 'oc-swarm/worker-a')
      assert.equal(w.workspacePath, '.oc-swarm-worktrees/11111111/worker-a')
    }

    const compacted = compactSwarmSnapshotToByteBudget(enrichedSnap, 13_000)
    assert.equal(compacted.members[0]?.cacheReadTokens, 84_000)
    assert.equal(compacted.members[0]?.thinkingTokens, 1_950)
    assert.equal(compacted.members[0]?.workspaceBranch, 'oc-swarm/worker-a')
    assert.equal(compacted.members[0]?.workspacePath, '.oc-swarm-worktrees/11111111/worker-a')
  })
})

describe('extractSwarmMentions (OCV5-932 Defect #3A)', () => {
  it('extracts @b1-integrator from real #48 handoff text while ignoring `@openclaude/protocol` and scoped paths', () => {
    const post48 = [
      '@b1-integrator [done] 前端切片已完成，契约对齐 `` `@openclaude/protocol` `` 与 `@openclaude/protocol` 导出。',
      '同时检查了 @openclaude/protocol/browser、@sinclair/typebox 与 @types/node 类型引用，请 @b1-integrator 处理合入。',
    ].join('\n')
    assert.deepEqual(extractSwarmMentions(post48), ['b1-integrator'])
  })

  it('strips triple-backtick and tilde fenced code blocks and inline code spans before matching mentions', () => {
    const fenced = [
      '请 @verifier 复核以下示例（不要唤醒代码里的成员）：',
      '```ts',
      '// @all @coordinator @worker-1',
      'const pkg = "@openclaude/protocol"',
      '```',
      '~~~bash',
      'echo "@all @slice-gw-wake"',
      '~~~',
      '> ```json',
      '> { "mention": "@coordinator" }',
      '> ```',
      '行内代码 `@worker`、`foo @all bar` 以及 ```@worker-2``` 同样不应触发提及。',
    ].join('\n')
    assert.deepEqual(extractSwarmMentions(fenced), ['verifier'])
  })

  it('rejects plain npm scoped packages and emails while preserving valid mentions & Chinese punctuation', () => {
    assert.deepEqual(
      extractSwarmMentions('依赖 @openclaude/protocol, @sinclair/typebox, @types/node, @scope/pkg-a/sub'),
      [],
    )
    assert.deepEqual(
      extractSwarmMentions('联系 a.b@example.com 或 dev+ops@company.org 或 foo_bar@test.io'),
      [],
    )
    assert.deepEqual(
      extractSwarmMentions(
        '请 @b1-integrator 处理；抄送（@worker、@worker-1）与请@coordinator确认 @all 广播到 @#channel-1.',
      ),
      ['b1-integrator', 'worker', 'worker-1', 'coordinator', 'all', '#channel-1'],
    )
  })

  it('processes adversarial unmatched backticks in linear time without catastrophic backtracking', () => {
    const pathological = `${Array.from({ length: 1500 }, (_, i) => '`'.repeat((i % 4) + 1)).join('x')} @b1-integrator`
    const t0 = Date.now()
    const mentions = extractSwarmMentions(pathological)
    const elapsed = Date.now() - t0
    assert.equal(mentions.includes('b1-integrator'), true)
    assert.equal(elapsed < 200, true)
  })
})
