// OpenClaude — LaTeX (.tex) export
//
// 与 export-docx.js 的"尊重已渲染 DOM"不同,.tex 导出从 **markdown 源文本** 走
// —— 因为 LaTeX 本身就是源格式,用户拿到的是可继续编辑的文本,DOM 层里的
// Mermaid SVG / Chart canvas 在 .tex 里并没有直接对应物(应作为图片附件,
// 不在此模块范围)。目标是让 alice 类用户把对话产出直接丢进 TeXstudio /
// Overleaf 继续写,而不是照抄。
//
// 覆盖范围(够用即可):
//   - 标题 # ## ### 六级 → section / subsection / subsubsection / paragraph
//   - 代码块 ```lang ... ``` → lstlisting(带 language 标签),没有语言则 verbatim
//   - 行内代码 `x` → \texttt{x}
//   - 粗体 **x** → \textbf{x},斜体 *x* → \emph{x}
//   - 链接 [text](url) → \href{url}{text}(需 hyperref)
//   - 无序/有序列表(嵌套最多两层,再深退化到首层)
//   - 表格 | a | b | → longtable
//   - 数学:$...$ 和 $$...$$ 原样透传(本来就是 LaTeX)
//   - 其它特殊字符:& % $ # _ { } ~ ^ \ 在正文里转义;代码块/数学块内不转义
//
// 没覆盖的(已知限制,科研场景基本用不到):
//   - 图片(alice 的会话里极少出现需要导出的图)
//   - 脚注 / 自定义环境
//   - 引用(以后若要和 P2-8 的引用核查联动,把 [@key] 转成 \cite{key})
//   - **多反引号 code span**(`` ``x`` `` / ``` ```x``` ```):只识别单反引号 `` `x` ``,
//     多反引号形式会按单反引号翻转状态,可能导致表格列或行内渲染错位。极罕见。
//   - code span 内部的 `\|`:反斜杠会被下游 `_escapeLatex` 变成 `\textbackslash{}`;
//     若真要在 code 里显示字面 `\|`,用户可以手改输出的 `\texttt{...}` 段。
//   - 表格扫描**依赖成对单反引号** —— 未闭合的单反引号(奇数个)会导致 code 状态残留,
//     当前实现的降级是"本行后半段一律视为 code,不再分列",表现偏保守但不炸。

import { toast } from './ui.js?v=85fd3f7'

// ── LaTeX 特殊字符转义(仅用于正文,代码/数学里不调用) ──
//
// 顺序陷阱:如果先把 `\\` 换成 `\\textbackslash{}`,再去转义 `{}`,那个命令的 `{}`
// 会被再次转义成 `\\{\\}`,变成字面 `{}` —— 用户看到 `\\textbackslash\\{\\}` 而不是 `\\`。
// 解决:先用 sentinel(U+0001 不可能出现在合法文本)占位 `\\`、`{`、`}`,
// 再做其它转义,最后一次性把 sentinel 展开成命令形式,保证 `\\textbackslash{}` 里
// 的 `{}` 不会被当用户输入再转义一次。
// ~ 和 ^ 在 LaTeX 里是激活字符,必须包进 \textasciitilde{}、\textasciicircum{} 形式
// —— 同样放在最后,命令里的 `{}` 不会再被误转。
function _escapeLatex(s) {
  return s
    .replace(/\\/g, '\u0001BS\u0001')
    .replace(/\{/g, '\u0001LB\u0001')
    .replace(/\}/g, '\u0001RB\u0001')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\u0001TI\u0001')
    .replace(/\^/g, '\u0001CI\u0001')
    .replace(/\u0001LB\u0001/g, '\\{')
    .replace(/\u0001RB\u0001/g, '\\}')
    .replace(/\u0001BS\u0001/g, '\\textbackslash{}')
    .replace(/\u0001TI\u0001/g, '\\textasciitilde{}')
    .replace(/\u0001CI\u0001/g, '\\textasciicircum{}')
}

