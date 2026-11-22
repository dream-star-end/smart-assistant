import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
/**
 * L2/L3 Multi-viewport x Dual-theme Layout Invariants & DOM A11y Gate (OCV5-847 Module 2).
 *
 * Dual-purpose ESM module (zero new npm dependencies — uses existing playwright-core):
 *   1. Exported pure assertion engine (importable from unit tests without launching a browser):
 *      - rectIntersectionArea(a, b)
 *      - checkHorizontalOverflow(metrics)
 *      - checkControlOverlaps(controls, options)
 *      - checkNonEllipsisTruncation(elements, options)
 *      - checkTouchTargets(controls, viewportWidth, options)
 *      - checkDomA11y(snapshot)
 *      - evaluateLayoutSnapshot(snapshot, options)
 *      - formatLayoutViolations(violations, context)
 *
 *   2. CLI runner for auditing either a local URL (--url) or ui-preview scenes (--scenes / --tier=core)
 *      across 4 viewports (390x844, 768x1024, 1280x800, 1440x900) x 2 themes (light, dark):
 *      - Automatically layers @axe-core/playwright (wcag2a/wcag2aa/wcag21a/wcag21aa) if installed.
 *      - On any violation, injects `3px solid red` outlines onto offending nodes and saves a
 *        full-page failure screenshot to --out-dir.
 *
 * Usage:
 *   node packages/web-react/browser-tests/layout-invariants.mjs --url http://127.0.0.1:5174
 *   node packages/web-react/browser-tests/layout-invariants.mjs --scenes shell-ui-kit,composer-idle
 *   node packages/web-react/browser-tests/layout-invariants.mjs --tier=core --out-dir /tmp/layout-fails
 */
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const VIEWPORTS = Object.freeze({
  mobile: Object.freeze({
    name: 'mobile',
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  }),
  tablet: Object.freeze({
    name: 'tablet',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: true,
  }),
  laptop: Object.freeze({
    name: 'laptop',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  }),
  desktop: Object.freeze({
    name: 'desktop',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  }),
})

export const THEMES = Object.freeze(['light', 'dark'])
export const MIN_TOUCH_TARGET_PX = 44
export const MOBILE_BREAKPOINT_PX = 640
export const LAYOUT_BASELINE_SCHEMA_VERSION = 1
export const DEFAULT_BASELINE_FILENAME = 'layout-invariants-baseline.json'

/**
 * PR 级核心布局不变量场景集（--tier core，11 场景 × 4 视口 × 2 主题 = 88 帧）：
 * 覆盖主聊空态/流式/完成、顶栏+输入区、侧栏、设置/订阅、市场、管理中心、Workbench。
 */
export const LAYOUT_CORE_TIER_SCENE_IDS = Object.freeze([
  'shell-empty-state',
  'messages-assistant-streaming',
  'messages-timeline-rich',
  'composer-idle',
  'sidebar-overview',
  'settings-full-account',
  'settings-subscription-dialog',
  'market-browse-skill',
  'manage-skills',
  'workspace-chat-density',
  'tools-inspector',
])

/**
 * Compute intersection area (in CSS px^2) between two axis-aligned rectangles { x, y, width, height }.
 */
export function rectIntersectionArea(a, b) {
  if (!a || !b) return 0
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return 0
  const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  if (xOverlap <= 0) return 0
  const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (yOverlap <= 0) return 0
  return xOverlap * yOverlap
}

/**
 * Check 1: Zero horizontal overflow and forbid masking overflow via html/body { overflow-x: hidden }.
 */
export function checkHorizontalOverflow(metrics, options = {}) {
  const tolerancePx = options.tolerancePx ?? 1
  const violations = []
  if (!metrics) return violations

  const { scrollWidth = 0, innerWidth = 0, htmlOverflowX = '', bodyOverflowX = '' } = metrics
  if (innerWidth > 0 && scrollWidth > innerWidth + tolerancePx) {
    violations.push({
      ruleId: 'LAYOUT-HORIZONTAL-OVERFLOW',
      selector: 'html',
      detail: `documentElement.scrollWidth (${scrollWidth}px) > window.innerWidth (${innerWidth}px)`,
      why: '多端视口下严禁出现横向滚动条/页面溢出（OCV5-847 L2）',
      howToFix:
        '为弹性子项补充 min-width: 0、长文本 break-words 或响应式换行，切勿给 html/body 写 overflow-x: hidden 遮丑',
    })
  }

  const normalizedHtml = String(htmlOverflowX).trim().toLowerCase()
  const normalizedBody = String(bodyOverflowX).trim().toLowerCase()
  if (normalizedHtml === 'hidden' || normalizedBody === 'hidden') {
    const offending = [
      normalizedHtml === 'hidden' ? 'html' : null,
      normalizedBody === 'hidden' ? 'body' : null,
    ]
      .filter(Boolean)
      .join(', ')
    violations.push({
      ruleId: 'LAYOUT-FORBIDDEN-OVERFLOW-X-HIDDEN',
      selector: offending,
      detail: `${offending} 设置了 overflow-x: hidden`,
      why: '严禁在 html/body 上用 overflow-x: hidden 掩盖组件撑爆视口的布局缺陷',
      howToFix:
        '移除 html/body 的 overflow-x: hidden，在溢出的具体容器/组件上用 min-w-0 与正确布局根治溢出',
    })
  }

  return violations
}

/**
 * Check 2: Zero overlap between visible interactive controls in the same stacking layer.
 */
export function checkControlOverlaps(controls = [], options = {}) {
  const toleranceAreaPx = options.toleranceAreaPx ?? 1
  const violations = []
  const visible = controls.filter(
    (c) => c?.rect && c.rect.width > 0 && c.rect.height > 0 && c.visible !== false,
  )

  for (let i = 0; i < visible.length; i += 1) {
    const a = visible[i]
    const layerA = a.layerKey ?? 'root'
    for (let j = i + 1; j < visible.length; j += 1) {
      const b = visible[j]
      const layerB = b.layerKey ?? 'root'
      if (layerA !== layerB) continue
      // Skip ancestor-descendant pairs if caller records containment relationships.
      if (
        (a.id && b.parentId === a.id) ||
        (b.id && a.parentId === b.id) ||
        (Array.isArray(a.containsIds) && b.id && a.containsIds.includes(b.id)) ||
        (Array.isArray(b.containsIds) && a.id && b.containsIds.includes(a.id))
      ) {
        continue
      }
      const area = rectIntersectionArea(a.rect, b.rect)
      if (area > toleranceAreaPx) {
        violations.push({
          ruleId: 'LAYOUT-CONTROL-OVERLAP',
          selector: a.selector ?? a.id ?? '(control-a)',
          secondarySelector: b.selector ?? b.id ?? '(control-b)',
          area: Math.round(area * 100) / 100,
          detail: `同层可交互控件重叠 ${Math.round(area)}px²: ${a.selector ?? a.id} ∩ ${b.selector ?? b.id}`,
          why: '同层级可见按钮/胶囊交集面积必须为 0，避免移动端/窄屏穿模遮挡误触（OCV5-847 L2）',
          howToFix: '调整父容器 flex-wrap / gap / 响应式显隐或拆分次要入口进折叠菜单',
        })
      }
    }
  }
  return violations
}

