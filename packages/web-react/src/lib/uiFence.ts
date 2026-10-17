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
    const g = GLUED_UI.exec(line)
    if (g && g.index > 0) {
      const before = line.slice(0, g.index).trimEnd()
      if (before) out.push(before)
      openUi('', g[1]!, line.slice(g.index + g[0].length))
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}
