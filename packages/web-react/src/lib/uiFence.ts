/**
 * OCV5-482:模型(官方 DeepSeek)有时把 ```ui 块直接接在正文同一行后面 —— `2```ui{"type":"next",…}` ——
 * 或把 JSON 写在围栏行上。CommonMark 只在行首开围栏,于是整块被当成行内代码,用户看到原始 JSON,
 * 输入预测也丢了。这里把这种开围栏(以及贴在 JSON 后面的收围栏)挪到单独一行。
 * 其它代码围栏里的内容不动;不含 ```ui / ~~~ui 的文本原样返回。
 */

const LINE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
/** 行首的 ui 围栏,同一行还跟着 JSON。 */
const LINE_UI_WITH_BODY = /^( {0,3})(`{3,}|~{3,})[ \t]*ui[ \t]*(\{.*)$/i
/** 行中间的 ui 开围栏:后面只能是 JSON 开头或行尾,否则是正文里提到这个写法。 */
const GLUED_UI = /(`{3,}|~{3,})ui(?=[ \t]*(?:\{|$))/i
/** 缩进代码块的行:原样保留,里面的 ```ui 只是示例文字。 */
const INDENTED_CODE = /^(?: {4}|\t)/

export function normalizeInlineUiFences(text: string): string {
  if (!text.includes('```ui') && !text.includes('~~~ui')) return text
  const out: string[] = []
  type OpenState = { char: string; len: number; ui: boolean; depth: number }
  const state: { open: OpenState | null } = { open: null }

  const fenceChar = (o: { char: string }) => (o.char === '`' ? '`' : '~')
  const closeRe = (o: { char: string; len: number }) =>
    new RegExp(`^ {0,3}${fenceChar(o)}{${o.len},}[ \\t]*$`)
  const closeTrailingRe = (o: { char: string; len: number }) =>
    new RegExp(`^( {0,3}${fenceChar(o)}{${o.len},})[ \\t]*(\\S.*)$`)
  const findUiCloseSplit = (
    line: string,
    o: OpenState,
  ): { before: string; fence: string; after: string } | null => {
    const ch = fenceChar(o)
    const trailingClose = closeTrailingRe(o).exec(line)
    if (trailingClose) return { before: '', fence: trailingClose[1]!, after: trailingClose[2]! }
    let inString = false
    let esc = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (inString) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === '{') o.depth += 1
      else if (c === '}') {
        if (o.depth > 0) o.depth -= 1
        if (o.depth === 0) {
          const tail = new RegExp(`^[ \\t]*(${ch}{${o.len},})(?:[ \\t]*(\\S.*))?$`).exec(line.slice(i + 1))
          if (tail) return { before: line.slice(0, i + 1), fence: tail[1]!, after: tail[2] ?? '' }
        }
      }
    }
    return null
  }
  const pushOutside = (line: string) => {
    const withBody = LINE_UI_WITH_BODY.exec(line)
    if (withBody) {
      openUi(withBody[1]!, withBody[2]!, withBody[3]!)
      return
    }
    const m = LINE_FENCE.exec(line)
    if (m) {
      out.push(line)
      state.open = { char: m[1]![0]!, len: m[1]!.length, ui: m[2]!.toLowerCase() === 'ui', depth: 0 }
      return
    }
    // 只处理正文后面贴着的开围栏:前面得有文字,且这一行不是缩进代码块(4 空格/Tab 起头)。
    const g = INDENTED_CODE.test(line) ? null : GLUED_UI.exec(line)
    const before = g ? line.slice(0, g.index).trimEnd() : ''
    if (g && before.trim()) {
      out.push(before)
      openUi('', g[1]!, line.slice(g.index + g[0].length))
      return
    }
    out.push(line)
  }
  const pushUiBody = (line: string) => {
    // 仅在 JSON 字符串外且根对象闭合后（或行首闭合围栏）拆分收围栏与后续正文，避免破坏正文字符串里的 ```{...}```。
    const o = state.open!
    const split = findUiCloseSplit(line, o)
    if (split) {
      if (split.before) out.push(split.before)
      out.push(split.fence)
      state.open = null
      if (split.after) pushOutside(split.after)
      return
    }
    out.push(line)
  }
  const openUi = (indent: string, fence: string, rest: string) => {
    out.push(`${indent}${fence}ui`)
    state.open = { char: fence[0]!, len: fence.length, ui: true, depth: 0 }
    if (rest.trim()) pushUiBody(rest.trim())
  }

  for (const line of text.split('\n')) {
    const o = state.open
    if (o) {
      if (closeRe(o).test(line)) {
        out.push(line)
        state.open = null
      } else if (o.ui) pushUiBody(line)
      else out.push(line)
      continue
    }
    pushOutside(line)
  }
  return out.join('\n')
}
