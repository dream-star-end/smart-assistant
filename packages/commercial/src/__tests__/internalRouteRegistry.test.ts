/**
 * 内部路由注册表(protocol internalRoutes.ts)一致性 contract test。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/internalRouteRegistry.test.ts
 *
 * 拦的事故形态(send_to_agent、delegate grok-route 都真实发生过):新增/改动
 * 容器→master 内部路由时,gateway 调用方、egress forwarder 例外、master
 * dispatchInternal 挂载三处手写同一路径,漏一处 = 线上 403/404。三道门:
 *
 *   a. 扫 packages/gateway/src(生产源码,不含 __tests__ —— 测试文件里有故意
 *      拼错的路径与带 query 的样例,不属于漂移面)里所有 `/internal/v3|v5/...`
 *      字符串字面量,断言每条都被注册表覆盖(exact 命中或落在 prefix 条目下)。
 *   b. egress forwarder 的 v5 放行例外集合与注册表 `egressForwardException`
 *      标记一致(deny-by-default 语义本身由 egressSplit.test.ts 行为级锁定)。
 *   c. 注册表里每条 v5 放行例外在 master dispatchInternal 源码中有挂载引用
 *      (文本扫描;挂载缺失 = 放行了却 404,正是 grok-route 事故的另一半)。
 *
 * 风格参照 containerRouteInventory(源码扫描 + fail-loud 下界哨兵)与
 * egressSplit.test.ts(index.ts 锚点切片)。
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DELEGATE_GROK_ROUTE_MINT_PATH,
  DELEGATE_GROK_ROUTE_RELEASE_PATH,
  DELEGATE_GROK_ROUTE_RENEW_PATH,
  EGRESS_FORWARD_EXCEPTION_PATHS,
  INTERNAL_ROUTES,
  type InternalRouteEntry,
  isDelegateGrokRoutePath,
  isRegisteredInternalPath,
} from '@openclaude/protocol'

/** 宽化到接口类型:`as const` 联合上不能访问可选标记字段。 */
const registryEntries: readonly InternalRouteEntry[] = INTERNAL_ROUTES

const here = dirname(fileURLToPath(import.meta.url))
const gatewaySrcDir = join(here, '..', '..', '..', 'gateway', 'src')
const forwarderPath = join(here, '..', 'egress', 'forwarder.ts')
const indexPath = join(here, '..', 'index.ts')

/** 递归列出 gateway 生产源码文件(跳过 __tests__;漂移面只在生产代码)。 */
async function listGatewaySources(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listGatewaySources(full)))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

interface FoundLiteral {
  readonly file: string
  readonly line: number
  readonly literal: string
}

/**
 * 抓一个源文件里的 `/internal/v3|v5/...` 字符串字面量。
 *
 * 锚定引号/反引号/`}`(模板 `${expr}` 续段,如 ocMarketCli 的
 * `` `${base}/internal/v3/marketplace/agent` ``):只认字符串字面量形态,注释
 * 散文(中文标点/花括号缩写)没有这些锚,自然排除;注释里反引号包住的路径
 * 引用会被算进来 —— 它们同样应指向注册过的路径。**不做注释剥除**:字符串里
 * 合法出现的 `/*`(glob 等)会把朴素剥除器打瞎,反而吞掉真代码(server.ts
 * 实测)。字符类只认路径合法字符,模板字面量在 `${` 处自然截断(静态前缀
 * 足以做覆盖判定,如 grokAdapter 的 `/internal/v5/grok-relay/route/${token}/v1`)。
 */
function scanInternalLiterals(file: string, source: string): FoundLiteral[] {
  const found: FoundLiteral[] = []
  const re = /['"`}](\/internal\/v[35]\/[A-Za-z0-9/_-]*)/g
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(re)) {
      found.push({ file, line: i + 1, literal: m[1]! })
    }
  }
  return found
}