// ── 行内转换:保留 $...$ 和 `...` 原样,其它部分先处理链接占位,再转义再处理 **/* ──
//
// 策略:用单次 regex 把文本切成 "token 数组" —— 每个 token 要么是一个原样片段
// (math / code),要么是普通文本。只对普通文本做转义和粗体/斜体/链接替换。
// 这样 `\int_0^1` 这种在 $...$ 里的反斜杠不会被 _escapeLatex 吃掉。
//
// 链接处理:_escapeLatex 不转 [ ] ( ),所以要在**转义之前**先把 [txt](url) 抓出来
// 用不可见 sentinel 占位,转义完再还原成 \href{url}{escaped_txt}。
// 链接解析:手写平衡括号扫描,容忍 URL 里带 `)`(如 Wikipedia 的 `Foo_(bar)`)
// 和 markdown 本身定义的 "标题可含 \]"(这里不支持转义,只支持无转义的 [txt]).
// 从 openIdx(指向 `[`)开始,返回 { text, url, end }(end 指向闭合 `)` 下一位) 或 null。
function _parseMarkdownLink(src, openIdx) {
  if (src[openIdx] !== '[') return null
  // 找 ] (不支持嵌套的 [ ])
  let i = openIdx + 1
  let txtEnd = -1
  while (i < src.length) {
    const c = src[i]
    if (c === ']') {
      txtEnd = i
      break
    }
    if (c === '\n') return null
    i++
  }
  if (txtEnd < 0 || src[txtEnd + 1] !== '(') return null
  // 平衡 ()
  let depth = 1
  let j = txtEnd + 2
  let urlStart = j
  while (j < src.length) {
    const c = src[j]
    if (c === '\n') return null
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) {
        return {
          text: src.slice(openIdx + 1, txtEnd),
          url: src.slice(urlStart, j),
          end: j + 1,
        }
      }
    }
    j++
  }
  return null
}

