/**
 * Diff 展示增强工具（仅供懒加载块 tool/bodies.tsx 消费，避免经 workPane.ts → lineDiff.ts 进入首屏闭包）：
 * - diffStats：统计 +N/-M 行数
 * - collapseDiffContext：按 ±N 行折叠大段未改动上下文
 * - parseUnifiedDiffLines：解析 unified diff 文件头 / hunk 头与双侧行号
 */
import type { DiffRow } from './lineDiff'

export function diffStats(rows: readonly DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.sign === '+') added += 1
    else if (r.sign === '-') removed += 1
  }
  return { added, removed }
}

export type DiffDisplayEntry =
  | { kind: 'row'; row: DiffRow; index: number }
  | { kind: 'gap'; start: number; end: number; count: number }

/**
 * 折叠未改动上下文行（默认仅保留每个变更 hunk 上下 3 行），避免大文件编辑时前 60 行全是未变上下文
 * 掩盖真正的 +/- 改动。单行间隔直接展示不折叠；已手动展开的 gap（按 start 索引记）原地还原。
 */
export function collapseDiffContext(
  rows: readonly DiffRow[],
  contextLines = 3,
  expandedGaps?: ReadonlySet<number>,
): DiffDisplayEntry[] {
  const n = rows.length
  if (n === 0) return []
  const changedIndices: number[] = []
  for (let i = 0; i < n; i++) {
    if (rows[i]!.sign !== ' ') changedIndices.push(i)
  }
  if (changedIndices.length === 0) {
    return rows.map((row, index) => ({ kind: 'row', row, index }))
  }
  const keep = new Uint8Array(n)
  for (const idx of changedIndices) {
    const lo = Math.max(0, idx - contextLines)
    const hi = Math.min(n - 1, idx + contextLines)
    for (let k = lo; k <= hi; k++) keep[k] = 1
  }
  const out: DiffDisplayEntry[] = []
  let i = 0
  while (i < n) {
    if (keep[i]) {
      out.push({ kind: 'row', row: rows[i]!, index: i })
      i += 1
      continue
    }
    const start = i
    while (i < n && !keep[i]) i += 1
    const count = i - start
    if (count <= 1 || expandedGaps?.has(start)) {
      for (let k = start; k < i; k++) {
        out.push({ kind: 'row', row: rows[k]!, index: k })
      }
    } else {
      out.push({ kind: 'gap', start, end: i - 1, count })
    }
  }
  return out
}

export type UnifiedDiffLine = {
  kind: 'file-header' | 'hunk-header' | 'add' | 'del' | 'context'
  oldNo: number | null
  newNo: number | null
  sign: '' | '+' | '-' | ' '
  text: string
  raw: string
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/

/** 解析 unified diff：区分 +++/--- 文件头、@@ hunk 头与增删行，并推导旧/新行号。 */
export function parseUnifiedDiffLines(diff: string): {
  lines: UnifiedDiffLine[]
  added: number
  removed: number
} {
  const rawLines = diff.replace(/\n$/, '').split('\n')
  const lines: UnifiedDiffLine[] = []
  let oldLine: number | null = null
  let newLine: number | null = null
  let added = 0
  let removed = 0

  for (const raw of rawLines) {
    if (
      raw.startsWith('+++ ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('diff --git ') ||
      raw.startsWith('index ') ||
      raw.startsWith('new file mode ') ||
      raw.startsWith('deleted file mode ')
    ) {
      lines.push({ kind: 'file-header', oldNo: null, newNo: null, sign: '', text: raw, raw })
      continue
    }
    const hunk = HUNK_HEADER_RE.exec(raw)
    if (hunk) {
      oldLine = Number.parseInt(hunk[1]!, 10)
      newLine = Number.parseInt(hunk[2]!, 10)
      lines.push({ kind: 'hunk-header', oldNo: null, newNo: null, sign: '', text: raw, raw })
      continue
    }
    if (raw.startsWith('+')) {
      added += 1
      const n = newLine
      if (newLine !== null) newLine += 1
      lines.push({ kind: 'add', oldNo: null, newNo: n, sign: '+', text: raw.slice(1), raw })
      continue
    }
    if (raw.startsWith('-')) {
      removed += 1
      const o = oldLine
      if (oldLine !== null) oldLine += 1
      lines.push({ kind: 'del', oldNo: o, newNo: null, sign: '-', text: raw.slice(1), raw })
      continue
    }
    const o = oldLine
    const n = newLine
    if (oldLine !== null) oldLine += 1
    if (newLine !== null) newLine += 1
    const text = raw.startsWith(' ') ? raw.slice(1) : raw
    lines.push({ kind: 'context', oldNo: o, newNo: n, sign: ' ', text, raw })
  }
  return { lines, added, removed }
}
