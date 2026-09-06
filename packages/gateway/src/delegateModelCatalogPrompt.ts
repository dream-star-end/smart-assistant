/**
 * 「委派可用型号」prompt 段:把当前 per-uid catalog 投影里可路由的型号 slug 按 engine
 * 列给模型,让它填 `model` 时不再靠猜(`gpt-6` ≠ `gpt-6-astra`)。
 *
 * 设计约束(评审结论):
 *  - **精确 slug,不做笛卡尔积压缩**:cursor 家族用 brace 展开式表达,但展开集合必须
 *    与真实集合逐个相等(`renderCursorFamilies` 按「同家族下 非-fast 档位集 / -fast 档位集」
 *    分别枚举,两集相等才合写 `[-fast]`);解析不出档位的 slug 原样列出。
 *  - 与服务端校验同源:输入就是 `LocalCatalogView.models`(master 已按 uid 过滤),只保留
 *    `available === true`(= `isRoutable`)。
 *  - 标注快照来源(在线核验 / 仅本地缓存)与 projectionRevision,并声明「调用时服务端仍会
 *    重新校验」—— 这段只是发现用,不是授权。
 *  - 没有投影时**不静默消失**:给一行提示,让模型知道去哪确认。
 */
import type { LocalCatalogModel } from './modelCatalogClient.js'

export const DELEGATE_MODEL_SECTION_HEADING = '## 委派可用型号'

const CURSOR_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type CursorEffort = (typeof CURSOR_EFFORTS)[number]
const EFFORT_ORDER = new Map<string, number>(CURSOR_EFFORTS.map((e, i) => [e, i]))

const ENGINE_ORDER: readonly LocalCatalogModel['engine'][] = ['ccb', 'codex', 'grok', 'cursor', 'zcode']
const ENGINE_LABEL: Record<LocalCatalogModel['engine'], string> = {
  ccb: 'CCB',
  codex: 'Codex',
  grok: 'Grok',
  cursor: 'Cursor',
  zcode: 'ZCode',
}

export interface DelegateModelSectionInput {
  models: readonly Pick<LocalCatalogModel, 'modelId' | 'engine' | 'available'>[]
  projectionRevision: string
  /** >0 = 已在线核验过的内存快照;0 = 只读到本地 LKG 缓存。 */
  verifiedAt: number
}

interface ParsedCursorSlug {
  family: string
  effort: CursorEffort
  fast: boolean
}

/** `cursor-opus-5-high-fast` → { family: 'cursor-opus-5', effort: 'high', fast: true };解析失败 → null。 */
export function parseCursorSlug(slug: string): ParsedCursorSlug | null {
  if (!slug.startsWith('cursor-')) return null
  let rest = slug
  let fast = false
  if (rest.endsWith('-fast')) {
    fast = true
    rest = rest.slice(0, -'-fast'.length)
  }
  const idx = rest.lastIndexOf('-')
  if (idx <= 0) return null
  const effort = rest.slice(idx + 1)
  const family = rest.slice(0, idx)
  if (!EFFORT_ORDER.has(effort) || family === 'cursor') return null
  return { family, effort: effort as CursorEffort, fast }
}

function sortEfforts(set: ReadonlySet<CursorEffort>): CursorEffort[] {
  return [...set].sort((a, b) => (EFFORT_ORDER.get(a) ?? 99) - (EFFORT_ORDER.get(b) ?? 99))
}

function brace(family: string, efforts: readonly CursorEffort[], suffix: string): string {
  if (efforts.length === 1) return `${family}-${efforts[0]}${suffix}`
  return `${family}-{${efforts.join(',')}}${suffix}`
}

/**
 * 把 cursor slug 列表压成若干 brace 表达式,**展开后与输入集合逐个相等**。
 * 返回值每一项都是一个可精确展开的模式(或原样 slug)。
 */
export function renderCursorFamilies(slugs: readonly string[]): string[] {
  const families = new Map<string, { plain: Set<CursorEffort>; fast: Set<CursorEffort> }>()
  const verbatim: string[] = []
  for (const slug of slugs) {
    const parsed = parseCursorSlug(slug)
    if (!parsed) {
      verbatim.push(slug)
      continue
    }
    let entry = families.get(parsed.family)
    if (!entry) {
      entry = { plain: new Set(), fast: new Set() }
      families.set(parsed.family, entry)
    }
    ;(parsed.fast ? entry.fast : entry.plain).add(parsed.effort)
  }
  const out: string[] = []
  for (const family of [...families.keys()].sort()) {
    const { plain, fast } = families.get(family)!
    const plainSorted = sortEfforts(plain)
    const fastSorted = sortEfforts(fast)
    const same =
      plainSorted.length === fastSorted.length && plainSorted.every((e, i) => e === fastSorted[i])
    if (same && plainSorted.length > 0) {
      out.push(`${brace(family, plainSorted, '')}[-fast]`)
      continue
    }
    if (plainSorted.length > 0) out.push(brace(family, plainSorted, ''))
    if (fastSorted.length > 0) out.push(brace(family, fastSorted, '-fast'))
  }
  out.push(...verbatim.sort())
  return out
}

