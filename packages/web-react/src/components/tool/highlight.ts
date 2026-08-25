/**
 * 工具卡内容的语法高亮接入(highlight.js 惰性加载)。
 *
 * markdown 渲染走 rehype-highlight(MarkdownImpl 懒加载),工具卡的 diff/文件预览不经
 * markdown 管线,这里直接用 highlight.js。为不把 ~几百 KB 的 hljs 拖进主包,采用
 * 模块级单例 + 动态 import('highlight.js/lib/common'):首次需要高亮时才加载,
 * 加载完成通过订阅通知所有挂载中的组件重渲。`.hljs-*` 配色已在 styles.css 桥接到主题 token。
 *
 * 测试环境(vitest/jsdom)跳过异步加载:高亮是纯视觉增强,跳过可保证测试渲染同步确定,
 * 断言始终针对纯文本回退路径。
 */
import { useEffect, useState } from 'react'

type HljsApi = {
  getLanguage(name: string): unknown
  highlight(
    code: string,
    options: { language: string; ignoreIllegals?: boolean },
  ): { value: string }
}

let hljs: HljsApi | null = null
let loadStarted = false
const subscribers = new Set<() => void>()

function loadHljs(): void {
  if (hljs || loadStarted) return
  loadStarted = true
  import('highlight.js/lib/common')
    .then((mod) => {
      hljs = mod.default as unknown as HljsApi
      for (const notify of subscribers) notify()
    })
    .catch(() => {
      // 加载失败(离线/分包丢失)→ 永久纯文本回退,不重试不报错。
    })
}

// 文件扩展名 → highlight.js 语言名(只列 lib/common 覆盖的常见语言,未知一律纯文本)。
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  ini: 'ini',
  toml: 'ini',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  diff: 'diff',
}

/** 从文件路径推断 highlight.js 语言名;无扩展名/未知扩展 → null(纯文本)。 */
export function languageForPath(path: string | null | undefined): string | null {
  if (!path) return null
  const base = String(path).split(/[?#]/)[0]?.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? null
}

/** 单段代码的高亮成本上限:超过则纯文本(高亮是增强,不为它卡渲染)。 */
const MAX_HIGHLIGHT_CHARS = 30_000

/**
 * 返回 highlight 函数 `(code) => html | null`:hljs 未就绪 / 语言未知 / 代码过长 → null,
 * 调用方渲染纯文本。hljs 输出对源码做了 HTML 转义,可安全用于 dangerouslySetInnerHTML。
 */
export function useHighlighter(language: string | null): (code: string) => string | null {
  const [, force] = useState(0)
  useEffect(() => {
    if (!language || hljs) return
    if (import.meta.env.MODE === 'test') return
    const notify = () => force((v) => v + 1)
    subscribers.add(notify)
    loadHljs()
    return () => {
      subscribers.delete(notify)
    }
  }, [language])
  return (code: string) => {
    if (!language || !hljs || code.length > MAX_HIGHLIGHT_CHARS) return null
    try {
      if (!hljs.getLanguage(language)) return null
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    } catch {
      return null
    }
  }
}
