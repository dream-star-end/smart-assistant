/**
 * 容器路由 × 宿主代理白名单 **闭包契约**(#201 根治,照 routeOwnership 范式)。
 *
 * ── 它红了,用户会看到什么 ────────────────────────────────────────────────────
 * 容器(personal gateway)加了新 `/api/*` 端点、前端开始调它,但商业宿主的
 * `BRIDGE_API_ALLOWLIST` 没登记 → `matchCommercialContainerApiProxy` 不认领 →
 * 请求落到 commercial router 的 `__unmatched__` 返 404。用户侧就是"面板一片空白 /
 * 按钮点了没反应",后端日志里只有一条毫无线索的 404。
 * 2026-07-23 #201(auto-dream optimizer 三条路由)正是这个形态,上线后才由用户暴露。
 *
 * ── 契约 ─────────────────────────────────────────────────────────────────────
 * 权威源:
 *   A. 容器路由清单   = packages/gateway/src/server.ts 的分发点(解析所得)
 *   B. 代理认领面     = packages/gateway/src/bridgeApiAllowlist.ts(直接 import)
 *   C. 宿主 deny 面   = commercial router 的 BLOCKED_FOR_USER_RULES(解析所得)
 *
 * "家族" = 路径前两段(`/api/agents/x/y` → `/api/agents`)。一个家族只要有任意一条
 * 路由被 B 认领为可代理,就算**已对商业用户开放**。
 *
 *   ① 开放家族内的每条容器路由,必须有人明确表过态:
 *        · 被 B 认领 → 可代理;或
 *        · 登记在下面的 `NOT_PROXIED_ON_PURPOSE` 里 **且** 被 C 明确 deny。
 *      两者都不沾 = 没人表过态 → 红。
 *   ② 登记表卫生:登记项不得已经可代理(过期条目),也不得对应不上任何真实容器路由(幽灵条目)。
 *   ③ 反向:B 里每条规则都要能匹配到至少一条真实容器路由(不许有死规则)。
 *
 * ── 为什么"被 C deny"不能单独当作"故意不代理"的证据 ──────────────────────────
 * BLOCKED_FOR_USER_RULES 的语义是"**万一**打到 host singleton 就拒绝",它对可代理路由
 * 同样要写(#201 自己就是 allowlist 与 deny 两处一起加的,见 router.ts 里那三条的注释:
 * "正常请求先由 containerApiProxy 转发;这里全方法拦截仅作 host singleton 兜底")。
 * 所以 deny 面不携带"该不该代理"的信息,只能用来给"决定不代理"的路由补一道安全证明:
 * 不代理又不 deny 的路由会裸奔在 host singleton 上。
 *
 * ── 为什么用家族闭包而不是"全部容器路由 ⊆ allowlist" ─────────────────────────
 * `/api/config`、`/api/doctor`、`/api/usage` 这些整族都是 host-singleton 危险面,
 * 故意不代理;要求它们进 allowlist 是错的。家族闭包只在"这个家族已经开放"的前提下要求
 * 完备性 —— 拦住真正的漏登记,不制造噪音。
 *
 * 本门只判定**路径可达性**(不判 method):容器分发是 if 链,method 判定散在各 handler
 * 内部,无法从注册面可靠推导。路径漏登记正是 #201 的实际形态,也是 404 的来源。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { BRIDGE_API_ALLOWLIST, matchBridgeApiAllowlist } from '@openclaude/gateway'
import {
  readBlockedForUserPatterns,
  readContainerApiRoutes,
  routeFamily,
} from './helpers/containerRouteInventory.js'

/**
 * 开放家族里**故意不代理**的容器路由。
 *
 * 这是唯一的人工登记面,存在的意义是强制表态:在已开放家族里加端点,必须二选一 ——
 * 要么进 bridge allowlist,要么写进这里说明为什么不给商业用户。条目不许只写路径,
 * 必须写清理由(未来的人才知道能不能改)。
 */
const NOT_PROXIED_ON_PURPOSE: readonly { re: RegExp; reason: string }[] = [
  {
    re: /^\/api\/agents\/[^/]+\/message$/,
    reason:
      '商业版对话一律走 WebSocket turn 管线(计费/配额/turn tape 都挂在那条链上)。' +
      '这条 REST 入口是个人版遗留,代理进去会绕开计费与 turn 持久化。',
  },
  {
    re: /^\/api\/agents\/[^/]+\/delegate$/,
    reason:
      '同上:同步 delegate 是个人版 REST 入口。商业版的组队 = main 队长 turn 内自主' +
      'delegate_task,由 turn 管线记账,不经这条路。',
  },
]

/** 路径级可达性判定:任一常见 method 命中即算"这条路径被认领"。 */
const PROBE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const

function claimedByAllowlist(path: string): boolean {
  return PROBE_METHODS.some((m) => matchBridgeApiAllowlist(path, m) !== null)
}

