/**
 * Shared types, deterministic sandbox fixtures, and ResidentContractGuard
 * (with real-file anti-forgery replayReceipts verification) for
 * `scripts/check-context-static.ts` (OCV5-885 Workstream 1).
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PROMPT_PRIVACY, estimateModelHistoryTokens } from '@openclaude/protocol'
import { buildIntelligentUiPrompt } from '../../packages/commercial/src/intelligentUi/index.js'
import { verifyCrossFamilyAudit } from '../check-cross-family-audit.js'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEFAULT_BASELINE_REL_PATH = '.github/context-eval-baseline.json'
export const DEFAULT_BASELINE_PATH = join(REPO_ROOT, DEFAULT_BASELINE_REL_PATH)

export const FIXTURE_NAMES = [
  'webchat_first_turn',
  'webchat_resumed_turn',
  'wechat_turn',
  'research_turn',
  'project_memory_full',
] as const

export type FixtureName = (typeof FIXTURE_NAMES)[number]

export const RESIDENT_CONTRACTS = [
  'iui_trigger_catalog',
  'input_prediction_inline',
  'options_block_schema',
  'generated_dir_delivery',
] as const

export type ResidentContractId = (typeof RESIDENT_CONTRACTS)[number]

export const MAX_WAIVER_DAYS = 30
export const DEFAULT_MAX_TOTAL_GROWTH_RATIO = 0.05
export const DEFAULT_MAX_SLOT_GROWTH_RATIO = 0.15
export const DEFAULT_MIN_SLOT_GROWTH_BYTES = 256

export interface BaselineWaiver {
  ticket: string
  fixture: string
  maxBytes: number
  expiresAt: string
  reason: string
}

export interface ReplayReceipt {
  ticket: string
  contract: ResidentContractId
  receiptPath: string
  receiptSha256: string
  expiresAt: string
  reason: string
  commit?: string
  promptSha?: string
  verdict?: string
}

export interface FixtureBaselineEntry {
  totalBytes: number
  tokensEstimate: number
  staticPrefixBytes: number | null
  slots: Record<string, number>
}

export interface SubEvalsBaseline {
  coreMemory: {
    minPrecisionAt3: number
    minMrr: number
    minNoMatchAccuracy: number
    maxAvgHitsRatio: number
  }
  skillShadow: {
    minCases: number
    routes: Record<string, { minRecallAt3: number; minRecallAt5: number }>
  }
}

export interface ContextEvalBaseline {
  schemaVersion: 1
  generatedAt: string
  thresholds: {
    maxTotalBytes: number
    maxTotalGrowthRatio: number
    maxSlotGrowthRatio: number
    minSlotGrowthBytes: number
  }
  fixtures: Record<FixtureName, FixtureBaselineEntry>
  subEvals: SubEvalsBaseline
  waivers: BaselineWaiver[]
  replayReceipts: ReplayReceipt[]
}

export interface MeasuredFixture {
  name: FixtureName
  totalBytes: number
  tokensEstimate: number
  staticPrefixBytes: number | null
  contentSha256: string
  slots: Record<string, number>
  degradedReasons: string[]
  content: string
  iuiSlotContent: string | null
}

export interface GuardIssue {
  guard: 'slotLedgerRatchet' | 'staticPrefixStability' | 'residentContractGuard' | 'subEvals'
  code: string
  target: string
  message: string
}

export interface ResidentContractCheck {
  contract: ResidentContractId
  fixture: FixtureName
  pass: boolean
  degradedToBarePointer: boolean
  exemptedByReceipt: {
    ticket: string
    headCommit: string
    verdict: string
    receiptPath: string
  } | null
  detail: string
}

export interface ResidentContractGuardResult {
  pass: boolean
  issues: GuardIssue[]
  checks: ResidentContractCheck[]
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseIsoMs(raw: unknown): number {
  if (typeof raw !== 'string' || !raw.trim()) return Number.NaN
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T23:59:59.999Z`)
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s ? ms : Number.NaN
  }
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : Number.NaN
}

// ── Isolated sandbox & lazy gateway module loader ──
// `@openclaude/storage`'s `paths.ts` binds `HOME = process.env.OPENCLAUDE_HOME`
// at module load time. Create a process-scoped isolated sandbox BEFORE importing
// `promptSlots.ts` so the gate never reads the host user's `~/.openclaude`.

let _sandboxHome: string | null = null
let _gatewayModsPromise: Promise<{
  promptSlots: typeof import('../../packages/gateway/src/promptSlots.js')
  promptFreeze: typeof import('../../packages/gateway/src/promptFreeze.js')
  envProbe: typeof import('../../packages/gateway/src/envProbe.js')
  platformPrompts: typeof import('../../packages/gateway/src/platformPrompts.js')
}> | null = null

export function ensureSandboxHome(): string {
  if (_sandboxHome) return _sandboxHome
  const dir = mkdtempSync(join(tmpdir(), 'oc-ctx-static-'))
  _sandboxHome = dir
  mkdirSync(join(dir, 'platform-skills'), { recursive: true })
  process.env.OPENCLAUDE_HOME = dir
  process.env.OPENCLAUDE_BASELINE_SKILLS_DIR = join(dir, 'platform-skills')
  if (!process.env.OPENCLAUDE_LOG_LEVEL) {
    process.env.OPENCLAUDE_LOG_LEVEL = 'warn'
  }
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort cleanup */
    }
  })
  return dir
}