/**
 * Check 3: Zero unintended non-ellipsis horizontal text truncation on labels/buttons/headings.
 */
export function checkNonEllipsisTruncation(elements = [], options = {}) {
  const tolerancePx = options.tolerancePx ?? 1
  const violations = []
  for (const el of elements) {
    if (!el || !el.clientWidth || el.clientWidth <= 0) continue
    const explicitEllipsis =
      el.hasTruncateClass === true ||
      String(el.textOverflow ?? '')
        .trim()
        .toLowerCase() === 'ellipsis'
    if (explicitEllipsis) continue
    if ((el.scrollWidth ?? 0) > el.clientWidth + tolerancePx) {
      violations.push({
        ruleId: 'LAYOUT-NON-ELLIPSIS-TRUNCATION',
        selector: el.selector ?? '(element)',
        detail: `未声明省略号截断却发生横向裁切 (scrollWidth=${el.scrollWidth}px > clientWidth=${el.clientWidth}px${el.text ? `, text="${String(el.text).slice(0, 40)}"` : ''})`,
        why: '未显式声明 truncate / text-ellipsis 的按钮或标题被裁切会吞字影响可读性（OCV5-847 L2）',
        howToFix:
          '允许换行、放宽宽度，或在确需单行截断时显式使用 truncate / text-ellipsis 并提供完整 title/Tooltip',
      })
    }
  }
  return violations
}

/**
 * Check 4: Mobile (<640px) touch target minimum size (44x44px).
 */
export function checkTouchTargets(controls, viewportWidth, options = {}) {
  const breakpoint = options.mobileBreakpointPx ?? MOBILE_BREAKPOINT_PX
  const minPx = options.minPx ?? MIN_TOUCH_TARGET_PX
  if (typeof viewportWidth !== 'number' || viewportWidth >= breakpoint) return []

  const violations = []
  for (const ctrl of controls) {
    if (!ctrl || !ctrl.rect || ctrl.visible === false || ctrl.primary === false) continue
    const { width = 0, height = 0 } = ctrl.rect
    if (width <= 0 || height <= 0) continue
    if (width < minPx || height < minPx) {
      violations.push({
        ruleId: 'LAYOUT-TOUCH-TARGET-SMALL',
        selector: ctrl.selector ?? ctrl.id ?? '(control)',
        detail: `移动端主操作热区 ${Math.round(width)}×${Math.round(height)}px 小于最小要求 ${minPx}×${minPx}px`,
        why: '移动端（<640px）主操作控件必须满足 ≥44×44px 触控热区标准（WCAG / Apple HIG）',
        howToFix:
          '使用 min-h-[44px] min-w-[44px] 或 [@media(hover:none)] 扩展热区（可用内边距扩大点击面）',
      })
    }
  }
  return violations
}

/**
 * Check 5: Critical DOM accessibility invariants (unnamed buttons, missing img alt, missing <html lang>, forbidden overflow-x: hidden).
 */
export function checkDomA11y(snapshot, options = {}) {
  const violations = []
  if (!snapshot) return violations

  const htmlLang = typeof snapshot.htmlLang === 'string' ? snapshot.htmlLang.trim() : ''
  if (!htmlLang) {
    violations.push({
      ruleId: 'A11Y-MISSING-HTML-LANG',
      selector: 'html',
      detail: '文档根元素缺少有效的 <html lang> 属性',
      why: 'WCAG 3.1.1：屏幕阅读器与字体排版回退依赖 <html lang>',
      howToFix: '在入口 HTML 模板中确保 <html lang="zh-CN">（或对应语言标签）',
    })
  }

  for (const btn of snapshot.buttons ?? []) {
    if (!btn || btn.visible === false || btn.ariaHidden === true) continue
    const hasName = Boolean(
      String(btn.text ?? '').trim() ||
        String(btn.ariaLabel ?? '').trim() ||
        String(btn.ariaLabelledBy ?? '').trim() ||
        String(btn.title ?? '').trim(),
    )
    if (!hasName) {
      violations.push({
        ruleId: 'A11Y-UNNAMED-BUTTON',
        selector: btn.selector ?? 'button',
        detail:
          '可见图标/操作按钮缺少可访问名称（text / aria-label / aria-labelledby / title 均为空）',
        why: 'WCAG 4.1.2：纯图标按钮无名称会导致键盘与读屏用户无法识别功能',
        howToFix: '为纯图标按钮补充清晰的 aria-label（如 aria-label="关闭面板"）或 sr-only 文本',
      })
    }
  }

  for (const img of snapshot.images ?? []) {
    if (!img || img.visible === false || img.ariaHidden === true) continue
    const role = String(img.role ?? '')
      .trim()
      .toLowerCase()
    if (role === 'presentation' || role === 'none') continue
    // Note: alt="" is valid for decorative images; only missing attribute (null/undefined) is a violation.
    if (img.alt === null || img.alt === undefined) {
      violations.push({
        ruleId: 'A11Y-MISSING-IMG-ALT',
        selector: img.selector ?? 'img',
        detail: '<img> 元素缺少 alt 属性',
        why: 'WCAG 1.1.1：所有非装饰图片须提供替代文本，纯装饰图须显式写 alt=""',
        howToFix: '为信息性图片补充描述性 alt 文本，装饰性图片显式添加 alt=""',
      })
    }
  }

  if (options.includeOverflowCheck !== false) {
    const htmlOv = String(snapshot.htmlOverflowX ?? '')
      .trim()
      .toLowerCase()
    const bodyOv = String(snapshot.bodyOverflowX ?? '')
      .trim()
      .toLowerCase()
    if (htmlOv === 'hidden' || bodyOv === 'hidden') {
      const offending = [htmlOv === 'hidden' ? 'html' : null, bodyOv === 'hidden' ? 'body' : null]
        .filter(Boolean)
        .join(', ')
      violations.push({
        ruleId: 'LAYOUT-FORBIDDEN-OVERFLOW-X-HIDDEN',
        selector: offending,
        detail: `${offending} 设置了 overflow-x: hidden`,
        why: '严禁在 html/body 上用 overflow-x: hidden 掩盖布局溢出',
        howToFix: '移除 html/body 的 overflow-x: hidden 并在真实溢出容器上根治布局问题',
      })
    }
  }

  return violations
}

