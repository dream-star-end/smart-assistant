/**
 * L6 Independent VLM Aesthetic Rubric Judge Engine (Blueprint §3.3 L6).
 *
 * Dual-purpose module:
 *   1. Exported pure engine (zero external npm dependencies, unit-testable offline):
 *      - loadVlmRubric(rubricPath) / validateVlmRubric(raw)
 *      - shouldTriggerVlmJudge(changedFiles, labels, options)
 *      - buildVlmJudgePrompt(rubric, context)
 *      - evaluateVlmResponse(rawJson, rubric, opts)
 *   2. CLI runner:
 *      - Supports `--dry-run --changed-files a,b --labels ui-redesign`
 *      - Supports `--response-file <path>` to validate/score a captured VLM JSON response
 *      - Gracefully skips (exit 0, $0 cost) on non-trigger paths
 *      - In `advisory` mode without a configured VLM API key, prints an explicit advisory notice
 *        and exits 0 without breaking CI; in `enforce` mode, fails closed.
 *
 * Exit codes: 0 = pass / skip / advisory-only, 1 = gate rejection / invalid response / budget exceeded, 2 = CLI usage error.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_RUBRIC_PATH = 'packages/web-react/browser-tests/vlm-rubric/rubric.json'

export const VLM_DIMENSION_IDS = [
  'craft',
  'hierarchy_density',
  'design_system_coherence',
  'anti_slop_restraint',
  'interactive_usability',
] as const

export type VlmDimensionId = (typeof VLM_DIMENSION_IDS)[number]
export type VlmJudgeMode = 'advisory' | 'enforce'

export type VlmRubricDimension = {
  id: VlmDimensionId
  label: string
  minScore: number
  hardRejectBelow: number
  weight: number
  criteria: string
  anchors: {
    '5': string
    '3': string
    '1': string
  }
}

export type VlmTriggerPolicy = {
  labels: string[]
  exactPaths: string[]
  pathPrefixes: string[]
  newTopLevelCenterPatterns: string[]
  ignorePatterns: string[]
}

export type VlmRubric = {
  schemaVersion: number
  mode: VlmJudgeMode
  calibrationWeeks: number
  temperature: number
  hardRejectFloor: number
  passTargetDefault: number
  maxCostUsdPerPr: number
  maxRoundsPerPr: number
  scoreScale: {
    min: number
    max: number
  }
  dimensions: VlmRubricDimension[]
  triggerPolicy: VlmTriggerPolicy
}

export type ChangedFileInput =
  | string
  | {
      path: string
      status?: 'A' | 'M' | 'D' | 'R'
    }

export type VlmTriggerDecision = {
  trigger: boolean
  reasons: string[]
  matchedFiles: string[]
  matchedLabels: string[]
  estimatedCostUsd: number
}

export type VlmPromptContext = {
  prTitle?: string
  changedFiles?: string[]
  scenes?: string[]
  viewports?: string[]
  themes?: string[]
  round?: number
}

export type VlmJudgePrompt = {
  system: string
  user: string
  temperature: number
  responseFormat: 'json_object'
}

export type VlmObservation = {
  zone: string
  finding: string
}

export type VlmDefect = {
  zone?: string
  dimension?: string
  severity?: 'critical' | 'major' | 'minor'
  description: string
  suggestion?: string
}

export type VlmEvaluationOptions = {
  mode?: VlmJudgeMode
  costUsd?: number
  round?: number
}

export type VlmEvaluationVerdict =
  | 'pass'
  | 'needs-review'
  | 'hard-reject'
  | 'budget-exceeded'
  | 'round-limit-exceeded'
  | 'invalid-response'

export type VlmEvaluationResult = {
  ok: boolean
  blocked: boolean
  advisoryWarning: boolean
  needsHumanReview: boolean
  mode: VlmJudgeMode
  verdict: VlmEvaluationVerdict
  exitCode: 0 | 1
  scores: Partial<Record<VlmDimensionId, number>>
  weightedScore: number | null
  hardRejectDimensions: Array<{ id: VlmDimensionId; score: number; floor: number }>
  reviewDimensions: Array<{ id: VlmDimensionId; score: number; minScore: number }>
  observationsCount: number
  defectsCount: number
  costUsd: number
  round: number
  errors: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRepoPath(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

export function validateVlmRubric(raw: unknown): VlmRubric {
  if (!isPlainObject(raw)) {
    throw new Error('[GATE-ERROR] VLM-RUBRIC-INVALID: rubric root must be an object')
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(
      `[GATE-ERROR] VLM-RUBRIC-INVALID: unsupported schemaVersion=${JSON.stringify(raw.schemaVersion)}`,
    )
  }
  if (raw.mode !== 'advisory' && raw.mode !== 'enforce') {
    throw new Error(`[GATE-ERROR] VLM-RUBRIC-INVALID: invalid mode=${JSON.stringify(raw.mode)}`)
  }
  if (typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature) || raw.temperature !== 0) {
    throw new Error(
      `[GATE-ERROR] VLM-RUBRIC-INVALID: temperature must be 0 for deterministic grading (got ${JSON.stringify(raw.temperature)})`,
    )
  }
  if (
    typeof raw.hardRejectFloor !== 'number' ||
    !Number.isFinite(raw.hardRejectFloor) ||
    raw.hardRejectFloor <= 0 ||
    raw.hardRejectFloor > 5
  ) {
    throw new Error('[GATE-ERROR] VLM-RUBRIC-INVALID: invalid hardRejectFloor')
  }
  if (
    typeof raw.maxCostUsdPerPr !== 'number' ||
    !Number.isFinite(raw.maxCostUsdPerPr) ||
    raw.maxCostUsdPerPr <= 0
  ) {
    throw new Error('[GATE-ERROR] VLM-RUBRIC-INVALID: invalid maxCostUsdPerPr')
  }
  if (
    typeof raw.maxRoundsPerPr !== 'number' ||
    !Number.isSafeInteger(raw.maxRoundsPerPr) ||
    raw.maxRoundsPerPr < 1
  ) {
    throw new Error('[GATE-ERROR] VLM-RUBRIC-INVALID: invalid maxRoundsPerPr')
  }
  if (!Array.isArray(raw.dimensions) || raw.dimensions.length !== VLM_DIMENSION_IDS.length) {
    throw new Error(
      `[GATE-ERROR] VLM-RUBRIC-INVALID: expected ${VLM_DIMENSION_IDS.length} dimensions`,
    )
  }
  const seen = new Set<string>()
  for (const dim of raw.dimensions) {
    if (!isPlainObject(dim)) {
      throw new Error('[GATE-ERROR] VLM-RUBRIC-INVALID: each dimension must be an object')
    }
    if (
      typeof dim.id !== 'string' ||
      !(VLM_DIMENSION_IDS as readonly string[]).includes(dim.id) ||
      seen.has(dim.id)
    ) {
      throw new Error(
        `[GATE-ERROR] VLM-RUBRIC-INVALID: unknown or duplicate dimension id=${JSON.stringify(dim.id)}`,
      )
    }
    seen.add(dim.id)
    if (typeof dim.minScore !== 'number' || !Number.isFinite(dim.minScore)) {
      throw new Error(`[GATE-ERROR] VLM-RUBRIC-INVALID: invalid minScore for ${dim.id}`)
    }
    if (typeof dim.hardRejectBelow !== 'number' || !Number.isFinite(dim.hardRejectBelow)) {
      throw new Error(`[GATE-ERROR] VLM-RUBRIC-INVALID: invalid hardRejectBelow for ${dim.id}`)
    }
    if (typeof dim.weight !== 'number' || !Number.isFinite(dim.weight) || dim.weight <= 0) {
      throw new Error(`[GATE-ERROR] VLM-RUBRIC-INVALID: invalid weight for ${dim.id}`)
    }
  }
  if (!isPlainObject(raw.triggerPolicy)) {
    throw new Error('[GATE-ERROR] VLM-RUBRIC-INVALID: missing triggerPolicy')
  }
  return raw as unknown as VlmRubric
}

export function loadVlmRubric(rubricPath?: string): VlmRubric {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const absPath = rubricPath ? path.resolve(rubricPath) : path.join(repoRoot, DEFAULT_RUBRIC_PATH)
  if (!existsSync(absPath)) {
    throw new Error(`[GATE-ERROR] VLM-RUBRIC-INVALID: rubric file not found: ${absPath}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf8'))
  } catch (err) {
    throw new Error(
      `[GATE-ERROR] VLM-RUBRIC-INVALID: malformed rubric JSON (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  return validateVlmRubric(parsed)
}

/**
 * Determine whether a PR should trigger the L6 VLM Aesthetic Judge.
 * Non-trigger changes (T0 backend/docs/scripts, ordinary local UI bug fixes, tests) return
 * `{ trigger: false, estimatedCostUsd: 0 }` so PR CI spends $0.
 */
