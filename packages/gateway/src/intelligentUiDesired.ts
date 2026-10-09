/**
 * Intelligent UI(OCV5-361)—— 开关对「新回合」立即生效。
 *
 * Grok / Cursor / Zcode 每轮重组系统提示,天然跟随开关。CCB 与 Codex 的系统提示在 runner
 * 启动时写死:runner 记下启动时是否注入了 INTELLIGENT_UI(`promptIntelligentUi`),
 * sessionManager.submit 在应用 effort/model 的同一把锁里用本模块取「现在应当是否注入」,
 * 不一致就并入已有的「shutdown → 本次 submit 以 resume 自动重启」路径。
 *
 * 取值:同一容器只属于一个用户,所以按容器缓存 5 秒;过期同步拉一次 master slots(本机,
 * 超时 1 秒)。拉取失败返回 undefined —— 调用方不得据此重启(失败 ≠ 已关闭)。
 */
import {
  fetchPlatformSlotsFromMasterDetailed,
  type FetchPlatformSlotsDeps,
  INTELLIGENT_UI_SLOT,
  isWebchatSessionKey,
} from './promptSlots.js'

const TTL_MS = 5_000
const TIMEOUT_MS = 1_000

let cache: { value: boolean; at: number } | null = null
/** 测试替身:替换「拉 master」这一步(webchat 判定与缓存之外的部分)。 */
let fetchOverride: (() => Promise<boolean | undefined>) | null = null

export async function getDesiredIntelligentUi(
  sessionKey: string | undefined,
  deps: FetchPlatformSlotsDeps & { now?: () => number } = {},
): Promise<boolean | undefined> {
  // 非 webchat 会话永远不注入:期望值恒为 false(与 runner 记录一致,不会触发重启)。
  if (!isWebchatSessionKey(sessionKey)) return false
  const now = deps.now ?? Date.now
  if (fetchOverride) return fetchOverride()
  if (cache && now() - cache.at < TTL_MS) return cache.value
  const r = await fetchPlatformSlotsFromMasterDetailed(
    { agentId: 'main' },
    { ...deps, timeoutMs: deps.timeoutMs ?? TIMEOUT_MS },
  )
  if (r === null || !r.ok) return undefined
  const value = r.slots.some((s) => s.name === INTELLIGENT_UI_SLOT)
  cache = { value, at: now() }
  return value
}

/**
 * 纯判定:runner 启动时的状态与当前期望不一致 → 需要重启。
 * 任一方未知(runner 不记录 = 每轮重组的引擎;或拉取失败)都不重启。
 */
export function intelligentUiNeedsRestart(applied: unknown, desired: boolean | undefined): boolean {
  return typeof applied === 'boolean' && typeof desired === 'boolean' && applied !== desired
}

export function __resetIntelligentUiDesiredCacheForTests(): void {
  cache = null
  fetchOverride = null
}

export function __setIntelligentUiDesiredFetchForTests(fn: (() => Promise<boolean | undefined>) | null): void {
  fetchOverride = fn
}
