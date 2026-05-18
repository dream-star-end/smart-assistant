/**
 * Phase 5 — buildRepoSlot 是纯函数,把 RepoSnapshot 翻译成 extra-prompt.md 里的
 * REPO slot。这是 CCB 看到"本会话仓库约束"的唯一权威源,所以契约必须固定:
 *
 *  - null snapshot           → 不出 slot(返 null)
 *  - status:pending/cloning  → 状态文案 + 禁止写仓库内文件
 *  - status:ready            → workspaceDir 必出现 + push 提示 + headSha short
 *  - status:ready 但无 workspaceDir → 不出 slot(状态机不一致兜底)
 *  - status:failed           → errorCode 出现 + 中性化(不指挥用户)
 *
 * 这些行为是 Codex Phase 5 review 多轮 PASS 后的最终契约,改文案前先改测试。
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildRepoSlot, type PromptSlotContext } from '../promptSlots.js'

// RepoSnapshot 不是 promptSlots 的公开 surface(v3 同款),通过 ctx 字段类型推导:
type RepoSnapshot = NonNullable<PromptSlotContext['repoSnapshot']>

const baseSnap: RepoSnapshot = {
  status: 'ready',
  selectionVersion: 1,
  owner: 'octo',
  repo: 'demo',
  branch: 'main',
  workspaceDir: '/home/agent/.openclaude/repos/sess-1/1',
  headSha: '0123456789abcdef0123456789abcdef01234567',
  errorCode: null,
  errorMessage: null,
}

describe('buildRepoSlot', () => {
  it('returns null when no repoSnapshot is provided', () => {
    assert.equal(buildRepoSlot({ agentId: 'a' }), null)
  })

  it('returns null when repoSnapshot is null', () => {
    assert.equal(buildRepoSlot({ agentId: 'a', repoSnapshot: null }), null)
  })

  it('cloning status: emits "正在克隆" + write-forbid hint, NO workspaceDir leak', () => {
    const slot = buildRepoSlot({
      agentId: 'a',
      repoSnapshot: { ...baseSnap, status: 'cloning' },
    })
    assert.ok(slot, 'cloning must emit a slot')
    assert.equal(slot!.name, 'REPO')
    assert.match(slot!.content, /octo\/demo/)
    assert.match(slot!.content, /main/)
    assert.match(slot!.content, /正在克隆/)
    assert.match(slot!.content, /不要.*写操作/)
    // workspaceDir MUST NOT leak in cloning state — CCB shouldn't try to use it.
    assert.equal(slot!.content.includes(baseSnap.workspaceDir!), false)
  })

  it('pending status: same template as cloning (state machine equivalence)', () => {
    const slot = buildRepoSlot({
      agentId: 'a',
      repoSnapshot: { ...baseSnap, status: 'pending', workspaceDir: null },
    })
    assert.ok(slot)
    assert.match(slot!.content, /正在克隆/)
    assert.match(slot!.content, /不要.*写操作/)
  })

  it('ready status with full snapshot: emits workspaceDir + 7-char headSha + push hint', () => {
    const slot = buildRepoSlot({ agentId: 'a', repoSnapshot: baseSnap })
    assert.ok(slot, 'ready must emit a slot')
    assert.equal(slot!.name, 'REPO')
    assert.match(slot!.content, /octo\/demo/)
    assert.match(slot!.content, /HEAD `0123456`/)
    assert.match(slot!.content, /\/home\/agent\/\.openclaude\/repos\/sess-1\/1/)
    assert.match(slot!.content, /git status.*git diff.*git push/)
    assert.match(slot!.content, /credential helper/)
  })

  it('ready status without headSha: emits "?" placeholder, still includes workspaceDir', () => {
    const slot = buildRepoSlot({
      agentId: 'a',
      repoSnapshot: { ...baseSnap, headSha: null },
    })
    assert.ok(slot)
    assert.match(slot!.content, /HEAD `\?`/)
    assert.match(slot!.content, /\/home\/agent\/\.openclaude\/repos\/sess-1\/1/)
  })

  it('ready status WITHOUT workspaceDir: returns null (state-machine inconsistency tripwire)', () => {
    // Defensive: if status=ready but workspaceDir somehow missing, do NOT emit
    // a half-baked slot — CCB would dereference a missing path. Caller must
    // observe "no slot" and decide whether to wait.
    const slot = buildRepoSlot({
      agentId: 'a',
      repoSnapshot: { ...baseSnap, workspaceDir: null },
    })
    assert.equal(slot, null)
  })

  it('failed status with errorCode: emits errorCode in the slot text', () => {
    const slot = buildRepoSlot({
      agentId: 'a',
      repoSnapshot: {
        ...baseSnap,
        status: 'failed',
        workspaceDir: null,
        headSha: null,
        errorCode: 'AUTH_FAILED',
        errorMessage: 'token rejected',
      },
    })
    assert.ok(slot, 'failed must emit a slot')
    assert.match(slot!.content, /克隆失败/)
    assert.match(slot!.content, /AUTH_FAILED/)
    assert.match(slot!.content, /没有可用的仓库工作目录/)
  })

  it('failed status without errorCode: falls back to "unknown"', () => {
    const slot = buildRepoSlot({
      agentId: 'a',
      repoSnapshot: {
        ...baseSnap,
        status: 'failed',
        workspaceDir: null,
        errorCode: null,
      },
    })
    assert.ok(slot)
    assert.match(slot!.content, /unknown/)
  })

  it('failed slot is NEUTRAL: no imperative "请重试" / "请联系" 等指挥语', () => {
    // Codex Phase 5 plan v4: failed slot 不应该指挥 agent 替用户做决定;只陈述事实。
    const slot = buildRepoSlot({
      agentId: 'a',
      repoSnapshot: {
        ...baseSnap,
        status: 'failed',
        workspaceDir: null,
        errorCode: 'NETWORK',
      },
    })
    assert.ok(slot)
    assert.equal(/请重试|请联系|请使用/.test(slot!.content), false)
  })
})