export async function loadGatewayModules() {
  ensureSandboxHome()
  if (!_gatewayModsPromise) {
    _gatewayModsPromise = (async () => {
      const [promptSlots, promptFreeze, envProbe, platformPrompts] = await Promise.all([
        import('../../packages/gateway/src/promptSlots.js'),
        import('../../packages/gateway/src/promptFreeze.js'),
        import('../../packages/gateway/src/envProbe.js'),
        import('../../packages/gateway/src/platformPrompts.js'),
      ])
      return { promptSlots, promptFreeze, envProbe, platformPrompts }
    })()
  }
  return _gatewayModsPromise
}

function writeSkillFile(rootDir: string, name: string, description: string, priority = 0): void {
  const dir = join(rootDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\npriority: ${priority}\n---\n# ${name}\n\n${description}\n`,
    'utf8',
  )
}

export function seedDeterministicSandbox(home: string): void {
  const agentsDir = join(home, 'agents')
  const mainDir = join(agentsDir, 'eval-main')
  const stabilityDir = join(agentsDir, 'eval-stability')
  const sharedSkillsDir = join(home, 'skills')
  const platformSkillsDir = join(home, 'platform-skills')

  rmSync(agentsDir, { recursive: true, force: true })
  rmSync(sharedSkillsDir, { recursive: true, force: true })
  rmSync(platformSkillsDir, { recursive: true, force: true })

  mkdirSync(join(mainDir, 'memory'), { recursive: true })
  mkdirSync(join(stabilityDir, 'memory'), { recursive: true })
  mkdirSync(sharedSkillsDir, { recursive: true })
  mkdirSync(platformSkillsDir, { recursive: true })

  const soulMd = [
    'You are EvalMain, a deterministic engineering assistant for OpenClaude context evaluation.',
    '',
    '## Core Principles',
    '- Verify facts before stating conclusions; cite file paths and line ranges.',
    '- Prefer concise, structured answers and minimal reversible edits.',
    '- Never leak secrets, tokens, or private user data into prompts or logs.',
  ].join('\n')
  writeFileSync(join(mainDir, 'SOUL.md'), `${soulMd}\n`, 'utf8')
  writeFileSync(join(stabilityDir, 'SOUL.md'), `${soulMd}\n`, 'utf8')

  const mainMemories = [
    {
      slug: 'pref-concise-replies',
      name: 'Concise Replies',
      type: 'user',
      desc: 'User prefers concise technical answers with direct file references.',
      body: 'Keep engineering summaries crisp and include exact commands run.',
    },
    {
      slug: 'feedback-verify-before-claim',
      name: 'Verify Before Claim',
      type: 'feedback',
      desc: 'Always run tests and inspect outputs before claiming a fix passes.',
      body: 'Never claim a gate is green without running the exact verification command.',
    },
    {
      slug: 'project-context-budget',
      name: 'Context Budget Policy',
      type: 'project',
      desc: 'System prompt stays within 44KB UTF-8 budget without silent degradation.',
      body: 'Track per-slot UTF-8 bytes and guard static cache prefixes across turns.',
    },
    {
      slug: 'project-release-train',
      name: 'Release Train Cadence',
      type: 'project',
      desc: 'Commercial and selfhost releases require CI parity and regression proof.',
      body: 'Follow check:v5 and check:ci-parity before cutting release tags.',
    },
    {
      slug: 'ref-eval-architecture',
      name: 'Eval Architecture Reference',
      type: 'reference',
      desc: 'Four-layer eval: T-Static, T-Replay, T-Live, and T-Online telemetry.',
      body: 'Static gates run in seconds with 0 tokens before merge.',
    },
  ]
  const indexLines = ['<!-- oc-memdir-index v1 -->']
  for (const m of mainMemories) {
    writeFileSync(
      join(mainDir, 'memory', `${m.slug}.md`),
      `---\nname: ${m.name}\ndescription: ${m.desc}\ntype: ${m.type}\n---\n${m.body}\n`,
      'utf8',
    )
    indexLines.push(`- [${m.name}](memory/${m.slug}.md) — ${m.desc}`)
  }
  writeFileSync(join(mainDir, 'MEMORY.md'), `${indexLines.join('\n')}\n`, 'utf8')

  writeSkillFile(platformSkillsDir, 'browser', 'Operate real Chromium browser via oc-browser CLI.', 90)
  writeSkillFile(platformSkillsDir, 'web-context', 'Extract public web pages and parse local documents via oc-web.', 80)
  writeSkillFile(platformSkillsDir, 'memory-management', 'Search and maintain Core, Session, and Archival memories.', 70)

  writeSkillFile(sharedSkillsDir, 'docx-report', 'Create and edit formatted Word documents with tracked styles.', 20)
  writeSkillFile(sharedSkillsDir, 'xlsx-analysis', 'Build and audit multi-sheet Excel workbooks and charts.', 20)
  writeSkillFile(sharedSkillsDir, 'code-review-checklist', 'Structured security and regression review checklist.', 10)
  writeSkillFile(sharedSkillsDir, 'incident-triage', 'Gather logs, isolate root causes, and draft postmortems.', 10)

  writeFileSync(
    join(home, 'agents.yaml'),
    [
      'default: eval-main',
      'routes: []',
      'agents:',
      '  - id: eval-main',
      '    displayName: Eval Main',
      '    model: claude-sonnet-4-6',
      '    provider: ccb',
      '  - id: coding-assistant',
      '    displayName: Coding Assistant',
      '    model: claude-opus-4-7',
      '    provider: ccb',
      '    source: marketplace',
      '  - id: research-analyst',
      '    displayName: Research Analyst',
      '    model: claude-opus-4-7',
      '    provider: ccb',
      '    source: marketplace',
      '',
    ].join('\n'),
    'utf8',
  )
}

