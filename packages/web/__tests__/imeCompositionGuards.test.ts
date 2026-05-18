import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

/**
 * 波次 4 — IME composition guard + dual menu cross-close static asserts.
 *
 * These tests lock in CALL-SITE WIRING (not source-of-truth helpers), so a
 * regression that re-introduces the IME race or dual-menu visual bug will
 * fail at CI time. They do NOT restate algorithms.
 */

const MAIN = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'main.js'),
  'utf-8',
)
const SESSIONS = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sessions.js'),
  'utf-8',
)
const EFFORT = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'effortMode.js'),
  'utf-8',
)
const MODEL = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'modelPicker.js'),
  'utf-8',
)

/** Strip // line comments (avoid false positive matches in jsdoc/explanatory text) */
function stripLineComments(s: string): string {
  return s.replace(/\/\/.*$/gm, '')
}

describe('波次 4 — IME composition guards', () => {
  it('A. main.js slash popup 分支条件本身写为 `slashPopupVisible && !e.isComposing`', () => {
    const src = stripLineComments(MAIN)
    assert.match(
      src,
      /if\s*\(\s*slashPopupVisible\s*&&\s*!e\.isComposing\s*\)/,
      'slash popup 分支条件必须本身合并 !e.isComposing 守卫,不允许只在 sub-branch 内零散加',
    )
  })

  it('B1. main.js palette-input keydown handler 顶部首条语句为 `if (e.isComposing) return`', () => {
    // Locate palette-input keydown listener and snip first ~8 statements
    const idx = MAIN.indexOf("$('palette-input').addEventListener('keydown'")
    assert.ok(idx >= 0, 'palette-input keydown handler 应存在')
    const region = stripLineComments(MAIN.slice(idx, idx + 400))
    // 第一条非注释语句必须是 IME early-return
    assert.match(
      region,
      /keydown'\s*,\s*\(e\)\s*=>\s*\{\s*if\s*\(\s*e\.isComposing\s*\)\s*return/,
      'palette-input keydown handler 顶部首条必须是 `if (e.isComposing) return`',
    )
  })

  it('B2. main.js 全局 Escape handler 顶部含 `if (e.isComposing) return`', () => {
    // 该 handler 以注释开始: "// ── Escape key: close modals, lightbox, palette ──"
    const idx = MAIN.indexOf('// ── Escape key: close modals')
    assert.ok(idx >= 0, '全局 Escape handler 标志注释应存在')
    const region = stripLineComments(MAIN.slice(idx, idx + 600))
    assert.match(
      region,
      /document\.addEventListener\('keydown'\s*,\s*\(e\)\s*=>\s*\{[\s\S]{0,200}if\s*\(\s*e\.isComposing\s*\)\s*return/,
      '全局 Escape handler 顶部必须有 isComposing early-return',
    )
    // 注:原 lightbox-specific Escape listener 已在波次 7 (PR #8) 作为死代码删除
    // (主 Escape handler 已先处理 lightbox 分支),它的 isComposing guard
    // 测试条款也随之失效,无需再断言。
  })

  it('C. sessions.js rename input onkeydown 的 Enter + Escape 两支都带 `!e.isComposing`', () => {
    const src = stripLineComments(SESSIONS)
    // Enter 分支
    assert.match(
      src,
      /if\s*\(\s*e\.key\s*===\s*'Enter'\s*&&\s*!e\.isComposing\s*\)/,
      'sessions rename Enter 分支必须带 !e.isComposing',
    )
    // Escape 分支
    assert.match(
      src,
      /else\s+if\s*\(\s*e\.key\s*===\s*'Escape'\s*&&\s*!e\.isComposing\s*\)/,
      'sessions rename Escape 分支必须带 !e.isComposing',
    )
  })
})

describe('波次 4 — Dual menu cross-close (effortMode ⇄ modelPicker)', () => {
  it('D. effortMode + modelPicker 都 dispatch composer-popup-opening event', () => {
    assert.match(
      EFFORT,
      /dispatchEvent\(\s*new\s+CustomEvent\(\s*['"]composer-popup-opening['"]/,
      'effortMode.js openMenu 必须 dispatch composer-popup-opening',
    )
    assert.match(
      MODEL,
      /dispatchEvent\(\s*new\s+CustomEvent\(\s*['"]composer-popup-opening['"]/,
      'modelPicker.js openMenu 必须 dispatch composer-popup-opening',
    )
  })

  it('E. effortMode + modelPicker 监听 event 且异源时调用 closeMenu(false)', () => {
    // effortMode: listener body must contain closeMenu(false) call
    assert.match(
      EFFORT,
      /addEventListener\(\s*['"]composer-popup-opening['"][\s\S]{0,200}closeMenu\(false\)/,
      'effortMode.js 必须监听 composer-popup-opening 且在异源时调用 closeMenu(false)',
    )
    assert.match(
      MODEL,
      /addEventListener\(\s*['"]composer-popup-opening['"][\s\S]{0,200}closeMenu\(false\)/,
      'modelPicker.js 必须监听 composer-popup-opening 且在异源时调用 closeMenu(false)',
    )
    // 校验 source 字段:effort 模块过滤 !== 'effort' / model 模块过滤 !== 'model'
    // (确保两个模块用相同的事件名但用不同的 source 标识自己)
    const effortListenerIdx = EFFORT.indexOf("addEventListener('composer-popup-opening'")
    assert.ok(effortListenerIdx >= 0)
    const effortRegion = EFFORT.slice(effortListenerIdx, effortListenerIdx + 250)
    assert.match(
      effortRegion,
      /e\.detail\?\.source\s*!==\s*POPUP_SOURCE/,
      'effortMode 应过滤异源 source(允许用 POPUP_SOURCE 常量)',
    )
    const modelListenerIdx = MODEL.indexOf("addEventListener('composer-popup-opening'")
    assert.ok(modelListenerIdx >= 0)
    const modelRegion = MODEL.slice(modelListenerIdx, modelListenerIdx + 250)
    assert.match(
      modelRegion,
      /e\.detail\?\.source\s*!==\s*POPUP_SOURCE/,
      'modelPicker 应过滤异源 source(允许用 POPUP_SOURCE 常量)',
    )
  })

  it('F. POPUP_SOURCE 常量值在两模块上不同', () => {
    const effortSourceMatch = EFFORT.match(/const\s+POPUP_SOURCE\s*=\s*['"]([^'"]+)['"]/)
    const modelSourceMatch = MODEL.match(/const\s+POPUP_SOURCE\s*=\s*['"]([^'"]+)['"]/)
    assert.ok(effortSourceMatch, 'effortMode.js 应定义 POPUP_SOURCE 常量')
    assert.ok(modelSourceMatch, 'modelPicker.js 应定义 POPUP_SOURCE 常量')
    assert.notEqual(
      effortSourceMatch[1],
      modelSourceMatch[1],
      `两模块的 POPUP_SOURCE 必须不同(否则互发互关 / 自杀);` +
        `effort=${effortSourceMatch[1]}, model=${modelSourceMatch[1]}`,
    )
  })
})
