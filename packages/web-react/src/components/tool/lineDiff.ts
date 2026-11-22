/**
 * 行级 LCS diff(纯函数,无 React,可单测)。
 *
 * Edit 工具的 old_string/new_string 是同一文件区域的前后快照:此前 DiffView 把整段 old
 * 刷成删除、整段 new 刷成新增,未变行被重复标红标绿。这里用标准 LCS 动态规划求出
 * 未变行(上下文行),只把真正变化的行标 +/-,并给出快照内相对行号。
 *
 * 不引入 `diff` npm 依赖(package.json 无此包,且行级 LCS 足够小);超大输入退化为
 * 朴素"整删整增"以防 O(n·m) 内存爆炸(渲染保护,非产品语义)。
 */

export type DiffSign = ' ' | '+' | '-'
export interface DiffRow {
  sign: DiffSign
  /** 旧快照内 1-based 行号(新增行为 null)。 */
  oldNo: number | null
  /** 新快照内 1-based 行号(删除行为 null)。 */
  newNo: number | null
  text: string
}

/** LCS DP 的规模上限(行数乘积)。超过则退化为整删整增,防止内存/耗时失控。 */
const MAX_LCS_CELLS = 1_000_000

function naiveRows(a: string[], b: string[]): DiffRow[] {
  return [
    ...a.map((text, i) => ({ sign: '-' as const, oldNo: i + 1, newNo: null, text })),
    ...b.map((text, i) => ({ sign: '+' as const, oldNo: null, newNo: i + 1, text })),
  ]
}

/** 行级 diff:相同行为上下文(sign ' '),其余按删除/新增输出,保持稳定顺序(先 - 后 +)。 */
export function diffLines(oldStr: string, newStr: string): DiffRow[] {
  const a = oldStr ? oldStr.split('\n') : []
  const b = newStr ? newStr.split('\n') : []
  if (a.length === 0) return naiveRows([], b)
  if (b.length === 0) return naiveRows(a, [])
  const n = a.length
  const m = b.length
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) return naiveRows(a, b)

  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度(倒序填表,回溯时正序输出)。
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ sign: ' ', oldNo: i + 1, newNo: j + 1, text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      rows.push({ sign: '-', oldNo: i + 1, newNo: null, text: a[i] })
      i++
    } else {
      rows.push({ sign: '+', oldNo: null, newNo: j + 1, text: b[j] })
      j++
    }
  }
  while (i < n) {
    rows.push({ sign: '-', oldNo: i + 1, newNo: null, text: a[i] })
    i++
  }
  while (j < m) {
    rows.push({ sign: '+', oldNo: null, newNo: j + 1, text: b[j] })
    j++
  }
  return rows
}

export interface InlineDiffSpan {
  text: string
  changed: boolean
}

const INLINE_TOKEN_RE = /[A-Za-z0-9_$]+|[\u4e00-\u9fff]|[^\sA-Za-z0-9_$\u4e00-\u9fff]+|\s+/g
const MAX_INLINE_DIFF_CHARS = 2000

/**
 * 零依赖词级前后缀公共子串高亮：对相邻的 `-` / `+` 行求出公共词前缀与公共词后缀，
 * 仅高亮中间真正改动的片段；若整行毫无公共词（如完全重写）或超长则返回 null，避免整行双重涂色。
 */
export function inlineDiffSpans(
  oldText: string,
  newText: string,
): { oldSpans: InlineDiffSpan[]; newSpans: InlineDiffSpan[] } | null {
  if (oldText === newText) return null
  if (oldText.length > MAX_INLINE_DIFF_CHARS || newText.length > MAX_INLINE_DIFF_CHARS) return null
  const a = oldText.match(INLINE_TOKEN_RE) ?? []
  const b = newText.match(INLINE_TOKEN_RE) ?? []
  let prefix = 0
  const minLen = Math.min(a.length, b.length)
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < minLen - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  if (prefix === 0 && suffix === 0) return null

  const build = (tokens: string[]): InlineDiffSpan[] => {
    const out: InlineDiffSpan[] = []
    if (prefix > 0) out.push({ text: tokens.slice(0, prefix).join(''), changed: false })
    const midEnd = tokens.length - suffix
    if (midEnd > prefix) out.push({ text: tokens.slice(prefix, midEnd).join(''), changed: true })
    if (suffix > 0) out.push({ text: tokens.slice(midEnd).join(''), changed: false })
    return out
  }
  return { oldSpans: build(a), newSpans: build(b) }
}

/** 为 diff 行序列中相邻的 `-` 块与 `+` 块按行配对计算词级高亮，返回 rowIndex → InlineDiffSpan[]。 */
export function computeInlineDiffMap(rows: readonly Pick<DiffRow, 'sign' | 'text'>[]): Map<number, InlineDiffSpan[]> {
  const map = new Map<number, InlineDiffSpan[]>()
  let i = 0
  while (i < rows.length) {
    if (rows[i]!.sign !== '-') {
      i++
      continue
    }
    const delStart = i
    while (i < rows.length && rows[i]!.sign === '-') i++
    const delCount = i - delStart
    const addStart = i
    while (i < rows.length && rows[i]!.sign === '+') i++
    const addCount = i - addStart
    const pairs = Math.min(delCount, addCount)
    for (let k = 0; k < pairs; k++) {
      const res = inlineDiffSpans(rows[delStart + k]!.text, rows[addStart + k]!.text)
      if (res) {
        map.set(delStart + k, res.oldSpans)
        map.set(addStart + k, res.newSpans)
      }
    }
  }
  return map
}