function _renderInlineV2(text) {
  // 手扫 token 化:code span (`...`) 和 math ($$...$$, $...$)。
  // 关键:反斜杠转义的 `\`` / `\$` 不应作为定界符 —— 否则 `a \` b` 的 `` ` `` 会被
  // 当 code 起点,`\$100` 里的 `$` 会开始 math。用 _isBackslashEscapedAt 过滤。
  // 已知限制(文件头注释里):仅支持单反引号 code span;未闭合定界会让剩余文本
  // 作为普通文本处理(保守)。
  const tokens = []
  let i = 0
  let textStart = 0 // 下一个 text token 的起点(上次 code/math 闭合之后或 0)
  const flushText = (end) => {
    if (end > textStart) tokens.push({ kind: 'text', v: text.slice(textStart, end) })
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '`' && !_isBackslashEscapedAt(text, i)) {
      // 找下一个非转义的未换行 `
      let j = i + 1
      let found = -1
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '`' && !_isBackslashEscapedAt(text, j)) {
          found = j
          break
        }
        j++
      }
      if (found > i) {
        flushText(i)
        tokens.push({ kind: 'code', v: text.slice(i + 1, found) })
        i = found + 1
        textStart = i
        continue
      }
      // 未闭合:退化成普通字符,继续推进
    }
    if (c === '$' && !_isBackslashEscapedAt(text, i)) {
      // 判断 $$ 还是 $(开头的两个字符决定模式)
      const isDouble = text[i + 1] === '$'
      const delim = isDouble ? '$$' : '$'
      const searchFrom = i + delim.length
      let j = searchFrom
      let found = -1
      while (j < text.length && text[j] !== '\n') {
        if (!_isBackslashEscapedAt(text, j) && text[j] === '$') {
          if (isDouble) {
            // $$ 模式:必须闭在 $$
            if (text[j + 1] === '$') {
              found = j
              break
            }
            // 孤立 $ 不算闭 —— 跳过
          } else {
            // $ 模式:任意未转义 $ 都闭合,不要再检查下一字符是否 $,否则
            // `$a$$b$` 会被当一整段 math 而不是两段独立 math。
            found = j
            break
          }
        }
        j++
      }
      if (found > i) {
        flushText(i)
        tokens.push({ kind: 'math', v: text.slice(i, found + delim.length) })
        i = found + delim.length
        textStart = i
        continue
      }
      // 未闭合 $ → 退化成普通字符(下游 _escapeLatex 会把裸 $ 转义成 \$)
    }
    i++
  }
  flushText(text.length)

  return tokens
    .map((t) => {
      if (t.kind === 'math') return t.v
      if (t.kind === 'code') return `\\texttt{${_escapeLatex(t.v)}}`
      // text:先扫 [txt](url) 占位(手写平衡括号),再转义,再处理 **/*。
      let s = t.v
      const linkStore = []
      {
        const pieces = []
        let p = 0
        while (p < s.length) {
          if (s[p] === '[') {
            const lk = _parseMarkdownLink(s, p)
            if (lk) {
              pieces.push(`\u0000LINK${linkStore.length}\u0000`)
              linkStore.push(lk)
              p = lk.end
              continue
            }
          }
          pieces.push(s[p])
          p++
        }
        s = pieces.join('')
      }
      s = _escapeLatex(s)
      // 粗体 **x**:要求内容非空、前后非 *,避免和 *x* 冲突
      s = s.replace(/\*\*([^*\n]+)\*\*/g, (_mm, x) => `\\textbf{${x}}`)
      // 斜体 *x*:单星号对,不能是 ** 的一部分
      s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_mm, pre, x) => `${pre}\\emph{${x}}`)
      // 还原链接:URL 用 \detokenize 最稳(hyperref 保证特殊字符按字面展开),
      // 可显式失败在 & ^ 等 —— detokenize 后这些字符需要 catcode other,hyperref 会处理。
      // 文本保持转义后状态,不能再跑一遍 _escapeLatex(会把已转义的 \_ 再转一次)。
      s = s.replace(/\u0000LINK(\d+)\u0000/g, (_mm, i) => {
        const { text: linkTxt, url } = linkStore[Number(i)]
        const safeUrl = url.trim()
        // detokenize 里不能有未配对 {},做最小保险 —— 极端情况退回转义形式
        if (/\{|\}/.test(safeUrl)) {
          const esc = _escapeLatex(safeUrl)
          return `\\href{${esc}}{${_escapeLatex(linkTxt)}}`
        }
        return `\\href{\\detokenize{${safeUrl}}}{${_escapeLatex(linkTxt)}}`
      })
      return s
    })
    .join('')
}

// ── 表格:| a | b | c | ──
// 约定:markdown 标准表格,第二行是 |---|---|---| 分隔线。我们扫三种状态:
// 找到表头 → 找到分隔 → 收集后续行 → 第一空行或非 | 行结束。
function _emitTable(headerCells, rows) {
  const colCount = headerCells.length
  const colSpec = Array(colCount).fill('l').join(' | ')
  const lines = []
  lines.push(`\\begin{longtable}{| ${colSpec} |}`)
  lines.push('\\hline')
  lines.push(headerCells.map((c) => `\\textbf{${_renderInlineV2(c.trim())}}`).join(' & ') + ' \\\\')
  lines.push('\\hline')
  lines.push('\\endhead')
  for (const row of rows) {
    // 行短于 header 时补空格;行长于 header 时截断
    const cells = row.slice(0, colCount)
    while (cells.length < colCount) cells.push('')
    lines.push(cells.map((c) => _renderInlineV2(c.trim())).join(' & ') + ' \\\\')
    lines.push('\\hline')
  }
  lines.push('\\end{longtable}')
  return lines.join('\n')
}

