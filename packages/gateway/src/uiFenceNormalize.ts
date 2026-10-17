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
  let open: { char: string; len: number; ui: boolean } | null = null

  const closeRe = (o: { char: string; len: number }) =>
    new RegExp(`^ {0,3}${o.char === '`' ? '`' : '~'}{${o.len},}[ \\t]*$`)
  const pushUiBody = (line: string) => {
    // `{…}```` :收围栏贴在 JSON 后面。
    const o = open!
    const glued = new RegExp(
      `^(.*\\})[ \\t]*(${o.char === '`' ? '`' : '~'}{${o.len},})[ \\t]*$`,
    ).exec(line)
    if (glued) {
      out.push(glued[1]!, glued[2]!)
      open = null
    } else out.push(line)
  }
  const openUi = (indent: string, fence: string, rest: string) => {
    out.push(`${indent}${fence}ui`)
    open = { char: fence[0]!, len: fence.length, ui: true }
    if (rest.trim()) pushUiBody(rest.trim())
  }

  for (const line of text.split('\n')) {
    if (open) {
      if (closeRe(open).test(line)) {
        out.push(line)
        open = null
      } else if (open.ui) pushUiBody(line)
      else out.push(line)
      continue
    }
    const withBody = LINE_UI_WITH_BODY.exec(line)
    if (withBody) {
      openUi(withBody[1]!, withBody[2]!, withBody[3]!)
      continue
    }
    const m = LINE_FENCE.exec(line)
    if (m) {
      out.push(line)
      open = { char: m[1]![0]!, len: m[1]!.length, ui: m[2]!.toLowerCase() === 'ui' }
      continue
    }
    // 只处理正文后面贴着的开围栏:前面得有文字,且这一行不是缩进代码块(4 空格/Tab 起头)。
    const g = INDENTED_CODE.test(line) ? null : GLUED_UI.exec(line)
    const before = g ? line.slice(0, g.index).trimEnd() : ''
    if (g && before.trim()) {
      out.push(before)
      openUi('', g[1]!, line.slice(g.index + g[0].length))
      continue
    }
    out.push(line)
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
