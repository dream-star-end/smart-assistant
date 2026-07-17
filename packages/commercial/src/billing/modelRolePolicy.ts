// 按用户角色的模型产品策略(role-tiered projection)。
//
// 定位:catalog(model_catalog)声明的是**执行机制事实**(模型/上游的真实窗口上限);
// 本表声明的是**产品分档策略**(同一个模型,不同角色给多大窗口)。二者刻意分层:
//   - 机制上限进 catalog 行(context_window,入 executionRevision,active 行不可变);
//   - 角色分档是投影语义,在读取/签发面按 scope.role 收窄,**不改动 catalog 行本身**
//     (否则每加一档就要走版本状态机,且 capability_profile 加字段要 bump schema version
//     → 老进程 fail-closed,单模型产品策略不值得动那个契约)。
//
// 一致性要求(**所有消费方必须同一纯函数 projectContextWindowForRole**)。本策略有两条
// 投影轴,防线机制**不同** —— 切勿把两者都当成"被 409 对账兜住"(旧注释如此声称,审计
// 证实不成立):
//
//   A. 列表轴(DB 角色):ModelCatalogSnapshot.listForUser —— 前端 /api/public/models、
//      容器 /internal/v3/model-catalog 的投影行,以及 **projectionRevisionFor**(master
//      下发与 egress 每请求重算共用该方法,策略天然进哈希、双端自洽)。**此轴有 409 对账网**:
//      master 快照与 egress 每请求重算的 projectionRevision 不一致即 409。
//   B. 执行轴(JWT 角色):userChatBridge 签发 executionDescriptor.contextWindow —— CCB
//      auto-compact 的实际执行窗口(真正的执行面收窄点)。此轴取连接 claims.role(JWT),
//      **从不进 projectionRevision 对账**;15min TTL 内 JWT 角色与 DB 角色的漂移是**被设计
//      容忍**的(晋升迟一个 token 生命周期生效、收窄方向保守)。故执行轴**没有 409 兜底**。
//
//   ⇒ 执行轴的一致性**唯一防线** = 两条轴共用同一纯函数 + 两处落点单测钉死:
//        · modelRolePolicy.test.ts(纯函数契约)
//        · modelAuthorityBridge.test.ts:431(bridge 签发端到端)
//      这两个测试**不可删** —— 删任一即拆掉执行轴唯一防线。**新增任何按角色投影模型语义的
//      消费方(读取面/执行面)必须同步加对应落点单测**,不能依赖 409 对账兜底。
//
// 登记纪律:仅当"模型机制窗口 > 想给普通用户的窗口"时登记;不登记 = 全角色同窗(现状)。
// 若未来第二类角色差异(限速/档位/可见性)出现,再评估是否升格为 catalog 数据列 —— 触发
// 条件与代价已记入 docs/V5_DEV_PLAYBOOK.md 债表。

/**
 * 非 admin 用户的 per-model 上下文窗口上限(tokens)。
 * kimi-k3:机制窗口 1,048,576(Moonshot 官方),普通用户收窄到 500k=512,000 控制订阅配额
 * 消耗(boss 2026-07-17:"管理员 1M,其它用户 500k,以此降低成本")。admin 不受本表约束。
 */
export const NON_ADMIN_CONTEXT_WINDOW_LIMITS: Readonly<Record<string, number>> = {
  'kimi-k3': 512_000,
}

/**
 * 按角色投影模型上下文窗口。admin → 原值;其他角色 → min(机制窗口, 登记上限)。
 * contextWindow=null(codex 行等"无窗口语义")原样透传 —— null 不是 0,不参与 min。
 */
export function projectContextWindowForRole(
  modelId: string,
  contextWindow: number | null,
  role: 'user' | 'admin',
): number | null {
  if (role === 'admin' || contextWindow === null) return contextWindow
  const limit = NON_ADMIN_CONTEXT_WINDOW_LIMITS[modelId]
  if (limit === undefined) return contextWindow
  return Math.min(contextWindow, limit)
}
