/**
 * 容器侧(personal gateway)`/api/*` 路由清单的**可枚举投影** + 宿主 deny 面解析。
 *
 * 为什么需要它:容器路由生效面与商业宿主的 `BRIDGE_API_ALLOWLIST` 是"两处分开写"的
 * 典型漂移面 —— 容器加了新端点、前端开始调用,而宿主 allowlist 没登记 →
 * `matchCommercialContainerApiProxy` 不认领 → 请求落到 router 的 `__unmatched__`
 * 返 404,用户侧表现为"面板一片空白/按钮点了没反应"。2026-07-23 的 #201
 * (auto-dream optimizer 三条路由)就是这个形态。
 *
 * server.ts 的容器路由是一条巨大的 if 链(不是声明式 Route[] 数组),没有运行时可读的
 * 注册表可 import,所以这里解析**分发点源码**。解析对象是三种分发形态本身:
 *   ① `url.pathname === '/api/x'`
 *   ② `url.pathname.startsWith('/api/x/')`
 *   ③ `url.pathname.match(/^\/api\/…$/)`(允许换行)
 * 这些形态是"路由如何被声明"的结构事实,不是 handler 实现细节 —— 改 handler 名/顺序/
 * 注释都不影响本文件;只有"增删一条容器 API 路由"才会改变结果,那正是要拦的事件。
 *
 * ── 样例路径合成(以及为什么可信)────────────────────────────────────────────────
 * 家族闭包判定需要把正则变成一条具体路径去喂 allowlist 匹配器。合成器只认一小撮受支持的
 * 正则构造,遇到没见过的构造**立刻抛错**(而不是猜),并且每条合成出来的样例都要用原正则
 * 自校验一遍 —— 我们绝不会拿一条"容器根本不接受的路径"去做断言。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '..', '..', '..', '..', 'gateway', 'src', 'server.ts')
const routerPath = join(here, '..', '..', 'http', 'router.ts')

export interface ContainerRoute {
  /** 分发形态。 */
  readonly kind: 'exact' | 'prefix' | 'regex'
  /** 源码里写的东西(字面量路径或正则 source),用于报错定位。 */
  readonly declared: string
  /** 一条确定满足该路由的具体路径(regex 形态经自校验)。 */
  readonly sample: string
  /** server.ts 行号(1-based),报错时人能直接跳过去。 */
  readonly line: number
}

/** 合成器不认识的正则构造 → fail loud,禁止静默降级。 */
class UnsupportedRegexConstruct extends Error {
  constructor(src: string, at: number, why: string) {
    super(
      `[containerRouteInventory] 无法为容器路由正则合成样例路径:${why}` +
        `(位置 ${at},正则 ${src})。修法:扩展本文件的 synthesizeFromRegexSource` +
        `以支持该构造 —— 绝不要为了让门变绿而跳过这条路由。`,
    )
  }
}

/** 在字符类里挑一个满足它的字符;挑不到就 fail loud。 */
function pickCharForClass(classBody: string): string {
  const re = new RegExp(`^[${classBody}]$`)
  for (const candidate of ['a', 'b', '0', '1', 'x', 'z', '_', '-', '.']) {
    if (re.test(candidate)) return candidate
  }
  throw new Error(
    `[containerRouteInventory] 字符类 [${classBody}] 无法从候选集挑出样例字符;` +
      '请在 pickCharForClass 补候选。',
  )
}

/**
 * 受限正则 → 样例字符串。
 *
 * 支持:锚点 ^ $、转义字面量 \/ \. 等、普通字面量、字符类 [...] + 量词(+ * {n} {n,} {n,m})、
 * 分组 (...)(含 |,取第一个分支)。其余一律抛 UnsupportedRegexConstruct。
 */
