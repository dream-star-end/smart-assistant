/**
 * Regression test for mobile-perf 波次 5: passive listener compliance.
 *
 * 历史 bug:
 *   - messages.js initMessagesListeners 给 wheel / touchmove 装的是默认监听器,
 *     未带 { passive: true }。这些 handler 实际只读 state + 设 timeout,
 *     永远不调 preventDefault → mobile 拖动消息列表 + 桌面滚轮事件被浏览器
 *     强行等 JS 处理才能继续 → 可察觉迟滞,iOS Safari momentum scroll 被打断。
 *   - sessions.js 给每个 session item 装 long-press 用 property-style 监听器
 *     (`item.ontouchstart = fn`),DOM Level 0 的 property-style 监听器永远
 *     non-passive → 滑过 sidebar 时每次触摸都得等 JS → 滚动 frame drop。
 *
 * 修复: 全部走 addEventListener(..., { passive: true })。
 *
 * 测试策略: 静态读源码,正则锁定结构,避免 jsdom / happy-dom 依赖。
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const MODULES_DIR = resolve(import.meta.dirname, '..', 'public', 'modules')
const messagesSrc = readFileSync(resolve(MODULES_DIR, 'messages.js'), 'utf-8')
const sessionsSrc = readFileSync(resolve(MODULES_DIR, 'sessions.js'), 'utf-8')

// 去掉行注释,避免被 `// item.ontouchstart = ...` 这种文档式注释误伤
function stripLineComments(s: string): string {
  return s
    .split('\n')
    .map((ln) => ln.replace(/\/\/.*$/, ''))
    .join('\n')
}

const messagesClean = stripLineComments(messagesSrc)
const sessionsClean = stripLineComments(sessionsSrc)

describe('messages.js — 滚动监听器必须 passive', () => {
  it('A: wheel 监听器带 { passive: true }', () => {
    // 锁定 `msgEl.addEventListener('wheel', _handleUserScroll, { passive: true })`
    const re = /addEventListener\(\s*['"]wheel['"]\s*,\s*[A-Za-z_$][\w$]*\s*,\s*\{\s*passive:\s*true\s*\}\s*\)/
    assert.match(messagesClean, re, 'messages.js 必须给 wheel 监听器传 { passive: true }')
  })

  it('B: touchmove 监听器带 { passive: true }', () => {
    const re = /addEventListener\(\s*['"]touchmove['"]\s*,\s*[A-Za-z_$][\w$]*\s*,\s*\{\s*passive:\s*true\s*\}\s*\)/
    assert.match(messagesClean, re, 'messages.js 必须给 touchmove 监听器传 { passive: true }')
  })

  it('vanity: 不再有 wheel / touchmove 未带 options 的 addEventListener', () => {
    // 防止有人新增不带 options 的 wheel/touchmove 监听器导致回归
    // 匹配 `addEventListener('wheel', fn)` 不带第三参数 — 用反向断言: 找到的每处必须含 passive
    const wheelCalls = [...messagesClean.matchAll(/addEventListener\(\s*['"]wheel['"][^)]*\)/g)]
    for (const m of wheelCalls) {
      assert.ok(
        /passive:\s*true/.test(m[0]),
        `messages.js wheel addEventListener 必须 passive:true,违规: ${m[0]}`,
      )
    }
    const moveCalls = [...messagesClean.matchAll(/addEventListener\(\s*['"]touchmove['"][^)]*\)/g)]
    for (const m of moveCalls) {
      assert.ok(
        /passive:\s*true/.test(m[0]),
        `messages.js touchmove addEventListener 必须 passive:true,违规: ${m[0]}`,
      )
    }
  })
})

describe('sessions.js — long-press 触摸监听器必须 passive 且禁用 property-style', () => {
  it('C: 不再有 item.ontouchstart / ontouchend / ontouchmove = ... property-style 监听器', () => {
    // property-style 永远 non-passive;long-press 不需要 preventDefault → 一律改 addEventListener
    for (const evt of ['touchstart', 'touchend', 'touchmove']) {
      const re = new RegExp(`\\.on${evt}\\s*=`, 'g')
      const m = sessionsClean.match(re)
      assert.equal(
        m,
        null,
        `sessions.js 不允许 property-style .on${evt} 赋值 (non-passive)。找到: ${m?.join(', ')}`,
      )
    }
  })

  it('D: 三件套都用 addEventListener 且带 { passive: true }', () => {
    for (const evt of ['touchstart', 'touchend', 'touchmove']) {
      const re = new RegExp(
        `addEventListener\\(\\s*['"]${evt}['"][\\s\\S]*?\\{\\s*passive:\\s*true\\s*\\}\\s*\\)`,
      )
      assert.match(
        sessionsClean,
        re,
        `sessions.js 必须用 addEventListener('${evt}', fn, { passive: true })`,
      )
    }
  })

})