export function shouldTriggerVlmJudge(
  changedFiles: ChangedFileInput[] = [],
  labels: string[] = [],
  options: { addedFiles?: string[]; rubric?: VlmRubric } = {},
): VlmTriggerDecision {
  const rubric = options.rubric ?? loadVlmRubric()
  const policy = rubric.triggerPolicy
  const triggerLabels = new Set(policy.labels.map((l) => l.trim().toLowerCase()))
  const exactPaths = new Set(policy.exactPaths.map(normalizeRepoPath))
  const prefixes = policy.pathPrefixes.map(normalizeRepoPath)
  const centerRegexes = policy.newTopLevelCenterPatterns.map((p) => new RegExp(p))
  const ignoreRegexes = (policy.ignorePatterns ?? []).map((p) => new RegExp(p))
  const addedSet = new Set((options.addedFiles ?? []).map(normalizeRepoPath))

  const matchedLabels: string[] = []
  const matchedFiles: string[] = []
  const reasons: string[] = []

  for (const rawLabel of labels) {
    const norm = String(rawLabel ?? '').trim().toLowerCase()
    if (norm && triggerLabels.has(norm)) {
      matchedLabels.push(rawLabel.trim())
      reasons.push(`label:${rawLabel.trim()}`)
    }
  }

  for (const entry of changedFiles) {
    const filePath = normalizeRepoPath(typeof entry === 'string' ? entry : entry.path)
    if (!filePath) continue
    if (ignoreRegexes.some((re) => re.test(filePath))) continue

    const status = typeof entry === 'string' ? undefined : entry.status
    const isAdded = status === 'A' || addedSet.has(filePath)

    if (exactPaths.has(filePath)) {
      matchedFiles.push(filePath)
      reasons.push(`shell-or-styles:${filePath}`)
      continue
    }

    if (prefixes.some((prefix) => filePath.startsWith(prefix))) {
      matchedFiles.push(filePath)
      reasons.push(`design-system-ui:${filePath}`)
      continue
    }

    if (isAdded && centerRegexes.some((re) => re.test(filePath))) {
      matchedFiles.push(filePath)
      reasons.push(`new-top-level-center:${filePath}`)
    }
  }

  const dedupFiles = [...new Set(matchedFiles)]
  const dedupLabels = [...new Set(matchedLabels)]
  const dedupReasons = [...new Set(reasons)]
  const trigger = dedupReasons.length > 0

  return {
    trigger,
    reasons: dedupReasons,
    matchedFiles: dedupFiles,
    matchedLabels: dedupLabels,
    estimatedCostUsd: trigger ? Math.min(0.18, rubric.maxCostUsdPerPr) : 0,
  }
}

