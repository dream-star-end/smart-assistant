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
  'plan-panel-btn', // initPlanPanel() creates the header trigger on demand
  'plan-panel-badge', // initPlanPanel() creates the trigger badge on demand
  'plan-panel-backdrop', // initPlanPanel() creates the drawer backdrop on demand
  'plan-panel', // initPlanPanel() creates aside#plan-panel on demand
  'plan-panel-close', // initPlanPanel() creates the drawer close button on demand
  'plan-panel-content', // initPlanPanel() creates the drawer content mount on demand
  'goal-mode-toggle', // initGoalModePanel() creates the simple composer Goal toggle
  'slash-popup', // showSlashPopup() creates div#slash-popup
  'permission-modal', // permission prompts are created on demand in websocket.js
])

// ── Template-literal dynamic IDs: $(`tasks-panel-${t}`) / $(`wechat-state-${s}`) ──
// These have known expansions which ARE in the HTML.
const TEMPLATE_DYNAMIC_IDS: Record<string, string[]> = {
  'tasks-panel-': ['cron', 'bg', 'log'],
  'tasks-tab-': ['cron', 'bg', 'log'],
  'wechat-state-': ['unbound', 'pairing', 'bound'],
}
const TEMPLATE_DYNAMIC_PREFIXES = Object.keys(TEMPLATE_DYNAMIC_IDS)

// ── Load files once ──
const html = readPublicFile('index.html')

// Load JS source: either modules/ directory (post-refactor) or app.js (pre-refactor)
const modulesDir = resolve(PUBLIC, 'modules')
let js: string
if (existsSync(modulesDir)) {
  // Post-refactor: scan all .js files in modules/
  js = readdirSync(modulesDir)
    .filter((f) => f.endsWith('.js'))
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
  for (const [prefix, suffixes] of Object.entries(TEMPLATE_DYNAMIC_IDS)) {
    for (const suffix of suffixes) {
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