/**
 * 覆盖判定:注册表直接命中,或补尾斜杠后命中 prefix 条目(调用方拼
 * `${base}/sub` 时 base 不带尾斜杠,如 ocMarketCli 的 marketplace/agent)。
 */
function isCovered(literal: string): boolean {
  return isRegisteredInternalPath(literal) || isRegisteredInternalPath(`${literal}/`)
}

// ── a. gateway 生产源码扫描:每条 /internal/* 字面量都必须在注册表 ────────────

describe('internalRouteRegistry — gateway 字面量扫描', () => {
  test('gateway/src 生产代码里的每条 /internal/v3|v5 字面量都被注册表覆盖', async () => {
    const files = await listGatewaySources(gatewaySrcDir)
    assert.ok(files.length > 50, `gateway 源码文件数异常(${files.length}),扫描目录可能错了`)

    const found: FoundLiteral[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      found.push(...scanInternalLiterals(relative(gatewaySrcDir, file), source))
    }

    // 下界哨兵:refactor 后 gateway 生产源码仍保有 server.ts if 链等 10+ 处字面量
    // (2026-08-25 实测)。归零 = 扫描正则被打瞎,必须红,不许在空集合上通过。
    assert.ok(
      found.length >= 10,
      `gateway /internal/* 字面量只扫到 ${found.length} 条(低于历史下界 10),扫描器可能失效`,
    )

    const offenders = found.filter((f) => {
      // 裸平面前缀(如 server.ts 的 startsWith('/internal/v3/') 鉴权兜底判定)
      // 是结构判定,不是一条路由。
      if (f.literal === '/internal/v3/' || f.literal === '/internal/v5/') return false
      return !isCovered(f.literal)
    })
    assert.deepEqual(
      offenders,
      [],
      `发现未登记进 protocol internalRoutes.ts 注册表的 /internal/* 字面量:\n` +
        offenders.map((f) => `  ${f.file}:${f.line} ${f.literal}`).join('\n') +
        `\n修法:把该路径(含 plane/egress 语义标记与 sources)登记进注册表,` +
        `不要为了变绿而在本测试里加排除。`,
    )
  })

  test('注册表自身不变量:路径唯一、plane 与路径前缀一致、例外标记只出现在 v5', () => {
    const seen = new Set<string>()
    for (const entry of registryEntries) {
      assert.ok(!seen.has(entry.path), `注册表路径重复:${entry.path}`)
      seen.add(entry.path)
      assert.ok(
        entry.path.startsWith(`/internal/${entry.plane}/`),
        `${entry.path} 的 plane 标记(${entry.plane})与路径前缀不符`,
      )
      if (entry.egressForwardException) {
        assert.equal(entry.plane, 'v5', `${entry.path}:v3 默认全转,forward 例外标记只对 v5 有意义`)
        assert.equal(entry.match, 'exact', `${entry.path}:forwarder 例外必须是精确路径(前缀放行会扩大伪造面)`)
      }
    }
  })
})

// ── b. forwarder 的 v5 放行例外集合与注册表一致 ─────────────────────────────

