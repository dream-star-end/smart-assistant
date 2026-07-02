// codex engine 模型归属 —— master(commercial bridge)与容器 gateway 共用的单一权威。
//
// 背景(P0 计费旁路封堵,2026-07-02):
//   - 容器侧 gateway `engine/registry.ts` 的 resolveEngine 按 model 判定底座
//     (codex vs ccb),其 MODEL_ENGINE_MAP 由本表派生;
//   - master 侧 commercial `ws/userChatBridge.ts` 需要在 forward 前做同构判定
//     (codex turn → preCheck / inflight journal / server-owned requestId 注入),
//     判定不同构 = codex turn 绕过计费(免费 codex)或 CCB turn 误走 codex 计费。
//   两处如果各自硬编码 gpt 集合,漂移是必然的 —— 收口在 protocol(双方共同依赖、
//   零依赖 leaf),新增 codex 系模型只改本表一处。
//
// 设计边界:只回答「哪些 model id 由 codex engine 承接」。模型准入(白名单 /
// 授权可见性)与 engine 构造(registry fail-closed)仍在各自消费方收口。

/** codex engine 承接的模型 id 全集(精确字面量,与 registry MODEL_ENGINE_MAP 同源)。 */
export const CODEX_ENGINE_MODEL_IDS = ['gpt-5.5'] as const

/** codex seed agent(id='codex')的固定模型 —— entrypoint desiredCodexAgent 同值。 */
export const DEFAULT_CODEX_ENGINE_MODEL: string = CODEX_ENGINE_MODEL_IDS[0]

/**
 * 该 model id 是否由 codex engine 承接(精确匹配,大小写敏感 —— 与
 * resolveEngine 的 MODEL_ENGINE_MAP key 查找逐字节一致)。
 * 注意:**不是** `gpt-` 前缀判定 —— 前缀在 resolveExecutionModel 白名单收敛后
 * 与精确集等价,但前缀判定会把「白名单外的 gpt-xxx(实际被收敛到平台默认、
 * 落 CCB)」误分类成 codex,破坏 master/容器判定同构。
 */
export function isCodexEngineModel(modelId: string | null | undefined): boolean {
  return (
    typeof modelId === 'string' &&
    (CODEX_ENGINE_MODEL_IDS as readonly string[]).includes(modelId)
  )
}
