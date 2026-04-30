/**
 * 0049 model visibility + grants — 执行路径授权(plan v3 §B3 / §F4)。
 *
 * 与 `pricing.listForUser` 的关系:listForUser 解决"前台展示什么模型给这个 user",
 * canUseModel 解决"这个 user 能不能在 chat / API 调用里实际用某个 modelId"。**两个
 * 必须同源**(同一份 visibility + 同一份 grants),否则 UI 列表过滤和实际拒绝会出现
 * 漂移 —— 用户被前端骗能选,后端再 403,UX 很差。
 *
 * 调用顺序(plan v3 §B4 强约束):
 *   inbound.message frame 到达 → canUseModel(uid, frame.model) → 通过 → 路由到 codex/claude agent
 *   ↑ canUseModel 必须在 inferAgentForModel 之前。理由:未授权用户提交 'gpt-5.5' 时,
 *     如果先走 inferAgentForModel,错误信息会变成 "no_codex_agent" / "mismatch",
 *     这泄漏了 "container 是否配置了 codex agent / boss 是否完成了 OAuth" 的状态。
 *     先 canUseModel 直接 403 NOT_AUTHORIZED → 攻击者拿不到任何 codex 相关线索。
 *
 * 输入是已加载的 PricingCache + 已查的 grants 集合,函数本身**不做 I/O**。caller 自己
 * 在执行路径前置组装这两个输入(grants 通常按 uid 一次 SQL 查表,缓存到 ws session)。
 *
 * 边界 case:
 *   - 未知 modelId(canonicalize 后 PricingCache 里没有)→ false。决定权在 PricingCache,
 *     而不是这里"假设兜底允许" —— 上线 release 之前必须先 seed 才能用,这是 admin
 *     掌控权的保证。
 *   - enabled=false 的模型 → false(即使 visibility=public,被关掉就是关掉)
 *   - role=admin + visibility='hidden' + 没 grant → false。admin 不自动 bypass hidden,
 *     与 listForUser 同源:hidden 是"必须显式授权才能用"的最严格语义,plan v3 §E1 定义。
 */
import type { PricingCache } from './pricing.js'
import { canonicalizeModelId } from './pricing.js'

export interface CanUseModelDeps {
  /** 已 load 完毕的 pricing 缓存(进程级 singleton)。 */
  pricing: PricingCache
}

export interface CanUseModelInput {
  /** JWT 解析得到。anonymous(未登录)调用本函数无意义,caller 自己先决定要不要查。 */
  role: 'user' | 'admin'
  /** caller 必须在调用前一次性查表得到本 uid 的 grants 集合。空集合可。 */
  grantedModelIds: ReadonlySet<string>
  /** 用户提交的原始 model id;函数内部走 canonicalize 后查 PricingCache。 */
  modelId: string
}

/**
 * 同 listForUser 的语义,但作用在单个 modelId 上 —— 返回 boolean,不抛错。
 *
 * 不在内部记日志:caller(handlers / bridge frame inspector)拒绝时统一记一条
 * 'unauthorized_model' 含 uid+modelId+role,日志聚合更清晰。
 */
export function canUseModel(deps: CanUseModelDeps, input: CanUseModelInput): boolean {
  const canonical = canonicalizeModelId(input.modelId)
  const pricing = deps.pricing.get(canonical)
  if (!pricing) return false
  if (!pricing.enabled) return false
  if (pricing.visibility === 'public') return true
  if (pricing.visibility === 'admin') {
    return input.role === 'admin' || input.grantedModelIds.has(pricing.model_id)
  }
  // visibility === "hidden"
  return input.grantedModelIds.has(pricing.model_id)
}
