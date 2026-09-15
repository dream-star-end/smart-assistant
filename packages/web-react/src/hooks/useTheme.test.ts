import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { THEME_COLOR, THEME_STORAGE_KEY, parseTheme, themeColorFor, useTheme } from './useTheme'

function locateIndexHtml(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i += 1) {
    for (const candidate of [
      resolve(dir, 'index.html'),
      resolve(dir, 'packages/web-react/index.html'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到 index.html(cwd=${process.cwd()})`)
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  document.head.querySelector('meta[name="theme-color"]')?.remove()
})
afterEach(cleanup)

describe('parseTheme(S-12 取值校验)', () => {
  it('三个合法值原样返回', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('system')).toBe('system')
  })
  it('脏值 / 空 / null 一律回落 system', () => {
    expect(parseTheme('auto')).toBe('system')
    expect(parseTheme('')).toBe('system')
    expect(parseTheme(null)).toBe('system')
    expect(parseTheme(undefined)).toBe('system')
  })
})

describe('useTheme', () => {
  it('localStorage 里是脏值时不强制浅色,按 system 处理', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'auto')
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('system')
    // effect 会把校验后的合法值写回
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('theme-color 跟随明暗,取值与 index.html 内联脚本一致(S-11)', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('content', '#090a08')
    document.head.appendChild(meta)

    const { result } = renderHook(() => useTheme())
    // setup.ts 的 matchMedia 桩恒 matches=false → system 即浅色
    expect(meta.getAttribute('content')).toBe(THEME_COLOR.light)
    act(() => result.current.setTheme('dark'))
    expect(meta.getAttribute('content')).toBe(THEME_COLOR.dark)
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    // 内联脚本无法 import 本模块:把两处的字面量钉在同一条断言里,值漂移即转红。
    const html = readFileSync(locateIndexHtml(), 'utf8')
    expect(html).toContain(THEME_COLOR.dark)
    expect(html).toContain(THEME_COLOR.light)
    expect(themeColorFor(true)).toBe(THEME_COLOR.dark)
    expect(themeColorFor(false)).toBe(THEME_COLOR.light)
  })

  it('另一个标签页改了 oc_theme → 本标签页跟随(S-12 storage 事件)', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('system')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }),
      )
    })
    expect(result.current.theme).toBe('dark')
    // 无关键不理
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'light' }))
    })
    expect(result.current.theme).toBe('dark')
    // 对方写了脏值 → 回落 system
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'garbage' }),
      )
    })
    expect(result.current.theme).toBe('system')
  })

  it('cycle:light → dark → system → light', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const { result } = renderHook(() => useTheme())
    act(() => result.current.cycle())
    expect(result.current.theme).toBe('dark')
    act(() => result.current.cycle())
    expect(result.current.theme).toBe('system')
    act(() => result.current.cycle())
    expect(result.current.theme).toBe('light')
  })
})
