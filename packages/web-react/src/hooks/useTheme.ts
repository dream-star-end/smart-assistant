import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'oc_theme'
const THEMES: readonly Theme[] = ['light', 'dark', 'system']

/**
 * localStorage 里的取值校验:只认三个合法值,其余(旧版本遗留 / 手工改 / 空)一律回落 system。
 * 原实现直接 `as Theme`,脏值会让 classList.toggle("dark", false) 强制浅色并忽略系统偏好,
 * ThemeToggle 的 title 还会渲染成「主题:undefined」(shell 审计 S-12)。
 */
export function parseTheme(raw: string | null | undefined): Theme {
  return raw && (THEMES as readonly string[]).includes(raw) ? (raw as Theme) : 'system'
}

/**
 * 浏览器 UI(地址栏 / 状态栏)的 theme-color。**唯一权威**:index.html 的首屏内联脚本与本 hook
 * 都必须取这里的两个值(内联脚本无法 import,靠 useTheme.test 把两处钉在一起,值漂移即测试转红;
 * shell 审计 S-11:原先内联脚本只在 dark 时改写、且写的是营销页黑 #090a08,浅色用户首帧状态栏
 * 先黑后白)。
 */
export const THEME_COLOR = { dark: '#0c0c11', light: '#fafafb' } as const

export function themeColorFor(dark: boolean): string {
  return dark ? THEME_COLOR.dark : THEME_COLOR.light
}

function readStoredTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', themeColorFor(dark))
    }
    apply()
    mq.addEventListener('change', apply)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      /* private mode / 无 storage */
    }
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  // 跨标签页同步:另一个标签页切了主题,这里跟着变,不必刷新(S-12)。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return
      setTheme(parseTheme(e.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const cycle = () => setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'))
  return { theme, setTheme, cycle }
}
