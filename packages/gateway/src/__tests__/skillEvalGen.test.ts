/**
 * AI 生成评测用例的行为测试:纯逻辑(query/摘录/解析/归一化/提示语)+ 轻量 job 状态机
 * (启动/排他/完成/失败/重启收敛/跨 store 互斥查询)。
 *
 * Run:
 *   npx tsx --test packages/gateway/src/__tests__/skillEvalGen.test.ts
 */
import * as assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-evalgen-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  buildSessionSearchQuery,
  buildSessionExcerpt,
  selectUsageSessionHits,
  buildGeneratePrompt,
  parseGeneratedCasesJson,
  normalizeGeneratedCases,
  finalizeGeneratedCases,
  buildGenerationNote,
} = await import('../skillEvalGen.js')
const { SkillEvalGenJobStore } = await import('../skillEvalGenJobs.js')
const { SkillEvalJobStore } = await import('../skillEvalJobs.js')
const { paths } = await import('@openclaude/storage')

const T0 = 1_700_000_000_000

// ── buildSessionSearchQuery ──────────────────────────────────────────────
describe('buildSessionSearchQuery', () => {
  it('OR-joins name + hyphen-split + description keywords, drops short/operator tokens', () => {
    const q = buildSessionSearchQuery('deploy-flow', '把项目 部署 到 or 生产环境')
    const terms = q.split(' OR ')
    assert.ok(terms.includes('deploy-flow'))
    assert.ok(terms.includes('deploy'))
    assert.ok(terms.includes('flow'))
    assert.ok(terms.includes('部署'))
    assert.ok(terms.includes('生产环境'))
    // 单字符 "到" 被丢;FTS 运算符 "or" 被丢(避免误当运算符)。
    assert.ok(!terms.includes('到'))
    assert.ok(!terms.includes('or'))
    // 关键词间用大写 OR 连接(FTS 运算符)。
    assert.ok(q.includes(' OR '))
  })

  it('returns empty string when nothing usable', () => {
    assert.equal(buildSessionSearchQuery('a', ''), '') // 单字符名不入选
  })
})

// ── buildSessionExcerpt ──────────────────────────────────────────────────
describe('buildSessionExcerpt', () => {
  it('labels roles, collapses whitespace, and returns empty on no content', () => {
    assert.equal(buildSessionExcerpt([]), '')
    assert.equal(buildSessionExcerpt([{ role: 'user', content: '  \n ' }]), '')
    const ex = buildSessionExcerpt([
      { role: 'user', content: '帮我  部署\n服务' },
      { role: 'assistant', content: '好的' },
    ])
    assert.equal(ex, '用户: 帮我 部署 服务\n助手: 好的')
  })

  it('truncates to maxChars with ellipsis on the overflowing line', () => {
    const long = 'x'.repeat(500)
    const ex = buildSessionExcerpt([{ role: 'user', content: long }], 100)
    assert.ok(ex.length <= 101) // ≤100 + 省略号
    assert.ok(ex.endsWith('…'))
  })
})

// ── selectUsageSessionHits(有/无会话记录 & 过滤两分支)──────────────────────
describe('selectUsageSessionHits', () => {
  const hit = (over: Partial<{ channel: string; lastAt: number; sessionId: string }>) => ({
    sessionId: over.sessionId ?? 's',
    channel: over.channel ?? 'webchat',
    title: 't',
    lastAt: over.lastAt ?? T0,
  })

  it('keeps recent non-eval sessions and drops old / eval-train channels', () => {
    const now = T0 + 40 * 24 * 60 * 60 * 1000 // 距 T0 已 40 天
    const hits = [
      hit({ sessionId: 'recent', lastAt: now - 1000 }),
      hit({ sessionId: 'old', lastAt: T0 }), // 40 天前 → 超 30 天窗口
      hit({ sessionId: 'evalnoise', channel: 'skill-eval', lastAt: now }),
      hit({ sessionId: 'gennoise', channel: 'skill-eval-gen', lastAt: now }),
      hit({ sessionId: 'unknown', lastAt: 0 }), // 时间未知 → 不因时间排除
    ]
    const kept = selectUsageSessionHits(hits, now).map((h) => h.sessionId)
    assert.deepEqual(kept, ['recent', 'unknown'])
  })

  it('caps at max', () => {
    const hits = Array.from({ length: 10 }, (_, i) => hit({ sessionId: `s${i}`, lastAt: T0 }))
    assert.equal(selectUsageSessionHits(hits, T0, 3).length, 3)
  })

  it('empty in → empty out (无会话记录分支)', () => {
    assert.deepEqual(selectUsageSessionHits([], T0), [])
  })
})

