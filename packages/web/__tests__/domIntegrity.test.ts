import * as assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
/**
 * DOM Integrity Tests for OpenClaude Frontend.
 *
 * Static analysis: reads index.html and app.js as text, cross-references
 * all $('id') calls in JS against id="..." attributes in HTML.
 * Prevents regressions like accidentally deleting #toast.
 *
 * Run: npx tsx --test packages/web/__tests__/domIntegrity.test.ts
 */
import { describe, it } from 'node:test'

const PUBLIC = resolve(import.meta.dirname, '..', 'public')

function readPublicFile(name: string): string {
  return readFileSync(resolve(PUBLIC, name), 'utf-8')
}

// ── Helpers ──

/** Extract all id="..." values from HTML (handles single/double quotes) */
function extractHtmlIds(html: string): string[] {
  const ids: string[] = []
  const re = /\bid\s*=\s*["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) ids.push(m[1])
  return ids
}

/** Extract all $('...') references from JS (the $ = getElementById helper) */
function extractDollarRefs(js: string): string[] {
  const refs: string[] = []
  const re = /\$\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(js))) refs.push(m[1])
  return refs
}

/** Extract all getElementById('...') references from JS */
function extractGetElementByIdRefs(js: string): string[] {
  const refs: string[] = []
  const re = /getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(js))) refs.push(m[1])
  return refs
}

/** Extract template-literal $() calls like $(`tasks-panel-${t}`) */
function extractTemplateDollarRefs(js: string): string[] {
  // These are dynamic references — pattern: $(`prefix-${var}`)
  // We extract the static prefix for documentation only
  const refs: string[] = []
  const re = /\$\(\s*`([^`]+)`\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(js))) refs.push(m[1])
  return refs
}

// ── IDs that are created dynamically at runtime (not in index.html) ──
const DYNAMIC_IDS = new Set([
  '__typing', // showTypingIndicator() creates div#__typing
  'tasks-panel', // _renderTasksPanel() creates div#tasks-panel
  'slash-popup', // showSlashPopup() creates div#slash-popup
])

// ── Template-literal dynamic IDs: $(`tasks-panel-${t}`) / $(`tasks-tab-${t}`) ──
// These have known expansions: cron, bg, log — which ARE in the HTML
const TEMPLATE_DYNAMIC_PREFIXES = ['tasks-panel-', 'tasks-tab-']

// ── Load files once ──
const html = readPublicFile('index.html')

// V3 Phase 4D: admin.html + modules/admin.js 是独立的超管控制台,与 SPA 的
// index.html 共享 modules/state.js + modules/api.js,但 DOM/ID 命名空间完
// 全独立。集成测试要把这一对当成 sibling pair,scan modules/ 时排除
// admin.js,避免 admin 的 $('view') 等 ID 被错算到 index.html 名下。
const ADMIN_MODULES = new Set(['admin.js'])

// Load JS source: either modules/ directory (post-refactor) or app.js (pre-refactor)
const modulesDir = resolve(PUBLIC, 'modules')
let js: string
if (existsSync(modulesDir)) {
  // Post-refactor: scan all .js files in modules/(排除 admin.js — 那是 admin.html 用的)
  js = readdirSync(modulesDir)
    .filter((f) => f.endsWith('.js') && !ADMIN_MODULES.has(f))
    .map((f) => readFileSync(resolve(modulesDir, f), 'utf-8'))
    .join('\n')
} else {
  js = readPublicFile('app.js')
}

const htmlIds = extractHtmlIds(html)
const htmlIdSet = new Set(htmlIds)
const dollarRefs = extractDollarRefs(js)
const getElemRefs = extractGetElementByIdRefs(js)
const allJsRefs = [...new Set([...dollarRefs, ...getElemRefs])]
const templateRefs = extractTemplateDollarRefs(js)

// Filter out dynamic IDs and template refs
const staticJsRefs = allJsRefs.filter(
  (id) =>
    !DYNAMIC_IDS.has(id) && !TEMPLATE_DYNAMIC_PREFIXES.some((prefix) => id.startsWith(prefix)),
)

// ── T01: Every $() reference has a matching id in HTML ──
describe('T01: $() references match HTML IDs', () => {
  const missing = staticJsRefs.filter((id) => !htmlIdSet.has(id))

  it('all $() references resolve to an HTML element', () => {
    if (missing.length > 0) {
      assert.fail(
        `${missing.length} $() reference(s) have NO matching id in index.html:\n${missing.map((id) => `  - $('${id}')`).join('\n')}\n\nFix: add the missing id to index.html, or add to DYNAMIC_IDS if created at runtime.`,
      )
    }
  })

  // Individual assertions for each ref so failures pinpoint the exact ID
  for (const id of staticJsRefs) {
    it(`$('${id}') has matching id="${id}" in HTML`, () => {
      assert.ok(
        htmlIdSet.has(id),
        `$('${id}') called in app.js but no element with id="${id}" exists in index.html`,
      )
    })
  }
})

// ── T02: No duplicate IDs in HTML ──
describe('T02: No duplicate IDs in HTML', () => {
  const counts = new Map<string, number>()
  for (const id of htmlIds) {
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  const duplicates = [...counts.entries()].filter(([, c]) => c > 1)

  it('index.html has no duplicate id attributes', () => {
    if (duplicates.length > 0) {
      assert.fail(
        `Duplicate IDs found in index.html:\n${duplicates.map(([id, c]) => `  - "${id}" appears ${c} times`).join('\n')}`,
      )
    }
  })
})

// ── T03: Template-literal dynamic IDs resolve ──
describe('T03: Template-literal dynamic $() IDs resolve', () => {
  // Known expansions for tasks-panel-${t} and tasks-tab-${t}
  const knownSuffixes = ['cron', 'bg', 'log']

  for (const prefix of TEMPLATE_DYNAMIC_PREFIXES) {
    for (const suffix of knownSuffixes) {
      const fullId = `${prefix}${suffix}`
      it(`$(\`${prefix}\${t}\`) with t="${suffix}" → id="${fullId}" exists`, () => {
        assert.ok(htmlIdSet.has(fullId), `Dynamic ID "${fullId}" not found in index.html`)
      })
    }
  }
})