/**
 * Evaluate a full page snapshot with all geometric and DOM a11y checks.
 */
export function evaluateLayoutSnapshot(snapshot, options = {}) {
  const viewportWidth = snapshot?.viewport?.width ?? snapshot?.overflow?.innerWidth ?? 1440
  const violations = [
    ...checkHorizontalOverflow(snapshot?.overflow, options.overflow),
    ...checkControlOverlaps(snapshot?.controls, options.overlaps),
    ...checkNonEllipsisTruncation(snapshot?.textElements, options.truncation),
    ...checkTouchTargets(
      snapshot?.touchTargets ?? snapshot?.controls,
      viewportWidth,
      options.touchTargets,
    ),
    ...checkDomA11y(snapshot?.a11y, { includeOverflowCheck: false }),
  ]

  // Append optional axe-core violations if present on snapshot
  for (const axeV of snapshot?.axeViolations ?? []) {
    if (axeV.impact === 'critical' || axeV.impact === 'serious') {
      violations.push({
        ruleId: `A11Y-AXE-${String(axeV.id ?? 'UNKNOWN').toUpperCase()}`,
        selector: axeV.nodes?.[0]?.target?.join(' ') ?? 'document',
        detail: `[axe ${axeV.impact}] ${axeV.help ?? axeV.id} (${axeV.nodes?.length ?? 1} node(s))`,
        why: 'WCAG 2.1 AA 运行时无障碍硬门禁（@axe-core/playwright）',
        howToFix: axeV.helpUrl
          ? `参考 ${axeV.helpUrl} 修复对应节点的对比度或 ARIA 语义`
          : '修复对应节点的无障碍违规',
      })
    }
  }

  const byRule = {}
  for (const v of violations) {
    byRule[v.ruleId] = (byRule[v.ruleId] ?? 0) + 1
  }

  return {
    ok: violations.length === 0,
    violations,
    summary: {
      total: violations.length,
      byRule,
    },
  }
}

/**
 * Format violations using the repository's standard [GATE-ERROR] remediation template.
 */
export function formatLayoutViolations(violations, context = {}) {
  const ctxLabel =
    [context.target, context.viewport, context.theme].filter(Boolean).join(' / ') || 'page'
  return violations
    .map((v) =>
      [
        `[GATE-ERROR] ${v.ruleId} at ${ctxLabel} (${v.selector})`,
        `  Violation : ${v.detail}`,
        `  Why       : ${v.why}`,
        `  How to Fix: ${v.howToFix}`,
        context.screenshotPath ? `  Screenshot: ${context.screenshotPath}` : '',
        '  Re-verify : node packages/web-react/browser-tests/layout-invariants.mjs',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n')
}

// ── B-Class Monotonic Debt Baseline Engine (pure, unit-testable) ────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateNonEmptySegment(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('|')) {
    throw new Error(
      `[GATE-ERROR] LAYOUT-BASELINE-INVALID: invalid ${fieldName} (${JSON.stringify(value)})`,
    )
  }
  return value.trim()
}

/**
 * Normalize a single violation occurrence into a stable identity key:
 *   `${target}|${viewport}|${theme}|${ruleId}`
 * Aggregating per (scene, viewport, theme, rule) prevents DOM micro-tweaks from causing noisy churn.
 */
export function buildViolationKey(target, viewport, theme, ruleId) {
  return [
    validateNonEmptySegment(target, 'target'),
    validateNonEmptySegment(viewport, 'viewport'),
    validateNonEmptySegment(theme, 'theme'),
    validateNonEmptySegment(ruleId, 'ruleId'),
  ].join('|')
}

function sortCountsObject(counts) {
  const sorted = {}
  for (const key of Object.keys(counts).sort()) {
    const val = counts[key]
    if (val > 0) sorted[key] = val
  }
  return sorted
}

/**
 * Aggregate violations across evaluated frames into deterministic key -> count map.
 */
export function aggregateViolationCounts(frameResults = []) {
  const counts = {}
  for (const frame of frameResults) {
    if (!frame || !Array.isArray(frame.violations)) continue
    for (const v of frame.violations) {
      if (!v || !v.ruleId) continue
      const key = buildViolationKey(frame.target, frame.viewport, frame.theme, v.ruleId)
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return sortCountsObject(counts)
}

/**
 * Create a canonical B-class layout invariants baseline payload.
 */
export function createLayoutBaseline(counts = {}, metadata = {}) {
  const baseline = {
    schemaVersion: LAYOUT_BASELINE_SCHEMA_VERSION,
    tier: typeof metadata.tier === 'string' && metadata.tier.trim() ? metadata.tier.trim() : 'core',
    keyFormat: 'scene|viewport|theme|ruleId',
    scenes: Array.isArray(metadata.scenes) ? [...metadata.scenes] : [],
    viewports: Array.isArray(metadata.viewports) ? [...metadata.viewports] : Object.keys(VIEWPORTS),
    themes: Array.isArray(metadata.themes) ? [...metadata.themes] : [...THEMES],
    counts: sortCountsObject(counts),
  }
  return validateLayoutBaseline(baseline)
}

/**
 * Fail-closed schema validation for layout-invariants baseline JSON.
 */
export function validateLayoutBaseline(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('[GATE-ERROR] LAYOUT-BASELINE-INVALID: baseline root must be a JSON object')
  }
  if (raw.schemaVersion !== LAYOUT_BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `[GATE-ERROR] LAYOUT-BASELINE-INVALID: unsupported schemaVersion=${JSON.stringify(raw.schemaVersion)} (expected ${LAYOUT_BASELINE_SCHEMA_VERSION})`,
    )
  }
  if (!isPlainObject(raw.counts)) {
    throw new Error('[GATE-ERROR] LAYOUT-BASELINE-INVALID: missing or invalid "counts" object')
  }
  for (const listField of ['scenes', 'viewports', 'themes']) {
    if (raw[listField] !== undefined) {
      if (
        !Array.isArray(raw[listField]) ||
        raw[listField].some((item) => typeof item !== 'string' || item.trim().length === 0)
      ) {
        throw new Error(
          `[GATE-ERROR] LAYOUT-BASELINE-INVALID: "${listField}" must be an array of non-empty strings`,
        )
      }
    }
  }

  const validatedCounts = {}
  for (const [key, val] of Object.entries(raw.counts)) {
    const parts = key.split('|')
    if (parts.length !== 4 || parts.some((p) => p.trim().length === 0 || p !== p.trim())) {
      throw new Error(
        `[GATE-ERROR] LAYOUT-BASELINE-INVALID: invalid count key "${key}" (expected "scene|viewport|theme|ruleId")`,
      )
    }
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) {
      throw new Error(
        `[GATE-ERROR] LAYOUT-BASELINE-INVALID: invalid count value for "${key}" (${JSON.stringify(val)}; expected non-negative integer)`,
      )
    }
    validatedCounts[key] = val
  }

  return {
    schemaVersion: LAYOUT_BASELINE_SCHEMA_VERSION,
    tier: typeof raw.tier === 'string' && raw.tier.trim() ? raw.tier.trim() : 'core',
    keyFormat: 'scene|viewport|theme|ruleId',
    scenes: Array.isArray(raw.scenes) ? [...raw.scenes] : [],
    viewports: Array.isArray(raw.viewports) ? [...raw.viewports] : Object.keys(VIEWPORTS),
    themes: Array.isArray(raw.themes) ? [...raw.themes] : [...THEMES],
    counts: sortCountsObject(validatedCounts),
  }
}