/**
 * Build an adversarial, CoT-enforced, few-shot anchored VLM aesthetic audit prompt.
 * Forces the VLM to list zone-by-zone pixel-level defects BEFORE outputting numerical scores.
 */
export function buildVlmJudgePrompt(
  rubric: VlmRubric,
  context: VlmPromptContext = {},
): VlmJudgePrompt {
  const validRubric = validateVlmRubric(rubric)
  const dimensionLines = validRubric.dimensions
    .map(
      (d) =>
        [
          `- **${d.id}** (${d.label}, target >= ${d.minScore.toFixed(1)}, hard-reject < ${d.hardRejectBelow.toFixed(1)}, weight ${d.weight}): ${d.criteria}`,
          `  - Anchor 5.0: ${d.anchors['5']}`,
          `  - Anchor 3.0: ${d.anchors['3']}`,
          `  - Anchor 1.0: ${d.anchors['1']}`,
        ].join('\n'),
    )
    .join('\n')

  const system = [
    '你是一名**独立挑刺设计审计员（Adversarial UI/UX Design Critic）**，与代码作者完全隔离，严禁出于礼貌打同情分。',
    '你的职责是对渲染截图进行像素级美学与可用性审计，按照固定 5 维 Rubric 给出客观、可复现的评分（temperature=0）。',
    '',
    '### 强制审计协议（CoT 先观察、后打分）',
    '1. **必须先逐区列出像素级观察缺陷（observations）**，至少覆盖以下区域中可见的全部区域：顶栏（Header）、侧栏（Sidebar）、主内容/对话区（Main Content）、输入坞/操作控件（Composer & Controls）、弹窗/抽屉/表面层级（Overlays & Surfaces）、排版与明暗对比度（Typography & Polarity）。',
    '2. 每条观察必须具体到视觉证据（如“移动端 390px 顶栏右侧胶囊与标题间距仅 2px 且发生挤压”），禁止空泛夸奖。',
    '3. 只有完成全部逐区缺陷盘点后，才能基于观察结果给 5 个维度打 1.0–5.0 分（允许 0.1 精度）。',
    `4. 评分红线：任一维度 < ${validRubric.hardRejectFloor.toFixed(1)} 触发硬打回（hard-reject）；高于等于 ${validRubric.hardRejectFloor.toFixed(1)} 但低于该维度目标分（通常 4.0）触发人工覆核（needs-review）。`,
    '',
    '### Few-shot 标定锚点（Calibration Anchors）',
    '- **高分参考（>= 4.5）**：主对话区呼吸感充裕、明暗主题描边与层次统一、图标/文字基线严格对齐、无渐变光晕等 AI 模板装饰、移动端触控热区宽裕。',
    '- **边界参考（3.5–3.9，需覆核）**：主体可用但存在局部瑕疵，例如卡片内边距轻微不一致、个别次要徽章略显喧宾夺主、或暗色模式次级文字对比度偏紧。',
    '- **打回参考（< 3.5，硬打回）**：出现控件重叠/吞字/横向溢出、暗色模式下白底刺眼孤岛、紫蓝霓虹渐变或重发光等典型 AI Slop、或向终端用户暴露内部错误码。',
    '',
    '### 5 维量化 Rubric',
    dimensionLines,
    '',
    '### 严格 JSON 输出格式（禁止输出 JSON 以外的解释文字）',
    '{',
    '  "observations": [{ "zone": "top-bar|sidebar|main-content|composer|overlays|typography", "finding": "像素级具体观察与缺陷（无缺陷也需写明实测证据）" }],',
    '  "scores": {',
    '    "craft": 4.2,',
    '    "hierarchy_density": 4.1,',
    '    "design_system_coherence": 4.3,',
    '    "anti_slop_restraint": 4.0,',
    '    "interactive_usability": 4.2',
    '  },',
    '  "defects": [{ "zone": "...", "dimension": "craft", "severity": "major", "description": "...", "suggestion": "..." }],',
    '  "summary": "一句简洁结论"',
    '}',
  ].join('\n')

  const contextLines = [
    context.prTitle ? `PR Title: ${context.prTitle}` : null,
    context.round ? `Audit Round: ${context.round} / ${validRubric.maxRoundsPerPr}` : null,
    context.changedFiles?.length ? `Changed UI Files: ${context.changedFiles.join(', ')}` : null,
    context.scenes?.length ? `Target Scenes: ${context.scenes.join(', ')}` : null,
    context.viewports?.length ? `Viewports: ${context.viewports.join(', ')}` : null,
    context.themes?.length ? `Themes: ${context.themes.join(', ')}` : null,
    '请严格按系统指令先逐区输出像素级 observations，再输出 5 维 scores 与可执行 defects。',
  ].filter(Boolean)

  return {
    system,
    user: contextLines.join('\n'),
    temperature: validRubric.temperature,
    responseFormat: 'json_object',
  }
}

