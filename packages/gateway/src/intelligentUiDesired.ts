/**
 * Intelligent UI(OCV5-361)—— 开关对「新回合」立即生效。
 *
 * Grok / Cursor / Zcode 每轮重组系统提示,天然跟随开关。CCB 与 Codex 的系统提示在 runner
 * 启动时写死:runner 记下启动时是否注入了 INTELLIGENT_UI(`promptIntelligentUi`),
 * sessionManager.submit 在应用 effort/model 的同一把锁里用本模块取「现在应当是否注入」,
 * 不一致就并入已有的「shutdown → 本次 submit 以 resume 自动重启」路径。
 *
 * 取值:同一容器只属于一个用户,分别按网页对话/任务展示面缓存 5 秒;过期同步拉一次 master slots(本机,
 * 超时 1 秒)。拉取失败返回 undefined —— 调用方不得据此重启(失败 ≠ 已关闭)。
 *
 * 比的是 INTELLIGENT_UI 段的内容指纹(intelligentUiFingerprint),不只是有没有这一段:
 * 输入预测(OCV5-375)和组件协议拼在同一段里,只关输入预测时这一段仍在,只比有无就不会重启,
 * 模型会照旧每轮写预测块(用户看不到,但照样计费)。
 */
import {
  fetchPlatformSlotsFromMasterDetailed,
  type FetchPlatformSlotsDeps,
  INTELLIGENT_UI_SLOT,
  type IntelligentUiApplied,
  intelligentUiFingerprint,
  isWebchatSessionKey,
  isWebRenderedIuiSessionKey,
} from './promptSlots.js'

const TTL_MS = 5_000
const TIMEOUT_MS = 1_000

const cache = new Map<'webchat' | 'taskboard', { value: IntelligentUiApplied; at: number }>()
/** 测试替身:替换「拉 master」这一步(webchat 判定与缓存之外的部分)。 */
let fetchOverride: (() => Promise<IntelligentUiApplied | undefined>) | null = null

export async function getDesiredIntelligentUi(
  sessionKey: string | undefined,
  deps: FetchPlatformSlotsDeps & { now?: () => number } = {},
): Promise<IntelligentUiApplied | undefined> {
  // Other channels do not render IUI. Each web surface has its own content fingerprint.
  if (!isWebRenderedIuiSessionKey(sessionKey)) return false
  const surface = isWebchatSessionKey(sessionKey) ? 'webchat' : 'taskboard'
  const now = deps.now ?? Date.now
  if (fetchOverride) return fetchOverride()
  const cached = cache.get(surface)
  if (cached && now() - cached.at < TTL_MS) return cached.value
  const r = await fetchPlatformSlotsFromMasterDetailed(
    { agentId: 'main', sessionKey },
    { ...deps, timeoutMs: deps.timeoutMs ?? TIMEOUT_MS },
  )
  if (r === null || !r.ok) return undefined
  const value = intelligentUiFingerprint(r.slots.find((s) => s.name === INTELLIGENT_UI_SLOT)?.content)
  cache.set(surface, { value, at: now() })
  return value
}

/**
 * 纯判定:runner 启动时的状态与当前期望不一致 → 需要重启。
 * 任一方未知(runner 不记录 = 每轮重组的引擎;或拉取失败)都不重启。
 */
export function intelligentUiNeedsRestart(applied: unknown, desired: IntelligentUiApplied | undefined): boolean {
  return isIntelligentUiApplied(applied) && desired !== undefined && applied !== desired
}

/** runner 记录过 spawn 时的 INTELLIGENT_UI 指纹(每轮重组提示的引擎不记录 → undefined)。 */
export function isIntelligentUiApplied(v: unknown): v is IntelligentUiApplied {
  return v === false || typeof v === 'string'
}

export function __resetIntelligentUiDesiredCacheForTests(): void {
  cache.clear()
  fetchOverride = null
}

export function __setIntelligentUiDesiredFetchForTests(fn: (() => Promise<IntelligentUiApplied | undefined>) | null): void {
  fetchOverride = fn
}