// 判断 s[k] 处的字符是否被紧邻其前的反斜杠转义:
// 数 k-1 起连续 `\` 的个数 —— 奇数 = 被转义,偶数/0 = 字面。
// 例:`\\|` 有 2 个 `\`,第 2 个被第 1 个转义掉,所以 `|` 不是被转义的;
//     `\\\|` 有 3 个 `\`,前 2 个互相抵消,第 3 个转义 `|`,所以 `|` 被转义。
function _isBackslashEscapedAt(s, k) {
  let n = 0
  let j = k - 1
  while (j >= 0 && s[j] === '\\') {
    n++
    j--
  }
  return n % 2 === 1
}

// 从 s[k]=='$'(未转义)起,跳到该 math span 结束之后的 index;未闭合返回 -1。
// 单 `$...$` 和 `$$...$$` 都支持,行内不跨 `\n`。
function _skipMathSpan(s, k) {
  const isDouble = s[k + 1] === '$' && !_isBackslashEscapedAt(s, k + 1)
  const delimLen = isDouble ? 2 : 1
  let j = k + delimLen
  while (j < s.length && s[j] !== '\n') {
    if (s[j] === '$' && !_isBackslashEscapedAt(s, j)) {
      if (isDouble) {
        if (s[j + 1] === '$') return j + 2
      } else {
        return j + 1
      }
    }
    j++
  }
  return -1
}

function _splitTableRow(line) {
  // 按非转义管道 split。需要跳过的"伪管道":
  //   - 反引号 code span 内部(仅单反引号)
  //   - 行内 math span 内部(`$...$` / `$$...$$`) —— 科研里 `$|x|$`、`$\|A\|$` 常见
  //   - `\|`(markdown 约定字面管道) —— 吃掉那一个转义反斜杠,cell 里存字面 `|`
  // 前导 `|` 可选;trailing 不预先剥离 —— 扫完后若最后一次 push 是来自 `|` 分隔器
  // 且 cur 为空,则那是个 trailing 分隔器,丢弃即可。这样在 `| $a|b$ |` 这种
  // math 内有 `|` 的行里也不会误把内部 `|` 当列分隔。
  const trimmed = line.trim().replace(/^\|/, '')
  const cells = []
  let cur = ''
  let inCode = false
  let lastWasPipeDelim = false
  for (let k = 0; k < trimmed.length; k++) {
    const c = trimmed[k]
    // code span 切换(单反引号);反斜杠转义的 `\`` 不翻转
    if (c === '`' && !_isBackslashEscapedAt(trimmed, k)) {
      inCode = !inCode
      cur += c
      lastWasPipeDelim = false
      continue
    }
    // math span:一次性跳过整段,里面的 `|` 天然免疫
    if (c === '$' && !inCode && !_isBackslashEscapedAt(trimmed, k)) {
      const end = _skipMathSpan(trimmed, k)
      if (end > k) {
        cur += trimmed.slice(k, end)
        k = end - 1 // loop ++ 之后正好落到 end
        lastWasPipeDelim = false
        continue
      }
      // 未闭合:退化成字面 `$`,继续往下走
    }
    if (c === '|' && !inCode && !_isBackslashEscapedAt(trimmed, k)) {
      cells.push(cur.trim())
      cur = ''
      lastWasPipeDelim = true
      continue
    }
    // 字面 `\|`:吃掉那一个转义反斜杠,保留 `|`
    if (c === '|' && !inCode && _isBackslashEscapedAt(trimmed, k)) {
      if (cur.endsWith('\\')) cur = cur.slice(0, -1)
      cur += '|'
      lastWasPipeDelim = false
      continue
    }
    cur += c
    if (c !== ' ' && c !== '\t') lastWasPipeDelim = false
  }
  // 若最后一次 push 是 trailing `|` 分隔器且 cur 只有空白,则那是个 trailing 分隔,
  // 不再 push 空 cell;否则把 cur 作为最后一个单元。
  if (!(lastWasPipeDelim && cur.trim() === '')) {
    cells.push(cur.trim())
  }
  return cells
}

