// Taskboard 准入条件 —— 小而封闭的布尔表达式(纯逻辑,无 I/O,不用 eval)。
//
// 本段注释会被前端阶段配置界面的帮助文案引用,改语法时请同步改测试。
//
// ═══════════════════════════════════════════════════════════════════════════
// 语法
//
//   空 / 只空白 / null  → 无条件放行
//
//   表达式是具名谓词的布尔组合,支持:
//     &&   与(优先级高于 ||)
//     ||   或
//     !    非(最高优先级)
//     ( )  括号
//
//   谓词(大小写敏感,参数用双引号或单引号;英文枚举也可不带引号):
//
//     always
//         恒真。用来占位或写「!always」做恒假。
//
//     no_open_blockers
//         没有未完成的 blocks 依赖。
//
//     has_body_section("章节名")
//         正文 Markdown 里存在标题恰好等于该名的 ATX 标题
//         (# / ## / ### …,允许行尾闭合 #)。
//         例: has_body_section("复现步骤")
//
//     has_label("标签")
//         单据标签数组里有完全相等的一项。
//         例: has_label("已确认")
//
//     has_comment_from(human|agent|system)
//         至少有一条该角色写的评论。
//
//     priority_at_least(P0|P1|P2|P3)
//         优先级不低于给定档。P0 最高:priority_at_least(P1) 匹配 P0 与 P1。
//
//     last_run_succeeded
//         最近一次 run 状态为 succeeded。还没有 run 视为不满足。
//
//   中文参数必须加引号。空格可出现在运算符两侧。
//
//   合法例子:
//     has_body_section("复现步骤") && no_open_blockers
//     has_label("已确认") || has_comment_from(human)
//     priority_at_least(P1) && !no_open_blockers
//     always
//
//   不支持:嵌套函数、算术、比较、正则、属性路径、eval。
// ═══════════════════════════════════════════════════════════════════════════

import { AUTHOR_KINDS, type AuthorKind, TICKET_PRIORITIES, type TicketPriority } from './domain.js'

// ── AST ─────────────────────────────────────────────────────────────────────

export type EntryAst =
  | { type: 'always' }
  | { type: 'not'; of: EntryAst }
  | { type: 'and'; left: EntryAst; right: EntryAst }
  | { type: 'or'; left: EntryAst; right: EntryAst }
  | { type: 'no_open_blockers' }
  | { type: 'last_run_succeeded' }
  | { type: 'has_body_section'; name: string }
  | { type: 'has_label'; name: string }
  | { type: 'has_comment_from'; actorKind: AuthorKind }
  | { type: 'priority_at_least'; priority: TicketPriority }

export type ParseEntryResult = { ok: true; ast: EntryAst } | { ok: false; error: string }

export interface EntryConditionContext {
  /** Markdown 正文,供 has_body_section 扫描标题。 */
  body: string
  labels: readonly string[]
  /** 是否存在未完成的 blocks 依赖。 */
  hasOpenBlockers: boolean
  /** 已经出现过评论的作者类型(调用方从 DB 聚合后传入)。 */
  commentAuthorKinds: readonly AuthorKind[]
  priority: TicketPriority
  /** 最近一次 run 是否成功;null 表示还没有 run。 */
  lastRunSucceeded: boolean | null
}

const PRIORITY_RANK: Record<TicketPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
}

const AUTHOR_KIND_SET = new Set<string>(AUTHOR_KINDS)
const PRIORITY_SET = new Set<string>(TICKET_PRIORITIES)

// ── 词法 ────────────────────────────────────────────────────────────────────

type Token =
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'not' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'eof' }

interface Lexed {
  tokens: Token[]
  error: string | null
}

function lex(src: string): Lexed {
  const tokens: Token[] = []
  let i = 0
  const n = src.length

  const here = (): string => `第 ${i + 1} 个字符处`

  while (i < n) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (ch === '&' && src[i + 1] === '&') {
      tokens.push({ kind: 'and' })
      i += 2
      continue
    }
    if (ch === '|' && src[i + 1] === '|') {
      tokens.push({ kind: 'or' })
      i += 2
      continue
    }
    if (ch === '!') {
      tokens.push({ kind: 'not' })
      i++
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' })
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      i++
      let value = ''
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          value += src[i + 1]
          i += 2
          continue
        }
        value += src[i]
        i++
      }
      if (i >= n) {
        return { tokens, error: `${here()}：字符串没有闭合的 ${quote}` }
      }
      i++
      tokens.push({ kind: 'string', value })
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = ''
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) {
        value += src[i]
        i++
      }
      tokens.push({ kind: 'ident', value })
      continue
    }
    return { tokens, error: `${here()}：不能识别的字符「${ch}」` }
  }

  tokens.push({ kind: 'eof' })
  return { tokens, error: null }
}

