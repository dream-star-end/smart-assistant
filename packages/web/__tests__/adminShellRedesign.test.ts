import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const PUB_DIR = resolve(import.meta.dirname, '..', 'public')
const adminHtml = readFileSync(resolve(PUB_DIR, 'admin.html'), 'utf-8')
const adminJs = readFileSync(resolve(PUB_DIR, 'modules', 'admin.js'), 'utf-8')

const EXPECTED_TABS = [
  'dashboard',
  'users',
  'accounts',
  'accountGroups',
  'egressProxies',
  'containers',
  'hosts',
  'ledger',
  'orders',
  'pricing',
  'plans',
  'modelGrants',
  'feedback',
  'inbox',
  'marketplace',
  'literature',
  'settings',
  'audit',
  'health',
  'alerts',
]

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

describe('admin commercial redesign shell', () => {
  it('keeps exactly one production nav button for each admin tab', () => {
    const tabs = [...adminHtml.matchAll(/<button\s+data-tab="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(tabs, EXPECTED_TABS)
    assert.deepEqual(unique(tabs), tabs, 'admin nav should not duplicate tab buttons')
  })

  it('preserves required admin shell ids and grouped sidebar labels', () => {
    for (const id of ['tabs', 'who', 'theme-toggle', 'back-to-app', 'logout', 'view', 'toasts', 'modal-bg', 'modal-body']) {
      assert.match(adminHtml, new RegExp(`id="${id}"`), `admin.html missing #${id}`)
    }
    assert.match(adminHtml, /<body class="admin-shell-body">/, 'admin shell body class missing')
    for (const label of ['经营驾驶舱', '账号与调度', '运行资源', '财务与商业', '用户触达', '系统运营']) {
      assert.match(adminHtml, new RegExp(label), `admin nav missing group label ${label}`)
    }
    assert.match(adminHtml, /role="presentation" aria-hidden="true">经营驾驶舱/, 'group labels should be hidden from tablist semantics')
  })

  it('keeps TABS, ADMIN_TAB_META, and static nav in sync', () => {
    const tabsBlock = adminJs.slice(adminJs.indexOf('const TABS = {'), adminJs.indexOf('const ADMIN_TAB_META = {'))
    const tabsKeys = [...tabsBlock.matchAll(/^\s{2}([A-Za-z0-9_]+):\s+render/gm)].map((m) => m[1])
    assert.deepEqual(tabsKeys, EXPECTED_TABS)

    const metaBlock = adminJs.slice(adminJs.indexOf('const ADMIN_TAB_META = {'), adminJs.indexOf('function decorateAdminShell'))
    const metaKeys = [...metaBlock.matchAll(/^\s{2}([A-Za-z0-9_]+):\s+\{/gm)].map((m) => m[1])
    assert.deepEqual(metaKeys, EXPECTED_TABS)
    assert.doesNotMatch(adminJs, /const ADMIN_TAB_VISUALS = \{/, 'admin UI should not depend on decorative fake visual cards')
  })

  it('decorates tabs without changing routing contracts', () => {
    assert.match(adminJs, /function decorateAdminShell\(\)/, 'decorateAdminShell helper missing')
    assert.match(adminJs, /querySelectorAll\('#tabs button\[data-tab\]'\)/, 'tab event binding should target only tab buttons')
    assert.match(adminJs, /btn\.setAttribute\('aria-selected', isActive \? 'true' : 'false'\)/, 'applyHash should keep aria-selected in sync')
    assert.match(adminJs, /document\.body\.dataset\.adminTab = tab/, 'active tab dataset hook missing')
  })

  it('resumes HttpOnly refresh-cookie login before showing the unauthenticated gate', () => {
    assert.match(adminJs, /onAuthExpired,\s*silentRefresh\s*\}\s+from '\.\/api\.js\?v=[^']+'/, 'admin.js should import silentRefresh')
    const bootstrapStart = adminJs.indexOf('async function bootstrap()')
    const bootstrapEnd = adminJs.indexOf('function logout()')
    assert.notEqual(bootstrapStart, -1, 'bootstrap function missing')
    assert.notEqual(bootstrapEnd, -1, 'logout function missing')
    const bootstrapBlock = adminJs.slice(bootstrapStart, bootstrapEnd)
    const noTokenStart = bootstrapBlock.indexOf('if (!state.token)')
    const meStart = bootstrapBlock.indexOf('let me')
    assert.notEqual(noTokenStart, -1, 'bootstrap should check missing state.token')
    assert.notEqual(meStart, -1, 'bootstrap should continue to /api/me after token recovery')
    const noTokenBlock = bootstrapBlock.slice(noTokenStart, meStart)
    assert.match(noTokenBlock, /正在恢复登录状态/, 'admin cold start should show a non-destructive recovery state')
    assert.match(noTokenBlock, /await silentRefresh\(\)/, 'missing token should attempt silentRefresh')
    assert.ok(
      noTokenBlock.indexOf('await silentRefresh()') < noTokenBlock.indexOf("renderGate('未登录')"),
      'admin should not render 未登录 until silentRefresh has failed',
    )
  })

  it('keeps context header and table decoration resilient across direct tab rerenders', () => {
    assert.match(adminJs, /function startAdminViewDecorator\(\)/, 'MutationObserver decorator bootstrap missing')
    assert.match(adminJs, /new MutationObserver\(\(\) => scheduleAdminViewDecoration\(\)\)/, 'view mutation observer should reschedule card decoration')
    assert.match(adminJs, /function decorateAdminView\(tab\)/, 'decorateAdminView helper missing')
    assert.match(adminJs, /function ensureAdminContextHeader\(root, tab, meta\)/, 'context header helper missing')
    assert.match(adminJs, /existing\?\.dataset\?\.tab === tab/, 'context header should not duplicate on repeated decoration')
    assert.match(adminJs, /function wrapAdminTables\(root\)/, 'table wrapper helper missing')
    assert.match(adminJs, /wrap\.appendChild\(table\)/, 'table wrapper must move existing table node, not rewrite/clone HTML')
    assert.match(adminJs, /escapeHtml\(meta\.group\)/, 'context group should be escaped before insertion')
    assert.match(adminJs, /escapeHtml\(meta\.label\)/, 'context label should be escaped before insertion')
    assert.match(adminJs, /escapeHtml\(chip\.label\)/, 'context chip label should be escaped before insertion')
    assert.match(adminJs, /escapeHtml\(chip\.value\)/, 'context chip value should be escaped before insertion')
    assert.match(adminJs, /admin-context-header/, 'admin context header class missing')
    assert.match(adminJs, /admin-table-card/, 'admin table card class missing')
  })
})