// ── buildGeneratePrompt(素材有/无两分支)────────────────────────────────────
describe('buildGeneratePrompt', () => {
  const base = { skillName: 'deploy-flow', description: '部署流程', skillMd: '# SKILL body' }

  it('includes real-usage excerpts when present', () => {
    const p = buildGeneratePrompt({
      ...base,
      existingCases: [],
      excerpts: [{ title: '发布', text: '用户: 帮我部署' }],
    })
    assert.ok(p.includes('真实使用会话摘录'))
    assert.ok(p.includes('用户: 帮我部署'))
    assert.ok(!p.includes('无真实使用记录'))
    assert.ok(p.includes('# SKILL body'))
  })

  it('degrades to declared-scenario note when no excerpts, and lists existing cases', () => {
    const p = buildGeneratePrompt({
      ...base,
      existingCases: [{ id: 'a', prompt: '现有任务A', assertions: ['x'] }],
      excerpts: [],
    })
    assert.ok(p.includes('无真实使用记录'))
    assert.ok(p.includes('场景不重复'))
    assert.ok(p.includes('现有任务A'))
  })
})

// ── parseGeneratedCasesJson(宽容解析)+ finalize(过格式权威 / 拒坏格式)──────
describe('parse + finalize generated cases', () => {
  it('parses fenced {cases:[…]} with surrounding prose', () => {
    const text = `好的:\n\`\`\`json\n{"cases":[{"prompt":"任务1","assertions":["断言1"]},{"id":"ignored","prompt":"任务2","assertions":["断言2","断言3"],"expectedOutput":"参考"}]}\n\`\`\`\n完毕`
    const raw = parseGeneratedCasesJson(text)
    assert.ok(raw)
    assert.equal(raw?.length, 2)
  })

  it('falls back to a bare top-level array', () => {
    const raw = parseGeneratedCasesJson('[{"prompt":"p","assertions":["a"]}]')
    assert.ok(raw)
    assert.equal(raw?.length, 1)
  })

  it('returns null on garbage', () => {
    assert.equal(parseGeneratedCasesJson('no json at all'), null)
  })

  it('finalize: happy path normalizes ids to gen-1.. and passes parseSkillEvalsJson', () => {
    const text = `{"cases":[{"id":"whatever","prompt":"任务1","assertions":["断言1"]},{"prompt":"任务2","assertions":["断言2"]}]}`
    const r = finalizeGeneratedCases(text, [])
    assert.ok(r.ok)
    if (r.ok) {
      assert.deepEqual(
        r.cases.map((c) => c.id),
        ['gen-1', 'gen-2'],
      )
      assert.equal(r.cases[0].prompt, '任务1')
    }
  })

  it('finalize: bad format → ok:false with reason', () => {
    const r = finalizeGeneratedCases('garbage', [])
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /无法解析/)
  })

  it('finalize: all entries unusable (no assertions) → ok:false', () => {
    const r = finalizeGeneratedCases('{"cases":[{"prompt":"p"}]}', [])
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /没有可用用例/)
  })
})