export function parseLayoutBaselineJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('[GATE-ERROR] LAYOUT-BASELINE-INVALID: baseline file is empty')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(
      `[GATE-ERROR] LAYOUT-BASELINE-INVALID: malformed JSON (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  return validateLayoutBaseline(parsed)
}

/**
 * Compare current aggregated violation counts against a validated B-class baseline.
 * - actual <= allowed: PASS (debt paydown when actual < allowed)
 * - actual > allowed (new key or increased count): FAIL (regression)
 */
export function compareWithLayoutBaseline(actualCounts, baseline) {
  const validBaseline = validateLayoutBaseline(baseline)
  if (!isPlainObject(actualCounts)) {
    throw new Error('[GATE-ERROR] LAYOUT-BASELINE-INVALID: actualCounts must be a plain object')
  }

  const regressions = []
  const debtPaydowns = []
  let totalActual = 0
  let totalAllowed = 0

  const allKeys = new Set([...Object.keys(validBaseline.counts), ...Object.keys(actualCounts)])
  for (const key of [...allKeys].sort()) {
    const allowed = validBaseline.counts[key] ?? 0
    const actual = actualCounts[key] ?? 0
    if (typeof actual !== 'number' || !Number.isSafeInteger(actual) || actual < 0) {
      throw new Error(
        `[GATE-ERROR] LAYOUT-BASELINE-INVALID: invalid actual count for "${key}" (${JSON.stringify(actual)})`,
      )
    }
    totalAllowed += allowed
    totalActual += actual

    if (actual > allowed) {
      regressions.push({
        key,
        kind: allowed === 0 ? 'new-violation' : 'count-increased',
        actual,
        allowed,
        delta: actual - allowed,
      })
    } else if (actual < allowed) {
      debtPaydowns.push({
        key,
        previous: allowed,
        actual,
        delta: allowed - actual,
      })
    }
  }

  return {
    ok: regressions.length === 0,
    regressions,
    debtPaydowns,
    totalActual,
    totalAllowed,
    baselineKeyCount: Object.keys(validBaseline.counts).length,
    actualKeyCount: Object.keys(actualCounts).filter((k) => (actualCounts[k] ?? 0) > 0).length,
  }
}

export function formatBaselineRegressions(regressions, context = {}) {
  return regressions
    .map((r) => {
      const [target, viewport, theme, ruleId] = r.key.split('|')
      const kindLabel =
        r.kind === 'new-violation' ? '新增布局/无障碍违规' : `存量违规计数上涨 (+${r.delta})`
      return [
        `[GATE-ERROR] LAYOUT-BASELINE-REGRESSION (${ruleId}) at ${target} / ${viewport} / ${theme}`,
        `  Violation : ${kindLabel} — actual=${r.actual}, baseline=${r.allowed}`,
        '  Why       : B 类存量基线只允许单调清债（actual <= baseline），严禁新增违规或抬高基线',
        '  How to Fix: 修复当前改动引入的布局/触控热区/无障碍回归；严禁调高 baseline 绕过门禁',
        context.outDir ? `  Artifacts : ${context.outDir}` : '',
        context.baselinePath
          ? `  Re-verify : node packages/web-react/browser-tests/layout-invariants.mjs --tier core --baseline ${context.baselinePath}`
          : '  Re-verify : node packages/web-react/browser-tests/layout-invariants.mjs --tier core --baseline packages/web-react/layout-invariants-baseline.json',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

// ── Browser Snapshot Collector (executed in Playwright page context) ─────────

async function collectPageSnapshot(page, viewport) {
  return page.evaluate((vp) => {
    function cssSelectorFor(el, fallbackIdx) {
      if (!el || !(el instanceof Element)) return `(unknown-${fallbackIdx})`
      if (el.id) return `#${CSS.escape(el.id)}`
      const testId = el.getAttribute('data-testid')
      if (testId) return `[data-testid="${testId}"]`
      const existing = el.getAttribute('data-oc-layout-id')
      const marker = existing ?? `oc-li-${fallbackIdx}`
      if (!existing) el.setAttribute('data-oc-layout-id', marker)
      const tag = el.tagName.toLowerCase()
      return `${tag}[data-oc-layout-id="${marker}"]`
    }

    function clippedVisibleRect(el) {
      if (!(el instanceof Element)) return null
      const style = getComputedStyle(el)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity) === 0
      ) {
        return null
      }
      const r = el.getBoundingClientRect()
      if (r.width <= 0.5 || r.height <= 0.5) return null
      let left = r.left
      let top = r.top
      let right = r.right
      let bottom = r.bottom
      // Clip against scroll/overflow ancestors so items scrolled out of view do not falsely collide
      // with fixed headers/footers outside the scroll container.
      let parent = el.parentElement
      while (parent && parent !== document.body && parent !== document.documentElement) {
        const ps = getComputedStyle(parent)
        const clipX = ps.overflowX === 'hidden' || ps.overflowX === 'auto' || ps.overflowX === 'scroll' || ps.overflowX === 'clip'
        const clipY = ps.overflowY === 'hidden' || ps.overflowY === 'auto' || ps.overflowY === 'scroll' || ps.overflowY === 'clip'
        if (clipX || clipY) {
          const pr = parent.getBoundingClientRect()
          if (clipX) {
            left = Math.max(left, pr.left)
            right = Math.min(right, pr.right)
          }
          if (clipY) {
            top = Math.max(top, pr.top)
            bottom = Math.min(bottom, pr.bottom)
          }
          if (right - left <= 0.5 || bottom - top <= 0.5) return null
        }
        parent = parent.parentElement
      }
      return { x: left, y: top, width: right - left, height: bottom - top }
    }

    function isElementVisible(el) {
      return clippedVisibleRect(el) !== null
    }

    function layerKeyFor(el) {
      const dialog = el.closest(
        '[role="dialog"], [data-radix-popper-content-wrapper], [data-radix-portal]',
      )
      if (!dialog) return 'root'
      if (!dialog.getAttribute('data-oc-layer-id')) {
        dialog.setAttribute('data-oc-layer-id', `layer-${Math.random().toString(36).slice(2, 8)}`)
      }
      return dialog.getAttribute('data-oc-layer-id') ?? 'portal'
    }

    const htmlStyle = getComputedStyle(document.documentElement)
    const bodyStyle = getComputedStyle(document.body)
    const overflow = {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      htmlOverflowX: htmlStyle.overflowX,
      bodyOverflowX: bodyStyle.overflowX,
    }

    const interactiveNodes = Array.from(
      document.querySelectorAll('button, a[href], [role="button"], [role="tab"]'),
    )
    const controls = []
    const touchTargets = []
    const nodeToId = new Map()
    let seq = 0

    for (const el of interactiveNodes) {
      const r = clippedVisibleRect(el)
      if (!r) continue
      const rawRect = el.getBoundingClientRect()
      seq += 1
      const id = `ctrl-${seq}`
      nodeToId.set(el, id)
      const selector = cssSelectorFor(el, seq)
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60)
      const primary = el.tagName.toLowerCase() === 'button' || el.getAttribute('role') === 'button'
      controls.push({
        id,
        selector,
        label,
        layerKey: layerKeyFor(el),
        visible: true,
        primary,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        _el: el,
      })
      // For mobile touch target checks, measure the control's intrinsic rendered rect when at least
      // half of it is visible inside any clipping scroll container (avoids subpixel scroll-edge jitter).
      const rawArea = rawRect.width * rawRect.height
      const visibleArea = r.width * r.height
      if (rawArea > 0 && visibleArea / rawArea >= 0.5) {
        touchTargets.push({
          id,
          selector,
          label,
          visible: true,
          primary,
          rect: { x: rawRect.x, y: rawRect.y, width: rawRect.width, height: rawRect.height },
        })
      }
    }

    // Link ancestor/descendant controls to avoid false overlaps for nested buttons/links
    for (const item of controls) {
      const containsIds = []
      for (const other of controls) {
        if (other.id !== item.id && item._el.contains(other._el)) {
          containsIds.push(other.id)
        }
      }
      item.containsIds = containsIds
      item._el = undefined
    }

    const textCandidates = Array.from(
      document.querySelectorAll("button, h1, h2, h3, h4, [role='tab']"),
    )
    const textElements = []
    for (const el of textCandidates) {
      if (!isElementVisible(el)) continue
      const style = getComputedStyle(el)
      const cls = typeof el.className === 'string' ? el.className : ''
      seq += 1
      textElements.push({
        selector: cssSelectorFor(el, seq),
        text: (el.textContent || '').trim().slice(0, 60),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        textOverflow: style.textOverflow,
        overflowX: style.overflowX,
        hasTruncateClass: /\b(?:truncate|text-ellipsis|line-clamp-\d+)\b/.test(cls),
      })
    }

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map((el) => {
      seq += 1
      return {
        selector: cssSelectorFor(el, seq),
        visible: isElementVisible(el),
        ariaHidden: el.getAttribute('aria-hidden') === 'true',
        text: (el.textContent || '').trim(),
        ariaLabel: el.getAttribute('aria-label'),
        ariaLabelledBy: el.getAttribute('aria-labelledby'),
        title: el.getAttribute('title'),
      }
    })

    const images = Array.from(document.querySelectorAll('img')).map((el) => {
      seq += 1
      return {
        selector: cssSelectorFor(el, seq),
        visible: isElementVisible(el),
        ariaHidden: el.getAttribute('aria-hidden') === 'true',
        role: el.getAttribute('role'),
        alt: el.hasAttribute('alt') ? el.getAttribute('alt') : null,
      }
    })

    return {
      viewport: vp,
      overflow,
      controls,
      touchTargets,
      textElements,
      a11y: {
        htmlLang: document.documentElement.getAttribute('lang'),
        buttons,
        images,
        htmlOverflowX: htmlStyle.overflowX,
        bodyOverflowX: bodyStyle.overflowX,
      },
    }
  }, viewport)
}