// 表头行:包含至少一个 code/math/转义之外的 `|` 才算。
// 避免 `` `a | b` `` 和 `$a|b$` 这种内部伪管道被误当表头。
function _looksLikeTableHeader(line) {
  if (!line) return false
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  // 忽略纯表格分隔(避免把 `---|---` 行当表头)
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) return false
  let inCode = false
  for (let k = 0; k < trimmed.length; k++) {
    const c = trimmed[k]
    if (c === '`' && !_isBackslashEscapedAt(trimmed, k)) {
      inCode = !inCode
      continue
    }
    if (c === '$' && !inCode && !_isBackslashEscapedAt(trimmed, k)) {
      const end = _skipMathSpan(trimmed, k)
      if (end > k) {
        k = end - 1
        continue
      }
    }
    if (c === '|' && !inCode && !_isBackslashEscapedAt(trimmed, k)) return true
  }
  return false
}

function _isTableSeparator(line) {
  // 必须至少包含一个 |(否则纯 `---` 会和 horizontal rule 撞车,
  // 导致上一行是 `a | b` 的普通段落被误判成表头)。
  // 允许对齐语法 :---: / ---: / :---;前后 | 可选。
  if (!line.includes('|')) return false
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)
}

// ── 列表:最简策略,只处理纯无序 (- / *) 和有序 (数字.) 两种 ──
// 嵌套用行首空格数推断(每 2 空格一级)。超过 2 层退化到当前层。
function _emitListBlock(items) {
  // items: [{ level: 0|1|2, ordered: bool, text: string }]
  const lines = []
  const stack = [] // 已打开的 [ordered] 列表栈
  const open = (ordered) => {
    lines.push(ordered ? '\\begin{enumerate}' : '\\begin{itemize}')
    stack.push(ordered)
  }
  const close = () => {
    const ord = stack.pop()
    lines.push(ord ? '\\end{enumerate}' : '\\end{itemize}')
  }
  for (const it of items) {
    const lvl = Math.min(it.level, 2)
    // 收到更深 level:开新层(同类型的嵌套也开新 enumerate/itemize)
    while (stack.length - 1 < lvl) open(it.ordered)
    // 收到更浅 level:关闭多余层
    while (stack.length - 1 > lvl) close()
    // 同级但类型切换:关当前再开
    if (stack[stack.length - 1] !== it.ordered) {
      close()
      open(it.ordered)
    }
    lines.push(`  \\item ${_renderInlineV2(it.text)}`)
  }
  while (stack.length > 0) close()
  return lines.join('\n')
}