// ── normalizeGeneratedCases(id 不撞现有 + 丢弃/封顶)────────────────────────
describe('normalizeGeneratedCases', () => {
  it('assigns gen-N skipping existing ids, drops promptless/assertionless, caps counts', () => {
    const raw = [
      { prompt: '有效1', assertions: ['a'] },
      { prompt: '', assertions: ['a'] }, // 无 prompt → 丢
      { prompt: '无断言', assertions: [] }, // 无断言 → 丢
      { prompt: '有效2', assertions: Array.from({ length: 12 }, (_, i) => `a${i}`) }, // 断言封顶 8
      { prompt: '有效3', assertions: ['a'] },
    ]
    // 现有已占 gen-1、gen-2 → 新分配从 gen-3 起。
    const out = normalizeGeneratedCases(raw, ['gen-1', 'gen-2'])
    assert.deepEqual(
      out.map((c) => c.id),
      ['gen-3', 'gen-4', 'gen-5'],
    )
    assert.equal(out[1].assertions.length, 8) // MAX_EVAL_ASSERTIONS
  })

  it('caps generated cases at MAX_EVAL_CASES (5)', () => {
    const raw = Array.from({ length: 9 }, (_, i) => ({ prompt: `p${i}`, assertions: ['a'] }))
    assert.equal(normalizeGeneratedCases(raw, []).length, 5)
  })
})

// ── buildGenerationNote ──────────────────────────────────────────────────
describe('buildGenerationNote', () => {
  it('mentions real-usage source when excerpts used', () => {
    const n = buildGenerationNote({ excerptCount: 3, existingCount: 0, generatedCount: 4 })
    assert.match(n, /参考 3 段真实使用记录/)
  })
  it('mentions declared-scenario derivation when no excerpts', () => {
    const n = buildGenerationNote({ excerptCount: 0, existingCount: 0, generatedCount: 3 })
    assert.match(n, /按技能声明的场景推导/)
  })
  it('warns when existing + generated exceed the cap', () => {
    const n = buildGenerationNote({ excerptCount: 1, existingCount: 4, generatedCount: 4 })
    assert.match(n, /上限 5/)
    assert.match(n, /酌情删减/)
  })
  it('no merge warning when total within cap', () => {
    const n = buildGenerationNote({ excerptCount: 1, existingCount: 2, generatedCount: 2 })
    assert.doesNotMatch(n, /删减/)
  })
})

// ── SkillEvalGenJobStore 状态机 ───────────────────────────────────────────
async function fresh(store: any, runId: string, skillName = 'deploy-flow') {
  return store.create({ runId, skillName, userId: 'u1', model: 'deepseek-v4-pro', now: T0 })
}