// ── T04: Critical IDs that must always exist ──
describe('T04: Critical IDs always present', () => {
  const CRITICAL_IDS = [
    'login-view',
    'app-view',
    'token',
    'login-btn',
    'sidebar',
    'messages',
    'input',
    'send',
    'toast',
    'session-title',
    'session-sub',
    'sessions-body',
    'agent-select',
    'settings-dropdown',
    'lightbox',
    'palette-backdrop',
    'palette-input',
    'palette-list',
    // Modals
    'agents-modal',
    'persona-modal',
    'memory-modal',
    'skills-modal',
    'tasks-modal',
    'add-task-modal',
    'oauth-modal',
  ]

  for (const id of CRITICAL_IDS) {
    it(`critical element #${id} exists in HTML`, () => {
      assert.ok(htmlIdSet.has(id), `Critical element #${id} is missing from index.html!`)
    })
  }
})

// ── T-ADMIN: admin.html ↔ modules/admin.js cross-check ──
//
// V3 Phase 4D — admin 控制台是独立 SPA(同源,共享 token);它的 $() 调用
// 必须解析到 admin.html 的 ID,而不是 index.html。
describe('T-ADMIN: admin.html / modules/admin.js DOM integrity', () => {
  const adminHtmlPath = resolve(PUBLIC, 'admin.html')
  const adminJsPath = resolve(PUBLIC, 'modules/admin.js')
  const exists = existsSync(adminHtmlPath) && existsSync(adminJsPath)

  it('admin.html + modules/admin.js both exist (Phase 4D shipped)', () => {
    assert.ok(exists, 'expected admin.html and modules/admin.js')
  })
  if (!exists) return

  const adminHtml = readFileSync(adminHtmlPath, 'utf-8')
  const adminJs = readFileSync(adminJsPath, 'utf-8')
  // 可用 ID 集 = admin.html 静态 ID ∪ admin.js 模板字符串里 id="..." 的 ID。
  // admin.js 用 `view().innerHTML = \`...\`` 渲染各 tab,内含的表单/按钮 id
  // 在运行时被注入 DOM,后续 $() 查询能命中。把模板里出现过的 id 视作有效。
  const adminIds = new Set([
    ...extractHtmlIds(adminHtml),
    ...extractHtmlIds(adminJs),
  ])
  const refs = [
    ...extractDollarRefs(adminJs),
    ...extractGetElementByIdRefs(adminJs),
  ]
  const uniqueRefs = [...new Set(refs)]
  it('every $()/getElementById ref in admin.js resolves (static or template-injected)', () => {
    const missing = uniqueRefs.filter((id) => !adminIds.has(id))
    if (missing.length > 0) {
      assert.fail(
        `${missing.length} admin.js ref(s) missing in admin.html and template strings:\n${missing.map((id) => `  - ${id}`).join('\n')}`,
      )
    }
  })
  // 关键骨架 ID 必须在(admin.html 删了它们 admin.js 直接崩)。
  const ADMIN_CRITICAL_IDS = ['view', 'tabs', 'who', 'logout', 'toasts', 'modal-bg', 'modal-body']
  for (const id of ADMIN_CRITICAL_IDS) {
    it(`admin critical element #${id} exists`, () => {
      assert.ok(adminIds.has(id), `admin critical #${id} missing in admin.html`)
    })
  }
})

// ── T05: Sanity check — file parsing worked ──
describe('T05: Parser sanity checks', () => {
  it('extracted at least 50 IDs from HTML', () => {
    assert.ok(htmlIds.length >= 50, `Only found ${htmlIds.length} IDs in HTML (expected ≥50)`)
  })

  it('extracted at least 30 unique $() refs from JS', () => {
    const unique = new Set(allJsRefs)
    assert.ok(unique.size >= 30, `Only found ${unique.size} unique $() refs (expected ≥30)`)
  })

  it('$ helper is defined in JS source', () => {
    assert.ok(
      js.includes('const $ = (id) => document.getElementById(id)') ||
        js.includes('export const $ = (id) => document.getElementById(id)'),
      '$ helper not found in JS source',
    )
  })
})