describe('容器路由 × bridge allowlist 闭包契约(#201)', () => {
  test('① 已开放家族内的每条容器路由都有人表过态(可代理 / 已登记不代理)', async () => {
    const routes = await readContainerApiRoutes()
    const blocked = await readBlockedForUserPatterns()

    const proxiedFamilies = new Set(
      BRIDGE_API_ALLOWLIST.filter((r) => r.proxyFromCommercial).map((r) => routeFamily(r.label)),
    )
    assert.ok(
      proxiedFamilies.size >= 5,
      `可代理家族只有 ${proxiedFamilies.size} 个,allowlist 可能被清空 —— 拒绝在空前提下判绿`,
    )

    const inScope = routes.filter((r) => proxiedFamilies.has(routeFamily(r.sample)))
    assert.ok(
      inScope.length >= 20,
      `已开放家族内只扫到 ${inScope.length} 条容器路由(低于历史下界 20),抽取器可能失效`,
    )

    const unowned = inScope
      .filter(
        (r) =>
          !claimedByAllowlist(r.sample) && !NOT_PROXIED_ON_PURPOSE.some((e) => e.re.test(r.sample)),
      )
      .map((r) => `${r.declared} (server.ts:${r.line}, 样例 ${r.sample})`)

    assert.deepEqual(
      unowned,
      [],
      '以下容器路由处在"已对商业用户开放"的家族里,却没有任何人对它表过态 —— 商业用户' +
        `调它会拿到 router 的 404(前端表现为面板空白 / 按钮点了没反应):\n  ${unowned.join('\n  ')}\n` +
        '修法二选一:① 该端点应对用户开放 → 在 packages/gateway/src/bridgeApiAllowlist.ts ' +
        '补一条 proxyFromCommercial:true 的规则;② 该端点不该给商业用户 → 在本文件的 ' +
        'NOT_PROXIED_ON_PURPOSE 登记并写明理由,同时确认 BLOCKED_FOR_USER_RULES 已 deny 它。',
    )

    // 决定"不代理"的路由必须同时被宿主 deny —— 否则它会裸奔在 host singleton 上
    // (用户拿自己的 JWT 直接打宿主,操作的是**宿主**的 agent/技能状态,不是自己容器的)。
    const undefended = inScope
      .filter((r) => NOT_PROXIED_ON_PURPOSE.some((e) => e.re.test(r.sample)))
      .filter((r) => !blocked.some((re) => re.test(r.sample)))
      .map((r) => `${r.declared} (样例 ${r.sample})`)
    assert.deepEqual(
      undefended,
      [],
      '以下路由登记为"故意不代理",但 BLOCKED_FOR_USER_RULES 没有 deny 它 —— 普通用户' +
        `可以直接打到 host singleton 上操作宿主状态:\n  ${undefended.join('\n  ')}`,
    )
  })

  test('② NOT_PROXIED_ON_PURPOSE 登记表没有过期条目和幽灵条目', async () => {
    const routes = await readContainerApiRoutes()

    const nowProxied = NOT_PROXIED_ON_PURPOSE.filter((e) =>
      routes.some((r) => e.re.test(r.sample) && claimedByAllowlist(r.sample)),
    ).map((e) => e.re.source)
    assert.deepEqual(
      nowProxied,
      [],
      `以下条目登记为"故意不代理",但 bridge allowlist 已经认领了对应路由 —— 登记表过期,` +
        `请删掉这些条目:\n  ${nowProxied.join('\n  ')}`,
    )

    const ghosts = NOT_PROXIED_ON_PURPOSE.filter(
      (e) => !routes.some((r) => e.re.test(r.sample)),
    ).map((e) => e.re.source)
    assert.deepEqual(
      ghosts,
      [],
      `以下条目对应不上任何真实容器路由(路由已删或改名),属于幽灵登记,` +
        `请清理:\n  ${ghosts.join('\n  ')}`,
    )

    for (const entry of NOT_PROXIED_ON_PURPOSE) {
      assert.ok(
        entry.reason.length >= 20,
        `NOT_PROXIED_ON_PURPOSE 条目 ${entry.re.source} 的 reason 太短 —— 必须写清为什么不代理`,
      )
    }
  })

  test('③ allowlist 里每条规则都能匹配到真实容器路由(无死规则)', async () => {
    const routes = await readContainerApiRoutes()

    const dead = BRIDGE_API_ALLOWLIST.filter(
      (rule) => !routes.some((r) => rule.re.test(r.sample)),
    ).map((rule) => `${rule.label} → ${rule.re.source}`)

    assert.deepEqual(
      dead,
      [],
      '以下 bridge allowlist 规则匹配不到任何容器侧真实路由 —— 要么正则写错,要么容器侧' +
        `路径已改名。两种情况下用户请求都会 404:\n  ${dead.join('\n  ')}\n` +
        '修法:核对 packages/gateway/src/server.ts 的实际分发路径后修正规则(或删除已废弃的规则)。',
    )
  })
})