// ── Block 解析 ──
function _mdToLatexBody(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0

  const flushParagraph = (buf) => {
    if (buf.length === 0) return
    out.push(_renderInlineV2(buf.join(' ')))
    out.push('')
  }

  let paragraphBuf = []

  while (i < lines.length) {
    const line = lines[i]

    // 1) fenced code:``` 或 ~~~
    const fenceMatch = line.match(/^(\s*)(```|~~~)\s*([\w+-]*)\s*$/)
    if (fenceMatch) {
      flushParagraph(paragraphBuf)
      paragraphBuf = []
      const fence = fenceMatch[2]
      const lang = fenceMatch[3] || ''
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing fence (or EOF)
      if (lang) {
        // lstlisting 支持的语言有限;不认识的 language 选项会让 pdflatex 报错。
        // 保险做法:统一用 basicstyle + 不指定 language,靠注释标注原语言。
        out.push(`\\begin{lstlisting}[basicstyle=\\ttfamily\\small,breaklines=true]`)
        out.push(`% language: ${lang}`)
        out.push(...codeLines)
        out.push(`\\end{lstlisting}`)
      } else {
        out.push('\\begin{verbatim}')
        out.push(...codeLines)
        out.push('\\end{verbatim}')
      }
      out.push('')
      continue
    }

    // 2) display math $$...$$(块级,允许单行或多行 fence)
    {
      // 单行必须是"整行恰好包一对 $$...$$",内部不能再有 $$(用 non-greedy + 否定检查),
      // 否则 `$$a$$ and $$b$$` 会被贪婪抓成一个 block,变成 `\[ a$$ and $$b \]`。
      // 这种"行内两段 display math"罕见,但发生时应走普通段落 + 行内 $$ 渲染。
      const singleLine = line.match(/^\s*\$\$(.+?)\$\$\s*$/)
      const singleLineOk = singleLine && !singleLine[1].includes('$$')
      const fenceOnly = /^\s*\$\$\s*$/.test(line)
      if (singleLineOk) {
        flushParagraph(paragraphBuf)
        paragraphBuf = []
        out.push('\\[')
        out.push(singleLine[1])
        out.push('\\]')
        out.push('')
        i++
        continue
      }
      if (fenceOnly) {
        flushParagraph(paragraphBuf)
        paragraphBuf = []
        const mathLines = []
        i++
        while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
          mathLines.push(lines[i])
          i++
        }
        i++ // skip closing $$
        out.push('\\[')
        out.push(...mathLines)
        out.push('\\]')
        out.push('')
        continue
      }
    }

    // 3) heading
    const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (hMatch) {
      flushParagraph(paragraphBuf)
      paragraphBuf = []
      const level = hMatch[1].length
      const title = _renderInlineV2(hMatch[2])
      // # → section,## → subsection,### → subsubsection,#### → paragraph,剩余退化
      const cmd =
        level === 1
          ? 'section'
          : level === 2
            ? 'subsection'
            : level === 3
              ? 'subsubsection'
              : level === 4
                ? 'paragraph'
                : 'subparagraph'
      out.push(`\\${cmd}{${title}}`)
      out.push('')
      i++
      continue
    }

    // 4) table — 表头不强求前导 |,只要有 | 且下一行是对齐分隔
    if (
      _looksLikeTableHeader(line) &&
      i + 1 < lines.length &&
      _isTableSeparator(lines[i + 1])
    ) {
      flushParagraph(paragraphBuf)
      paragraphBuf = []
      const header = _splitTableRow(line)
      i += 2 // skip header + separator
      const rows = []
      while (i < lines.length && !/^\s*$/.test(lines[i])) {
        // 遇到明显非表格行(如新 heading、新 list)就停
        if (/^(#{1,6}\s)|(\s*[-*+]\s)|(\s*\d+\.\s)|(\s*```)|(\s*>)/.test(lines[i])) break
        // 必须含有至少一个**真 pipe**(非 code/math/转义内部)才视为表格体延续 ——
        // 复用 `_looksLikeTableHeader` 的识别即可,它忽略 code/math/\| 里的伪 pipe。
        if (!_looksLikeTableHeader(lines[i])) break
        rows.push(_splitTableRow(lines[i]))
        i++
      }
      out.push(_emitTable(header, rows))
      out.push('')
      continue
    }

    // 5) blockquote:> text —— 简单 quote 环境
    if (/^\s*>/.test(line)) {
      flushParagraph(paragraphBuf)
      paragraphBuf = []
      const quoteLines = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push('\\begin{quote}')
      out.push(_renderInlineV2(quoteLines.join(' ')))
      out.push('\\end{quote}')
      out.push('')
      continue
    }

    // 6) list(收集连续列表项)
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
    if (listMatch) {
      flushParagraph(paragraphBuf)
      paragraphBuf = []
      const items = []
      while (i < lines.length) {
        const lm = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
        if (!lm) break
        const indent = lm[1].length
        const level = Math.floor(indent / 2)
        const ordered = /^\d+\./.test(lm[2])
        items.push({ level, ordered, text: lm[3] })
        i++
      }
      out.push(_emitListBlock(items))
      out.push('')
      continue
    }

    // 7) horizontal rule
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      flushParagraph(paragraphBuf)
      paragraphBuf = []
      out.push('\\noindent\\hrulefill')
      out.push('')
      i++
      continue
    }

    // 8) blank line → flush paragraph
    if (/^\s*$/.test(line)) {
      flushParagraph(paragraphBuf)
      paragraphBuf = []
      i++
      continue
    }

    // 9) default: paragraph accumulation
    paragraphBuf.push(line)
    i++
  }

  flushParagraph(paragraphBuf)
  return out.join('\n')
}

