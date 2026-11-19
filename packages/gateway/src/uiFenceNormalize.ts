/**
 * OCV5-482: server-side twin of web-react/src/lib/uiFence.ts (same rule, kept in step by
 * __tests__/uiFenceNormalize.test.ts). Official DeepSeek sometimes glues the ```ui prediction
 * block to the answer line. The stored turn (tape, history, export, share) gets the fence on its
 * own line; the live stream is left as is and rendered by the web fix.
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

/**
 * Normalize a completed assistant output. Each segment is normalized on its own and the text is
 * rebuilt from the segments, so the tape invariant (segments join to text) still holds. If the
 * input does not satisfy that invariant it is returned untouched.
 */
export function normalizeAssistantOutputUiFences<S extends { text: string }>(output: {
  text: string
  segments: S[]
}): { text: string; segments: S[] } {
  if (output.segments.length === 0) {
    return { text: normalizeInlineUiFences(output.text), segments: output.segments }
  }
  if (output.segments.map((segment) => segment.text).join('') !== output.text) return output
  const segments = output.segments.map((segment) => ({
    ...segment,
    text: normalizeInlineUiFences(segment.text),
  }))
  return { text: segments.map((segment) => segment.text).join(''), segments }
}
