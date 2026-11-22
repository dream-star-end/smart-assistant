/**
 * Pure protocol contract tests for `packages/protocol/src/swarm.ts` (OCV5-852).
 *
 * Run: npx tsx --test packages/protocol/src/__tests__/swarm.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compactSwarmSnapshotToByteBudget,
  isSwarmSnapshot,
  mergeSwarmSnapshotsStrict,
  parseSwarmSlashCommand,
  type SwarmSnapshot,
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
