import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  LAYOUT_BASELINE_SCHEMA_VERSION,
  LAYOUT_CORE_TIER_SCENE_IDS,
  THEMES,
  VIEWPORTS,
  aggregateViolationCounts,
  buildViolationKey,
  checkControlOverlaps,
  checkDomA11y,
  checkHorizontalOverflow,
  checkNonEllipsisTruncation,
  checkTouchTargets,
  compareWithLayoutBaseline,
  createLayoutBaseline,
  evaluateLayoutSnapshot,
  formatBaselineRegressions,
  formatLayoutViolations,
  parseCliArgs,
  parseLayoutBaselineJson,
  rectIntersectionArea,
  validateLayoutBaseline,
} from '../../packages/web-react/browser-tests/layout-invariants.mjs'
import {
  CORE_TIER_SCENE_IDS,
  parseShootArgs,
  selectScenesForRun,
} from '../../packages/web-react/browser-tests/ui-preview/shoot.mjs'
import {
  type UiStaticBaseline,
  createEmptyBaseline,
  evaluateBaselineMonotonic,
  evaluateUiHardGates,
  formatGateErrors,
  scanUiHardGates,
} from '../check-ui-hard-gates.ts'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/check-ui-hard-gates.ts')

function makeFixture(
  files: Record<string, string>,
  baseline: UiStaticBaseline = createEmptyBaseline(),
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-ui-hard-gates-test-'))
  const srcDir = path.join(dir, 'src')
  const baselinePath = path.join(dir, 'ui-static-baseline.json')
  mkdirSync(srcDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(srcDir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  return {
    dir,
    srcDir,
    baselinePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function runCli(
  srcDir: string,
  baselinePath: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT_PATH, '--src', srcDir, '--baseline', baselinePath],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

describe('UI static hard gates (scripts/check-ui-hard-gates.ts)', () => {
  it('UI-SCROLL-SINGLE-WRITER: allows whitelisted single-writer primitives and blocks direct scroll mutations in chat core', () => {
    const good = makeFixture({
      'components/chat/stickToBottom.ts':
        'export function snap(el: HTMLElement) { el.scrollTop = el.scrollHeight; }\n',
      'hooks/useChatScroll.ts':
        'export function jump(el: HTMLElement) { el.scrollTo({ top: 0 }); }\n',
      'components/chat/wheelFence.ts':
        'export function f(el: HTMLElement) { el.scrollIntoView(); }\n',
      'components/chat/archivePaging.ts':
        'export function a(el: HTMLElement) { el.scrollTop = 10; }\n',
      'components/chat/MessageList.tsx': [
        '// el.scrollTop = 999 (comment must be ignored)',
        'export function check(el: HTMLElement) { return el.scrollTop === 0; }',
      ].join('\n'),
    })
    try {
      const scan = scanUiHardGates(good.srcDir)
      const res = evaluateUiHardGates(scan, createEmptyBaseline())
      assert.equal(res.ok, true)
      assert.equal(scan.findings.length, 0)
    } finally {
      good.cleanup()
    }

    const bad = makeFixture({
      'components/chat/BadPane.tsx': [
        'export function bad(el: HTMLElement) {',
        '  el.scrollTop = el.scrollHeight;',
        "  el.scrollIntoView({ behavior: 'smooth' });",
        '}',
      ].join('\n'),
      'App.tsx': 'export function appScroll(el: HTMLElement) { el.scrollTo({ top: 0 }); }\n',
    })
    try {
      const cli = runCli(bad.srcDir, bad.baselinePath)
      assert.equal(cli.status, 1)
      assert.match(cli.stderr, /\[GATE-ERROR\] UI-SCROLL-SINGLE-WRITER/)
      assert.match(cli.stderr, /BadPane\.tsx:2/)
      assert.match(cli.stderr, /App\.tsx:1/)
      assert.match(cli.stderr, /followBottomRef\.current = false → stick\.correctTo/)
    } finally {
      bad.cleanup()
    }
  })

  it('UI-ZINDEX-LADDER: allows var(--z-*) semantic tokens and blocks bare z-[60..999] / z-index: 60..999', () => {
    const good = makeFixture({
      'components/Popover.tsx': `export const cls = "z-[var(--z-popover-portal)] z-[20]";\n`,
      'components/Modal.css':
        '/* z-index: 999 comment */\n.modal { z-index: var(--z-modal); }\n.sticky { z-index: 10; }\n',
    })
    try {
      const scan = scanUiHardGates(good.srcDir)
      assert.equal(evaluateUiHardGates(scan, createEmptyBaseline()).ok, true)
    } finally {
      good.cleanup()
    }

    const bad = makeFixture({
      'components/BadViewer.tsx': `export const cls = "fixed inset-0 z-[62]";\n`,
      'components/BadOverlay.css': '.overlay { z-index: 120; }\n',
    })
    try {
      const cli = runCli(bad.srcDir, bad.baselinePath)
      assert.equal(cli.status, 1)
      assert.match(cli.stderr, /\[GATE-ERROR\] UI-ZINDEX-LADDER/)
      assert.match(cli.stderr, /BadViewer\.tsx:1/)
      assert.match(cli.stderr, /BadOverlay\.css:1/)
      assert.match(cli.stderr, /var\(--z-/)
    } finally {
      bad.cleanup()
    }
  })

  it('UI-ZERO-LEARNING-COPY: allows internal protocol checks/comments and blocks user-visible jargon or manual /compact nagging', () => {
    const good = makeFixture({
      'components/chat/ContextDivider.tsx': [
        'import { formatCompactDuration } from "../sidebar/compactDuration";',
        '// Handles context_too_long and checkpoint_reset silently',
        'export function ContextDivider({ err }: { err?: { code?: string } }) {',
        '  if (err?.code === "PROMPT_TOO_LONG" || err?.code === "context_too_long") {',
        '    return <div>已自动整理较早对话，可继续无缝聊下去</div>;',
        '  }',
        '  return <span>{formatCompactDuration(12)}</span>;',
        '}',
      ].join('\n'),
      // Admin/manage surfaces are excluded from chat/sidebar user-facing zero-learning scope
      'components/manage/DiagnosticsPanel.tsx':
        'export function Diag() { return <div>checkpoint_reset</div>; }\n',
    })
    try {
      const scan = scanUiHardGates(good.srcDir)
      assert.equal(evaluateUiHardGates(scan, createEmptyBaseline()).ok, true)
    } finally {
      good.cleanup()
    }

    const bad = makeFixture({
      'components/chat/BadBanner.tsx': [
        'export function BadBanner() {',
        '  return (',
        '    <div>',
        '      <p>发生 checkpoint_reset，上下文已达 80%，请运行 /compact 手动压缩</p>',
        '      <span title="PROMPT_TOO_LONG">触发 context_too_long 请重试</span>',
        '    </div>',
        '  );',
        '}',
      ].join('\n'),
      'components/sidebar/BadRow.tsx': ['export const label = "🎫 lease ls-abc123 排队中";'].join(
        '\n',
      ),
    })
    try {
      const cli = runCli(bad.srcDir, bad.baselinePath)
      assert.equal(cli.status, 1)
      assert.match(cli.stderr, /\[GATE-ERROR\] UI-ZERO-LEARNING-COPY/)
      assert.match(cli.stderr, /BadBanner\.tsx/)
      assert.match(cli.stderr, /BadRow\.tsx/)
    } finally {
      bad.cleanup()
    }
  })

  it('UI-REDUCED-MOTION: allows @keyframes CSS with prefers-reduced-motion and blocks new CSS missing reduced-motion', () => {
    const good = makeFixture({
      'components/chat/goodAnim.css': [
        '@keyframes fade-up { from { opacity: 0; } to { opacity: 1; } }',
        '@media (prefers-reduced-motion: reduce) { .fade-up { animation: none; } }',
      ].join('\n'),
      'components/chat/staticOnly.css': '.box { display: flex; }\n',
    })
    try {
      const scan = scanUiHardGates(good.srcDir)
      assert.equal(evaluateUiHardGates(scan, createEmptyBaseline()).ok, true)
    } finally {
      good.cleanup()
    }

    const bad = makeFixture({
      'components/chat/newShimmer.css':
        '@keyframes new-shimmer { from { opacity: 0.4; } to { opacity: 1; } }\n',
    })
    try {
      const cli = runCli(bad.srcDir, bad.baselinePath)
      assert.equal(cli.status, 1)
      assert.match(cli.stderr, /\[GATE-ERROR\] UI-REDUCED-MOTION/)
      assert.match(cli.stderr, /newShimmer\.css:1/)
      assert.match(cli.stderr, /prefers-reduced-motion/)
    } finally {
      bad.cleanup()
    }
  })

  it('Monotonic baseline guard: allows debt paydown and blocks baseline inflation or new entries', () => {
    const base: UiStaticBaseline = {
      'UI-SCROLL-SINGLE-WRITER': { 'components/chat/A.tsx': 3 },
      'UI-ZINDEX-LADDER': { 'components/X.tsx': 2 },
      'UI-ZERO-LEARNING-COPY': {},
      'UI-REDUCED-MOTION': { 'styles/legacy.css': 4 },
    }
    const paidDown: UiStaticBaseline = {
      'UI-SCROLL-SINGLE-WRITER': { 'components/chat/A.tsx': 1 },
      'UI-ZINDEX-LADDER': {},
      'UI-ZERO-LEARNING-COPY': {},
      'UI-REDUCED-MOTION': { 'styles/legacy.css': 2 },
    }
    assert.deepEqual(evaluateBaselineMonotonic(base, paidDown), [])

    const inflated: UiStaticBaseline = {
      'UI-SCROLL-SINGLE-WRITER': { 'components/chat/A.tsx': 4 },
      'UI-ZINDEX-LADDER': { 'components/X.tsx': 2, 'components/NewBad.tsx': 1 },
      'UI-ZERO-LEARNING-COPY': {},
      'UI-REDUCED-MOTION': { 'styles/legacy.css': 4 },
    }
    const regs = evaluateBaselineMonotonic(base, inflated)
    assert.equal(regs.length, 2)
    assert.equal(
      regs.some((r) => r.kind === 'count-increased' && r.file === 'components/chat/A.tsx'),
      true,
    )
    assert.equal(
      regs.some((r) => r.kind === 'added-entry' && r.file === 'components/NewBad.tsx'),
      true,
    )
    const formatted = formatGateErrors([], regs)
    assert.match(formatted, /\[GATE-ERROR\] UI-STATIC-BASELINE-MONOTONIC/)
  })
})

describe('Layout invariants & DOM a11y pure engine (packages/web-react/browser-tests/layout-invariants.mjs)', () => {
  it('exports 4 standard viewports (390/768/1280/1440) and light/dark themes', () => {
    assert.deepEqual(
      Object.values(VIEWPORTS).map((v) => `${v.width}x${v.height}`),
      ['390x844', '768x1024', '1280x800', '1440x900'],
    )
    assert.deepEqual([...THEMES], ['light', 'dark'])
  })

  it('positive control: clean mobile snapshot passes all geometry and DOM a11y checks', () => {
    const res = evaluateLayoutSnapshot({
      viewport: VIEWPORTS.mobile,
      overflow: {
        scrollWidth: 390,
        innerWidth: 390,
        htmlOverflowX: 'visible',
        bodyOverflowX: 'visible',
      },
      controls: [
        {
          id: 'c1',
          selector: '#btn-send',
          rect: { x: 16, y: 780, width: 48, height: 44 },
          layerKey: 'root',
        },
        {
          id: 'c2',
          selector: '#btn-attach',
          rect: { x: 76, y: 780, width: 44, height: 44 },
          layerKey: 'root',
        },
      ],
      textElements: [
        { selector: 'h1', text: 'Clarvy', scrollWidth: 80, clientWidth: 120, textOverflow: 'clip' },
        {
          selector: '.session-title',
          text: '很长的标题允许省略号截断',
          scrollWidth: 260,
          clientWidth: 140,
          textOverflow: 'ellipsis',
          hasTruncateClass: true,
        },
      ],
      a11y: {
        htmlLang: 'zh-CN',
        buttons: [
          { selector: '#btn-send', text: '发送', visible: true },
          { selector: '#btn-attach', text: '', ariaLabel: '上传附件', visible: true },
        ],
        images: [
          { selector: 'img.avatar', alt: '用户头像', visible: true },
          { selector: 'img.decor', alt: '', visible: true },
        ],
      },
    })
    assert.equal(res.ok, true)
    assert.equal(res.violations.length, 0)
  })

  it('negative controls: intercepts overflow, forbidden overflow-x:hidden, control overlap, non-ellipsis truncation, small touch targets, and DOM a11y violations', () => {
    assert.equal(
      rectIntersectionArea(
        { x: 0, y: 0, width: 50, height: 40 },
        { x: 30, y: 20, width: 50, height: 40 },
      ),
      400,
    )
    assert.equal(
      rectIntersectionArea(
        { x: 0, y: 0, width: 20, height: 20 },
        { x: 20, y: 0, width: 20, height: 20 },
      ),
      0,
    )

    const overflowViolations = checkHorizontalOverflow({
      scrollWidth: 440,
      innerWidth: 390,
      htmlOverflowX: 'hidden',
      bodyOverflowX: 'visible',
    })
    assert.equal(
      overflowViolations.some((v) => v.ruleId === 'LAYOUT-HORIZONTAL-OVERFLOW'),
      true,
    )
    assert.equal(
      overflowViolations.some((v) => v.ruleId === 'LAYOUT-FORBIDDEN-OVERFLOW-X-HIDDEN'),
      true,
    )

    const overlapViolations = checkControlOverlaps([
      {
        id: 'a',
        selector: '#pill-model',
        rect: { x: 10, y: 10, width: 120, height: 36 },
        layerKey: 'root',
      },
      {
        id: 'b',
        selector: '#btn-sub',
        rect: { x: 100, y: 10, width: 80, height: 36 },
        layerKey: 'root',
      },
      // Different layer should NOT collide with root
      {
        id: 'c',
        selector: '#modal-close',
        rect: { x: 10, y: 10, width: 44, height: 44 },
        layerKey: 'dialog-1',
      },
    ])
    assert.equal(overlapViolations.length, 1)
    assert.equal(overlapViolations[0].ruleId, 'LAYOUT-CONTROL-OVERLAP')
    assert.equal(overlapViolations[0].area, 1080)

    const truncViolations = checkNonEllipsisTruncation([
      {
        selector: 'button.cta',
        text: '立即订阅专业版',
        scrollWidth: 180,
        clientWidth: 100,
        textOverflow: 'clip',
      },
    ])
    assert.equal(truncViolations.length, 1)
    assert.equal(truncViolations[0].ruleId, 'LAYOUT-NON-ELLIPSIS-TRUNCATION')

    const touchMobile = checkTouchTargets(
      [{ selector: '#icon-btn', rect: { x: 0, y: 0, width: 28, height: 28 } }],
      390,
    )
    assert.equal(touchMobile.length, 1)
    assert.equal(touchMobile[0].ruleId, 'LAYOUT-TOUCH-TARGET-SMALL')
    // Desktop viewport (>=640px) does not enforce 44px mobile touch rule
    assert.equal(
      checkTouchTargets(
        [{ selector: '#icon-btn', rect: { x: 0, y: 0, width: 28, height: 28 } }],
        1440,
      ).length,
      0,
    )

    const a11yViolations = checkDomA11y({
      htmlLang: '',
      buttons: [
        {
          selector: 'button.mystery-icon',
          text: '   ',
          ariaLabel: null,
          title: null,
          visible: true,
        },
      ],
      images: [{ selector: 'img.hero', alt: null, visible: true }],
    })
    assert.deepEqual(a11yViolations.map((v) => v.ruleId).sort(), [
      'A11Y-MISSING-HTML-LANG',
      'A11Y-MISSING-IMG-ALT',
      'A11Y-UNNAMED-BUTTON',
    ])

    const formatted = formatLayoutViolations(a11yViolations, {
      target: 'composer-idle',
      viewport: 'mobile',
      theme: 'dark',
      screenshotPath: '/tmp/fail.png',
    })
    assert.match(formatted, /\[GATE-ERROR\] A11Y-UNNAMED-BUTTON at composer-idle \/ mobile \/ dark/)
    assert.match(formatted, /Screenshot: \/tmp\/fail\.png/)
  })

  it('B-class baseline comparison: allows exact match & debt paydown, blocks new violations & count increases', () => {
    assert.ok(LAYOUT_CORE_TIER_SCENE_IDS.length >= 8 && LAYOUT_CORE_TIER_SCENE_IDS.length <= 12)
    assert.equal(
      buildViolationKey('composer-idle', 'mobile', 'dark', 'LAYOUT-TOUCH-TARGET-SMALL'),
      'composer-idle|mobile|dark|LAYOUT-TOUCH-TARGET-SMALL',
    )

    const initialCounts = aggregateViolationCounts([
      {
        target: 'composer-idle',
        viewport: 'mobile',
        theme: 'dark',
        violations: [
          { ruleId: 'LAYOUT-TOUCH-TARGET-SMALL' },
          { ruleId: 'LAYOUT-TOUCH-TARGET-SMALL' },
          { ruleId: 'LAYOUT-FORBIDDEN-OVERFLOW-X-HIDDEN' },
        ],
      },
      {
        target: 'sidebar-overview',
        viewport: 'desktop',
        theme: 'light',
        violations: [{ ruleId: 'LAYOUT-CONTROL-OVERLAP' }],
      },
    ])

    const baseline = createLayoutBaseline(initialCounts, {
      tier: 'core',
      scenes: ['composer-idle', 'sidebar-overview'],
    })
    assert.equal(baseline.schemaVersion, LAYOUT_BASELINE_SCHEMA_VERSION)

    // Exact match passes
    const exact = compareWithLayoutBaseline(initialCounts, baseline)
    assert.equal(exact.ok, true)
    assert.equal(exact.regressions.length, 0)
    assert.equal(exact.debtPaydowns.length, 0)

    // Debt paydown (reduced count + eliminated key) passes and reports paydowns
    const paidDown = compareWithLayoutBaseline(
      {
        'composer-idle|mobile|dark|LAYOUT-TOUCH-TARGET-SMALL': 1,
        'composer-idle|mobile|dark|LAYOUT-FORBIDDEN-OVERFLOW-X-HIDDEN': 1,
      },
      baseline,
    )
    assert.equal(paidDown.ok, true)
    assert.equal(paidDown.regressions.length, 0)
    assert.equal(paidDown.debtPaydowns.length, 2)

    // Increased count + brand-new violation key are strictly blocked
    const regressed = compareWithLayoutBaseline(
      {
        'composer-idle|mobile|dark|LAYOUT-TOUCH-TARGET-SMALL': 3,
        'composer-idle|mobile|dark|LAYOUT-FORBIDDEN-OVERFLOW-X-HIDDEN': 1,
        'sidebar-overview|desktop|light|LAYOUT-CONTROL-OVERLAP': 1,
        'market-browse-skill|mobile|dark|LAYOUT-HORIZONTAL-OVERFLOW': 1,
      },
      baseline,
    )
    assert.equal(regressed.ok, false)
    assert.equal(regressed.regressions.length, 2)
    assert.equal(
      regressed.regressions.some(
        (r) =>
          r.kind === 'count-increased' &&
          r.key === 'composer-idle|mobile|dark|LAYOUT-TOUCH-TARGET-SMALL' &&
          r.delta === 1,
      ),
      true,
    )
    assert.equal(
      regressed.regressions.some(
        (r) =>
          r.kind === 'new-violation' &&
          r.key === 'market-browse-skill|mobile|dark|LAYOUT-HORIZONTAL-OVERFLOW' &&
          r.allowed === 0 &&
          r.actual === 1,
      ),
      true,
    )
    const msg = formatBaselineRegressions(regressed.regressions, {
      baselinePath: 'packages/web-react/layout-invariants-baseline.json',
    })
    assert.match(msg, /\[GATE-ERROR\] LAYOUT-BASELINE-REGRESSION/)
    assert.match(msg, /LAYOUT-HORIZONTAL-OVERFLOW/)
  })

  it('B-class baseline fail-closed: rejects malformed JSON, invalid schema, bad keys, and non-integer counts', () => {
    assert.throws(() => parseLayoutBaselineJson(''), /LAYOUT-BASELINE-INVALID/)
    assert.throws(() => parseLayoutBaselineJson('{not valid json'), /LAYOUT-BASELINE-INVALID/)
    assert.throws(() => validateLayoutBaseline(null), /LAYOUT-BASELINE-INVALID/)
    assert.throws(
      () => validateLayoutBaseline({ schemaVersion: 99, counts: {} }),
      /LAYOUT-BASELINE-INVALID/,
    )
    assert.throws(
      () => validateLayoutBaseline({ schemaVersion: 1, counts: [] }),
      /LAYOUT-BASELINE-INVALID/,
    )
    assert.throws(
      () =>
        validateLayoutBaseline({
          schemaVersion: 1,
          counts: { 'bad-key-missing-parts': 1 },
        }),
      /LAYOUT-BASELINE-INVALID/,
    )
    assert.throws(
      () =>
        validateLayoutBaseline({
          schemaVersion: 1,
          counts: { 'scene|mobile|dark|RULE': -1 },
        }),
      /LAYOUT-BASELINE-INVALID/,
    )
    assert.throws(
      () =>
        validateLayoutBaseline({
          schemaVersion: 1,
          counts: { 'scene|mobile|dark|RULE': 1.5 },
        }),
      /LAYOUT-BASELINE-INVALID/,
    )
    assert.throws(
      () =>
        validateLayoutBaseline({
          schemaVersion: 1,
          counts: { 'scene|mobile|dark|RULE': '2' },
        }),
      /LAYOUT-BASELINE-INVALID/,
    )
    // CLI arg parsing for --tier, --baseline, --write-baseline
    const parsed = parseCliArgs([
      '--tier',
      'core',
      '--baseline',
      'packages/web-react/layout-invariants-baseline.json',
      '--write-baseline',
    ])
    assert.equal(parsed.tier, 'core')
    assert.equal(parsed.baseline, 'packages/web-react/layout-invariants-baseline.json')
    assert.equal(parsed.writeBaseline, true)
    assert.throws(() => parseCliArgs(['--tier', 'bogus']), /Unsupported --tier/)
  })
})

describe('ui-preview shoot.mjs --tier=core selector', () => {
  it('defines 30-40 core scene IDs and filters cleanly without altering default full behavior', () => {
    assert.ok(CORE_TIER_SCENE_IDS.length >= 30 && CORE_TIER_SCENE_IDS.length <= 40)
    assert.deepEqual(parseShootArgs([]), { tier: null, listOnly: false })
    assert.deepEqual(parseShootArgs(['--tier=core', '--list']), { tier: 'core', listOnly: true })
    assert.throws(() => parseShootArgs(['--tier=invalid']), /不支持的 --tier/)

    const fakeScenes = [
      ...CORE_TIER_SCENE_IDS.map((id) => ({ id, label: id, group: 'core' })),
      { id: 'extra-non-core-scene', label: 'extra', group: 'extra' },
    ]
    assert.equal(selectScenesForRun(fakeScenes, { tier: null }).selected.length, fakeScenes.length)
    const coreRes = selectScenesForRun(fakeScenes, { tier: 'core' })
    assert.equal(coreRes.selected.length, CORE_TIER_SCENE_IDS.length)
    assert.deepEqual(coreRes.missingCoreIds, [])
  })
})
