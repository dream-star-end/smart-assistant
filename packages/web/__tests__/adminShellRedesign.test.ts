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
  })

  it('decorates tabs without changing routing contracts', () => {
    assert.match(adminJs, /function decorateAdminShell\(\)/, 'decorateAdminShell helper missing')
    assert.match(adminJs, /querySelectorAll\('#tabs button\[data-tab\]'\)/, 'tab event binding should target only tab buttons')
    assert.match(adminJs, /btn\.setAttribute\('aria-selected', isActive \? 'true' : 'false'\)/, 'applyHash should keep aria-selected in sync')
    assert.match(adminJs, /document\.body\.dataset\.adminTab = tab/, 'active tab dataset hook missing')
  })
})
