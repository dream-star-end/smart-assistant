/**
 * 契约测试共用的**错误码枚举权威**(gateway errorClassify 的产出值域)。
 *
 * 为什么需要它:`turnErrorTaxonomyContract` / `terminalErrorSurfaceMatrix` 这两个门
 * 的措辞都是全称量词("**所有**非 unknown 产出码 …"),但实现只能遍历自己列的样例 ——
 * 手工样例集与真实值域一漂,门就退化成"只证明了列出的那几个"。2026-07-26 门禁审计实测:
 * CLASSIFY_SAMPLES 只列了 4 条(insufficient_credits / rate_limited / model_capacity /
 * upstream_failed),而 errorClassify 实际产出 5 + delegate 专属 1 = 6 个非 unknown 码
 * ——`context_too_long` 与 `bad_request` 从未被任何门覆盖过。
 *
 * ── 为什么是源码解析而不是 import 一个运行时常量 ────────────────────────────────
 * `ClassifiedErrorCode` 当前是**纯类型 union**(编译期擦除),运行时没有对应的值。
 * 最优解是让 errorClassify.ts 导出 `CLASSIFIED_ERROR_CODES = [...] as const` 并由它
 * 派生类型(单一权威 + 运行时可枚举);本轮按文件所有权切分,测试目录之外不动,故先在
 * 此解析**声明面**(type union 的字面量),并对锚点缺失 fail-loud。锚点一旦被改写成
 * 其它形态(如 `typeof ARRAY[number]`),本文件会立刻红并提示改用运行时导出 —— 不会
 * 静默退化成空集(那才是最危险的假绿)。
 *
 * 解析对象是**声明的契约**(union 成员),不是实现细节:PATTERNS 的正则/顺序/文案怎么改
 * 都不影响本文件;只有"新增/删除一个错误码"才会改变结果 —— 那正是要拦的事件。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const errorClassifyPath = join(here, '..', '..', 'errorClassify.ts')

/** 解析失败时的统一报错(带修复指引,禁止静默返回空集)。 */
function anchorFailure(what: string): never {
  throw new Error(
    `[classifiedErrorCodes] 无法从 errorClassify.ts 解析 ${what} —— 契约锚点失效。` +
      `修法:若该声明已改形态,请改为从 errorClassify.ts 导出运行时码集合` +
      `(export const CLASSIFIED_ERROR_CODES = [...] as const)并让本 helper 直接 import 它。`,
  )
}

/** 取 `export type <name> = | 'a' | 'b'` 的字面量成员(到分号/空行为止)。 */
function parseUnionLiterals(source: string, marker: string): string[] {
  const start = source.indexOf(marker)
  if (start < 0) anchorFailure(marker)
  const rest = source.slice(start + marker.length)
  // union 声明以下一个顶层语句(空行 + 非缩进 token)或分号结束。两种写法都吃得下。
  const end = rest.search(/\n\s*\n|;\s*\n/)
  const block = end >= 0 ? rest.slice(0, end) : rest
  const literals = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
  if (literals.length === 0) anchorFailure(`${marker} 的 union 成员`)
  return literals
}

export interface ClassifiedErrorCodeInventory {
  /** classifyRunError 能产出的非 unknown 码(= ClassifiedErrorCode − 'unknown')。 */
  readonly classifyCodes: readonly string[]
  /** Delegate 输出分类器声明的额外码（当前值域已统一，因此为空）。 */
  readonly delegateOnlyCodes: readonly string[]
  /** 两者并集 —— gateway 侧一切 turn 级错误分类的完整非 unknown 值域。 */
  readonly allCodes: readonly string[]
}

/**
 * 读 errorClassify.ts 的声明面,返回完整非 unknown 码值域。
 *
 * fail-loud 保证:任一锚点缺失 / 解析出的码数少于历史下界 → 抛错(不返回可疑的小集合)。
 */
export async function readClassifiedErrorCodes(): Promise<ClassifiedErrorCodeInventory> {
  const source = await readFile(errorClassifyPath, 'utf8')

  const union = parseUnionLiterals(source, 'export type ClassifiedErrorCode =')
  const classifyCodes = union.filter((c) => c !== 'unknown')
  if (!union.includes('unknown')) {
    anchorFailure("ClassifiedErrorCode 的 'unknown' 兜底成员")
  }

  // Parse any future `code: ClassifiedErrorCode | '...'` delegate-only extension.
  const delegateMarker = 'export interface DelegateOutputError {'
  const delegateStart = source.indexOf(delegateMarker)
  if (delegateStart < 0) anchorFailure(delegateMarker)
  const delegateBlock = source.slice(delegateStart, delegateStart + 400)
  const codeLine = /\bcode:\s*ClassifiedErrorCode([^\n]*)/.exec(delegateBlock)
  if (!codeLine) anchorFailure('DelegateOutputError.code 的声明')
  const delegateOnlyCodes = [...codeLine[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)

  const allCodes = [...classifyCodes, ...delegateOnlyCodes]
  // 下界哨兵:2026-07-26 实测 5 + 1。解析退化(正则被格式改动打瞎)时必须红,
  // 而不是让"覆盖率 100%"在一个残缺的值域上轻松通过。
  if (classifyCodes.length < 5 || allCodes.length < 6) {
    anchorFailure(
      `足量码(解析到 classify=${classifyCodes.length} delegate=${delegateOnlyCodes.length},` +
        '低于历史下界 5+1)',
    )
  }
  return { classifyCodes, delegateOnlyCodes, allCodes }
}