// ── 递归下降 ────────────────────────────────────────────────────────────────

class Parser {
  private i = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): ParseEntryResult {
    const ast = this.parseOr()
    if (!ast.ok) return ast
    if (this.peek().kind !== 'eof') {
      return { ok: false, error: `表达式末尾有多余内容：${this.describe(this.peek())}` }
    }
    return ast
  }

  private parseOr(): ParseEntryResult {
    let left = this.parseAnd()
    if (!left.ok) return left
    while (this.peek().kind === 'or') {
      this.i++
      const right = this.parseAnd()
      if (!right.ok) return right
      left = { ok: true, ast: { type: 'or', left: left.ast, right: right.ast } }
    }
    return left
  }

  private parseAnd(): ParseEntryResult {
    let left = this.parseUnary()
    if (!left.ok) return left
    while (this.peek().kind === 'and') {
      this.i++
      const right = this.parseUnary()
      if (!right.ok) return right
      left = { ok: true, ast: { type: 'and', left: left.ast, right: right.ast } }
    }
    return left
  }

  private parseUnary(): ParseEntryResult {
    if (this.peek().kind === 'not') {
      this.i++
      const inner = this.parseUnary()
      if (!inner.ok) return inner
      return { ok: true, ast: { type: 'not', of: inner.ast } }
    }
    return this.parseAtom()
  }

  private parseAtom(): ParseEntryResult {
    const tok = this.peek()
    if (tok.kind === 'lparen') {
      this.i++
      const inner = this.parseOr()
      if (!inner.ok) return inner
      if (this.peek().kind !== 'rparen') {
        return { ok: false, error: '括号没有闭合，缺少「)」。' }
      }
      this.i++
      return inner
    }
    if (tok.kind === 'ident') {
      this.i++
      return this.parseCall(tok.value)
    }
    if (tok.kind === 'eof') {
      return { ok: false, error: '表达式不完整，运算符后面缺少谓词。' }
    }
    return { ok: false, error: `期望谓词或左括号，却遇到${this.describe(tok)}。` }
  }

  private parseCall(name: string): ParseEntryResult {
    let args: string[] | null = null
    if (this.peek().kind === 'lparen') {
      this.i++
      args = []
      if (this.peek().kind !== 'rparen') {
        const arg = this.parseArg()
        if (!arg.ok) return arg
        args.push(arg.value)
        if (this.peek().kind !== 'rparen') {
          return {
            ok: false,
            error: `谓词 ${name} 只接受 0 或 1 个参数，多个参数请拆成 && / ||。`,
          }
        }
      }
      this.i++
    }
    return buildPredicate(name, args)
  }

  private parseArg(): { ok: true; value: string } | { ok: false; error: string } {
    const tok = this.peek()
    if (tok.kind === 'string' || tok.kind === 'ident') {
      this.i++
      return { ok: true, value: tok.value }
    }
    return {
      ok: false,
      error: `期望参数(引号字符串或标识符)，却遇到${this.describe(tok)}。中文参数必须加引号。`,
    }
  }

  private peek(): Token {
    return this.tokens[this.i] ?? { kind: 'eof' }
  }

  private describe(tok: Token): string {
    switch (tok.kind) {
      case 'and':
        return '「&&」'
      case 'or':
        return '「||」'
      case 'not':
        return '「!」'
      case 'lparen':
        return '「(」'
      case 'rparen':
        return '「)」'
      case 'ident':
        return `标识符「${tok.value}」`
      case 'string':
        return `字符串「${tok.value}」`
      case 'eof':
        return '表达式结尾'
    }
  }
}

