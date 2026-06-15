// 静态 key 文本 provider 的 **commercial 侧语义映射**。
//
// 路由元数据(endpoint / matchesRoute / inboundModelIds / canonicalize / strip / maxInputTokens)
// 在 @openclaude/protocol 的 STATIC_KEY_PROVIDERS。本表只放 commercial 独有语义：
//   - keyConfigField     : 该 provider 的静态 key 在 commercial Config 里的字段名(wiring/guard 用)
//   - notConfiguredHttpCode: 缺 key 时 proxy 返回的 503 错误码
//   - rejectMetricLabel  : 缺 key 时打点的 ProxyRejectReason
//
// 故意**不**放进 protocol —— protocol 是 commercial+gateway 共享的纯路由契约，不应耦合
// commercial 的 config/错误码/metrics(Codex plan review #1)。

import { findRouteProviderForModel, type StaticProviderId } from "@openclaude/protocol";
import { PLATFORM_DEFAULT_MODEL } from "../../platformDefaults.js";

export interface StaticProviderCommercialMeta {
  /** 静态 key 在 commercial Config 里的字段名(不含 key 值本身) */
  readonly keyConfigField: "DEEPSEEK_API_KEY" | "MINIMAX_TOKEN_PLAN_KEY" | "ARK_CODING_PLAN_KEY";
  /** 缺 key → 503 错误码 */
  readonly notConfiguredHttpCode:
    | "DEEPSEEK_NOT_CONFIGURED"
    | "MINIMAX_NOT_CONFIGURED"
    | "ARK_NOT_CONFIGURED";
  /** 缺 key → reject metric label(须与 admin/metrics.ts ProxyRejectReason 一致) */
  readonly rejectMetricLabel: "deepseek_config" | "minimax_config" | "ark_config";
}

export const STATIC_PROVIDER_META: Record<StaticProviderId, StaticProviderCommercialMeta> = {
  deepseek: {
    keyConfigField: "DEEPSEEK_API_KEY",
    notConfiguredHttpCode: "DEEPSEEK_NOT_CONFIGURED",
    rejectMetricLabel: "deepseek_config",
  },
  minimax: {
    keyConfigField: "MINIMAX_TOKEN_PLAN_KEY",
    notConfiguredHttpCode: "MINIMAX_NOT_CONFIGURED",
    rejectMetricLabel: "minimax_config",
  },
  ark: {
    keyConfigField: "ARK_CODING_PLAN_KEY",
    notConfiguredHttpCode: "ARK_NOT_CONFIGURED",
    rejectMetricLabel: "ark_config",
  },
};

/**
 * fail-closed guard：若平台全局默认模型(PLATFORM_DEFAULT_MODEL，当前 glm-5.1)路由到某静态 key
 * provider，但生产 env 未配该 provider 的 key → **throw**，让 master 装配 internal proxy 的启动路径
 * loud fail，而非全员默认模型静默 503(Codex plan review #4)。
 *
 * 触发面限定：只在 master 装配 internal anthropic proxy / agent runtime 的启动路径调用一次。
 * unit test / external API-key proxy harness / 不装配 agent runtime 的本地进程不调用本函数，不受影响。
 *
 * 默认模型若走 OAuth(findRouteProviderForModel 返回 undefined)→ 无静态 key 依赖，直接放行。
 */
export function assertPlatformDefaultModelConfigured(cfg: {
  DEEPSEEK_API_KEY?: string;
  MINIMAX_TOKEN_PLAN_KEY?: string;
  ARK_CODING_PLAN_KEY?: string;
}): void {
  const provider = findRouteProviderForModel(PLATFORM_DEFAULT_MODEL);
  if (!provider) return;
  const meta = STATIC_PROVIDER_META[provider.id];
  const key = cfg[meta.keyConfigField];
  if (key === undefined || key.trim() === "") {
    throw new Error(
      `PLATFORM_DEFAULT_MODEL="${PLATFORM_DEFAULT_MODEL}" 路由到静态 provider "${provider.id}"，` +
        `但其 key(${meta.keyConfigField})未在生产 env 配置。拒绝启动 internal proxy(loud fail)，` +
        `避免全员默认模型静默 503。请先在 systemd EnvironmentFile 写入(旋转后的) ${meta.keyConfigField} 再部署。`,
    );
  }
}