export async function withLoopbackIuiServer<T>(
  iuiContent: string | null,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const payload = JSON.stringify({
    slots: iuiContent ? [{ name: 'INTELLIGENT_UI', content: iuiContent }] : [],
  })
  const server: Server = createServer((_req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(payload)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

export async function withNormalizedPromptEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const managedKeys = [
    'OPENCLAUDE_V3_MASTER_BASE_URL',
    'OPENCLAUDE_V3_CONTAINER_TOKEN',
    'OPENCLAUDE_PLATFORM_PROMPTS_DIR',
    'OC_PROJECT_CONTEXT',
    'OC_P5_PROJECT_SEARCH',
    'OC_USER_ROLE',
    'OC_SELFHOST_ENGINE_LOCAL_TURNS',
    ...Object.keys(overrides),
  ]
  const saved = new Map<string, string | undefined>()
  for (const k of new Set(managedKeys)) saved.set(k, process.env[k])
  try {
    for (const k of managedKeys) delete process.env[k]
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function detectBudgetDegradation(
  content: string,
  slots: readonly { name: string; bytes: number }[],
  provider: string,
  cursorSkillsCompact: string,
): string[] {
  const reasons: string[] = []
  if (provider !== 'cursor' && content.includes(cursorSkillsCompact)) reasons.push('skills_degraded_to_l0')
  if (content.includes('参考资料清单已因总提示预算折叠')) reasons.push('project_assets_compacted')
  if (content.includes('索引已截断（超出 ')) reasons.push('index_truncated_for_budget')
  if (!slots.some((s) => s.name === 'AGENTS')) reasons.push('missing_agents_slot')
  if (!slots.some((s) => s.name === 'MEMORY')) reasons.push('missing_memory_slot')
  if (!slots.some((s) => s.name === 'TOOLS')) reasons.push('missing_tools_slot')
  return reasons
}

export async function buildSyntheticFixtures(): Promise<Record<FixtureName, MeasuredFixture>> {
  const home = ensureSandboxHome()
  seedDeterministicSandbox(home)
  const { promptSlots, envProbe, platformPrompts } = await loadGatewayModules()
  const {
    buildPromptContext,
    PLATFORM_MCP_TOOL_NAMES,
    PROMPT_SESSION_CONTEXT_MARKER,
    CURSOR_SKILLS_COMPACT,
  } = promptSlots

  envProbe.resetEnvFactsCache()
  envProbe.probeEnvFacts({
    env: {
      OC_USER_ID: '1000',
      OC_CONTAINER_ID: 'eval-static-gate',
      OPENCLAUDE_HOME: '/home/agent/.openclaude',
      OC_USER_TZ: 'Asia/Shanghai',
    },
    exists: () => false,
    isExecutable: () => false,
    readPrefix: () => null,
    initEnvironPath: null,
    now: new Date('2026-01-01T00:00:00Z'),
  })

  const fullIuiContent = buildIntelligentUiPrompt({
    componentsEnabled: true,
    predictionEnabled: true,
    surface: 'webchat',
  })

  const baseCatalog = {
    models: [
      { modelId: 'claude-sonnet-4-6', engine: 'ccb' as const, available: true },
      { modelId: 'claude-opus-4-7', engine: 'ccb' as const, available: true },
      { modelId: 'grok-4', engine: 'grok' as const, available: true },
    ],
    projectionRevision: 'rev-static-eval-v1',
    verifiedAt: 1,
  }

  const allMcpTools = [...PLATFORM_MCP_TOOL_NAMES]
  const emptyUsageMap = new Map()
  const projectMemoryIndex = Array.from({ length: 12 }, (_, idx) => {
    const num = String(idx + 1).padStart(2, '0')
    return `- [Project Decision ${num}](memory/proj-dec-${num}.md) — Architectural invariant #${num} for context budget and cache prefix stability.`
  }).join('\n')

  const fullFrozenProject = {
    boardProjectId: '11111111-1111-4111-8111-111111111111',
    bound: true,
    contextVersion: 1,
    assetsRevision: 3,
    assets: [
      {
        id: 'asset-1',
        name: 'architecture.md',
        containerPath: '/home/agent/.openclaude/projects/11111111/assets/architecture.md',
        mime: 'text/markdown',
        sizeBytes: 4200,
        excerpt: 'System architecture overview covering gateway prompt slots, cache prefixes, and storage isolation.',
      },
      {
        id: 'asset-2',
        name: 'api-contract.yaml',
        containerPath: '/home/agent/.openclaude/projects/11111111/assets/api-contract.yaml',
        mime: 'application/yaml',
        sizeBytes: 2800,
        excerpt: 'OpenAPI 3.1 endpoints for internal prompt slots and session lifecycle.',
      },
      {
        id: 'asset-3',
        name: 'release-checklist.md',
        containerPath: '/home/agent/.openclaude/projects/11111111/assets/release-checklist.md',
        mime: 'text/markdown',
        sizeBytes: 1500,
        excerpt: 'Pre-merge gate checklist: check:context:static, check:ci-parity, and replay non-inferiority.',
      },
    ],
    workspaceSpec: null,
    workspaceCwd: null,
    cwdSource: null,
    instructions: [
      'Project coding & review standards:',
      '1. Keep system prompts deterministic and cache-friendly.',
      '2. Every prompt contraction touching resident protocols requires replay proof.',
      '3. Never commit secrets, personal emails, or host-specific absolute paths.',
    ].join('\n'),
    projectMdSha256: sha256('project-md-eval-v1'),
    skills: [
      {
        name: 'context-eval-playbook',
        description: 'Run four-tier context evaluation gates and inspect byte ledgers.',
        skillMdSha256: sha256('context-eval-playbook-v1'),
      },
      {
        name: 'prefix-cache-audit',
        description: 'Audit static-first prompt prefix stability and prompt freeze reuse.',
        skillMdSha256: sha256('prefix-cache-audit-v1'),
      },
    ],
    skillManifestSha256: sha256('project-skills-v1'),
    officialMemory: [],
    officialMemoryIndex: projectMemoryIndex,
    officialMemoryManifestSha256: sha256(projectMemoryIndex),
  }

  return withLoopbackIuiServer(fullIuiContent, async (baseUrl) => {
    const runFixture = async (
      name: FixtureName,
      ctx: Parameters<typeof buildPromptContext>[0],
      envOverrides: Record<string, string | undefined>,
    ): Promise<MeasuredFixture> =>
      withNormalizedPromptEnv(envOverrides, async () => {
        platformPrompts._internals.resetForTests()
        const res = await buildPromptContext(ctx)
        const markerParts = res.content.split(PROMPT_SESSION_CONTEXT_MARKER)
        const slots: Record<string, number> = {}
        for (const s of res.applied) slots[s.name] = (slots[s.name] ?? 0) + s.bytes
        return {
          name,
          totalBytes: utf8Bytes(res.content),
          tokensEstimate: estimateModelHistoryTokens(res.content),
          staticPrefixBytes: markerParts.length === 2 ? utf8Bytes(markerParts[0]!) : null,
          contentSha256: res.contentSha256,
          slots,
          degradedReasons: detectBudgetDegradation(
            res.content,
            res.applied,
            ctx.provider ?? 'ccb',
            CURSOR_SKILLS_COMPACT,
          ),
          content: res.content,
          iuiSlotContent: res.applied.some((s) => s.name === 'INTELLIGENT_UI') ? fullIuiContent : null,
        }
      })

    const remoteEnv = {
      OPENCLAUDE_V3_MASTER_BASE_URL: baseUrl,
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.eval-static-token',
    }
    const baseCtx = {
      agentId: 'eval-main',
      availableMcpTools: allMcpTools,
      promptPolicy: DEFAULT_PROMPT_PRIVACY,
      delegateModelCatalog: baseCatalog,
      projectContext: null,
      frozenProjectContext: null,
      projectInstructions: null,
      projectAssets: null,
      skillUsageMap: emptyUsageMap,
    }

    const webchat_first_turn = await runFixture(
      'webchat_first_turn',
      {
        ...baseCtx,
        sessionKey: 'agent:eval-main:webchat:sess-first',
        sessionId: 'sess-first',
        provider: 'ccb',
        model: 'claude-sonnet-4-6',
        cacheLayout: 'static-first',
      },
      remoteEnv,
    )
    const webchat_resumed_turn = await runFixture(
      'webchat_resumed_turn',
      {
        ...baseCtx,
        sessionKey: 'agent:eval-main:webchat:sess-resumed',
        sessionId: 'sess-resumed',
        provider: 'antigravity',
        model: 'gemini-3-pro',
        cacheLayout: 'static-first',
        repoSnapshot: {
          owner: 'openclaude',
          repo: 'context-eval-demo',
          branch: 'main',
          status: 'ready',
          workspaceDir: '/home/agent/.openclaude/repos/context-eval-demo',
          headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        },
      },
      remoteEnv,
    )
    const wechat_turn = await runFixture(
      'wechat_turn',
      {
        ...baseCtx,
        sessionKey: 'agent:eval-main:wechat:wx-user-01',
        sessionId: 'wx-sess-01',
        provider: 'ccb',
        model: 'claude-sonnet-4-6',
        cacheLayout: 'legacy',
      },
      remoteEnv,
    )
    const research_turn = await runFixture(
      'research_turn',
      {
        ...baseCtx,
        sessionKey: 'agent:eval-main:webchat:sess-research',
        sessionId: 'sess-research',
        provider: 'ccb',
        model: 'claude-opus-4-7',
        effortLevel: 'max',
        cacheLayout: 'static-first',
      },
      remoteEnv,
    )
    const project_memory_full = await runFixture(
      'project_memory_full',
      {
        agentId: 'eval-main',
        sessionKey: 'agent:eval-main:webchat:sess-project',
        sessionId: 'sess-project',
        provider: 'ccb',
        model: 'claude-sonnet-4-6',
        cacheLayout: 'static-first',
        availableMcpTools: allMcpTools,
        promptPolicy: DEFAULT_PROMPT_PRIVACY,
        delegateModelCatalog: baseCatalog,
        projectContext: null,
        frozenProjectContext: fullFrozenProject as any,
        projectSearch: true,
        skillUsageMap: emptyUsageMap,
      },
      { ...remoteEnv, OC_PROJECT_CONTEXT: '1', OC_P5_PROJECT_SEARCH: '1' },
    )

    return {
      webchat_first_turn,
      webchat_resumed_turn,
      wechat_turn,
      research_turn,
      project_memory_full,
    }
  })
}

// ── Guard 3: ResidentContractGuard + real-file anti-forgery replayReceipts verification ──

export interface VerifiedReplayReceipt {
  ticket: string
  contract: ResidentContractId
  headCommit: string
  promptSha: string
  verdict: 'ACCEPT'
  receiptPath: string
  receiptSha256: string
  expiresAt: string
  reason: string
}

export function verifyReplayReceiptEntry(
  raw: unknown,
  contract: ResidentContractId,
  expectedPromptSha: string,
  nowMs: number,
  repoRoot: string = REPO_ROOT,
): { ok: true; receipt: VerifiedReplayReceipt } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: 'receipt entry must be an object' }
  if (raw.contract !== contract) return { ok: false, reason: 'contract mismatch' }

  const ticket = typeof raw.ticket === 'string' ? raw.ticket.trim() : ''
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  const receiptPath = typeof raw.receiptPath === 'string' ? raw.receiptPath.trim() : ''
  const declaredSha = typeof raw.receiptSha256 === 'string' ? raw.receiptSha256.trim().toLowerCase() : ''
  const expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt.trim() : ''

  if (!ticket || !reason) return { ok: false, reason: 'missing required ticket or reason' }
  if (!receiptPath) return { ok: false, reason: 'missing required repo-relative receiptPath' }
  if (isAbsolute(receiptPath) || receiptPath.includes('\0')) {
    return { ok: false, reason: `receiptPath must be repo-relative: ${receiptPath}` }
  }
  if (!/^[0-9a-f]{64}$/.test(declaredSha)) {
    return { ok: false, reason: 'receiptSha256 must be a 64-char hex digest' }
  }

  // ④ expiresAt <= 30d and unexpired
  const expMs = parseIsoMs(expiresAt)
  const maxHorizonMs = nowMs + MAX_WAIVER_DAYS * 86_400_000
  if (!Number.isFinite(expMs)) return { ok: false, reason: `invalid expiresAt: ${expiresAt}` }
  if (expMs <= nowMs) return { ok: false, reason: `receipt expired at ${expiresAt}` }
  if (expMs > maxHorizonMs) {
    return { ok: false, reason: `receipt expiresAt ${expiresAt} exceeds ${MAX_WAIVER_DAYS}d TTL` }
  }

  // Containment + non-symlink verification
  const absRoot = resolve(repoRoot)
  const resolvedPath = resolve(absRoot, receiptPath)
  if (!resolvedPath.startsWith(absRoot + sep)) {
    return { ok: false, reason: `receiptPath escapes repo root: ${receiptPath}` }
  }
  if (!existsSync(resolvedPath)) {
    return { ok: false, reason: `receipt file does not exist: ${receiptPath}` }
  }
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(resolvedPath)
  } catch (err) {
    return { ok: false, reason: `cannot stat receipt file: ${(err as Error).message}` }
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { ok: false, reason: `receiptPath must be a regular non-symlink file: ${receiptPath}` }
  }
  let realRoot: string
  let realFile: string
  try {
    realRoot = realpathSync(absRoot)
    realFile = realpathSync(resolvedPath)
  } catch (err) {
    return { ok: false, reason: `cannot resolve realpath: ${(err as Error).message}` }
  }
  const expectedReal = resolve(realRoot, relative(absRoot, resolvedPath))
  if (!realFile.startsWith(realRoot + sep) || realFile !== expectedReal) {
    return { ok: false, reason: `receiptPath traverses a symlink or escapes repo root: ${receiptPath}` }
  }

  // ① Raw file bytes SHA256 === entry.receiptSha256
  const rawBytes = readFileSync(resolvedPath)
  const actualSha = sha256(rawBytes)
  if (actualSha !== declaredSha) {
    return {
      ok: false,
      reason: `receiptSha256 mismatch for ${receiptPath} (expected=${declaredSha.slice(0, 12)}, actual=${actualSha.slice(0, 12)})`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBytes.toString('utf8'))
  } catch (err) {
    return { ok: false, reason: `receipt file is invalid JSON: ${(err as Error).message}` }
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'receipt JSON root must be an object' }

  // ② verdict === 'ACCEPT', redlineViolations === 0, fullSuite === true
  if (parsed.verdict !== 'ACCEPT') {
    return { ok: false, reason: `receipt verdict=${String(parsed.verdict)} (expected ACCEPT)` }
  }
  if (parsed.redlineViolations !== 0) {
    return { ok: false, reason: `receipt redlineViolations=${String(parsed.redlineViolations)} (must be 0)` }
  }
  if (parsed.fullSuite !== true) {
    return { ok: false, reason: `receipt fullSuite=${String(parsed.fullSuite)} (must be true)` }
  }

  // ③ file.promptSha === live promptSha & headCommit is valid 40-char hex
  const filePromptSha = typeof parsed.promptSha === 'string' ? parsed.promptSha.trim() : ''
  if (filePromptSha !== expectedPromptSha) {
    return {
      ok: false,
      reason: `receipt promptSha mismatch (file=${filePromptSha.slice(0, 12) || '<empty>'}, live=${expectedPromptSha.slice(0, 12)})`,
    }
  }
  const headCommit = typeof parsed.headCommit === 'string' ? parsed.headCommit.trim() : ''
  if (!/^[0-9a-f]{40}$/i.test(headCommit)) {
    return { ok: false, reason: `receipt headCommit must be 40-char hex (got ${JSON.stringify(parsed.headCommit)})` }
  }
  const declaredHeadCommit = typeof raw.headCommit === 'string' ? raw.headCommit.trim() : ''
  if (declaredHeadCommit && declaredHeadCommit.toLowerCase() !== headCommit.toLowerCase()) {
    return {
      ok: false,
      reason: `receipt headCommit mismatch against baseline entry (${declaredHeadCommit.slice(0, 12)} !== ${headCommit.slice(0, 12)})`,
    }
  }
  const candidateEnvCommit = process.env.OC_CANDIDATE_COMMIT?.trim()
  if (candidateEnvCommit && /^[0-9a-f]{7,40}$/i.test(candidateEnvCommit)) {
    if (!headCommit.toLowerCase().startsWith(candidateEnvCommit.toLowerCase())) {
      return {
        ok: false,
        reason: `receipt headCommit ${headCommit.slice(0, 12)} does not match OC_CANDIDATE_COMMIT=${candidateEnvCommit.slice(0, 12)}`,
      }
    }
  }
  const execModel = typeof parsed.execModel === 'string' ? parsed.execModel.trim() : ''
  const judgeModel = typeof parsed.judgeModel === 'string' ? parsed.judgeModel.trim() : ''
  if (!execModel || !judgeModel || !verifyCrossFamilyAudit(execModel, judgeModel).ok) {
    return {
      ok: false,
      reason: `receipt must carry valid cross-family non-weak execModel/judgeModel (got ${JSON.stringify(execModel)} / ${JSON.stringify(judgeModel)})`,
    }
  }
  if (typeof parsed.evaluatedCaseCount !== 'number' || parsed.evaluatedCaseCount < 20) {
    return {
      ok: false,
      reason: `receipt evaluatedCaseCount must be >= 20 canonical golden cases (got ${String(parsed.evaluatedCaseCount)})`,
    }
  }

  if (parsed.expiresAt !== undefined) {
    const fileExpMs = parseIsoMs(parsed.expiresAt)
    if (!Number.isFinite(fileExpMs) || fileExpMs <= nowMs || fileExpMs > maxHorizonMs) {
      return { ok: false, reason: `receipt file expiresAt invalid/expired/>30d: ${String(parsed.expiresAt)}` }
    }
  }

  return {
    ok: true,
    receipt: {
      ticket,
      contract,
      headCommit,
      promptSha: filePromptSha,
      verdict: 'ACCEPT',
      receiptPath,
      receiptSha256: actualSha,
      expiresAt,
      reason,
    },
  }
}

function findValidReplayReceipt(
  receipts: readonly unknown[] | undefined,
  contract: ResidentContractId,
  promptSha: string,
  nowMs: number,
  repoRoot: string,
): { receipt: VerifiedReplayReceipt | null; rejectionReasons: string[] } {
  const rejectionReasons: string[] = []
  if (!Array.isArray(receipts)) return { receipt: null, rejectionReasons }
  for (const raw of receipts) {
    if (!isPlainObject(raw) || raw.contract !== contract) continue
    const res = verifyReplayReceiptEntry(raw, contract, promptSha, nowMs, repoRoot)
    if (res.ok) return { receipt: res.receipt, rejectionReasons: [] }
    rejectionReasons.push(res.reason)
  }
  return { receipt: null, rejectionReasons }
}

export function evaluateResidentContracts(
  measured: Record<FixtureName, MeasuredFixture>,
  baseline: Pick<ContextEvalBaseline, 'replayReceipts'>,
  nowMs: number,
  repoRoot: string = REPO_ROOT,
): ResidentContractGuardResult {
  const issues: GuardIssue[] = []
  const checks: ResidentContractCheck[] = []

  const evaluateOne = (args: {
    contract: ResidentContractId
    fixture: FixtureName
    promptSha: string
    ok: boolean
    degradedToBarePointer: boolean
    detail: string
  }) => {
    if (args.ok) {
      checks.push({
        contract: args.contract,
        fixture: args.fixture,
        pass: true,
        degradedToBarePointer: false,
        exemptedByReceipt: null,
        detail: args.detail,
      })
      return
    }
    const { receipt, rejectionReasons } = findValidReplayReceipt(
      baseline.replayReceipts,
      args.contract,
      args.promptSha,
      nowMs,
      repoRoot,
    )
    if (receipt) {
      checks.push({
        contract: args.contract,
        fixture: args.fixture,
        pass: true,
        degradedToBarePointer: args.degradedToBarePointer,
        exemptedByReceipt: {
          ticket: receipt.ticket,
          headCommit: receipt.headCommit,
          verdict: receipt.verdict,
          receiptPath: receipt.receiptPath,
        },
        detail: `${args.detail} (exempted by verified receipt ${receipt.receiptPath} [${receipt.ticket} @ ${receipt.headCommit.slice(0, 12)}])`,
      })
      return
    }
    const rejectSuffix =
      rejectionReasons.length > 0 ? ` [receipt rejected: ${rejectionReasons.join('; ')}]` : ''
    checks.push({
      contract: args.contract,
      fixture: args.fixture,
      pass: false,
      degradedToBarePointer: args.degradedToBarePointer,
      exemptedByReceipt: null,
      detail: `${args.detail}${rejectSuffix}`,
    })
    issues.push({
      guard: 'residentContractGuard',
      code: args.degradedToBarePointer
        ? 'CONTRACT_DEGRADED_TO_BARE_SKILL_POINTER'
        : 'RESIDENT_CONTRACT_MISSING',
      target: `${args.fixture}:${args.contract}`,
      message:
        `${args.contract} failed on ${args.fixture}: ${args.detail}${rejectSuffix}. ` +
        `Anti-OCV5-610 guard blocks degrading resident protocols without a verified in-repo replayReceipts[] JSON file.`,
    })
  }

  // ① Webchat IUI: inline trigger catalog + ```ui JSON rule
  const webFirst = measured.webchat_first_turn
  const iuiText = webFirst.iuiSlotContent ?? webFirst.content
  const hasIuiCatalog =
    /\btable\b/.test(iuiText) &&
    /\bchart\b/.test(iuiText) &&
    /\bstats\b/.test(iuiText) &&
    /\bcompare\b/.test(iuiText) &&
    /\bcards\b/.test(iuiText)
  const hasUiFenceAndJson = iuiText.includes('```ui') && /\{\s*"type"\s*:/.test(iuiText)
  evaluateOne({
    contract: 'iui_trigger_catalog',
    fixture: 'webchat_first_turn',
    promptSha: webFirst.contentSha256,
    ok: hasIuiCatalog && hasUiFenceAndJson,
    degradedToBarePointer: !(hasIuiCatalog && hasUiFenceAndJson) && /oc-system\s+skill\s+ui\b/.test(iuiText),
    detail:
      hasIuiCatalog && hasUiFenceAndJson
        ? 'Inline IUI component trigger catalog (table/chart/stats/compare/cards) and ```ui JSON rule present'
        : `Missing inline IUI trigger catalog (${String(hasIuiCatalog)}) or \`\`\`ui JSON rule (${String(hasUiFenceAndJson)})`,
  })

  // ② InputPrediction: inline ```ui {"type":"next" contract
  const hasNextJsonContract = iuiText.includes('```ui') && /\{"type"\s*:\s*"next"/.test(iuiText)
  evaluateOne({
    contract: 'input_prediction_inline',
    fixture: 'webchat_first_turn',
    promptSha: webFirst.contentSha256,
    ok: hasNextJsonContract,
    degradedToBarePointer: !hasNextJsonContract && /oc-system\s+skill\s+input-prediction\b/.test(iuiText),
    detail: hasNextJsonContract
      ? 'Inline ```ui {"type":"next"...} inputPrediction contract present'
      : 'Missing inline ```ui {"type":"next"...} contract',
  })

  // ③ Antigravity / non-native ask channel: fenced ```options JSON schema contract
  const agTurn = measured.webchat_resumed_turn
  const hasOptionsFenceRule =
    /fenced\s+`options`|```options/.test(agTurn.content) &&
    agTurn.content.includes('question?: string') &&
    agTurn.content.includes('multi?: boolean') &&
    /options:\s*Array<\{\s*label:\s*string/.test(agTurn.content)
  evaluateOne({
    contract: 'options_block_schema',
    fixture: 'webchat_resumed_turn',
    promptSha: agTurn.contentSha256,
    ok: hasOptionsFenceRule,
    degradedToBarePointer: !hasOptionsFenceRule && /oc-system\s+skill\b/.test(agTurn.content),
    detail: hasOptionsFenceRule
      ? 'Inline fenced `options` JSON schema contract (question/multi/options[{label,desc}]) present for Antigravity'
      : 'Missing inline fenced `options` JSON schema contract for non-native ask channel (Antigravity)',
  })

  // ④ /home/agent/.openclaude/generated/ file delivery contract (webchat + wechat)
  const wechatTurn = measured.wechat_turn
  const checkGeneratedContract = (txt: string) =>
    txt.includes('/home/agent/.openclaude/generated/') && txt.includes('绝对路径') && txt.includes('/tmp')
  const genOkWebchat = checkGeneratedContract(webFirst.content)
  const genOkWechat = checkGeneratedContract(wechatTurn.content)
  const genOk = genOkWebchat && genOkWechat
  evaluateOne({
    contract: 'generated_dir_delivery',
    fixture: 'webchat_first_turn',
    promptSha: webFirst.contentSha256,
    ok: genOk,
    degradedToBarePointer:
      !genOk && (/oc-system\s+skill\b/.test(webFirst.content) || /oc-system\s+skill\b/.test(wechatTurn.content)),
    detail: genOk
      ? 'Inline `/home/agent/.openclaude/generated/` absolute-path file delivery contract present (webchat + wechat)'
      : `Missing \`/home/agent/.openclaude/generated/\` delivery contract (webchat=${String(genOkWebchat)}, wechat=${String(genOkWechat)})`,
  })

  return { pass: issues.length === 0, issues, checks }
}
