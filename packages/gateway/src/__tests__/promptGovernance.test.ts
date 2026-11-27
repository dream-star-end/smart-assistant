/**
 * OCV5-840 Pillar 2: Prompt two-tier budgeting, cache prefix hygiene,
 * three-bucket Frecency skills, cross-engine resumed-envelope dedup,
 * bounded transport protection, and Auto-Dream 14-day project TTL / L1 janitor.
 *
 * Run:
 *   npx tsx --test packages/gateway/src/__tests__/promptGovernance.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { GoalStateSnapshot } from '@openclaude/protocol'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-prompt-gov-'))
const BASELINE_SKILLS = join(TEST_HOME, 'platform-skills')
mkdirSync(BASELINE_SKILLS, { recursive: true })
process.env.OPENCLAUDE_HOME = TEST_HOME
process.env.OPENCLAUDE_BASELINE_SKILLS_DIR = BASELINE_SKILLS
process.env.OC_PROJECT_CONTEXT = '1'
delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR
delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
delete process.env.OC_PROMPT_FREEZE
delete process.env.OC_RESUMED_ENVELOPE_DEDUP

const {
  CURSOR_SKILLS_COMPACT,
  MEMORY_INDEX_MAX_BYTES,
  PROJECT_MEMORY_MAX_BYTES,
  SKILLS_DESCRIPTION_MAX_CHARS,
  SKILLS_SLOT_MAX_BYTES,
  SOUL_INJECT_MAX_BYTES,
  buildMemorySlot,
  buildProjectMemorySlot,
  buildPromptContext,
  buildSkillsSlot,
  buildSoulSlot,
  buildToolsSlot,
  enforceGlobalPromptBudget,
  summarizePromptSlotBreakdown,
} = await import('../promptSlots.js')
const { renderCcbGoalPrompt } = await import('../goalPrompt.js')
const { renderDelegateModelSection } = await import('../delegateModelCatalogPrompt.js')
const { resolvePromptFreezeMode } = await import('../promptFreeze.js')
const { cc5RemotePrompt, compileCc5ToolCatalog } = await import('../cc5ToolCatalog.js')
const { buildAntigravityPromptInputsKey } = await import('../engine/antigravityPromptState.js')
const {
  buildResumedEnvelopeInputsKey,
  clearResumedEnvelopeState,
  decideResumedEnvelopeElision,
  invalidateResumedEnvelopeForCompaction,
  resumedEnvelopePreamble,
  writeResumedEnvelopeState,
} = await import('../engine/resumedEnvelopeDedup.js')
const { prepareBoundedPrompt } = await import('../engine/boundedPrompt.js')
const { renderHistoricalContextJsonPrompt } = await import('../historicalContextPrompt.js')
const { AutoDreamService } = await import('../autoDream.js')
const {
  PROJECT_AUTO_MEMORY_TTL_DAYS,
  ProjectMemoryDir,
  ProjectMemoryLedger,
  addCalendarDays,
  recordLocalSkillView,
} = await import('@openclaude/storage')
const { getTaskboardDb, closeTaskboardDb } = await import('../taskboard/db/index.js')
const { ensureProjectById } = await import('../taskboard/db/ensureProject.js')

function utf8(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function writeSkill(dir: string, name: string, description: string, priority?: number): void {
  const skillDir = join(dir, name)
  mkdirSync(skillDir, { recursive: true })
  const prioLine = priority !== undefined ? `priority: ${priority}\n` : ''
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${prioLine}---\n# ${name}\n`,
  )
}

describe('OCV5-840 single-slot UTF-8 budgets & three-bucket skills', () => {
  it('SOUL clips oversized CJK persona to <= 8192 UTF-8 bytes with source path hint', () => {
    const agentId = 'soul-cap-agent'
    const agentDir = join(TEST_HOME, 'agents', agentId)
    mkdirSync(agentDir, { recursive: true })
    const soulFile = join(agentDir, 'SOUL.md')
    const headMarker = 'HEAD_IDENTITY_RULE_START'
    const tailMarker = 'TAIL_FINAL_GUARD_END'
    writeFileSync(soulFile, `${headMarker}\n${'中'.repeat(5000)}\n${tailMarker}`)

    const slot = buildSoulSlot({ agentId })
    assert.ok(slot)
    assert.ok(utf8(slot.content) <= SOUL_INJECT_MAX_BYTES, `SOUL bytes=${utf8(slot.content)}`)
    assert.ok(slot.content.includes(headMarker), 'head preserved')
    assert.ok(slot.content.includes(tailMarker), 'tail preserved')
    assert.ok(slot.content.includes(soulFile), 'source path hint preserved')
    // Must be valid UTF-8 with no replacement characters
    assert.ok(!slot.content.includes('\uFFFD'))
  })

  it('MEMORY and PROJECT_MEMORY enforce UTF-8 byte limits on CJK indexes', async () => {
    const agentId = 'cjk-mem-cap'
    const root = join(TEST_HOME, 'agents', agentId)
    const memDir = join(root, 'memory')
    mkdirSync(memDir, { recursive: true })
    const rows: string[] = []
    // Each row is ~210 UTF-8 bytes (70 CJK chars) -> 120 rows = ~25 KB UTF-8 > 16 KB
    for (let i = 0; i < 120; i++) {
      const slug = `m${String(i).padStart(3, '0')}.md`
      const desc = `这是第${i}条非常详细的中文核心记忆描述内容用来验证字节预算上限不会膨胀三倍`
      writeFileSync(join(memDir, slug), `---\nname: 记忆${i}\ndescription: ${desc}\ntype: project\n---\n正文\n`)
      rows.push(`- [记忆${i}](memory/${slug}) — ${desc}`)
    }
    writeFileSync(join(root, 'MEMORY.md'), `<!-- oc-memdir-index v1 -->\n${rows.join('\n')}\n`)

    const memSlot = await buildMemorySlot({ agentId, provider: 'ccb' })
    const indexPart = memSlot.content.split('## 当前索引\n\n')[1] ?? ''
    assert.ok(indexPart.length > 0)
    assert.ok(
      utf8(indexPart) <= MEMORY_INDEX_MAX_BYTES,
      `MEMORY index UTF-8 bytes ${utf8(indexPart)} exceeded ${MEMORY_INDEX_MAX_BYTES}`,
    )
    assert.match(indexPart, /索引已截断/)

    const projIndex = Array.from({ length: 80 }, (_, i) => `- [项目${i}](memory/p${i}.md) — ${'项'.repeat(60)}`).join('\n')
    const projSlot = await buildProjectMemorySlot({
      agentId,
      provider: 'ccb',
      frozenProjectContext: {
        boardProjectId: '22222222-2222-4222-8222-222222222222',
        bound: true,
        contextVersion: 1,
        assetsRevision: 0,
        assets: [],
        workspaceSpec: null,
        workspaceCwd: null,
        cwdSource: null,
        instructions: null,
        projectMdSha256: null,
        skills: [],
        skillManifestSha256: '0'.repeat(64),
        officialMemory: [],
        officialMemoryIndex: projIndex,
        officialMemoryManifestSha256: null,
      },
    })
    assert.ok(projSlot)
    const projIndexPart = projSlot.content.split('## 项目索引\n\n')[1] ?? ''
    assert.ok(
      utf8(projIndexPart) <= PROJECT_MEMORY_MAX_BYTES,
      `PROJECT_MEMORY index UTF-8 bytes ${utf8(projIndexPart)} exceeded ${PROJECT_MEMORY_MAX_BYTES}`,
    )
  })

  it('three-bucket SKILLS prevents user skills from evicting platform skills, ranks user skills by Frecency, and caps at 3600B', async () => {
    const agentId = 'bucket-skills-agent'
    // Seed 8 platform skills (priorities 90..20)
    for (let i = 0; i < 8; i++) {
      writeSkill(BASELINE_SKILLS, `plat-core-${i}`, `Platform core capability ${i} ${'x'.repeat(220)}`, 90 - i * 10)
    }
    // Seed 25 user skills alphabetically a..y plus a hot 'zzz-hot-skill'
    const userSkillsDir = join(TEST_HOME, 'agents', agentId, 'skills')
    for (let i = 0; i < 20; i++) {
      const prefix = String.fromCharCode(97 + i)
      writeSkill(userSkillsDir, `${prefix}-cold-user-${i}`, `Cold user skill ${i} ${'描'.repeat(100)}`)
    }
    writeSkill(userSkillsDir, 'zzz-hot-user', 'Frequently used hot skill that must beat alphabetical cold skills')

    const now = Date.now()
    const usageMap = new Map([
      ['zzz-hot-user', { useCount: 15, searchHitCount: 5, lastUsedAt: now - 3600_000, lastSearchHitAt: now }],
    ])
    const slot = await buildSkillsSlot({
      agentId,
      provider: 'ccb',
      skillUsageMap: usageMap,
      frozenProjectContext: {
        boardProjectId: '33333333-3333-4333-8333-333333333333',
        bound: true,
        contextVersion: 1,
        assetsRevision: 0,
        assets: [],
        workspaceSpec: null,
        workspaceCwd: null,
        cwdSource: null,
        instructions: null,
        projectMdSha256: null,
        skills: [
          { name: 'proj-alpha', description: 'Bound project skill alpha', files: [], treeSha256: '0'.repeat(64), skillMd: '' },
          { name: 'proj-beta', description: 'Bound project skill beta', files: [], treeSha256: '0'.repeat(64), skillMd: '' },
        ],
        skillManifestSha256: '0'.repeat(64),
        officialMemory: [],
        officialMemoryIndex: null,
        officialMemoryManifestSha256: null,
      },
    })
    assert.ok(slot)
    assert.ok(utf8(slot.content) <= SKILLS_SLOT_MAX_BYTES, `SKILLS bytes=${utf8(slot.content)}`)
    // Project skills present
    assert.ok(slot.content.includes('**proj-alpha**'))
    // Platform core top skills NOT evicted by 21 user skills
    assert.ok(slot.content.includes('**plat-core-0**'))
    assert.ok(slot.content.includes('**plat-core-1**'))
    // Hot user skill beats alphabetical cold user skills
    assert.ok(slot.content.includes('**zzz-hot-user**'))
    // Each rendered description line obeys <= 160 chars description cap
    for (const line of slot.content.split('\n').filter((l) => l.startsWith('- **'))) {
      const desc = line.split(' — ')[1] ?? ''
      assert.ok(desc.length <= SKILLS_DESCRIPTION_MAX_CHARS, `desc len=${desc.length}`)
    }
  })

  it('TOOLS slot forbids creating skills for one-off troubleshooting', () => {
    const tools = buildToolsSlot({ availableMcpTools: ['skill_search', 'skill_list', 'skill_view', 'skill_save'] })
    assert.match(tools.content, /跨任务重复 ≥2 次/)
    assert.match(tools.content, /禁止建 Skill/)
    assert.doesNotMatch(tools.content, /完成 3\+ 工具调用/)
  })

  it('buildSkillsSlot auto-loads getLocalSkillUsageMap with lowercase key matching and summarizePromptSlotBreakdown aggregates categories', async () => {
    const agentId = 'lower-key-usage-agent'
    const userSkillsDir = join(TEST_HOME, 'agents', agentId, 'skills')
    for (let i = 0; i < 8; i++) {
      const prefix = String.fromCharCode(97 + i)
      writeSkill(userSkillsDir, `${prefix}-cold-item`, `Cold skill ${i}`)
    }
    writeSkill(userSkillsDir, 'Zzz-Mixed-Hot', 'Mixed-case skill heated via local SQLite usage ledger')
    await recordLocalSkillView('Zzz-Mixed-Hot', 'user')
    await recordLocalSkillView('Zzz-Mixed-Hot', 'user')

    // Omit ctx.skillUsageMap so buildSkillsSlot loads getLocalSkillUsageMap() automatically
    const slot = await buildSkillsSlot({ agentId, provider: 'ccb' })
    assert.ok(slot)
    assert.ok(slot.content.includes('**Zzz-Mixed-Hot**'), 'lowercase usage key must match mixed-case skill name')

    const breakdown = summarizePromptSlotBreakdown([
      { name: 'ENV', bytes: 300 },
      { name: 'SOUL', bytes: 1200 },
      { name: 'AGENTS', bytes: 5000 },
      { name: 'AGENTS_DYNAMIC', bytes: 800 },
      { name: 'TOOLS', bytes: 1500 },
      { name: 'MEMORY', bytes: 1800 },
      { name: 'MEMORY_INDEX', bytes: 4200 },
      { name: 'SKILLS', bytes: 2100 },
      { name: 'SKILLS_LITERATURE', bytes: 900 },
      { name: 'PROJECT', bytes: 2500 },
      { name: 'PROJECT_MEMORY', bytes: 3500 },
    ])
    assert.deepEqual(breakdown, {
      systemBytes: 8800,
      memoryBytes: 6000,
      skillsBytes: 3000,
      projectBytes: 6000,
    })
  })
})

describe('OCV5-840 global budget arbiter & cc5RemotePrompt priority trim', () => {
  it('enforceGlobalPromptBudget degrades low-priority slots in order while preserving REPO/RESEARCH/TOOLS', () => {
    const slots = [
      { name: 'AGENTS', content: `# Platform capabilities\nstatic rules\n\n## 多 Agent 协作\n${'a'.repeat(3000)}` },
      { name: 'SKILLS', content: `# Skills (20)\n${'- **s** [user] — desc\n'.repeat(100)}` },
      { name: 'MEMORY', content: `# Memory\nrules\n\n## 当前索引\n\n${'- [m](memory/m.md) — hook text\n'.repeat(120)}` },
      { name: 'PROJECT_MEMORY', content: `# PROJECT MEMORY\nrules\n\n## 项目索引\n\n${'- [p](memory/p.md) — proj hook\n'.repeat(80)}` },
      { name: 'TOOLS', content: '# 学习系统\nkeep tools' },
      { name: 'RESEARCH', content: '# 科研模式守则\nkeep research' },
      { name: 'REPO', content: '# 当前会话 GitHub 仓库\nkeep repo' },
    ]
    const result = enforceGlobalPromptBudget(slots, -1, 4_500)
    const joined = result.slots.map((s) => s.content).join('\n\n---\n\n')
    assert.ok(utf8(joined) <= 4_500, `degraded bytes=${utf8(joined)}`)
    assert.equal(result.degradedSteps[0], 'skills_l0')
    assert.ok(result.degradedSteps.includes('memory_index_half'))
    assert.ok(joined.includes(CURSOR_SKILLS_COMPACT))
    assert.ok(joined.includes('keep tools'))
    assert.ok(joined.includes('keep research'))
    assert.ok(joined.includes('keep repo'))
  })

  it('cc5RemotePrompt trims low-priority sections instead of slicing off tail REPO/RESEARCH/MODEL_HINT', () => {
    const catalog = compileCc5ToolCatalog([
      { name: 'Bash', description: 'Run shell commands', inputSchema: { type: 'object' } },
    ])
    const platformPrompt = [
      `# Platform capabilities\nstatic rules\n\n## 委派可用型号\n${'m'.repeat(4000)}`,
      `# Skills (20)\n${'- **skill** [user] — desc\n'.repeat(150)}`,
      `# Memory\nrules\n\n## 当前索引\n\n${'- [k](memory/k.md) — memory hook\n'.repeat(150)}`,
      '# 模型行为补丁\nKEEP_MODEL_HINT',
      '# 科研模式守则\nKEEP_RESEARCH',
      '# 当前会话 GitHub 仓库\nKEEP_REPO',
    ].join('\n\n---\n\n')

    const out = cc5RemotePrompt(platformPrompt, catalog, '/workspace', 6_000)
    assert.ok(utf8(out) <= 6_000, `remote prompt bytes=${utf8(out)}`)
    assert.ok(out.includes('KEEP_MODEL_HINT'), 'MODEL_HINT must survive budget trim')
    assert.ok(out.includes('KEEP_RESEARCH'), 'RESEARCH must survive budget trim')
    assert.ok(out.includes('KEEP_REPO'), 'REPO must survive budget trim')
    assert.ok(out.includes('<tool-naming>'))
  })
})

describe('OCV5-840 cache prefix hygiene & promptFreeze defaults', () => {
  it('goalPrompt and delegateModelCatalogPrompt remain byte-identical across volatile metadata churn', () => {
    const baseGoal: GoalStateSnapshot = {
      sessionId: 's1',
      goalId: '11111111-1111-4111-8111-111111111111',
      objective: 'keep cache warm',
      status: 'active',
      tokenBudget: 50000,
      creditBudget: '100',
      tokensUsed: 100,
      creditsUsed: '1',
      timeUsedSeconds: 5,
      stateRevision: 1,
      snapshotRevision: 1,
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
      statusChangedAt: '2026-11-22T00:00:00.000Z',
    }
    const g1 = renderCcbGoalPrompt(baseGoal)
    const g2 = renderCcbGoalPrompt({ ...baseGoal, tokensUsed: 42000, creditsUsed: '88', timeUsedSeconds: 999 })
    assert.equal(g1, g2)
    assert.doesNotMatch(g1, /tokens_used:|credits_used:|time_used_seconds:/)

    const models = [{ modelId: 'deepseek-v4-flash', engine: 'ccb' as const, available: true }]
    const c1 = renderDelegateModelSection({ models, projectionRevision: 'rev-1', verifiedAt: 0 }, {})
    const c2 = renderDelegateModelSection({ models, projectionRevision: 'rev-2', verifiedAt: 12345 }, {})
    assert.equal(c1, c2)
    assert.doesNotMatch(c1, /rev-1|rev-2|已在线核验|仅本地缓存/)
  })

  it('antigravityPromptState ignores AGENTS dynamic catalog churn via static_sha256', async () => {
    const builtA = await buildPromptContext({
      agentId: 'agy-static-test',
      provider: 'antigravity',
      delegateModelCatalog: {
        models: [{ modelId: 'deepseek-v4-flash', engine: 'ccb', available: true }],
        projectionRevision: 'rev-a',
        verifiedAt: 1,
      },
    })
    const builtB = await buildPromptContext({
      agentId: 'agy-static-test',
      provider: 'antigravity',
      delegateModelCatalog: {
        models: [
          { modelId: 'deepseek-v4-flash', engine: 'ccb', available: true },
          { modelId: 'gpt-6-astra', engine: 'codex', available: true },
        ],
        projectionRevision: 'rev-b',
        verifiedAt: 0,
      },
    })
    assert.notEqual(builtA.contentSha256, builtB.contentSha256)
    const keyA = buildAntigravityPromptInputsKey({
      agentId: 'agy-static-test',
      cwd: '/w',
      cwdSource: 'default',
      availableMcpTools: ['skill_view'],
      applied: builtA.applied,
      memoryInstructionsFingerprint: 'mem-v1',
    })
    const keyB = buildAntigravityPromptInputsKey({
      agentId: 'agy-static-test',
      cwd: '/w',
      cwdSource: 'default',
      availableMcpTools: ['skill_view'],
      applied: builtB.applied,
      memoryInstructionsFingerprint: 'mem-v1',
    })
    assert.equal(keyA, keyB, 'AGENTS dynamic model catalog churn must not invalidate Antigravity dedup key')
  })

  it('promptFreeze defaults to enforce while preserving off/shadow kill-switches', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-freeze-default-'))
    try {
      assert.equal(resolvePromptFreezeMode(home, {}), 'enforce')
      assert.equal(resolvePromptFreezeMode(home, { OC_PROMPT_FREEZE: 'off' }), 'off')
      assert.equal(resolvePromptFreezeMode(home, { OC_PROMPT_FREEZE: 'shadow' }), 'shadow')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('OCV5-840 ResumedEnvelopeDedup & bounded transport protection', () => {
  it('elides repeated platform context on resumed turns and self-heals after compaction or flag off', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-dedup-home-'))
    try {
      const sessionKey = 'agent:main:webchat:dm:dedup-test'
      const applied = [
        { name: 'SOUL', bytes: 100, sha256: 'a'.repeat(64) },
        { name: 'AGENTS', bytes: 500, sha256: 'b'.repeat(64), meta: { static_sha256: 'c'.repeat(64) } },
        { name: 'MEMORY', bytes: 2000, sha256: 'd'.repeat(64) },
      ]
      const inputsKey = buildResumedEnvelopeInputsKey({
        engine: 'grok',
        preamble: 'PREAMBLE',
        agentId: 'main',
        cwd: '/w',
        availableMcpTools: ['skill_search'],
        applied,
        memoryInstructionsFingerprint: 'rules-v1',
      })
      // Turn 1: fresh session -> full inject
      assert.deepEqual(
        decideResumedEnvelopeElision({ openClaudeHome: home, engine: 'grok', sessionKey, requestedResumeId: null, inputsKey }),
        { elide: false, reason: 'fresh_session' },
      )
      // Persist after clean turn 1
      const t1 = 1_700_000_000_000
      writeResumedEnvelopeState(home, { v: 1, engine: 'grok', sessionKey, resumeId: 'sess-1', inputsKey, updatedAt: t1 }, t1)
      // Turn 2 with same resumeId + same instruction key (even if MEMORY index & AGENTS dynamic changed) -> elide!
      const inputsKeyChurned = buildResumedEnvelopeInputsKey({
        engine: 'grok',
        preamble: 'PREAMBLE',
        agentId: 'main',
        cwd: '/w',
        availableMcpTools: ['skill_search'],
        applied: [
          applied[0]!,
          { name: 'AGENTS', bytes: 999, sha256: 'e'.repeat(64), meta: { static_sha256: 'c'.repeat(64) } },
          { name: 'MEMORY', bytes: 9999, sha256: 'f'.repeat(64) },
        ],
        memoryInstructionsFingerprint: 'rules-v1',
      })
      assert.equal(inputsKeyChurned, inputsKey)
      assert.deepEqual(
        decideResumedEnvelopeElision({ openClaudeHome: home, engine: 'grok', sessionKey, requestedResumeId: 'sess-1', inputsKey: inputsKeyChurned }),
        { elide: true, reason: 'elided' },
      )
      assert.ok(utf8(resumedEnvelopePreamble('grok')) < 400)
      // Compaction timestamp after injection -> self-heal full inject
      assert.deepEqual(
        decideResumedEnvelopeElision({ openClaudeHome: home, engine: 'grok', sessionKey, requestedResumeId: 'sess-1', inputsKey, compactedAtMs: t1 + 1000 }),
        { elide: false, reason: 'compacted_since_injection' },
      )
      // Env kill-switch -> full inject
      assert.deepEqual(
        decideResumedEnvelopeElision({ openClaudeHome: home, engine: 'grok', sessionKey, requestedResumeId: 'sess-1', inputsKey, env: { OC_RESUMED_ENVELOPE_DEDUP: 'off' } }),
        { elide: false, reason: 'flag_off' },
      )
      // Explicit compaction invalidation clears state
      invalidateResumedEnvelopeForCompaction(home, 'grok', sessionKey)
      assert.deepEqual(
        decideResumedEnvelopeElision({ openClaudeHome: home, engine: 'grok', sessionKey, requestedResumeId: 'sess-1', inputsKey }),
        { elide: false, reason: 'no_prior_state' },
      )
      clearResumedEnvelopeState(home, 'grok', sessionKey)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('prepareBoundedPrompt trims oversized historical context for Cursor 48KB and offloads >96KB for ZCode', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'oc-bounded-cwd-'))
    try {
      const history = Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `Turn ${i}: ${'历'.repeat(600)}`,
      }))
      const histPrompt = renderHistoricalContextJsonPrompt(history, 'current question')
      assert.ok(utf8(histPrompt) > 48 * 1024)
      const events: unknown[] = []
      const fitted = await prepareBoundedPrompt({
        input: histPrompt,
        serialize: (s) => `ENVELOPE\n${s}`,
        maxBytes: 48 * 1024,
        cwd,
        engine: 'cursor',
        onEvent: (e) => events.push(e),
      })
      assert.ok(utf8(fitted) <= 48 * 1024)
      assert.ok(fitted.includes('current question'))

      const giantSingle = '巨'.repeat(40_000) // 120 KB > ZCode 96 KB
      const offloaded = await prepareBoundedPrompt({
        input: giantSingle,
        serialize: (s) => `PREFIX\n${s}`,
        maxBytes: 96 * 1024,
        cwd,
        engine: 'zcode',
        onEvent: (e) => events.push(e),
      })
      assert.ok(utf8(offloaded) <= 96 * 1024)
      assert.match(offloaded, /Input file:/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('OCV5-840 Auto-Dream 14-day project TTL, project snapshot & L1 janitor', () => {
  it('stamps 14-day TTL on project-bound Auto-Dream writes, snapshots official project memory, and runs L1 janitor', async () => {
    closeTaskboardDb()
    const db = getTaskboardDb()
    const projectId = '44444444-4444-4444-8444-444444444444'
    ensureProjectById(db, { id: projectId, name: 'Governance Test Project' })
    const ledger = new ProjectMemoryLedger(db)
    const today = '2026-11-22'
    // Seed an existing official project memory so we can verify Auto-Dream snapshots it
    await ledger.createCandidate({
      projectId,
      slug: 'existing-proj-rule.md',
      content: '---\nname: 既有项目规范\ndescription: 项目必须使用 pnpm\ntype: project\n---\n项目统一使用 pnpm。\n',
      actor: 'user:1',
      today,
    })

    const agentId = 'autodream-proj-ttl'
    let capturedPrompt = ''
    let janitorCalls = 0
    const service = new AutoDreamService({
      now: () => Date.parse(`${today}T12:00:00.000Z`),
      policyClient: {
        get: async () => ({
          enabled: true as const,
          mode: 'legacy_memory_v1' as const,
          modelId: 'test-model',
          minNewSessions: 1,
          minIntervalHours: 0,
        }),
      } as never,
      runJanitor: async (input) => {
        janitorCalls++
        assert.equal(input.mode, 'auto')
        assert.equal(input.archiveExpiredMemories, true)
        assert.equal(input.archiveColdSkills, false)
        assert.equal(input.pruneSkillHistory, true)
        assert.equal(input.decayArchival, true)
        return {
          runId: 'r1',
          batchId: null,
          agentId: input.agentId,
          mode: 'auto',
          dryRun: false,
          startedAt: `${today}T12:00:00.000Z`,
          finishedAt: `${today}T12:00:00.000Z`,
          expiredMemoriesArchived: 0,
          coldSkillsArchived: 0,
          skillHistoriesPruned: 0,
          archivalDecayed: 0,
          archivalCleaned: 0,
          bytesFreed: 0,
          archivedMemoryFiles: [],
          archivedSkillNames: [],
          errors: [],
        }
      },
      runModel: async ({ prompt }) => {
        capturedPrompt = prompt
        return JSON.stringify({
          upserts: [
            {
              file: 'new-proj-ttl.md',
              name: '新项目约定',
              description: '验证 14 天项目自动记忆 TTL',
              type: 'project',
              body: 'CI 门禁必须跑通。',
            },
          ],
          deletes: [],
          summary: 'ok',
        })
      },
    })

    await service.maybeSchedule({
      agentId,
      userId: '3',
      sessionKey: 'agent:autodream-proj-ttl:webchat:dm:s1',
      channel: 'webchat',
      userText: '记住项目约定：CI 门禁必须跑通',
      assistantText: '好的',
      projectId,
    })

    assert.equal(janitorCalls, 1, 'L1 janitor must run during periodic maintenance')
    assert.ok(
      capturedPrompt.includes('existing-proj-rule.md'),
      'project-bound Auto-Dream prompt snapshot must include existing official project memory for dedup',
    )
    const official = ledger.listOfficial(projectId).find((r) => r.slug === 'new-proj-ttl.md')
    assert.ok(official, 'new project memory should be promoted')
    const expectedExpires = addCalendarDays(today, PROJECT_AUTO_MEMORY_TTL_DAYS)
    assert.equal(official.expires, expectedExpires, `expected 14-day TTL ${expectedExpires}, got ${official.expires}`)
    const fileContent = readFileSync(new ProjectMemoryDir(projectId).officialFile('new-proj-ttl.md'), 'utf8')
    assert.match(fileContent, new RegExp(`expires: ${expectedExpires}`))
    closeTaskboardDb()
  })
})