function synthesizeFromRegexSource(src: string): string {
  let i = 0

  /** 读一个量词,返回"至少要重复几次"(无量词 = 1)。 */
  function readMinRepeat(): number {
    const c = src[i]
    if (c === '+') {
      i++
      return 1
    }
    if (c === '*') {
      i++
      // 0 次也合法,但取 1 次能让样例更像真实路径段(且仍满足正则)。
      return 1
    }
    if (c === '?') throw new UnsupportedRegexConstruct(src, i, '可选量词 ? 语义不唯一')
    if (c === '{') {
      const close = src.indexOf('}', i)
      if (close < 0) throw new UnsupportedRegexConstruct(src, i, '{ 未闭合')
      const body = src.slice(i + 1, close)
      const m = /^(\d+)(?:,(\d*))?$/.exec(body)
      if (!m) throw new UnsupportedRegexConstruct(src, i, `无法解析量词 {${body}}`)
      i = close + 1
      return Number(m[1])
    }
    return 1
  }

  function parseSequence(insideGroup: boolean): string {
    let out = ''
    while (i < src.length) {
      const c = src[i]!
      if (c === '^' || c === '$') {
        i++
        continue
      }
      if (c === '|' || c === ')') {
        if (insideGroup) return out
        throw new UnsupportedRegexConstruct(src, i, `顶层出现 ${c}`)
      }
      if (c === '(') {
        i++
        // 非捕获/前瞻等前缀一律不支持 —— 容器路由里只有普通捕获组。
        if (src[i] === '?') throw new UnsupportedRegexConstruct(src, i, '(?…) 特殊分组')
        const first = parseSequence(true)
        // 跳到本组结束(丢弃其余分支)。
        let depth = 1
        while (i < src.length && depth > 0) {
          const ch = src[i]
          if (ch === '\\') {
            i += 2
            continue
          }
          if (ch === '(') depth++
          else if (ch === ')') depth--
          i++
        }
        if (depth !== 0) throw new UnsupportedRegexConstruct(src, i, '( 未闭合')
        const times = readMinRepeat()
        out += first.repeat(times)
        continue
      }
      if (c === '[') {
        let j = i + 1
        if (src[j] === '^') j++
        if (src[j] === ']') j++
        while (j < src.length && src[j] !== ']') {
          if (src[j] === '\\') j++
          j++
        }
        if (j >= src.length) throw new UnsupportedRegexConstruct(src, i, '[ 未闭合')
        const body = src.slice(i + 1, j)
        i = j + 1
        const times = readMinRepeat()
        out += pickCharForClass(body).repeat(times)
        continue
      }
      if (c === '\\') {
        const escaped = src[i + 1]
        if (escaped === undefined) throw new UnsupportedRegexConstruct(src, i, '悬空反斜杠')
        i += 2
        if (escaped === 'd') {
          out += '0'.repeat(readMinRepeat())
          continue
        }
        if (escaped === 'w') {
          out += 'a'.repeat(readMinRepeat())
          continue
        }
        // \/ \. \- 等 → 字面量本身
        out += escaped.repeat(readMinRepeat())
        continue
      }
      if (c === '.') {
        i++
        out += 'a'.repeat(readMinRepeat())
        continue
      }
      if (/[A-Za-z0-9_/:-]/.test(c)) {
        i++
        out += c.repeat(readMinRepeat())
        continue
      }
      throw new UnsupportedRegexConstruct(src, i, `未支持的字符 ${JSON.stringify(c)}`)
    }
    if (insideGroup) throw new UnsupportedRegexConstruct(src, i, '分组在字符串结束前未闭合')
    return out
  }

  const sample = parseSequence(false)
  // 自校验:合成出来的路径必须真的被原正则接受,否则后续断言全是空转。
  if (!new RegExp(src).test(sample)) {
    throw new Error(
      `[containerRouteInventory] 合成的样例 ${JSON.stringify(sample)} 不满足正则 ${src};` +
        '合成器有 bug,拒绝在不可信样例上做断言。',
    )
  }
  return sample
}

/** 导出仅供合成器自身的单测使用。 */
export const __synthesizeFromRegexSource = synthesizeFromRegexSource

/**
 * 扫 server.ts 的三种分发形态,返回容器侧 `/api/*` 路由清单。
 *
 * fail-loud:抓到的条数低于历史下界 → 抛错(正则被格式改动打瞎时必须红,而不是让
 * "家族闭包成立"在一个空清单上轻松通过)。
 */