/**
 * 测试/自检用:把 `renderCursorFamilies` 的输出展开回 slug 集合。
 * 语法仅支持本文件产出的形态:`family-{a,b}[-fast]` / `family-{a,b}-fast` / `family-a` / 原样。
 */
export function expandCursorPatterns(patterns: readonly string[]): string[] {
  const out: string[] = []
  for (const p of patterns) {
    let base = p
    let optionalFast = false
    if (base.endsWith('[-fast]')) {
      optionalFast = true
      base = base.slice(0, -'[-fast]'.length)
    }
    const m = /^(.*)-\{([^}]+)\}(-fast)?$/.exec(base)
    const variants: string[] = []
    if (m) {
      for (const e of m[2].split(',')) variants.push(`${m[1]}-${e}${m[3] ?? ''}`)
    } else {
      variants.push(base)
    }
    for (const v of variants) {
      out.push(v)
      if (optionalFast) out.push(`${v}-fast`)
    }
  }
  return out
}

/** 没有任何投影(内存 + LKG 都没有)时的提示行:不静默消失,告诉模型去哪确认。 */
export const DELEGATE_MODEL_SECTION_UNAVAILABLE = [
  DELEGATE_MODEL_SECTION_HEADING,
  '',
  '当前拿不到模型 catalog 投影,委派时不要填 `model`(留空用成员绑定型号);显式型号会由服务端校验,填错返回 `DELEGATE_MODEL_UNKNOWN` 并附候选。',
].join('\n')

export function renderDelegateModelSection(input: DelegateModelSectionInput): string {
  const byEngine = new Map<LocalCatalogModel['engine'], string[]>()
  for (const m of input.models) {
    if (m.available !== true) continue
    const list = byEngine.get(m.engine) ?? []
    list.push(m.modelId)
    byEngine.set(m.engine, list)
  }
  const lines: string[] = [DELEGATE_MODEL_SECTION_HEADING, '']
  const state = input.verifiedAt > 0 ? '已在线核验' : '仅本地缓存,可能滞后'
  lines.push(
    `以下是你这个账号当前可委派的 catalog 型号 slug(投影 ${input.projectionRevision},${state});\`model\`/\`--model\` 只能填这里的精确值,调用时服务端仍会重新校验。\`{a,b}\` 表示逐个可选,\`[-fast]\` 表示每个档位另有 \`-fast\` 变体;没写的组合就是不存在。`,
  )
  let any = false
  for (const engine of ENGINE_ORDER) {
    const slugs = byEngine.get(engine)
    if (!slugs || slugs.length === 0) continue
    any = true
    const rendered = engine === 'cursor' ? renderCursorFamilies(slugs) : [...slugs].sort()
    lines.push(`- ${ENGINE_LABEL[engine]}: ${rendered.map((s) => `\`${s}\``).join(', ')}`)
  }
  if (!any) {
    lines.push('- (投影里当前没有可用型号;委派时不要填 `model`)')
  }
  return lines.join('\n')
}

/**
 * 给 DELEGATE_MODEL_UNKNOWN 错误挑候选:先前缀/包含,再编辑距离;只从**可路由**集合里挑
 * (不泄露不可用/无权限型号)。最多 `limit` 个;找不到近邻返回空数组(调用方引导查列表)。
 */
export function suggestDelegateModels(
  raw: string,
  models: readonly Pick<LocalCatalogModel, 'modelId' | 'available'>[],
  limit = 3,
): string[] {
  const needle = raw.trim().toLowerCase()
  if (!needle) return []
  const pool = models.filter((m) => m.available === true).map((m) => m.modelId)
  const scored: { id: string; score: number }[] = []
  for (const id of pool) {
    const hay = id.toLowerCase()
    let score: number
    if (hay === needle) score = 0
    else if (hay.startsWith(needle)) score = 1
    else if (hay.includes(needle) || needle.includes(hay)) score = 2
    else {
      const d = levenshtein(needle, hay)
      // 编辑距离超过较短串长度一半就不算近邻
      if (d > Math.max(2, Math.floor(Math.min(needle.length, hay.length) / 2))) continue
      score = 3 + d
    }
    scored.push({ id, score })
  }
  scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
  return scored.slice(0, limit).map((s) => s.id)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}