// ── Preamble ──
// ctex 处理中文;hyperref 放 amsmath 之后(ctex 文档要求);listings 给代码块。
// 不设字体(让用户在本地用默认宋体/黑体),避免 "fontspec not found on Overleaf free" 问题。
function _buildTexSource({ title, subtitle, body }) {
  const safeTitle = (title || 'OpenClaude 导出').replace(/[\\{}]/g, '')
  const safeSubtitle = (subtitle || '').replace(/[\\{}]/g, '')
  const lines = [
    '% Generated by OpenClaude',
    '% 默认用 ctex + pdflatex;如用 xelatex 也可直接编译。',
    '\\documentclass[11pt,a4paper]{ctexart}',
    '\\usepackage{amsmath,amssymb,amsthm}',
    '\\usepackage{longtable}',
    '\\usepackage{listings}',
    '\\usepackage{xcolor}',
    '\\usepackage[colorlinks=true,linkcolor=blue,urlcolor=blue]{hyperref}',
    '\\lstset{basicstyle=\\ttfamily\\small,breaklines=true,columns=flexible}',
    '',
    `\\title{${_escapeLatex(safeTitle)}}`,
    `\\author{${safeSubtitle ? _escapeLatex(safeSubtitle) : ''}}`,
    `\\date{${new Date().toLocaleDateString()}}`,
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    body,
    '',
    '\\end{document}',
    '',
  ]
  return lines.join('\n')
}

function _ts() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

function _sanitizeFilename(name) {
  return (name || 'openclaude').replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 80)
}

function _triggerDownload(content, filename) {
  const blob = new Blob([content], { type: 'application/x-tex;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ── Public API ──

export function exportMessageTex(msg, opts = {}) {
  try {
    const body = _mdToLatexBody(msg.text || '')
    const tex = _buildTexSource({
      title: opts.title || 'OpenClaude',
      subtitle: opts.subtitle || '',
      body,
    })
    const safeTitle = _sanitizeFilename(opts.title || 'openclaude')
    _triggerDownload(tex, `${safeTitle}-${_ts()}.tex`)
  } catch (e) {
    console.error('exportMessageTex failed', e)
    toast('TeX 导出失败: ' + (e?.message || e), 'error')
  }
}

export function exportSessionTex(sess) {
  if (!sess) return
  try {
    const parts = []
    for (const m of sess.messages || []) {
      if (m.role === 'user') {
        parts.push('\\subsection*{User}')
        parts.push(_mdToLatexBody(m.text || ''))
      } else if (m.role === 'assistant') {
        parts.push('\\subsection*{Assistant}')
        parts.push(_mdToLatexBody(m.text || ''))
      } else if (m.role === 'tool') {
        // tool 消息作为小灰字注释,不折叠到主流
        parts.push(`\\noindent\\textit{\\textcolor{gray}{[tool] ${_escapeLatex(m.text || '')}}}`)
      }
      parts.push('')
    }
    const tex = _buildTexSource({
      title: sess.title || 'OpenClaude 会话',
      subtitle: `Exported from OpenClaude · ${new Date().toLocaleString()}`,
      body: parts.join('\n'),
    })
    const safeTitle = _sanitizeFilename(sess.title || 'session')
    _triggerDownload(tex, `${safeTitle}-${_ts()}.tex`)
    toast('已导出 TeX', 'success')
  } catch (e) {
    console.error('exportSessionTex failed', e)
    toast('TeX 导出失败: ' + (e?.message || e), 'error')
  }
}
