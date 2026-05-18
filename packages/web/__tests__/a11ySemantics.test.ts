/**
 * Regression test for a11y 波次 6 systematic patches.
 *
 * 历史 bug (三类):
 *   B1: #toast 容器缺 aria-live → 屏幕阅读器全站 toast 无声
 *   B2: 14 个 <label> 与表单控件失联 → SR 进入字段只读 "combobox" / "textbox",不读字段名
 *   B3: 6 个 <a role="button" tabindex="0"> 不响应 Enter/Space → 纯键盘用户在登录页无法切换模式
 *
 * 修复:
 *   B1: 给 #toast 加 role="status" + aria-live="polite" + aria-atomic="true"
 *   B2: 14 个 label 加 for="<id>",1 个 effort radio group 用 aria-labelledby 模式
 *   B3: 6 个 <a role=button> 改成 <button type="button">,CSS 用 all:unset 复位 UA 默认样式
 *
 * 测试策略: 静态读 index.html,正则锁结构。不引入 jsdom。
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const PUB_DIR = resolve(import.meta.dirname, '..', 'public')
const html = readFileSync(resolve(PUB_DIR, 'index.html'), 'utf-8')

describe('a11y B1 — #toast 容器必须可被 SR 朗读', () => {
  it('A: #toast 含 role="status" + aria-live="polite" + aria-atomic="true"', () => {
    // 匹配 `<div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true">`
    // 属性顺序无所谓,逐项断言
    const toastTag = html.match(/<div\s+id="toast"[^>]*>/)
    assert.ok(toastTag, '#toast 元素不存在')
    const tag = toastTag[0]
    assert.match(tag, /role="status"/, `#toast 缺 role="status"。实际: ${tag}`)
    assert.match(tag, /aria-live="polite"/, `#toast 缺 aria-live="polite"。实际: ${tag}`)
    assert.match(tag, /aria-atomic="true"/, `#toast 缺 aria-atomic="true"。实际: ${tag}`)
  })
})

describe('a11y B2 — 表单控件 label 关联', () => {
  // 14 个 input/select/textarea id,对应 label 必须存在并通过 for= 关联
  const FORM_CONTROLS = [
    'new-agent-id',
    'persona-display-name',
    'persona-avatar-emoji',
    'persona-greeting',
    'persona-model-preset',
    'persona-model',
    'persona-permission',
    'persona-cwd',
    'persona-toolsets',
    'task-message',
    'task-cron',
    'oauth-provider',
    'feedback-category',
    'feedback-desc',
  ] as const

  for (const id of FORM_CONTROLS) {
    it(`C: <label for="${id}"> 存在`, () => {
      const re = new RegExp(`<label\\s+for="${id}"[^>]*>`)
      assert.match(html, re, `缺 <label for="${id}">`)
    })
  }

  it('D: effort radio group 用 aria-labelledby 模式(label#prefs-effort-label + role=radiogroup)', () => {
    // label 元素必须带 id
    assert.match(
      html,
      /<label\s+id="prefs-effort-label"[^>]*>默认 effort<\/label>/,
      '缺 <label id="prefs-effort-label">默认 effort</label>',
    )
    // 对应的 div 必须 role=radiogroup + aria-labelledby
    const divTag = html.match(/<div\s+id="prefs-effort-radios"[^>]*>/)
    assert.ok(divTag, '#prefs-effort-radios 元素不存在')
    const tag = divTag[0]
    assert.match(tag, /role="radiogroup"/, `#prefs-effort-radios 缺 role="radiogroup"。实际: ${tag}`)
    assert.match(
      tag,
      /aria-labelledby="prefs-effort-label"/,
      `#prefs-effort-radios 缺 aria-labelledby="prefs-effort-label"。实际: ${tag}`,
    )
  })
})

describe('a11y B3 — 登录页切换链接必须是真 <button>', () => {
  it('E: index.html 中 <a role="button"> 数量 = 0(整类消除)', () => {
    const matches = html.match(/<a\s+[^>]*role="button"[^>]*>/g) || []
    assert.equal(
      matches.length,
      0,
      `<a role="button"> 是反模式(<a> 无 href 时 Enter/Space 不触发 click)。残留 ${matches.length} 处: ${matches.join('\n')}`,
    )
  })

  it('F: 6 个登录页切换控件必须是 <button type="button">', () => {
    const AUTH_TOGGLE_IDS = [
      'auth-tab-forgot',
      'auth-tab-register',
      'auth-tab-login-from-register',
      'auth-forgot-back-btn',
      'auth-verify-resend-btn',
      'auth-verify-back-btn',
    ]
    for (const id of AUTH_TOGGLE_IDS) {
      const re = new RegExp(`<button\\s+id="${id}"\\s+type="button"[^>]*>`)
      assert.match(html, re, `#${id} 必须是 <button type="button">,不能用 <a role=button> + keydown 桥接`)
    }
  })
})