function invalidResponseResult(
  mode: VlmJudgeMode,
  errors: string[],
  costUsd: number,
  round: number,
): VlmEvaluationResult {
  return {
    ok: false,
    blocked: true,
    advisoryWarning: false,
    needsHumanReview: false,
    mode,
    verdict: 'invalid-response',
    exitCode: 1,
    scores: {},
    weightedScore: null,
    hardRejectDimensions: [],
    reviewDimensions: [],
    observationsCount: 0,
    defectsCount: 0,
    costUsd,
    round,
    errors,
  }
}

/**
 * Strictly validate and evaluate a VLM judge JSON response against the rubric,
 * cost budget (<=$0.50/PR), round limit (<=2 rounds/PR), and mode (`advisory` vs `enforce`).
 *
 * Fail-closed invariants (always exitCode=1 regardless of mode):
 *   - Malformed / non-JSON / schema-invalid VLM response
 *   - Missing CoT observations or missing/out-of-range dimension scores
 *   - Cost exceeding rubric.maxCostUsdPerPr ($0.50) or round exceeding rubric.maxRoundsPerPr (2)
 */
export function evaluateVlmResponse(
  rawJson: string | Record<string, unknown>,
  rubric: VlmRubric,
  opts: VlmEvaluationOptions = {},
): VlmEvaluationResult {
  const validRubric = validateVlmRubric(rubric)
  const mode: VlmJudgeMode = opts.mode ?? validRubric.mode
  const round = opts.round ?? 1

  if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 1) {
    return invalidResponseResult(
      mode,
      [`[GATE-ERROR] VLM-JUDGE-INVALID-ROUND: round must be a positive integer (got ${String(round)})`],
      opts.costUsd ?? 0,
      1,
    )
  }

  let parsed: unknown
  if (typeof rawJson === 'string') {
    if (rawJson.trim().length === 0) {
      return invalidResponseResult(
        mode,
        ['[GATE-ERROR] VLM-JUDGE-MALFORMED-JSON: empty VLM response'],
        opts.costUsd ?? 0,
        round,
      )
    }
    try {
      parsed = JSON.parse(rawJson)
    } catch (err) {
      return invalidResponseResult(
        mode,
        [
          `[GATE-ERROR] VLM-JUDGE-MALFORMED-JSON: failed to parse VLM response JSON (${err instanceof Error ? err.message : String(err)})`,
        ],
        opts.costUsd ?? 0,
        round,
      )
    }
  } else if (isPlainObject(rawJson)) {
    parsed = rawJson
  } else {
    return invalidResponseResult(
      mode,
      ['[GATE-ERROR] VLM-JUDGE-MALFORMED-JSON: VLM response must be a JSON string or object'],
      opts.costUsd ?? 0,
      round,
    )
  }

  if (!isPlainObject(parsed)) {
    return invalidResponseResult(
      mode,
      ['[GATE-ERROR] VLM-JUDGE-INVALID-SCHEMA: VLM response root must be a JSON object'],
      opts.costUsd ?? 0,
      round,
    )
  }

  const embeddedCost =
    isPlainObject(parsed.usage) && typeof parsed.usage.costUsd === 'number'
      ? parsed.usage.costUsd
      : undefined
  const costUsd = opts.costUsd ?? embeddedCost ?? 0
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) {
    return invalidResponseResult(
      mode,
      [`[GATE-ERROR] VLM-JUDGE-INVALID-COST: invalid costUsd (${String(costUsd)})`],
      0,
      round,
    )
  }

  // Enforce per-PR cost ceiling strictly (fail-closed)
  if (costUsd > validRubric.maxCostUsdPerPr) {
    return {
      ok: false,
      blocked: true,
      advisoryWarning: false,
      needsHumanReview: false,
      mode,
      verdict: 'budget-exceeded',
      exitCode: 1,
      scores: {},
      weightedScore: null,
      hardRejectDimensions: [],
      reviewDimensions: [],
      observationsCount: 0,
      defectsCount: 0,
      costUsd,
      round,
      errors: [
        `[GATE-ERROR] VLM-JUDGE-BUDGET-EXCEEDED: PR cost $${costUsd.toFixed(2)} exceeds cap $${validRubric.maxCostUsdPerPr.toFixed(2)}`,
      ],
    }
  }

  // Enforce per-PR round ceiling strictly (fail-closed)
  if (round > validRubric.maxRoundsPerPr) {
    return {
      ok: false,
      blocked: true,
      advisoryWarning: false,
      needsHumanReview: false,
      mode,
      verdict: 'round-limit-exceeded',
      exitCode: 1,
      scores: {},
      weightedScore: null,
      hardRejectDimensions: [],
      reviewDimensions: [],
      observationsCount: 0,
      defectsCount: 0,
      costUsd,
      round,
      errors: [
        `[GATE-ERROR] VLM-JUDGE-ROUND-LIMIT: audit round ${round} exceeds maxRoundsPerPr=${validRubric.maxRoundsPerPr}`,
      ],
    }
  }

  // Validate CoT observations (must be present & non-empty)
  if (!Array.isArray(parsed.observations) || parsed.observations.length === 0) {
    return invalidResponseResult(
      mode,
      [
        '[GATE-ERROR] VLM-JUDGE-INVALID-SCHEMA: missing non-empty CoT "observations" array (must inspect zones before scoring)',
      ],
      costUsd,
      round,
    )
  }
  for (let i = 0; i < parsed.observations.length; i += 1) {
    const obs = parsed.observations[i]
    const validString = typeof obs === 'string' && obs.trim().length > 0
    const validObj =
      isPlainObject(obs) &&
      typeof obs.zone === 'string' &&
      obs.zone.trim().length > 0 &&
      typeof obs.finding === 'string' &&
      obs.finding.trim().length > 0
    if (!validString && !validObj) {
      return invalidResponseResult(
        mode,
        [`[GATE-ERROR] VLM-JUDGE-INVALID-SCHEMA: observations[${i}] must be a non-empty string or { zone, finding }`],
        costUsd,
        round,
      )
    }
  }

  if (!isPlainObject(parsed.scores)) {
    return invalidResponseResult(
      mode,
      ['[GATE-ERROR] VLM-JUDGE-INVALID-SCHEMA: missing "scores" object'],
      costUsd,
      round,
    )
  }

  const scores: Partial<Record<VlmDimensionId, number>> = {}
  const hardRejectDimensions: Array<{ id: VlmDimensionId; score: number; floor: number }> = []
  const reviewDimensions: Array<{ id: VlmDimensionId; score: number; minScore: number }> = []
  let weightedSum = 0
  let weightTotal = 0

  for (const dim of validRubric.dimensions) {
    const val = parsed.scores[dim.id]
    if (
      typeof val !== 'number' ||
      !Number.isFinite(val) ||
      val < validRubric.scoreScale.min ||
      val > validRubric.scoreScale.max
    ) {
      return invalidResponseResult(
        mode,
        [
          `[GATE-ERROR] VLM-JUDGE-INVALID-SCHEMA: score for "${dim.id}" must be a finite number in [${validRubric.scoreScale.min}, ${validRubric.scoreScale.max}] (got ${JSON.stringify(val)})`,
        ],
        costUsd,
        round,
      )
    }
    scores[dim.id] = val
    weightedSum += val * dim.weight
    weightTotal += dim.weight

    const floor = Math.max(validRubric.hardRejectFloor, dim.hardRejectBelow)
    if (val < floor) {
      hardRejectDimensions.push({ id: dim.id, score: val, floor })
    } else if (val < dim.minScore) {
      reviewDimensions.push({ id: dim.id, score: val, minScore: dim.minScore })
    }
  }

  if (parsed.defects !== undefined && !Array.isArray(parsed.defects)) {
    return invalidResponseResult(
      mode,
      ['[GATE-ERROR] VLM-JUDGE-INVALID-SCHEMA: "defects" must be an array when provided'],
      costUsd,
      round,
    )
  }

  const weightedScore =
    weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) / 100 : null
  const defectsCount = Array.isArray(parsed.defects) ? parsed.defects.length : 0
  const observationsCount = parsed.observations.length

  if (hardRejectDimensions.length > 0) {
    const detail = hardRejectDimensions
      .map((d) => `${d.id}=${d.score.toFixed(1)} (<${d.floor.toFixed(1)})`)
      .join(', ')
    const isEnforce = mode === 'enforce'
    return {
      ok: !isEnforce,
      blocked: isEnforce,
      advisoryWarning: !isEnforce,
      needsHumanReview: false,
      mode,
      verdict: 'hard-reject',
      exitCode: isEnforce ? 1 : 0,
      scores,
      weightedScore,
      hardRejectDimensions,
      reviewDimensions,
      observationsCount,
      defectsCount,
      costUsd,
      round,
      errors: [
        isEnforce
          ? `[GATE-ERROR] VLM-AESTHETIC-HARD-REJECT: ${detail}`
          : `[VLM-ADVISORY] hard-reject threshold hit during calibration: ${detail}`,
      ],
    }
  }

  if (reviewDimensions.length > 0) {
    const detail = reviewDimensions
      .map((d) => `${d.id}=${d.score.toFixed(1)} (<${d.minScore.toFixed(1)})`)
      .join(', ')
    const isEnforce = mode === 'enforce'
    return {
      ok: !isEnforce,
      blocked: isEnforce,
      advisoryWarning: !isEnforce,
      needsHumanReview: true,
      mode,
      verdict: 'needs-review',
      exitCode: isEnforce ? 1 : 0,
      scores,
      weightedScore,
      hardRejectDimensions,
      reviewDimensions,
      observationsCount,
      defectsCount,
      costUsd,
      round,
      errors: [
        isEnforce
          ? `[GATE-ERROR] VLM-AESTHETIC-NEEDS-REVIEW: ${detail} (scores in 3.5–3.9 require second-round polish or design review)`
          : `[VLM-ADVISORY] needs-review range hit during calibration: ${detail}`,
      ],
    }
  }

  return {
    ok: true,
    blocked: false,
    advisoryWarning: false,
    needsHumanReview: false,
    mode,
    verdict: 'pass',
    exitCode: 0,
    scores,
    weightedScore,
    hardRejectDimensions: [],
    reviewDimensions: [],
    observationsCount,
    defectsCount,
    costUsd,
    round,
    errors: [],
  }
}

