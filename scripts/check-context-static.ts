#!/usr/bin/env tsx
/**
 * OCV5-885 Workstream 1 — T-Static Pre-Merge Context Evaluation Gate (0-Token, Offline).
 *
 * Four deterministic guards:
 *   1. Slot Byte/Token Ledger + Monotonic Ratchet (5 synthetic PromptSlotContext fixtures)
 *   2. Static Prefix SHA256 Immutability (`PROMPT_SESSION_CONTEXT_MARKER` + `applyPromptFreeze`)
 *   3. Critical Inline Capability Contract Guard (`ResidentContractGuard`, anti-OCV5-610 regression)
 *   4. Existing 0-Token Memory & Skill Regression Sub-Evals (parallel offline subprocesses)
 *
 * Usage:
 *   npx tsx scripts/check-context-static.ts [--json] [--skip-sub-evals] [--baseline <path>] [--now <iso>] [--write-baseline]
 *
 * Exit codes:
 *   0 = PASS
 *   1 = Gate FAIL
 *   2 = Usage / runtime / schema error
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PROMPT_PRIVACY } from '@openclaude/protocol'
import { buildIntelligentUiPrompt } from '../packages/commercial/src/intelligentUi/index.js'
import {
  DEFAULT_BASELINE_PATH,
  DEFAULT_BASELINE_REL_PATH,
  DEFAULT_MAX_SLOT_GROWTH_RATIO,
  DEFAULT_MAX_TOTAL_GROWTH_RATIO,
  DEFAULT_MIN_SLOT_GROWTH_BYTES,
  FIXTURE_NAMES,
  MAX_WAIVER_DAYS,
  REPO_ROOT,
  RESIDENT_CONTRACTS,
  buildSyntheticFixtures,
  ensureSandboxHome,
  evaluateResidentContracts,
  isPlainObject,
  loadGatewayModules,
  parseIsoMs,
  seedDeterministicSandbox,
  sha256,
  verifyReplayReceiptEntry,
  withLoopbackIuiServer,
  withNormalizedPromptEnv,
  type BaselineWaiver,
  type ContextEvalBaseline,
  type FixtureBaselineEntry,
  type FixtureName,
  type GuardIssue,
  type MeasuredFixture,
  type ReplayReceipt,
  type ResidentContractCheck,
  type ResidentContractGuardResult,
  type ResidentContractId,
  type SubEvalsBaseline,
  type VerifiedReplayReceipt,
} from './lib/contextStaticFixtures.js'

export {
  DEFAULT_BASELINE_PATH,
  DEFAULT_BASELINE_REL_PATH,
  DEFAULT_MAX_SLOT_GROWTH_RATIO,
  DEFAULT_MAX_TOTAL_GROWTH_RATIO,
  DEFAULT_MIN_SLOT_GROWTH_BYTES,
  FIXTURE_NAMES,
  MAX_WAIVER_DAYS,
  RESIDENT_CONTRACTS,
  buildSyntheticFixtures,
  evaluateResidentContracts,
  verifyReplayReceiptEntry,
  type BaselineWaiver,
  type ContextEvalBaseline,
  type FixtureBaselineEntry,
  type FixtureName,
  type GuardIssue,
  type MeasuredFixture,
  type ReplayReceipt,
  type ResidentContractCheck,
  type ResidentContractGuardResult,
  type ResidentContractId,
  type SubEvalsBaseline,
  type VerifiedReplayReceipt,
}

export interface LedgerRatchetResult {
  pass: boolean
  issues: GuardIssue[]
  waiversApplied: Array<{ fixture: string; ticket: string; expiresAt: string; maxBytes: number }>
  fixtures: Record<
    FixtureName,
    {
      totalBytes: number
      baselineBytes: number | null
      deltaBytes: number | null
      tokensEstimate: number
      staticPrefixBytes: number | null
      contentSha256: string
      slots: Record<string, number>
      degradedReasons: string[]
    }
  >
}

export interface StaticPrefixStabilityResult {
  pass: boolean
  issues: GuardIssue[]
  turn1PrefixSha256: string
  turn2PrefixSha256: string
  turn1DynamicSha256: string
  turn2DynamicSha256: string
  agentsStaticSha256Equal: boolean
  freezeReused: boolean
  freezeDecision: string
  freezeChangedSlots: string[]
  freezeStaticSlotsChanged: string[]
}

export interface CoreMemoryEvalMetrics {
  pass: boolean
  precisionAt3: number
  mrr: number
  noMatchAccuracy: number
  avgHits: number
  corpusFiles: number
  avgHitsRatio: number
  casesPassed: number
  casesTotal: number
  elapsedMs: number
}

export interface SkillShadowEvalMetrics {
  cases: number
  skillsWithEvals: number
  catalogSize: number
  routes: Record<string, { recallAt3: number; recallAt5: number; hitsAt3: number; hitsAt5: number }>
  elapsedMs: number
}

export interface SubEvalsResult {
  status: 'passed' | 'failed' | 'skipped'
  pass: boolean
  issues: GuardIssue[]
  coreMemory: CoreMemoryEvalMetrics | null
  skillShadow: SkillShadowEvalMetrics | null
}

export interface ContextStaticReport {
  pass: boolean
  elapsedMs: number
  baselinePath: string
  guards: {
    slotLedgerRatchet: LedgerRatchetResult
    staticPrefixStability: StaticPrefixStabilityResult
    residentContractGuard: ResidentContractGuardResult
    subEvals: SubEvalsResult
  }
  issues: GuardIssue[]
}

export interface CliOptions {
  json: boolean
  skipSubEvals: boolean
  baselinePath: string
  nowMs: number
  writeBaseline: boolean
  help: boolean
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const out: CliOptions = {
    json: false,
    skipSubEvals: false,
    baselinePath: DEFAULT_BASELINE_PATH,
    nowMs: Date.now(),
    writeBaseline: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--json') out.json = true
    else if (arg === '--skip-sub-evals') out.skipSubEvals = true
    else if (arg === '--write-baseline') out.writeBaseline = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--baseline') {
      const next = argv[++i]
      if (!next) throw new Error('--baseline requires a path')
      out.baselinePath = resolve(next)
    } else if (arg === '--now') {
      const next = argv[++i]
      if (!next) throw new Error('--now requires an ISO timestamp or YYYY-MM-DD date')
      const parsed = parseIsoMs(next)
      if (!Number.isFinite(parsed)) throw new Error(`invalid --now value: ${next}`)
      out.nowMs = parsed
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

// ── Guard 1: Slot Ledger & Monotonic Ratchet ──

export function validateWaivers(
  waivers: readonly unknown[],
  nowMs: number,
  maxTotalBytes: number,
): { valid: BaselineWaiver[]; issues: GuardIssue[] } {
  const valid: BaselineWaiver[] = []
  const issues: GuardIssue[] = []
  const maxHorizonMs = nowMs + MAX_WAIVER_DAYS * 86_400_000

  for (let i = 0; i < waivers.length; i++) {
    const raw = waivers[i]
    const label = `waivers[${i}]`
    if (!isPlainObject(raw)) {
      issues.push({
        guard: 'slotLedgerRatchet',
        code: 'WAIVER_SCHEMA_INVALID',
        target: label,
        message: `${label} must be an object { ticket, fixture, maxBytes, expiresAt, reason }`,
      })
      continue
    }
    const ticket = typeof raw.ticket === 'string' ? raw.ticket.trim() : ''
    const fixture = typeof raw.fixture === 'string' ? raw.fixture.trim() : ''
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
    const maxBytes = typeof raw.maxBytes === 'number' ? raw.maxBytes : Number.NaN
    const expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt.trim() : ''
    const expiresMs = parseIsoMs(expiresAt)

    if (!ticket || !fixture || !reason) {
      issues.push({
        guard: 'slotLedgerRatchet',
        code: 'WAIVER_SCHEMA_INVALID',
        target: label,
        message: `${label} requires non-empty ticket, fixture, and reason`,
      })
      continue
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > maxTotalBytes) {
      issues.push({
        guard: 'slotLedgerRatchet',
        code: 'WAIVER_MAX_BYTES_INVALID',
        target: `${fixture}(${ticket})`,
        message: `${label} maxBytes=${String(raw.maxBytes)} must be a positive integer <= ${maxTotalBytes}`,
      })
      continue
    }
    if (!Number.isFinite(expiresMs)) {
      issues.push({
        guard: 'slotLedgerRatchet',
        code: 'WAIVER_EXPIRES_INVALID',
        target: `${fixture}(${ticket})`,
        message: `${label} expiresAt=${JSON.stringify(expiresAt)} is not a valid ISO date/timestamp`,
      })
      continue
    }
    if (expiresMs > maxHorizonMs) {
      issues.push({
        guard: 'slotLedgerRatchet',
        code: 'WAIVER_TTL_EXCEEDS_30D',
        target: `${fixture}(${ticket})`,
        message: `${label} expiresAt=${expiresAt} exceeds maximum ${MAX_WAIVER_DAYS}-day waiver TTL`,
      })
      continue
    }
    if (expiresMs <= nowMs) continue
    valid.push({ ticket, fixture, maxBytes, expiresAt, reason })
  }

  return { valid, issues }
}

export function evaluateSlotLedgerRatchet(
  measured: Record<FixtureName, MeasuredFixture>,
  baseline: ContextEvalBaseline,
  nowMs: number,
  hardMaxTotalBytes = 44_000,
): LedgerRatchetResult {
  const issues: GuardIssue[] = []
  const waiversApplied: LedgerRatchetResult['waiversApplied'] = []
  const maxTotalBytes = Math.min(hardMaxTotalBytes, baseline.thresholds?.maxTotalBytes ?? hardMaxTotalBytes)
  const maxTotalGrowthRatio = baseline.thresholds?.maxTotalGrowthRatio ?? DEFAULT_MAX_TOTAL_GROWTH_RATIO
  const maxSlotGrowthRatio = baseline.thresholds?.maxSlotGrowthRatio ?? DEFAULT_MAX_SLOT_GROWTH_RATIO
  const minSlotGrowthBytes = baseline.thresholds?.minSlotGrowthBytes ?? DEFAULT_MIN_SLOT_GROWTH_BYTES

  const { valid: activeWaivers, issues: waiverSchemaIssues } = validateWaivers(
    Array.isArray(baseline.waivers) ? baseline.waivers : [],
    nowMs,
    maxTotalBytes,
  )
  issues.push(...waiverSchemaIssues)

  const summary = {} as LedgerRatchetResult['fixtures']

  for (const name of FIXTURE_NAMES) {
    const m = measured[name]
    const b = baseline.fixtures?.[name]
    summary[name] = {
      totalBytes: m.totalBytes,
      baselineBytes: b ? b.totalBytes : null,
      deltaBytes: b ? m.totalBytes - b.totalBytes : null,
      tokensEstimate: m.tokensEstimate,
      staticPrefixBytes: m.staticPrefixBytes,
      contentSha256: m.contentSha256,
      slots: m.slots,
      degradedReasons: m.degradedReasons,
    }

    if (m.totalBytes > maxTotalBytes) {
      issues.push({
        guard: 'slotLedgerRatchet',
        code: 'TOTAL_BYTES_CAP_EXCEEDED',
        target: name,
        message: `${name}: totalBytes=${m.totalBytes} exceeds hard cap PROMPT_TOTAL_MAX_BYTES=${maxTotalBytes}`,
      })
    }
    if (m.degradedReasons.length > 0) {
      issues.push({
        guard: 'slotLedgerRatchet',
        code: 'UNEXPECTED_BUDGET_DEGRADATION',
        target: name,
        message: `${name}: unexpected global budget degradation (${m.degradedReasons.join(', ')})`,
      })
    }
    if (!b) {
      issues.push({
        guard: 'slotLedgerRatchet',
        code: 'BASELINE_FIXTURE_MISSING',
        target: name,
        message: `${name}: missing entry in baseline JSON`,
      })
      continue
    }

    const matchingWaiver = activeWaivers.find((w) => w.fixture === name && m.totalBytes <= w.maxBytes)
    const allowedTotalCeiling = Math.floor(b.totalBytes * (1 + maxTotalGrowthRatio))
    let usedWaiver = false

    if (m.totalBytes > allowedTotalCeiling) {
      if (matchingWaiver) {
        usedWaiver = true
      } else {
        const pct = (((m.totalBytes - b.totalBytes) / Math.max(1, b.totalBytes)) * 100).toFixed(2)
        issues.push({
          guard: 'slotLedgerRatchet',
          code: 'TOTAL_BYTES_RATCHET_EXCEEDED',
          target: name,
          message:
            `${name}: totalBytes=${m.totalBytes} exceeds baseline ${b.totalBytes} (+${pct}%, ceiling=${allowedTotalCeiling}). ` +
            `Shrink prompt bytes or add a <=${MAX_WAIVER_DAYS}d waiver in .github/context-eval-baseline.json.`,
        })
      }
    }

    for (const [slotName, baseSlotBytes] of Object.entries(b.slots ?? {})) {
      const actualSlotBytes = m.slots[slotName] ?? 0
      if (actualSlotBytes <= baseSlotBytes) continue
      const allowedSlotCeiling =
        baseSlotBytes + Math.max(minSlotGrowthBytes, Math.floor(baseSlotBytes * maxSlotGrowthRatio))
      if (actualSlotBytes > allowedSlotCeiling) {
        if (matchingWaiver) {
          usedWaiver = true
        } else {
          issues.push({
            guard: 'slotLedgerRatchet',
            code: 'SLOT_BYTES_SPIKE',
            target: `${name}.${slotName}`,
            message:
              `${name}.${slotName}: bytes=${actualSlotBytes} spiked above baseline ${baseSlotBytes} ` +
              `(ceiling=${allowedSlotCeiling}) without an active waiver.`,
          })
        }
      }
    }

    if (usedWaiver && matchingWaiver) {
      waiversApplied.push({
        fixture: name,
        ticket: matchingWaiver.ticket,
        expiresAt: matchingWaiver.expiresAt,
        maxBytes: matchingWaiver.maxBytes,
      })
    }
  }

  return { pass: issues.length === 0, issues, waiversApplied, fixtures: summary }
}

// ── Guard 2: Static Prefix SHA256 Immutability (`StaticPrefixStability`) ──

const STATIC_SLOT_NAMES = new Set([
  'INTELLIGENT_UI',
  'AGENTS',
  'SKILLS_LITERATURE',
  'MEMORY',
  'TOOLS',
])

export async function runStaticPrefixStabilityGuard(): Promise<StaticPrefixStabilityResult> {
  const home = ensureSandboxHome()
  seedDeterministicSandbox(home)
  const { promptSlots, promptFreeze, envProbe, platformPrompts } = await loadGatewayModules()
  const { buildPromptContext, PLATFORM_MCP_TOOL_NAMES, PROMPT_SESSION_CONTEXT_MARKER } = promptSlots
  const { applyPromptFreeze, promptFreezeInputsKey } = promptFreeze

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

  const stabilityDir = join(home, 'agents', 'eval-stability')
  const freezeHome = mkdtempSync(join(tmpdir(), 'oc-ctx-freeze-'))
  const issues: GuardIssue[] = []

  try {
    return await withLoopbackIuiServer(fullIuiContent, async (baseUrl) =>
      withNormalizedPromptEnv(
        {
          OPENCLAUDE_V3_MASTER_BASE_URL: baseUrl,
          OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.eval-static-token',
        },
        async () => {
          platformPrompts._internals.resetForTests()
          const allMcpTools = [...PLATFORM_MCP_TOOL_NAMES]
          const sessionKey = 'agent:eval-stability:webchat:sess-prefix-stability'

          // Turn 1 dynamic state
          writeFileSync(
            join(stabilityDir, 'memory', 'turn1-note.md'),
            '---\nname: Turn 1 Note\ndescription: Initial turn dynamic memory entry.\ntype: project\n---\nTurn 1 body.\n',
            'utf8',
          )
          writeFileSync(
            join(stabilityDir, 'MEMORY.md'),
            '<!-- oc-memdir-index v1 -->\n- [Turn 1 Note](memory/turn1-note.md) — Initial turn dynamic memory entry.\n',
            'utf8',
          )
          writeFileSync(
            join(home, 'agents.yaml'),
            [
              'default: eval-stability',
              'routes: []',
              'agents:',
              '  - id: eval-stability',
              '    displayName: Eval Stability',
              '    model: claude-sonnet-4-6',
              '    provider: ccb',
              '  - id: collab-alpha',
              '    displayName: Collaborator Alpha',
              '    model: claude-sonnet-4-6',
              '    provider: ccb',
              '    source: marketplace',
              '',
            ].join('\n'),
            'utf8',
          )

          const turn1UserMessage = 'Turn 1 user prompt: summarize the gateway config.'
          const res1 = await buildPromptContext({
            agentId: 'eval-stability',
            sessionKey,
            sessionId: 'sess-prefix-stability',
            provider: 'ccb',
            model: 'claude-sonnet-4-6',
            cacheLayout: 'static-first',
            availableMcpTools: allMcpTools,
            promptPolicy: DEFAULT_PROMPT_PRIVACY,
            delegateModelCatalog: {
              models: [{ modelId: 'claude-sonnet-4-6', engine: 'ccb', available: true }],
              projectionRevision: 'rev-turn-1',
              verifiedAt: 100,
            },
            projectContext: null,
            frozenProjectContext: null,
            projectInstructions: 'Turn 1 dynamic project instructions.',
            projectAssets: null,
            repoSnapshot: null,
            skillUsageMap: new Map(),
          })

          // Turn 2 dynamic perturbation
          writeFileSync(
            join(stabilityDir, 'memory', 'turn2-note.md'),
            '---\nname: Turn 2 Note\ndescription: Mutated dynamic memory entry added on turn 2.\ntype: feedback\n---\nTurn 2 body.\n',
            'utf8',
          )
          writeFileSync(
            join(stabilityDir, 'MEMORY.md'),
            [
              '<!-- oc-memdir-index v1 -->',
              '- [Turn 1 Note](memory/turn1-note.md) — Initial turn dynamic memory entry.',
              '- [Turn 2 Note](memory/turn2-note.md) — Mutated dynamic memory entry added on turn 2.',
              '',
            ].join('\n'),
            'utf8',
          )
          writeFileSync(
            join(home, 'agents.yaml'),
            [
              'default: eval-stability',
              'routes: []',
              'agents:',
              '  - id: eval-stability',
              '    displayName: Eval Stability',
              '    model: claude-sonnet-4-6',
              '    provider: ccb',
              '  - id: collab-alpha',
              '    displayName: Collaborator Alpha',
              '    model: claude-sonnet-4-6',
              '    provider: ccb',
              '    source: marketplace',
              '  - id: collab-beta',
              '    displayName: Collaborator Beta',
              '    model: claude-opus-4-7',
              '    provider: ccb',
              '    source: marketplace',
              '',
            ].join('\n'),
            'utf8',
          )

          const turn2UserMessage =
            'Turn 2 user prompt: now run the full context regression diff and list changed slots.'
          const res2 = await buildPromptContext({
            agentId: 'eval-stability',
            sessionKey,
            sessionId: 'sess-prefix-stability',
            provider: 'ccb',
            model: 'claude-sonnet-4-6',
            cacheLayout: 'static-first',
            availableMcpTools: allMcpTools,
            promptPolicy: DEFAULT_PROMPT_PRIVACY,
            delegateModelCatalog: {
              models: [
                { modelId: 'claude-sonnet-4-6', engine: 'ccb', available: true },
                { modelId: 'claude-opus-4-7', engine: 'ccb', available: true },
                { modelId: 'grok-4', engine: 'grok', available: true },
              ],
              projectionRevision: 'rev-turn-2',
              verifiedAt: 200,
            },
            projectContext: null,
            frozenProjectContext: null,
            projectInstructions: 'Turn 2 mutated dynamic project instructions with new constraints.',
            projectAssets: null,
            repoSnapshot: {
              owner: 'openclaude',
              repo: 'context-eval-demo',
              branch: 'feat/turn-2-perturbation',
              status: 'ready',
              workspaceDir: '/home/agent/.openclaude/repos/context-eval-demo',
              headSha: 'fedcba9876543210fedcba9876543210fedcba98',
            },
            skillUsageMap: new Map(),
          })

          const parts1 = res1.content.split(PROMPT_SESSION_CONTEXT_MARKER)
          const parts2 = res2.content.split(PROMPT_SESSION_CONTEXT_MARKER)
          if (parts1.length !== 2 || parts2.length !== 2) {
            issues.push({
              guard: 'staticPrefixStability',
              code: 'MARKER_SPLIT_INVALID',
              target: 'PROMPT_SESSION_CONTEXT_MARKER',
              message: `Expected exactly 1 marker occurrence in both turns (got turn1=${parts1.length - 1}, turn2=${parts2.length - 1})`,
            })
          }

          const turn1PrefixSha256 = sha256(parts1[0] ?? '')
          const turn2PrefixSha256 = sha256(parts2[0] ?? '')
          const turn1DynamicSha256 = sha256(`${parts1[1] ?? ''}\n${turn1UserMessage}`)
          const turn2DynamicSha256 = sha256(`${parts2[1] ?? ''}\n${turn2UserMessage}`)

          if (turn1PrefixSha256 !== turn2PrefixSha256) {
            issues.push({
              guard: 'staticPrefixStability',
              code: 'STATIC_PREFIX_DRIFT',
              target: 'static-first-prefix',
              message: `Static prefix SHA256 drifted across Turn 1 (${turn1PrefixSha256.slice(0, 12)}) -> Turn 2 (${turn2PrefixSha256.slice(0, 12)})`,
            })
          }
          if (turn1DynamicSha256 === turn2DynamicSha256) {
            issues.push({
              guard: 'staticPrefixStability',
              code: 'DYNAMIC_PERTURBATION_NOOP',
              target: 'dynamic-tail',
              message: 'Turn 1 and Turn 2 dynamic tails were identical; perturbation did not take effect',
            })
          }

          const agentsStatic1 = res1.applied.find((s) => s.name === 'AGENTS')?.meta?.static_sha256
          const agentsStatic2 = res2.applied.find((s) => s.name === 'AGENTS')?.meta?.static_sha256
          const agentsStaticSha256Equal = Boolean(agentsStatic1 && agentsStatic1 === agentsStatic2)
          if (!agentsStaticSha256Equal) {
            issues.push({
              guard: 'staticPrefixStability',
              code: 'AGENTS_STATIC_HASH_DRIFT',
              target: 'AGENTS.static_sha256',
              message: `AGENTS static_sha256 drifted: ${String(agentsStatic1)} vs ${String(agentsStatic2)}`,
            })
          }

          const inputsKey = promptFreezeInputsKey({
            agentId: 'eval-stability',
            model: 'claude-sonnet-4-6',
            provider: 'ccb',
            cacheLayout: 'static-first',
            availableMcpTools: allMcpTools,
            sessionId: 'sess-prefix-stability',
            intelligentUi: res1.intelligentUi ?? false,
            promptPolicyFingerprint: res1.promptPolicyFingerprint,
          })

          const t0 = 1_760_000_000_000
          const firstFreeze = applyPromptFreeze({
            home: freezeHome,
            sessionKey,
            mode: 'enforce',
            inputsKey,
            fresh: { content: res1.content, contentSha256: res1.contentSha256, applied: res1.applied },
            now: t0,
          })
          if (firstFreeze.decision !== 'fresh_first' || firstFreeze.reused !== false) {
            issues.push({
              guard: 'staticPrefixStability',
              code: 'PROMPT_FREEZE_FIRST_SPAWN_INVALID',
              target: 'applyPromptFreeze',
              message: `Expected fresh_first/reused=false on Turn 1, got decision=${firstFreeze.decision} reused=${String(firstFreeze.reused)}`,
            })
          }

          const secondFreeze = applyPromptFreeze({
            home: freezeHome,
            sessionKey,
            mode: 'enforce',
            inputsKey,
            fresh: { content: res2.content, contentSha256: res2.contentSha256, applied: res2.applied },
            now: t0 + 60_000,
          })
          const freezeStaticSlotsChanged = secondFreeze.changedSlots.filter((s) => STATIC_SLOT_NAMES.has(s))

          if (!secondFreeze.reused || secondFreeze.decision !== 'reuse') {
            issues.push({
              guard: 'staticPrefixStability',
              code: 'PROMPT_FREEZE_REUSE_FAILED',
              target: 'applyPromptFreeze',
              message: `Expected decision=reuse & reused=true on Turn 2 respawn, got decision=${secondFreeze.decision} reused=${String(secondFreeze.reused)}`,
            })
          }
          if (secondFreeze.chosen.contentSha256 !== res1.contentSha256) {
            issues.push({
              guard: 'staticPrefixStability',
              code: 'PROMPT_FREEZE_CONTENT_MISMATCH',
              target: 'applyPromptFreeze',
              message: 'Reused frozen prompt contentSha256 did not match Turn 1 snapshot',
            })
          }
          if (freezeStaticSlotsChanged.length > 0) {
            issues.push({
              guard: 'staticPrefixStability',
              code: 'PROMPT_FREEZE_STATIC_SLOT_DRIFT',
              target: freezeStaticSlotsChanged.join(','),
              message: `Static slot(s) drifted between Turn 1 and Turn 2: ${freezeStaticSlotsChanged.join(', ')}`,
            })
          }

          return {
            pass: issues.length === 0,
            issues,
            turn1PrefixSha256,
            turn2PrefixSha256,
            turn1DynamicSha256,
            turn2DynamicSha256,
            agentsStaticSha256Equal,
            freezeReused: secondFreeze.reused,
            freezeDecision: secondFreeze.decision,
            freezeChangedSlots: secondFreeze.changedSlots,
            freezeStaticSlotsChanged,
          }
        },
      ),
    )
  } finally {
    rmSync(freezeHome, { recursive: true, force: true })
  }
}

// ── Guard 4: Existing 0-Token Memory & Skill Regression Sub-Evals ──

function findTsxCli(): string | null {
  return (
    [
      join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
      '/opt/openclaude/openclaude/node_modules/tsx/dist/cli.mjs',
    ].find((p) => existsSync(p)) ?? null
  )
}

function buildOfflineChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DASHSCOPE_API_KEY',
    'EMBEDDING_API_KEY',
    'EMBEDDING_PROVIDER',
    'EMBEDDING_BASE_URL',
    'OPENCLAUDE_V3_MASTER_BASE_URL',
    'OPENCLAUDE_V3_CONTAINER_TOKEN',
    'OPENCLAUDE_V3_CONTAINER_TOKEN_FILE',
    'OC_MANAGED_AGENT_RUNTIME',
  ]) {
    delete env[key]
  }
  return env
}

function runSubprocessCapture(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; elapsedMs: number }> {
  return new Promise((resolveRun) => {
    const t0 = performance.now()
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => outChunks.push(c))
    child.stderr.on('data', (c: Buffer) => errChunks.push(c))
    child.on('error', (err) => {
      resolveRun({
        code: 2,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: `${Buffer.concat(errChunks).toString('utf8')}\n${err.message}`,
        elapsedMs: Math.round(performance.now() - t0),
      })
    })
    child.on('close', (code) => {
      resolveRun({
        code: code ?? 2,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        elapsedMs: Math.round(performance.now() - t0),
      })
    })
  })
}

export function evaluateSubEvalMetrics(
  coreMemory: CoreMemoryEvalMetrics | null,
  skillShadow: SkillShadowEvalMetrics | null,
  baseline: SubEvalsBaseline,
): GuardIssue[] {
  const issues: GuardIssue[] = []

  if (!coreMemory) {
    issues.push({
      guard: 'subEvals',
      code: 'CORE_MEMORY_EVAL_MISSING',
      target: 'packages/mcp-memory/evals/run.mjs',
      message: 'Core memory eval failed to produce a valid JSON report',
    })
  } else {
    if (!coreMemory.pass) {
      issues.push({
        guard: 'subEvals',
        code: 'CORE_MEMORY_EVAL_FAILED',
        target: 'packages/mcp-memory/evals/run.mjs',
        message: `Core memory eval reported pass=false (P@3=${coreMemory.precisionAt3.toFixed(3)}, noMatch=${coreMemory.noMatchAccuracy.toFixed(3)}, avgHits=${coreMemory.avgHits.toFixed(2)})`,
      })
    }
    if (coreMemory.precisionAt3 < baseline.coreMemory.minPrecisionAt3) {
      issues.push({
        guard: 'subEvals',
        code: 'CORE_MEMORY_P3_REGRESSION',
        target: 'coreMemory.precisionAt3',
        message: `precision@3=${coreMemory.precisionAt3.toFixed(3)} dropped below baseline ${baseline.coreMemory.minPrecisionAt3.toFixed(3)}`,
      })
    }
    if (coreMemory.mrr < baseline.coreMemory.minMrr) {
      issues.push({
        guard: 'subEvals',
        code: 'CORE_MEMORY_MRR_REGRESSION',
        target: 'coreMemory.mrr',
        message: `MRR=${coreMemory.mrr.toFixed(3)} dropped below baseline ${baseline.coreMemory.minMrr.toFixed(3)}`,
      })
    }
    if (coreMemory.noMatchAccuracy < baseline.coreMemory.minNoMatchAccuracy) {
      issues.push({
        guard: 'subEvals',
        code: 'CORE_MEMORY_NOMATCH_REGRESSION',
        target: 'coreMemory.noMatchAccuracy',
        message: `noMatchAccuracy=${coreMemory.noMatchAccuracy.toFixed(3)} dropped below baseline ${baseline.coreMemory.minNoMatchAccuracy.toFixed(3)}`,
      })
    }
    if (coreMemory.avgHitsRatio > baseline.coreMemory.maxAvgHitsRatio) {
      issues.push({
        guard: 'subEvals',
        code: 'CORE_MEMORY_AVGHITS_REGRESSION',
        target: 'coreMemory.avgHitsRatio',
        message: `avgHitsRatio=${coreMemory.avgHitsRatio.toFixed(3)} exceeded cap ${baseline.coreMemory.maxAvgHitsRatio.toFixed(3)}`,
      })
    }
  }

  if (!skillShadow) {
    issues.push({
      guard: 'subEvals',
      code: 'SKILL_SHADOW_EVAL_MISSING',
      target: 'scripts/v5-skill-shadow-eval.ts',
      message: 'Skill shadow eval failed to produce a valid JSON report',
    })
  } else {
    if (skillShadow.cases < baseline.skillShadow.minCases) {
      issues.push({
        guard: 'subEvals',
        code: 'SKILL_SHADOW_CASES_DROPPED',
        target: 'skillShadow.cases',
        message: `skillShadow cases=${skillShadow.cases} dropped below baseline ${baseline.skillShadow.minCases}`,
      })
    }
    for (const [route, minMetrics] of Object.entries(baseline.skillShadow.routes)) {
      const actual = skillShadow.routes[route]
      if (!actual) {
        issues.push({
          guard: 'subEvals',
          code: 'SKILL_SHADOW_ROUTE_MISSING',
          target: `skillShadow.${route}`,
          message: `Missing skill shadow route ${route} in eval output`,
        })
        continue
      }
      if (actual.recallAt3 < minMetrics.minRecallAt3) {
        issues.push({
          guard: 'subEvals',
          code: 'SKILL_SHADOW_RECALL3_REGRESSION',
          target: `skillShadow.${route}.recallAt3`,
          message: `${route} recall@3=${actual.recallAt3.toFixed(3)} dropped below baseline ${minMetrics.minRecallAt3.toFixed(3)}`,
        })
      }
      if (actual.recallAt5 < minMetrics.minRecallAt5) {
        issues.push({
          guard: 'subEvals',
          code: 'SKILL_SHADOW_RECALL5_REGRESSION',
          target: `skillShadow.${route}.recallAt5`,
          message: `${route} recall@5=${actual.recallAt5.toFixed(3)} dropped below baseline ${minMetrics.minRecallAt5.toFixed(3)}`,
        })
      }
    }
  }

  return issues
}

export async function runSubEvalsGuard(baseline: SubEvalsBaseline): Promise<SubEvalsResult> {
  const tsxCli = findTsxCli()
  const childEnv = buildOfflineChildEnv()
  const memArgs = tsxCli
    ? [tsxCli, 'packages/mcp-memory/evals/run.mjs', '--json']
    : ['packages/mcp-memory/evals/run.mjs', '--json']
  const skillCmd = tsxCli ? process.execPath : 'npx'
  const skillArgs = tsxCli
    ? [tsxCli, 'scripts/v5-skill-shadow-eval.ts']
    : ['tsx', 'scripts/v5-skill-shadow-eval.ts']

  const [memProc, skillProc] = await Promise.all([
    runSubprocessCapture(process.execPath, memArgs, childEnv),
    runSubprocessCapture(skillCmd, skillArgs, childEnv),
  ])

  const issues: GuardIssue[] = []
  let coreMemory: CoreMemoryEvalMetrics | null = null
  let skillShadow: SkillShadowEvalMetrics | null = null

  if (memProc.code !== 0) {
    issues.push({
      guard: 'subEvals',
      code: 'CORE_MEMORY_EXIT_NONZERO',
      target: 'packages/mcp-memory/evals/run.mjs',
      message: `packages/mcp-memory/evals/run.mjs exited with code ${memProc.code}: ${memProc.stderr.trim().slice(0, 300)}`,
    })
  }
  try {
    const parsed = JSON.parse(memProc.stdout) as {
      pass: boolean
      corpus: { files: number }
      metrics: {
        precisionAt3: number
        mrr: number
        noMatchAccuracy: number
        avgHits: number
        casesPassed: number
        casesTotal: number
      }
    }
    const corpusFiles = parsed.corpus?.files ?? 1
    coreMemory = {
      pass: Boolean(parsed.pass),
      precisionAt3: parsed.metrics.precisionAt3,
      mrr: parsed.metrics.mrr,
      noMatchAccuracy: parsed.metrics.noMatchAccuracy,
      avgHits: parsed.metrics.avgHits,
      corpusFiles,
      avgHitsRatio: parsed.metrics.avgHits / Math.max(1, corpusFiles),
      casesPassed: parsed.metrics.casesPassed,
      casesTotal: parsed.metrics.casesTotal,
      elapsedMs: memProc.elapsedMs,
    }
  } catch (err) {
    if (memProc.code === 0) {
      issues.push({
        guard: 'subEvals',
        code: 'CORE_MEMORY_JSON_INVALID',
        target: 'packages/mcp-memory/evals/run.mjs',
        message: `Failed to parse JSON output from memory eval: ${(err as Error).message}`,
      })
    }
  }

  if (skillProc.code !== 0) {
    issues.push({
      guard: 'subEvals',
      code: 'SKILL_SHADOW_EXIT_NONZERO',
      target: 'scripts/v5-skill-shadow-eval.ts',
      message: `scripts/v5-skill-shadow-eval.ts exited with code ${skillProc.code}: ${skillProc.stderr.trim().slice(0, 300)}`,
    })
  }
  try {
    const parsed = JSON.parse(skillProc.stdout) as {
      dataset: { cases: number; skillsWithEvals: number; catalogSize: number }
      routes: Record<string, { recallAt3: number; recallAt5: number; hitsAt3: number; hitsAt5: number }>
    }
    skillShadow = {
      cases: parsed.dataset.cases,
      skillsWithEvals: parsed.dataset.skillsWithEvals,
      catalogSize: parsed.dataset.catalogSize,
      routes: parsed.routes,
      elapsedMs: skillProc.elapsedMs,
    }
  } catch (err) {
    if (skillProc.code === 0) {
      issues.push({
        guard: 'subEvals',
        code: 'SKILL_SHADOW_JSON_INVALID',
        target: 'scripts/v5-skill-shadow-eval.ts',
        message: `Failed to parse JSON output from skill shadow eval: ${(err as Error).message}`,
      })
    }
  }

  issues.push(...evaluateSubEvalMetrics(coreMemory, skillShadow, baseline))
  return { status: issues.length === 0 ? 'passed' : 'failed', pass: issues.length === 0, issues, coreMemory, skillShadow }
}

// ── Top-level orchestrator & CLI ──

export function readBaselineFile(baselinePath: string): ContextEvalBaseline {
  if (!existsSync(baselinePath)) throw new Error(`Baseline file not found: ${baselinePath}`)
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as ContextEvalBaseline
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1 || !isPlainObject(parsed.fixtures)) {
    throw new Error(`Invalid context-eval baseline schema in ${baselinePath}`)
  }
  return parsed
}

export async function generateBaselineSnapshot(opts: {
  includeSubEvals: boolean
  existing?: Partial<ContextEvalBaseline>
}): Promise<ContextEvalBaseline> {
  const { promptSlots } = await loadGatewayModules()
  const measured = await buildSyntheticFixtures()

  const fixtures = {} as Record<FixtureName, FixtureBaselineEntry>
  for (const name of FIXTURE_NAMES) {
    const m = measured[name]
    fixtures[name] = {
      totalBytes: m.totalBytes,
      tokensEstimate: m.tokensEstimate,
      staticPrefixBytes: m.staticPrefixBytes,
      slots: m.slots,
    }
  }

  let subEvals: SubEvalsBaseline = opts.existing?.subEvals ?? {
    coreMemory: { minPrecisionAt3: 1.0, minMrr: 1.0, minNoMatchAccuracy: 1.0, maxAvgHitsRatio: 0.4 },
    skillShadow: {
      minCases: 40,
      routes: {
        existing_keyword_fallback: { minRecallAt3: 0.375, minRecallAt5: 0.45 },
        zh_lexical: { minRecallAt3: 0.55, minRecallAt5: 0.625 },
        char_ngram: { minRecallAt3: 0.725, minRecallAt5: 0.725 },
        bm25_multiquery: { minRecallAt3: 0.75, minRecallAt5: 0.8 },
      },
    },
  }

  if (opts.includeSubEvals) {
    const subRes = await runSubEvalsGuard({
      coreMemory: { minPrecisionAt3: 0, minMrr: 0, minNoMatchAccuracy: 0, maxAvgHitsRatio: 1 },
      skillShadow: { minCases: 0, routes: {} },
    })
    if (subRes.coreMemory && subRes.skillShadow) {
      subEvals = {
        coreMemory: {
          minPrecisionAt3: subRes.coreMemory.precisionAt3,
          minMrr: subRes.coreMemory.mrr,
          minNoMatchAccuracy: subRes.coreMemory.noMatchAccuracy,
          maxAvgHitsRatio: 0.4,
        },
        skillShadow: {
          minCases: subRes.skillShadow.cases,
          routes: Object.fromEntries(
            Object.entries(subRes.skillShadow.routes).map(([route, r]) => [
              route,
              { minRecallAt3: r.recallAt3, minRecallAt5: r.recallAt5 },
            ]),
          ),
        },
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    thresholds: {
      maxTotalBytes: promptSlots.PROMPT_TOTAL_MAX_BYTES,
      maxTotalGrowthRatio: DEFAULT_MAX_TOTAL_GROWTH_RATIO,
      maxSlotGrowthRatio: DEFAULT_MAX_SLOT_GROWTH_RATIO,
      minSlotGrowthBytes: DEFAULT_MIN_SLOT_GROWTH_BYTES,
    },
    fixtures,
    subEvals,
    waivers: opts.existing?.waivers ?? [],
    replayReceipts: opts.existing?.replayReceipts ?? [],
  }
}

export async function runContextStaticGate(opts: {
  baselinePath?: string
  baselineOverride?: ContextEvalBaseline
  skipSubEvals?: boolean
  nowMs?: number
  repoRoot?: string
}): Promise<ContextStaticReport> {
  const t0 = performance.now()
  const baselinePath = opts.baselinePath ?? DEFAULT_BASELINE_PATH
  const baseline = opts.baselineOverride ?? readBaselineFile(baselinePath)
  const nowMs = opts.nowMs ?? Date.now()
  const { promptSlots } = await loadGatewayModules()

  const measured = await buildSyntheticFixtures()
  const slotLedgerRatchet = evaluateSlotLedgerRatchet(
    measured,
    baseline,
    nowMs,
    promptSlots.PROMPT_TOTAL_MAX_BYTES,
  )
  const staticPrefixStability = await runStaticPrefixStabilityGuard()
  const residentContractGuard = evaluateResidentContracts(
    measured,
    baseline,
    nowMs,
    opts.repoRoot ?? REPO_ROOT,
  )
  const subEvals: SubEvalsResult = opts.skipSubEvals
    ? { status: 'skipped', pass: true, issues: [], coreMemory: null, skillShadow: null }
    : await runSubEvalsGuard(baseline.subEvals)

  const issues = [
    ...slotLedgerRatchet.issues,
    ...staticPrefixStability.issues,
    ...residentContractGuard.issues,
    ...subEvals.issues,
  ]

  return {
    pass: issues.length === 0,
    elapsedMs: Math.round(performance.now() - t0),
    baselinePath,
    guards: { slotLedgerRatchet, staticPrefixStability, residentContractGuard, subEvals },
    issues,
  }
}

function formatHumanReport(report: ContextStaticReport): string {
  const lines: string[] = [
    `[check-context-static] ${report.pass ? 'PASS' : 'FAIL'} (${report.elapsedMs}ms) baseline=${report.baselinePath}`,
    '',
    `1. Slot Ledger & Ratchet: ${report.guards.slotLedgerRatchet.pass ? 'PASS' : 'FAIL'}`,
  ]
  for (const name of FIXTURE_NAMES) {
    const f = report.guards.slotLedgerRatchet.fixtures[name]
    const delta = f.deltaBytes === null ? 'n/a' : `${f.deltaBytes >= 0 ? '+' : ''}${f.deltaBytes}B`
    lines.push(
      `   - ${name.padEnd(21)} ${String(f.totalBytes).padStart(6)}B (${delta.padStart(7)})  ~${f.tokensEstimate} tok  staticPrefix=${f.staticPrefixBytes ?? 'n/a'}B`,
    )
  }
  for (const w of report.guards.slotLedgerRatchet.waiversApplied) {
    lines.push(`   * waiver applied: ${w.fixture} via ${w.ticket} (max=${w.maxBytes}B, expires=${w.expiresAt})`)
  }
  const sp = report.guards.staticPrefixStability
  lines.push(
    '',
    `2. StaticPrefixStability: ${sp.pass ? 'PASS' : 'FAIL'} (prefixSha=${sp.turn1PrefixSha256.slice(0, 12)}, freeze=${sp.freezeDecision}/reused=${String(sp.freezeReused)}, changedDynamic=[${sp.freezeChangedSlots.join(',')}])`,
    '',
    `3. ResidentContractGuard: ${report.guards.residentContractGuard.pass ? 'PASS' : 'FAIL'}`,
  )
  for (const c of report.guards.residentContractGuard.checks) {
    lines.push(`   - ${c.pass ? 'OK  ' : 'FAIL'} ${c.contract.padEnd(24)} (${c.fixture}): ${c.detail}`)
  }
  const se = report.guards.subEvals
  lines.push('')
  if (se.status === 'skipped') {
    lines.push('4. SubEvals (Memory + Skill Shadow): SKIPPED (--skip-sub-evals)')
  } else {
    lines.push(`4. SubEvals (Memory + Skill Shadow): ${se.pass ? 'PASS' : 'FAIL'}`)
    if (se.coreMemory) {
      lines.push(
        `   - coreMemory: P@3=${se.coreMemory.precisionAt3.toFixed(3)} MRR=${se.coreMemory.mrr.toFixed(3)} noMatch=${se.coreMemory.noMatchAccuracy.toFixed(3)} avgHits=${se.coreMemory.avgHits.toFixed(2)}/${se.coreMemory.corpusFiles} (${se.coreMemory.elapsedMs}ms)`,
      )
    }
    if (se.skillShadow) {
      const routes = Object.entries(se.skillShadow.routes)
        .map(([k, v]) => `${k}=${v.recallAt3.toFixed(3)}/${v.recallAt5.toFixed(3)}`)
        .join('  ')
      lines.push(`   - skillShadow (${se.skillShadow.cases} cases, ${se.skillShadow.elapsedMs}ms): ${routes}`)
    }
  }
  if (report.issues.length > 0) {
    lines.push('', `Failures (${report.issues.length}):`)
    for (const issue of report.issues) {
      lines.push(`  [${issue.guard}:${issue.code}] ${issue.target} — ${issue.message}`)
    }
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  let opts: CliOptions
  try {
    opts = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[check-context-static] ${(err as Error).message}`)
    process.exit(2)
  }
  if (opts.help) {
    console.log(
      'Usage: npx tsx scripts/check-context-static.ts [--json] [--skip-sub-evals] [--baseline <path>] [--now <iso>] [--write-baseline]',
    )
    process.exit(0)
  }
  if (opts.writeBaseline) {
    const existing = existsSync(opts.baselinePath)
      ? (JSON.parse(readFileSync(opts.baselinePath, 'utf8')) as Partial<ContextEvalBaseline>)
      : undefined
    const snap = await generateBaselineSnapshot({ includeSubEvals: !opts.skipSubEvals, existing })
    mkdirSync(dirname(opts.baselinePath), { recursive: true })
    writeFileSync(opts.baselinePath, `${JSON.stringify(snap, null, 2)}\n`, 'utf8')
    console.log(opts.json ? JSON.stringify(snap, null, 2) : `[check-context-static] wrote baseline to ${opts.baselinePath}`)
    process.exit(0)
  }

  let report: ContextStaticReport
  try {
    report = await runContextStaticGate({
      baselinePath: opts.baselinePath,
      skipSubEvals: opts.skipSubEvals,
      nowMs: opts.nowMs,
    })
  } catch (err) {
    console.error(`[check-context-static] fatal: ${(err as Error).message}`)
    process.exit(2)
  }

  console.log(opts.json ? JSON.stringify(report, null, 2) : formatHumanReport(report))
  process.exit(report.pass ? 0 : 1)
}

const __filename_ = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === __filename_) {
  await main()
}