describe('SkillEvalGenJobStore concurrency + lifecycle', () => {
  it('caps concurrency and forbids two active runs on same skill', async () => {
    const store = new SkillEvalGenJobStore({ maxConcurrent: 1 })
    await fresh(store, 'gen-r1', 'skill-a')
    assert.equal(store.canStart('skill-a').ok, false) // same skill busy
    assert.equal(store.canStart('skill-b').ok, false) // global cap reached (1)
    assert.equal(store.activeForSkill('skill-a'), true)
    assert.equal(store.activeForSkill('skill-b'), false)
  })

  it('finishDone/finishFailed terminalize and free the skill', async () => {
    const store = new SkillEvalGenJobStore({ maxConcurrent: 1 })
    const r = await fresh(store, 'gen-done', 'skill-a')
    await store.finishDone(r, T0 + 1, { cases: [{ id: 'gen-1', prompt: 'p', assertions: ['a'] }], note: 'ok' })
    assert.equal(store.get('gen-done')?.status, 'done')
    assert.equal(store.get('gen-done')?.cases.length, 1)
    assert.equal(store.activeForSkill('skill-a'), false)
    assert.equal(store.canStart('skill-a').ok, true) // freed

    const r2 = await fresh(store, 'gen-fail', 'skill-b')
    await store.finishFailed(r2, T0 + 2, '生成失败原因')
    assert.equal(store.get('gen-fail')?.status, 'failed')
    assert.equal(store.get('gen-fail')?.note, '生成失败原因')
    assert.equal(store.activeForSkill('skill-b'), false)
  })

  it('persists gen-<runId>.json and reconciles active → failed on reload', async () => {
    const store = new SkillEvalGenJobStore()
    await fresh(store, 'gen-persist', 'skill-x')
    assert.equal(existsSync(join(paths.skillEvalsDir, 'gen-persist.json')), true)

    const reloaded = new SkillEvalGenJobStore()
    await reloaded.loadAll(T0 + 100)
    const r = reloaded.get('gen-persist')
    assert.ok(r)
    assert.equal(r?.status, 'failed') // running 时进程没了 → 如实 failed
    assert.match(r?.note ?? '', /restarted/)
    assert.equal(r?.finishedAt, T0 + 100)
  })

  it('reload keeps a terminal (done) run intact', async () => {
    const store = new SkillEvalGenJobStore()
    const r = await fresh(store, 'gen-terminal', 'skill-y')
    await store.finishDone(r, T0 + 1, { cases: [], note: 'done note' })
    const reloaded = new SkillEvalGenJobStore()
    await reloaded.loadAll(T0 + 100)
    assert.equal(reloaded.get('gen-terminal')?.status, 'done')
    assert.equal(reloaded.get('gen-terminal')?.note, 'done note')
  })

  it('gen flat files coexist with eval run subdirs without cross-pickup', async () => {
    // 评测 run 写 <runId>/run.json 子目录;生成写 gen-<runId>.json 平铺文件。
    // 两者 loadAll 互不误捡。
    const evalStore = new SkillEvalJobStore({ maxConcurrent: 1 })
    await evalStore.create({
      runId: 'eval-abc',
      skillName: 'skill-z',
      userId: 'u1',
      mode: 'baseline',
      model: 'deepseek-v4-pro',
      cases: [{ id: 'c1', prompt: 'p', assertions: ['a'] }],
      now: T0,
    })
    const genStore = new SkillEvalGenJobStore()
    await fresh(genStore, 'gen-coexist', 'skill-z')

    const entries = await readdir(paths.skillEvalsDir)
    assert.ok(entries.includes('gen-coexist.json')) // 生成平铺文件
    assert.ok(entries.includes('eval-abc')) // 评测子目录

    // 评测 loadAll 不应把 gen-*.json 当成 run(含 '.' 不过 VALID_RUN_ID_RE)。
    const evalReload = new SkillEvalJobStore()
    await evalReload.loadAll(T0 + 100)
    assert.equal(evalReload.get('gen-coexist'), undefined)
    assert.ok(evalReload.get('eval-abc')) // 评测自己的 run 仍能载回

    // 生成 loadAll 只认 gen-*.json,不误捡评测子目录。
    const genReload = new SkillEvalGenJobStore()
    await genReload.loadAll(T0 + 100)
    assert.ok(genReload.get('gen-coexist'))
    assert.equal(genReload.get('eval-abc'), undefined)
  })
})

// ── 跨 store 互斥:eval 侧 activeForSkill 查询(生成 handler 据此 409)────────
describe('cross-store mutual exclusion query', () => {
  it('eval store exposes activeForSkill for the generate guard', async () => {
    const evalStore = new SkillEvalJobStore({ maxConcurrent: 1 })
    await evalStore.create({
      runId: 'eval-x',
      skillName: 'busy-skill',
      userId: 'u1',
      mode: 'baseline',
      model: 'deepseek-v4-pro',
      cases: [{ id: 'c1', prompt: 'p', assertions: ['a'] }],
      now: T0,
    })
    assert.equal(evalStore.activeForSkill('busy-skill'), true)
    assert.equal(evalStore.activeForSkill('other-skill'), false)
  })
})