async function highlightOffendingNodes(page, violations) {
  const selectors = [
    ...new Set(
      violations
        .flatMap((v) => [v.selector, v.secondarySelector])
        .filter((s) => s && s !== 'document'),
    ),
  ]
  if (selectors.length === 0) return
  await page.evaluate((list) => {
    for (const sel of list) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (el instanceof HTMLElement) {
            el.style.setProperty('outline', '3px solid red', 'important')
            el.style.setProperty('outline-offset', '-1px', 'important')
          }
        }
      } catch {}
    }
  }, selectors)
}

async function tryLoadAxeBuilder() {
  try {
    const mod = await import('@axe-core/playwright')
    return mod.default ?? mod.AxeBuilder ?? null
  } catch {
    return null
  }
}

async function applyTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark')
    try {
      localStorage.setItem('oc_theme', t)
    } catch {}
  }, theme)
}

export function parseCliArgs(argv) {
  const opts = {
    url: null,
    scenes: [],
    tier: null,
    baseline: null,
    writeBaseline: false,
    viewports: Object.keys(VIEWPORTS),
    themes: [...THEMES],
    outDir: join(tmpdir(), 'oc-layout-invariants-fails'),
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--url') {
      opts.url = argv[++i] ?? null
    } else if (arg.startsWith('--url=')) {
      opts.url = arg.slice('--url='.length)
    } else if (arg === '--scenes') {
      opts.scenes = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg.startsWith('--scenes=')) {
      opts.scenes = arg
        .slice('--scenes='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg === '--tier') {
      opts.tier = argv[++i] ?? null
    } else if (arg.startsWith('--tier=')) {
      opts.tier = arg.slice('--tier='.length)
    } else if (arg === '--baseline') {
      opts.baseline = argv[++i] ?? null
      if (!opts.baseline) throw new Error('--baseline requires a file path')
    } else if (arg.startsWith('--baseline=')) {
      opts.baseline = arg.slice('--baseline='.length)
      if (!opts.baseline) throw new Error('--baseline requires a file path')
    } else if (arg === '--write-baseline') {
      opts.writeBaseline = true
    } else if (arg === '--viewports') {
      opts.viewports = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg.startsWith('--viewports=')) {
      opts.viewports = arg
        .slice('--viewports='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg === '--themes') {
      opts.themes = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg.startsWith('--themes=')) {
      opts.themes = arg
        .slice('--themes='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg === '--out-dir') {
      opts.outDir = argv[++i] ?? opts.outDir
    } else if (arg.startsWith('--out-dir=')) {
      opts.outDir = arg.slice('--out-dir='.length)
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`)
    }
  }
  if (opts.tier !== null && opts.tier !== 'core' && opts.tier !== 'full') {
    throw new Error(`Unsupported --tier=${opts.tier} (expected core or full)`)
  }
  return opts
}

async function buildUiPreviewHarness(pkgDir, browserTestsDir) {
  const require_ = createRequire(import.meta.url)
  const esbuild = require_('esbuild')
  const { default: tailwindcss } = await import('@tailwindcss/vite')
  const { build: viteBuild } = await import('vite')

  const previewDir = join(browserTestsDir, 'ui-preview')
  const skipFile = /^(types|api-stub|harness)\.|(\.test\.|\.spec\.|\.d\.ts$)/
  const sceneFiles = readdirSync(previewDir).filter(
    (name) => /\.tsx?$/.test(name) && !skipFile.test(name) && /scene/i.test(name),
  )
  const groupFiles = {
    manage: sceneFiles.filter((name) => /manage/i.test(name)).sort(),
    market: sceneFiles.filter((name) => /market/i.test(name)).sort(),
  }
  const orphans = sceneFiles.filter(
    (name) => !groupFiles.manage.includes(name) && !groupFiles.market.includes(name),
  )
  groupFiles.manage.push(...orphans)

  const workDir = mkdtempSync(join(tmpdir(), 'oc-layout-invariants-'))
  const apiStub = join(previewDir, 'api-stub.ts')
  const bundlePath = join(workDir, 'harness.js')
  await esbuild.build({
    entryPoints: [join(previewDir, 'harness.tsx')],
    bundle: true,
    format: 'iife',
    outfile: bundlePath,
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.MODE': '"production"',
      'import.meta.env.PROD': 'true',
      'import.meta.env.DEV': 'false',
    },
    alias: { 'node:crypto': join(browserTestsDir, 'stubs', 'node-crypto.js') },
    plugins: [
      {
        name: 'ui-preview-api-stub',
        setup(build) {
          build.onResolve({ filter: /(^|\/)lib\/api$/ }, (args) => {
            if (args.importer === apiStub) return null
            return { path: apiStub }
          })
        },
      },
      {
        name: 'ui-preview-scene-groups',
        setup(build) {
          build.onResolve({ filter: /(^|\/)scenes-(manage|market)$/ }, (args) => ({
            path: /market$/.test(args.path) ? 'market' : 'manage',
            namespace: 'oc-scene-group',
          }))
          build.onLoad({ filter: /.*/, namespace: 'oc-scene-group' }, (args) => {
            const files = groupFiles[args.path] ?? []
            const imports = files.map(
              (file, i) => `import * as m${i} from ${JSON.stringify(`./${file}`)}`,
            )
            const contents = `${imports.join('\n')}\nexport const modules = [${files.map((_, i) => `m${i}`).join(', ')}]\n`
            return { contents, loader: 'ts', resolveDir: previewDir }
          })
        },
      },
    ],
    logLevel: 'warning',
  })

  const cssOutDir = join(workDir, 'css')
  await viteBuild({
    root: pkgDir,
    configFile: false,
    logLevel: 'silent',
    plugins: [tailwindcss()],
    build: {
      outDir: cssOutDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: join(browserTestsDir, 'preview-styles.ts'),
        output: {
          entryFileNames: 'preview-styles.js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  })

  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs, out)
      else out.push(abs)
    }
    return out
  }
  const builtAssets = walk(cssOutDir)
  const cssFile = builtAssets.find((p) => p.endsWith('.css'))
  if (!cssFile) throw new Error('layout-invariants: failed to build preview production CSS')
  const assetByName = new Map(builtAssets.map((p) => [basename(p), p]))
  const harnessUrl = 'http://127.0.0.1/__openclaude_layout_invariants__'
  const bundleUrl = `${harnessUrl}/harness.js`
  const bundleText = readFileSync(bundlePath, 'utf8')
  const deterministicMotionCss =
    '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;scroll-behavior:auto!important;}'
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenClaude Layout Invariants</title><style>${readFileSync(cssFile, 'utf8')}\n${deterministicMotionCss}</style></head><body><div id="root"></div><script src="${bundleUrl}"></script></body></html>`

  return {
    workDir,
    harnessUrl,
    bundleUrl,
    bundleText,
    html,
    assetByName,
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  }
}

function frameHasBaselineRegression(target, viewport, theme, violations, baseline) {
  if (!baseline) return violations.length > 0
  const byRule = {}
  for (const v of violations) {
    byRule[v.ruleId] = (byRule[v.ruleId] ?? 0) + 1
  }
  for (const [ruleId, count] of Object.entries(byRule)) {
    const key = buildViolationKey(target, viewport, theme, ruleId)
    const allowed = baseline.counts[key] ?? 0
    if (count > allowed) return true
  }
  return false
}

async function runCli() {
  const startedAt = Date.now()
  let opts
  try {
    opts = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[GATE-ERROR] LAYOUT-INVARIANTS-USAGE: ${err.message}`)
    process.exit(2)
  }

  if (opts.help || (!opts.url && opts.scenes.length === 0 && !opts.tier)) {
    console.log(
      [
        'Usage: node packages/web-react/browser-tests/layout-invariants.mjs [options]',
        '  --url <url>                 Audit a local running URL across 4 viewports x 2 themes',
        '  --scenes <id1,id2,...>      Audit matching ui-preview scenes',
        '  --tier core|full            Audit core (11 representative scenes) or full ui-preview scenes',
        '  --baseline <path>           Compare violations against B-class monotonic baseline JSON',
        '  --write-baseline            Write current violation counts as B-class baseline JSON',
        '  --viewports <list>          Subset of mobile,tablet,laptop,desktop (default: all 4)',
        '  --themes <list>             Subset of light,dark (default: light,dark)',
        '  --out-dir <dir>             Directory for failure screenshots with 3px red outlines',
      ].join('\n'),
    )
    process.exit(opts.help ? 0 : 2)
  }

  const invalidViewports = opts.viewports.filter((v) => !(v in VIEWPORTS))
  if (invalidViewports.length > 0) {
    console.error(`[GATE-ERROR] Unknown viewports: ${invalidViewports.join(', ')}`)
    process.exit(2)
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const pkgDir = dirname(here)
  const repoRoot = dirname(dirname(pkgDir))

  let loadedBaseline = null
  if (opts.baseline && !opts.writeBaseline) {
    const baselineAbs = resolve(opts.baseline)
    if (!existsSync(baselineAbs)) {
      console.error(
        `[GATE-ERROR] LAYOUT-BASELINE-INVALID: baseline file not found: ${baselineAbs}`,
      )
      return 1
    }
    try {
      loadedBaseline = parseLayoutBaselineJson(readFileSync(baselineAbs, 'utf8'))
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      return 1
    }
  }

  const require_ = createRequire(import.meta.url)
  const { chromium } = require_('playwright-core')
  const { resolveBrowserExecutable } = await import(
    pathToFileURL(join(repoRoot, 'scripts', 'lib', 'resolve-browser.mjs')).href
  )

  const AxeBuilder = await tryLoadAxeBuilder()
  const executablePath = resolveBrowserExecutable()
  console.log(
    `layout-invariants: chromium=${executablePath} | axe-core=${AxeBuilder ? 'enabled (wcag21aa)' : 'built-in geometry + DOM a11y engine'}`,
  )

  let browser
  let previewHarness = null
  try {
    browser = await chromium.launch({ executablePath, headless: true })
    const failures = []
    const frameResults = []
    let checksExecuted = 0
    let targetSceneIds = []

    if (opts.url) {
      targetSceneIds = [opts.url]
      for (const vpName of opts.viewports) {
        const vp = VIEWPORTS[vpName]
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: vp.deviceScaleFactor,
          isMobile: vp.isMobile,
          hasTouch: vp.hasTouch,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
        })
        const page = await ctx.newPage()
        await page.goto(opts.url, { waitUntil: 'networkidle' })
        for (const theme of opts.themes) {
          await applyTheme(page, theme)
          await page.evaluate(() => document.fonts.ready.then(() => true))
          await page.waitForTimeout(200)
          const snap = await collectPageSnapshot(page, vp)
          if (AxeBuilder) {
            const axeRes = await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
              .analyze()
            snap.axeViolations = axeRes.violations ?? []
          }
          const result = evaluateLayoutSnapshot(snap)
          checksExecuted += 1
          frameResults.push({
            target: opts.url,
            viewport: vpName,
            theme,
            violations: result.violations,
          })
          const shouldFailFrame =
            !opts.writeBaseline &&
            frameHasBaselineRegression(
              opts.url,
              vpName,
              theme,
              result.violations,
              loadedBaseline,
            )
          if (shouldFailFrame) {
            mkdirSync(opts.outDir, { recursive: true })
            await highlightOffendingNodes(page, result.violations)
            const shotPath = join(opts.outDir, `url--${vpName}--${theme}--fail.png`)
            await page.screenshot({ path: shotPath, fullPage: true, animations: 'disabled' })
            failures.push({
              target: opts.url,
              viewport: vpName,
              theme,
              screenshotPath: shotPath,
              violations: result.violations,
            })
          }
        }
        await ctx.close()
      }
    } else {
      previewHarness = await buildUiPreviewHarness(pkgDir, here)
      const CONTENT_TYPES = {
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
      }
      const setupPreviewPage = async (page) => {
        await page.route('**/*', (route) => {
          const url = route.request().url()
          if (url === previewHarness.bundleUrl) {
            return route.fulfill({
              status: 200,
              contentType: 'text/javascript; charset=utf-8',
              body: previewHarness.bundleText,
            })
          }
          if (url.startsWith(previewHarness.harnessUrl)) {
            return route.fulfill({
              status: 200,
              contentType: 'text/html; charset=utf-8',
              body: previewHarness.html,
            })
          }
          let asset
          try {
            asset = previewHarness.assetByName.get(basename(new URL(url).pathname))
          } catch {}
          if (asset) {
            return route.fulfill({
              status: 200,
              contentType: CONTENT_TYPES[extname(asset)] ?? 'application/octet-stream',
              body: readFileSync(asset),
            })
          }
          return route.fulfill({ status: 204 })
        })
        await page.goto(previewHarness.harnessUrl, { waitUntil: 'load' })
      }

      const probeCtx = await browser.newContext()
      const probePage = await probeCtx.newPage()
      await setupPreviewPage(probePage)
      const allScenes = await probePage.evaluate(() => window.__ocScenes ?? [])
      await probeCtx.close()

      let targetScenes = allScenes
      if (opts.tier === 'core') {
        const byId = new Map(allScenes.map((s) => [s.id, s]))
        const missingCoreIds = LAYOUT_CORE_TIER_SCENE_IDS.filter((id) => !byId.has(id))
        if (missingCoreIds.length > 0) {
          throw new Error(
            `layout-invariants: --tier core missing expected scenes: ${missingCoreIds.join(', ')}`,
          )
        }
        targetScenes = LAYOUT_CORE_TIER_SCENE_IDS.map((id) => byId.get(id))
      }
      if (opts.scenes.length > 0) {
        targetScenes = targetScenes.filter((s) =>
          opts.scenes.some((needle) => s.id.includes(needle)),
        )
      }
      if (targetScenes.length === 0) {
        throw new Error('layout-invariants: zero ui-preview scenes matched filter (fail-loud)')
      }
      targetSceneIds = targetScenes.map((s) => s.id)

      const viewportBatches = await Promise.all(
        opts.viewports.map(async (vpName) => {
          const vp = VIEWPORTS[vpName]
          const ctx = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: vp.deviceScaleFactor,
            isMobile: vp.isMobile,
            hasTouch: vp.hasTouch,
            reducedMotion: 'reduce',
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
          })
          const localFrames = []
          const localFailures = []
          let localChecks = 0
          try {
            const page = await ctx.newPage()
            await setupPreviewPage(page)
            for (const theme of opts.themes) {
              await applyTheme(page, theme)
              for (const scene of targetScenes) {
                await page.evaluate((id) => window.__mountScene(id), scene.id)
                await page.evaluate(
                  () =>
                    document.fonts.ready.then(
                      () =>
                        new Promise((r) =>
                          requestAnimationFrame(() => requestAnimationFrame(() => r(true))),
                        ),
                    ),
                )
                await page.waitForTimeout(180)
                const sceneError = await page.evaluate(() => window.__ocSceneError ?? null)
                const snap = await collectPageSnapshot(page, vp)
                if (AxeBuilder) {
                  const axeRes = await new AxeBuilder({ page })
                    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
                    .analyze()
                  snap.axeViolations = axeRes.violations ?? []
                }
                const result = evaluateLayoutSnapshot(snap)
                if (sceneError) {
                  result.violations.push({
                    ruleId: 'LAYOUT-SCENE-RENDER-ERROR',
                    selector: '#root',
                    detail: `场景渲染崩溃: ${String(sceneError).slice(0, 200)}`,
                    why: 'ui-preview 核心场景必须能正常渲染，不得在 ErrorBoundary 中崩溃',
                    howToFix: '检查对应场景或组件在当前视口/主题下的运行时异常',
                  })
                  result.ok = false
                }
                localChecks += 1
                localFrames.push({
                  target: scene.id,
                  viewport: vpName,
                  theme,
                  violations: result.violations,
                })
                const shouldFailFrame =
                  !opts.writeBaseline &&
                  frameHasBaselineRegression(
                    scene.id,
                    vpName,
                    theme,
                    result.violations,
                    loadedBaseline,
                  )
                if (shouldFailFrame) {
                  mkdirSync(opts.outDir, { recursive: true })
                  await highlightOffendingNodes(page, result.violations)
                  const shotPath = join(opts.outDir, `${scene.id}--${vpName}--${theme}--fail.png`)
                  await page.screenshot({ path: shotPath, fullPage: true, animations: 'disabled' })
                  localFailures.push({
                    target: scene.id,
                    viewport: vpName,
                    theme,
                    screenshotPath: shotPath,
                    violations: result.violations,
                  })
                }
                await page.evaluate(() => window.__unmountScene())
              }
            }
          } finally {
            await ctx.close()
          }
          return { localChecks, localFrames, localFailures }
        }),
      )
      for (const batch of viewportBatches) {
        checksExecuted += batch.localChecks
        frameResults.push(...batch.localFrames)
        failures.push(...batch.localFailures)
      }
    }

    if (checksExecuted === 0) {
      console.error('[GATE-ERROR] LAYOUT-INVARIANTS-ZERO-CHECKS: 0 checks executed')
      return 1
    }

    const actualCounts = aggregateViolationCounts(frameResults)
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)

    if (opts.writeBaseline) {
      const targetPath = opts.baseline
        ? resolve(opts.baseline)
        : join(pkgDir, DEFAULT_BASELINE_FILENAME)
      const baselineObj = createLayoutBaseline(actualCounts, {
        tier: opts.tier ?? (opts.url ? 'url' : 'custom'),
        scenes: targetSceneIds,
        viewports: opts.viewports,
        themes: opts.themes,
      })
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, `${JSON.stringify(baselineObj, null, 2)}\n`, 'utf8')
      const totalStock = Object.values(baselineObj.counts).reduce((sum, n) => sum + n, 0)
      console.log(
        `layout-invariants: WROTE BASELINE ${targetPath} (scenes=${targetSceneIds.length}, frames=${checksExecuted}, keys=${Object.keys(baselineObj.counts).length}, totalStock=${totalStock}, elapsed=${elapsedSec}s)`,
      )
      return 0
    }

    if (loadedBaseline) {
      const comparison = compareWithLayoutBaseline(actualCounts, loadedBaseline)
      if (!comparison.ok) {
        mkdirSync(opts.outDir, { recursive: true })
        writeFileSync(
          join(opts.outDir, 'report.json'),
          `${JSON.stringify({ regressions: comparison.regressions, failures }, null, 2)}\n`,
          'utf8',
        )
        console.error(
          formatBaselineRegressions(comparison.regressions, {
            baselinePath: opts.baseline,
            outDir: opts.outDir,
          }),
        )
        for (const f of failures) {
          console.error(`\n${formatLayoutViolations(f.violations, f)}`)
        }
        console.error(
          `\nlayout-invariants: FAIL (${comparison.regressions.length} baseline regression(s), frames=${checksExecuted}, elapsed=${elapsedSec}s, artifacts=${opts.outDir})`,
        )
        return 1
      }
      const paydownNote =
        comparison.debtPaydowns.length > 0
          ? ` | debtPaydowns=${comparison.debtPaydowns.length} (可运行 --write-baseline 清债收紧)`
          : ''
      console.log(
        `layout-invariants: PASS (scenes=${targetSceneIds.length}, frames=${checksExecuted}, baselineKeys=${comparison.baselineKeyCount}, stock=${comparison.totalActual}/${comparison.totalAllowed}, elapsed=${elapsedSec}s${paydownNote})`,
      )
      return 0
    }

    if (failures.length > 0) {
      mkdirSync(opts.outDir, { recursive: true })
      writeFileSync(
        join(opts.outDir, 'report.json'),
        `${JSON.stringify(failures, null, 2)}\n`,
        'utf8',
      )
      for (const f of failures) {
        console.error(formatLayoutViolations(f.violations, f))
      }
      console.error(
        `\nlayout-invariants: FAIL (${failures.length} / ${checksExecuted} frames failed, elapsed=${elapsedSec}s, screenshots in ${opts.outDir})`,
      )
      return 1
    }

    console.log(
      `layout-invariants: PASS (scenes=${targetSceneIds.length}, frames=${checksExecuted}, elapsed=${elapsedSec}s)`,
    )
    return 0
  } finally {
    if (browser) await browser.close()
    if (previewHarness) previewHarness.cleanup()
  }
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isDirectRun) {
  runCli()
    .then((code) => {
      process.exit(code)
    })
    .catch((err) => {
      console.error(`[GATE-ERROR] LAYOUT-INVARIANTS-CRASH: ${err?.stack ?? err}`)
      process.exit(1)
    })
}