function buildPredicate(name: string, args: string[] | null): ParseEntryResult {
  const argc = args === null ? -1 : args.length
  const need0 = args === null || argc === 0
  const one = args !== null && argc === 1 ? args[0] : null

  switch (name) {
    case 'always':
      if (!need0) return arityError(name, '不接受参数')
      return { ok: true, ast: { type: 'always' } }
    case 'no_open_blockers':
      if (!need0) return arityError(name, '不接受参数')
      return { ok: true, ast: { type: 'no_open_blockers' } }
    case 'last_run_succeeded':
      if (!need0) return arityError(name, '不接受参数')
      return { ok: true, ast: { type: 'last_run_succeeded' } }
    case 'has_body_section':
      if (one === null) {
        return {
          ok: false,
          error: '谓词 has_body_section 需要一个章节名，例如 has_body_section("复现步骤")。',
        }
      }
      return { ok: true, ast: { type: 'has_body_section', name: one } }
    case 'has_label':
      if (one === null) {
        return {
          ok: false,
          error: '谓词 has_label 需要一个标签名，例如 has_label("已确认")。',
        }
      }
      return { ok: true, ast: { type: 'has_label', name: one } }
    case 'has_comment_from':
      if (one === null) {
        return {
          ok: false,
          error: '谓词 has_comment_from 需要角色参数 human、agent 或 system。',
        }
      }
      if (!AUTHOR_KIND_SET.has(one)) {
        return {
          ok: false,
          error: `has_comment_from 的参数必须是 human、agent 或 system，不能是「${one}」。`,
        }
      }
      return { ok: true, ast: { type: 'has_comment_from', actorKind: one as AuthorKind } }
    case 'priority_at_least':
      if (one === null) {
        return {
          ok: false,
          error: '谓词 priority_at_least 需要优先级参数 P0、P1、P2 或 P3。',
        }
      }
      if (!PRIORITY_SET.has(one)) {
        return {
          ok: false,
          error: `priority_at_least 的参数必须是 P0、P1、P2 或 P3，不能是「${one}」。`,
        }
      }
      return { ok: true, ast: { type: 'priority_at_least', priority: one as TicketPriority } }
    default:
      return {
        ok: false,
        error: `未知谓词「${name}」。可用：always、no_open_blockers、has_body_section、has_label、has_comment_from、priority_at_least、last_run_succeeded。`,
      }
  }
}

function arityError(name: string, hint: string): ParseEntryResult {
  return { ok: false, error: `谓词 ${name} ${hint}。` }
}

/**
 * 解析准入条件。空 / 只空白 / null / undefined 视为无条件放行(always)。
 * 失败时 error 是给人看的中文,可直接显示在阶段配置界面。
 */
export function parseEntryCondition(expr: string | null | undefined): ParseEntryResult {
  if (expr == null || expr.trim() === '') {
    return { ok: true, ast: { type: 'always' } }
  }
  const lexed = lex(expr)
  if (lexed.error) return { ok: false, error: lexed.error }
  return new Parser(lexed.tokens).parse()
}

// ── 求值 ────────────────────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm

function hasBodySection(body: string, name: string): boolean {
  HEADING_RE.lastIndex = 0
  let m: RegExpExecArray | null = HEADING_RE.exec(body)
  while (m) {
    const title = m[2].replace(/\s+#*$/, '').trim()
    if (title === name) return true
    m = HEADING_RE.exec(body)
  }
  return false
}

export function evaluateEntryCondition(ast: EntryAst, ctx: EntryConditionContext): boolean {
  switch (ast.type) {
    case 'always':
      return true
    case 'not':
      return !evaluateEntryCondition(ast.of, ctx)
    case 'and':
      return evaluateEntryCondition(ast.left, ctx) && evaluateEntryCondition(ast.right, ctx)
    case 'or':
      return evaluateEntryCondition(ast.left, ctx) || evaluateEntryCondition(ast.right, ctx)
    case 'no_open_blockers':
      return !ctx.hasOpenBlockers
    case 'last_run_succeeded':
      return ctx.lastRunSucceeded === true
    case 'has_body_section':
      return hasBodySection(ctx.body, ast.name)
    case 'has_label':
      return ctx.labels.includes(ast.name)
    case 'has_comment_from':
      return ctx.commentAuthorKinds.includes(ast.actorKind)
    case 'priority_at_least':
      return PRIORITY_RANK[ctx.priority] <= PRIORITY_RANK[ast.priority]
  }
}