export async function readContainerApiRoutes(): Promise<ContainerRoute[]> {
  const source = await readFile(serverPath, 'utf8')
  const lineStarts: number[] = [0]
  for (let k = 0; k < source.length; k++) if (source[k] === '\n') lineStarts.push(k + 1)
  const lineOf = (index: number): number => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  const routes: ContainerRoute[] = []
  const seen = new Set<string>()
  const push = (r: ContainerRoute) => {
    const key = `${r.kind} ${r.declared}`
    if (seen.has(key)) return
    seen.add(key)
    routes.push(r)
  }

  // ① url.pathname === '/api/x'
  for (const m of source.matchAll(/url\.pathname === '(\/api\/[^']*)'/g)) {
    push({ kind: 'exact', declared: m[1]!, sample: m[1]!, line: lineOf(m.index!) })
  }
  // ② url.pathname.startsWith('/api/x/') —— 裸 '/api/' 是鉴权兜底判定,不是路由。
  for (const m of source.matchAll(/url\.pathname\.startsWith\('(\/api\/[^']*)'\)/g)) {
    const prefix = m[1]!
    if (prefix === '/api/') continue
    push({ kind: 'prefix', declared: prefix, sample: `${prefix}sample`, line: lineOf(m.index!) })
  }
  // ③ url.pathname.match(/^\/api\/…$/) —— 正则可能换行落在下一行。
  const matchRe = /url\.pathname\.match\(\s*\/(\^\\\/api\\\/[^\n]*?)\/[a-z]*\s*[,)]/g
  for (const m of source.matchAll(matchRe)) {
    const src = m[1]!
    push({
      kind: 'regex',
      declared: src,
      sample: synthesizeFromRegexSource(src),
      line: lineOf(m.index!),
    })
  }

  // 下界哨兵:2026-07-26 实测 exact 30 / prefix 1 / regex 30 条。任一形态归零 = 正则瞎了。
  const counts = {
    exact: routes.filter((r) => r.kind === 'exact').length,
    prefix: routes.filter((r) => r.kind === 'prefix').length,
    regex: routes.filter((r) => r.kind === 'regex').length,
  }
  if (counts.exact < 20 || counts.prefix < 1 || counts.regex < 20) {
    throw new Error(
      `[containerRouteInventory] 容器路由抽取结果异常(exact=${counts.exact} ` +
        `prefix=${counts.prefix} regex=${counts.regex},低于历史下界 20/1/20)。` +
        `server.ts 的分发写法可能改了 —— 请更新抽取正则,不要放低下界。`,
    )
  }
  return routes
}

/** 路径家族 = 前两段(`/api/agents/x/y` → `/api/agents`)。 */
export function routeFamily(path: string): string {
  const seg = path.split('/').filter(Boolean)
  return `/${seg.slice(0, 2).join('/')}`
}

/**
 * 取 commercial router 的 `BLOCKED_FOR_USER_RULES` 里所有 `re:` 正则。
 *
 * 这是"宿主明确拒绝把该路径交给普通用户"的**声明面**(第三个权威源)。容器里存在、
 * 但既没进 bridge allowlist 也没进这里 = 没人对它表过态。
 *
 * 注:正则字面量里可能出现未转义的 `/`(如 `[^/]`),所以扫描要认字符类,不能拿
 * 粗正则去切。
 */
export async function readBlockedForUserPatterns(): Promise<RegExp[]> {
  const source = await readFile(routerPath, 'utf8')
  const marker = 'const BLOCKED_FOR_USER_RULES: readonly BlockedForUserRule[] = ['
  const start = source.indexOf(marker)
  if (start < 0) {
    throw new Error(
      `[containerRouteInventory] router.ts 缺少 ${marker} —— deny 面锚点失效,` +
        '拒绝在读不到 deny 清单的前提下判定"没人表过态"。',
    )
  }
  // 配平方括号找数组结尾。起点必须是 marker 末尾那个 `[` —— 不能用 indexOf('[')
  // 去找,那会先撞上类型标注 `BlockedForUserRule[]` 里的空方括号并立刻"闭合"。
  const arrayOpen = start + marker.length - 1
  if (source[arrayOpen] !== '[') {
    throw new Error('[containerRouteInventory] BLOCKED_FOR_USER_RULES 锚点末尾不是 `[`')
  }
  let depth = 0
  let end = -1
  for (let k = arrayOpen; k < source.length; k++) {
    const ch = source[k]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        end = k
        break
      }
    }
  }
  if (end < 0) throw new Error('[containerRouteInventory] BLOCKED_FOR_USER_RULES 数组未闭合')
  const block = source.slice(start, end + 1)

  const patterns: RegExp[] = []
  for (let k = 0; k < block.length; k++) {
    if (!block.startsWith('re: /', k)) continue
    let p = k + 're: /'.length
    let inClass = false
    let body = ''
    for (; p < block.length; p++) {
      const ch = block[p]!
      if (ch === '\\') {
        body += ch + (block[p + 1] ?? '')
        p++
        continue
      }
      if (ch === '[') inClass = true
      else if (ch === ']') inClass = false
      else if (ch === '/' && !inClass) break
      body += ch
    }
    patterns.push(new RegExp(body))
  }
  // 下界哨兵:2026-07-26 实测 40+ 条。解析退化必须红。
  if (patterns.length < 30) {
    throw new Error(
      `[containerRouteInventory] BLOCKED_FOR_USER_RULES 只解析到 ${patterns.length} 条` +
        '(低于历史下界 30),扫描器可能被格式改动打瞎。',
    )
  }
  return patterns
}