describe('internalRouteRegistry — egress forwarder v5 例外一致性', () => {
  test('注册表例外集合 === delegate grok-route 三条,且与 isDelegateGrokRoutePath 同源', () => {
    assert.deepEqual(
      [...EGRESS_FORWARD_EXCEPTION_PATHS].sort(),
      [
        DELEGATE_GROK_ROUTE_MINT_PATH,
        DELEGATE_GROK_ROUTE_RELEASE_PATH,
        DELEGATE_GROK_ROUTE_RENEW_PATH,
      ].sort(),
    )
    for (const entry of registryEntries) {
      if (entry.plane !== 'v5') continue
      if (entry.match === 'exact') {
        assert.equal(
          isDelegateGrokRoutePath(entry.path),
          entry.egressForwardException === true,
          `${entry.path}:forwarder 例外判定与注册表 egressForwardException 标记不一致`,
        )
      } else {
        // v5 prefix 条目(grok/zcode relay)是 egress 本地截胡面,绝不能是转发例外。
        assert.ok(!entry.egressForwardException, `${entry.path}:prefix 条目不允许作为 forwarder 例外`)
        assert.ok(
          !isDelegateGrokRoutePath(`${entry.path}/route/x`),
          `${entry.path}:isDelegateGrokRoutePath 不应放行 relay 前缀下的路径`,
        )
      }
    }
  })

  test('forwarder 源码结构:v5 deny-by-default + 唯一例外走注册表同源判定', async () => {
    const source = await readFile(forwarderPath, 'utf8')
    assert.match(
      source,
      /CONTROL_ONLY_PREFIX = "\/internal\/v5\/"/,
      'forwarder 的 v5 控制面前缀被改动 —— 这是安全语义,改它必须同步注册表与本测试',
    )
    assert.match(
      source,
      /isDelegateGrokRoutePath/,
      'forwarder 不再引用 isDelegateGrokRoutePath —— v5 例外清单脱离注册表同源',
    )
    // 确认没有第二套手写例外(出现其他 /internal/v5/... 字面量 = 有人绕开注册表加例外)。
    const literals = scanInternalLiterals('egress/forwarder.ts', source)
      .map((f) => f.literal)
      .filter((l) => l.startsWith('/internal/v5/') && l !== '/internal/v5/')
    assert.deepEqual(
      literals.filter((l) => !isCovered(l)),
      [],
      'forwarder 出现未登记的 /internal/v5 字面量(疑似手写例外)',
    )
  })
})

// ── c. 每条 v5 例外在 master dispatchInternal 有挂载引用 ────────────────────

describe('internalRouteRegistry — dispatchInternal 挂载', () => {
  test('注册表每条 v5 forward 例外在 dispatchInternal 源码中有挂载引用', async () => {
    const source = await readFile(indexPath, 'utf8')
    const start = source.indexOf('dispatchInternal = (req, res, ctx)')
    assert.ok(start >= 0, 'index.ts 里找不到 dispatchInternal 装配锚点(写法改了请更新本测试)')
    const end = source.indexOf('// ── P3 控制口只读端点', start)
    assert.ok(end > start, 'dispatchInternal 切片终点锚点失效(P3 控制口注释被改动)')
    const dispatch = source.slice(start, end)

    for (const path of EGRESS_FORWARD_EXCEPTION_PATHS) {
      // 当前三条例外都经 isDelegateGrokRoutePath 单点挂载;若未来加入非 grok-route
      // 例外,必须在这里登记它的挂载引用方式,而不是放宽断言。
      assert.ok(
        isDelegateGrokRoutePath(path),
        `${path}:新 v5 例外的 dispatchInternal 挂载引用方式未登记进本测试`,
      )
    }
    assert.match(
      dispatch,
      /isDelegateGrokRoutePath\(path\)/,
      'dispatchInternal 里没有 delegate grok-route 的挂载引用(放行了 forwarder 却 404 —— 事故形态复现)',
    )
    // selfhost 门控事实:挂载 handler 的装配受 OC_SELFHOST_ENGINE_LOCAL_TURNS=1 门控。
    const gateIdx = source.indexOf('const delegateGrokRouteHandler')
    assert.ok(gateIdx >= 0 && gateIdx < start, 'delegateGrokRouteHandler 装配点丢失')
    assert.match(
      source.slice(gateIdx, gateIdx + 400),
      /OC_SELFHOST_ENGINE_LOCAL_TURNS === "1"/,
      'delegate grok-route 挂载的 selfhost 门控被改动(注册表 selfhostOnly 标记随之失真)',
    )
    for (const entry of registryEntries) {
      if (entry.selfhostOnly) {
        assert.ok(
          isDelegateGrokRoutePath(entry.path),
          `${entry.path}:标记了 selfhostOnly 但本测试不知道它的门控在哪 —— 请登记`,
        )
      }
    }
  })
})