// ── CLI Runner ──────────────────────────────────────────────────────────────

type CliOptions = {
  dryRun: boolean
  changedFiles: string[]
  addedFiles: string[]
  labels: string[]
  rubricPath: string | null
  mode: VlmJudgeMode | null
  responseFile: string | null
  costUsd: number | undefined
  round: number | undefined
  baseRef: string | null
  help: boolean
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parseVlmCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: false,
    changedFiles: [],
    addedFiles: [],
    labels: [],
    rubricPath: null,
    mode: null,
    responseFile: null,
    costUsd: undefined,
    round: undefined,
    baseRef: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--dry-run') {
      opts.dryRun = true
    } else if (arg === '--changed-files') {
      opts.changedFiles.push(...splitCsv(argv[++i] ?? ''))
    } else if (arg.startsWith('--changed-files=')) {
      opts.changedFiles.push(...splitCsv(arg.slice('--changed-files='.length)))
    } else if (arg === '--added-files') {
      opts.addedFiles.push(...splitCsv(argv[++i] ?? ''))
    } else if (arg.startsWith('--added-files=')) {
      opts.addedFiles.push(...splitCsv(arg.slice('--added-files='.length)))
    } else if (arg === '--labels') {
      opts.labels.push(...splitCsv(argv[++i] ?? ''))
    } else if (arg.startsWith('--labels=')) {
      opts.labels.push(...splitCsv(arg.slice('--labels='.length)))
    } else if (arg === '--rubric') {
      opts.rubricPath = argv[++i] ?? null
    } else if (arg.startsWith('--rubric=')) {
      opts.rubricPath = arg.slice('--rubric='.length)
    } else if (arg === '--mode') {
      const m = argv[++i] ?? ''
      if (m !== 'advisory' && m !== 'enforce') {
        throw new Error(`Unsupported --mode=${m} (expected advisory or enforce)`)
      }
      opts.mode = m
    } else if (arg.startsWith('--mode=')) {
      const m = arg.slice('--mode='.length)
      if (m !== 'advisory' && m !== 'enforce') {
        throw new Error(`Unsupported --mode=${m} (expected advisory or enforce)`)
      }
      opts.mode = m
    } else if (arg === '--response-file') {
      opts.responseFile = argv[++i] ?? null
    } else if (arg.startsWith('--response-file=')) {
      opts.responseFile = arg.slice('--response-file='.length)
    } else if (arg === '--cost-usd') {
      opts.costUsd = Number(argv[++i])
    } else if (arg.startsWith('--cost-usd=')) {
      opts.costUsd = Number(arg.slice('--cost-usd='.length))
    } else if (arg === '--round') {
      opts.round = Number(argv[++i])
    } else if (arg.startsWith('--round=')) {
      opts.round = Number(arg.slice('--round='.length))
    } else if (arg === '--base') {
      opts.baseRef = argv[++i] ?? null
    } else if (arg.startsWith('--base=')) {
      opts.baseRef = arg.slice('--base='.length)
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`)
    }
  }
  return opts
}

function discoverChangedFilesFromGit(baseRef: string): ChangedFileInput[] {
  const out = execFileSync('git', ['diff', '--name-status', `${baseRef}...HEAD`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const items: ChangedFileInput[] = []
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\t+/)
    const statusCode = parts[0]?.[0]
    const filePath = statusCode === 'R' ? parts[2] : parts[1]
    if (!filePath) continue
    const status =
      statusCode === 'A' || statusCode === 'M' || statusCode === 'D' || statusCode === 'R'
        ? statusCode
        : 'M'
    items.push({ path: filePath, status })
  }
  return items
}

function detectConfiguredVlmApiKey(): string | null {
  for (const envName of [
    'OC_VLM_JUDGE_API_KEY',
    'VLM_JUDGE_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
  ]) {
    const val = process.env[envName]
    if (typeof val === 'string' && val.trim().length > 0) return envName
  }
  return null
}

export function runVlmJudgeCli(argv: string[]): number {
  let opts: CliOptions
  try {
    opts = parseVlmCliArgs(argv)
  } catch (err) {
    console.error(`[GATE-ERROR] VLM-JUDGE-USAGE: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  if (opts.help) {
    console.log(
      [
        'Usage: npx tsx scripts/check-vlm-aesthetic-judge.ts [options]',
        '  --dry-run                   Evaluate trigger policy and print prompt/budget decision without API call',
        '  --changed-files <a,b,...>   Comma-separated changed repo paths',
        '  --added-files <a,b,...>     Comma-separated newly added repo paths (for new top-level center pages)',
        '  --labels <l1,l2,...>        PR labels (e.g. ui-redesign)',
        '  --base <git-ref>            Discover changed files via git diff <ref>...HEAD',
        '  --rubric <path>             Path to rubric.json (default packages/web-react/browser-tests/vlm-rubric/rubric.json)',
        '  --mode advisory|enforce     Override rubric mode',
        '  --response-file <path>      Validate and score a saved VLM JSON response',
        '  --cost-usd <number>         Recorded USD cost for budget guard (<=$0.50/PR)',
        '  --round <number>            Audit round number (<=2/PR)',
      ].join('\n'),
    )
    return 0
  }

  let rubric: VlmRubric
  try {
    rubric = loadVlmRubric(opts.rubricPath ?? undefined)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }

  const effectiveMode: VlmJudgeMode = opts.mode ?? rubric.mode

  if (opts.responseFile) {
    const absResp = path.resolve(opts.responseFile)
    if (!existsSync(absResp)) {
      console.error(`[GATE-ERROR] VLM-JUDGE-IO: response file not found: ${absResp}`)
      return 1
    }
    const rawText = readFileSync(absResp, 'utf8')
    const res = evaluateVlmResponse(rawText, rubric, {
      mode: effectiveMode,
      costUsd: opts.costUsd,
      round: opts.round,
    })
    console.log(
      `vlm-aesthetic-judge: verdict=${res.verdict} mode=${res.mode} weighted=${res.weightedScore ?? 'n/a'} cost=$${res.costUsd.toFixed(2)}/$${rubric.maxCostUsdPerPr.toFixed(2)} round=${res.round}/${rubric.maxRoundsPerPr}`,
    )
    for (const msg of res.errors) {
      if (res.exitCode !== 0) console.error(msg)
      else console.warn(msg)
    }
    return res.exitCode
  }

  const changedInputs: ChangedFileInput[] =
    opts.changedFiles.length > 0
      ? opts.changedFiles
      : opts.baseRef
        ? discoverChangedFilesFromGit(opts.baseRef)
        : []

  const decision = shouldTriggerVlmJudge(changedInputs, opts.labels, {
    addedFiles: opts.addedFiles,
    rubric,
  })

  if (!decision.trigger) {
    console.log(
      `vlm-aesthetic-judge: SKIP (cost=$0.00, mode=${effectiveMode}) — no high-risk UI surfaces or ui-redesign label matched`,
    )
    return 0
  }

  const prompt = buildVlmJudgePrompt(rubric, {
    changedFiles: decision.matchedFiles,
    round: opts.round ?? 1,
  })
  const apiKeyEnv = detectConfiguredVlmApiKey()

  if (opts.dryRun) {
    console.log(
      `vlm-aesthetic-judge: DRY-RUN TRIGGERED (mode=${effectiveMode}, temperature=${prompt.temperature}, cap=$${rubric.maxCostUsdPerPr.toFixed(2)}, maxRounds=${rubric.maxRoundsPerPr})`,
    )
    console.log(`  reasons : ${decision.reasons.join(', ')}`)
    console.log(
      `  apiKey  : ${apiKeyEnv ? `configured (${apiKeyEnv})` : 'not configured (advisory dry-run skips live VLM call without failing CI)'}`,
    )
    console.log(`  prompt  : system=${prompt.system.length} chars, user=${prompt.user.length} chars`)
    return 0
  }

  if (!apiKeyEnv) {
    if (effectiveMode === 'advisory') {
      console.warn(
        `[VLM-ADVISORY] Triggered (${decision.reasons.join(', ')}), but no VLM API key is configured; skipping live call in advisory calibration mode (exit 0).`,
      )
      return 0
    }
    console.error(
      `[GATE-ERROR] VLM-JUDGE-NO-API-KEY: VLM judge triggered (${decision.reasons.join(', ')}) in enforce mode, but no VLM API key is configured.`,
    )
    return 1
  }

  console.log(
    `vlm-aesthetic-judge: READY (apiKey=${apiKeyEnv}, mode=${effectiveMode}, reasons=${decision.reasons.join(', ')}) — pass --response-file <json> after capturing VLM output`,
  )
  return 0
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  process.exit(runVlmJudgeCli(process.argv.slice(2)))
}
