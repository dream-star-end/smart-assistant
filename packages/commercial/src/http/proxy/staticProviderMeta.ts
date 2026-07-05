// 静态 key 文本 provider 的 **commercial 侧语义映射**。
//
// 路由元数据(endpoint / matchesRoute / inboundModelIds / canonicalize / strip / maxInputTokens)
// 在 @openclaude/protocol 的 STATIC_KEY_PROVIDERS。本表只放 commercial 独有语义：
//   - keyConfigField     : 该 provider 的静态 key 在 commercial Config 里的字段名(wiring/guard 用)
//   - notConfiguredHttpCode: 缺 key 时 proxy 返回的 503 错误码
//   - rejectMetricLabel  : 缺 key 时打点的 ProxyRejectReason
//   - egress             : 出站出口策略(部署网络拓扑语义),见 StaticProviderCommercialMeta.egress 注释
//
// 故意**不**放进 protocol —— protocol 是 commercial+gateway 共享的纯路由契约，不应耦合
// commercial 的 config/错误码/metrics(Codex plan review #1)。

import { findRouteProviderForModel, type StaticProviderId } from "@openclaude/protocol";
import { PLATFORM_DEFAULT_MODEL } from "../../platformDefaults.js";

export interface StaticProviderCommercialMeta {
  /** 静态 key 在 commercial Config 里的字段名(不含 key 值本身) */
  readonly keyConfigField:
    | "DEEPSEEK_API_KEY"
    | "MINIMAX_TOKEN_PLAN_KEY"
    | "ARK_CODING_PLAN_KEY"
    | "ARK_AGENT_PLAN_KEY"
    | "OPENCODE_GO_API_KEY";
  /** 缺 key → 503 错误码 */
  readonly notConfiguredHttpCode:
    | "DEEPSEEK_NOT_CONFIGURED"
    | "MINIMAX_NOT_CONFIGURED"
    | "ARK_NOT_CONFIGURED"
    | "OPENCODEGO_NOT_CONFIGURED";
  /** 缺 key → reject metric label(须与 admin/metrics.ts ProxyRejectReason 一致) */
  readonly rejectMetricLabel:
    | "deepseek_config"
    | "minimax_config"
    | "ark_config"
    | "opencodego_config";
  /**
   * 出站出口策略(commercial 部署网络拓扑语义,非 protocol 路由契约,故落本表)。
   *
   *   - "direct": upstream fetch 显式挂**无代理直连** dispatcher(directEgressDispatcher)。
   *     适用国内/亚洲端点(ark 北京 / deepseek / minimax 新加坡)—— 从海外部署机直连即可达且更稳。
   *     **必须显式直连**,否则会落到 gateway 启动装的全局 EnvHttpProxyAgent(那是给 Anthropic
   *     出海用的日本节点 HTTPS_PROXY),变成"海外→日本→中国"双重跨境,长流式易半路断
   *     (proxy_finalize_aborted / TypeError: fetch failed)。实测 ark/minimax 绕日本 TLS 抖到 ~6s,
   *     直连 ~0.3s。
   *   - "proxy":  不挂 dispatcher,落全局默认出口(EnvHttpProxyAgent / HTTPS_PROXY)。预留给未来
   *     "需出海才可达"的静态 provider。
   *
   * 新增 provider 必须显式声明本字段(无默认),避免再次落进"dispatcher=undefined 被全局代理
   * 静默接管 → 绕日本"的陷阱。
   */
  readonly egress: "direct" | "proxy";
}

export const STATIC_PROVIDER_META: Record<StaticProviderId, StaticProviderCommercialMeta> = {
  deepseek: {
    keyConfigField: "DEEPSEEK_API_KEY",
    notConfiguredHttpCode: "DEEPSEEK_NOT_CONFIGURED",
    rejectMetricLabel: "deepseek_config",
    // api.deepseek.com:国内端点,海外部署机直连可达且优于绕日本(实测 TLS 0.32s vs 1.11s)。
    egress: "direct",
  },
  minimax: {
    // 2026-06-30:上游切火山方舟 Agent Plan,key 改用 ARK_AGENT_PLAN_KEY(与 ARK_CODING_PLAN_KEY 对称)。
    // provider id 仍 'minimax'(路由的模型还是 minimax-m3,语义正确);metric/错误码保持 minimax_* 连续性。
    keyConfigField: "ARK_AGENT_PLAN_KEY",
    notConfiguredHttpCode: "MINIMAX_NOT_CONFIGURED",
    rejectMetricLabel: "minimax_config",
    // ark.cn-beijing.volces.com:火山北京端点,直连 TLS ~0.3s 且稳;绕日本双重跨境 ~6s 且半路断 → 必须 direct。
    egress: "direct",
  },
  ark: {
    keyConfigField: "ARK_CODING_PLAN_KEY",
    notConfiguredHttpCode: "ARK_NOT_CONFIGURED",
    rejectMetricLabel: "ark_config",
    // ark.cn-beijing.volces.com:火山北京端点,直连 TLS ~0.3s 且稳;绕日本双重跨境 ~6s 且半路断。
    egress: "direct",
  },
  opencodego: {
    keyConfigField: "OPENCODE_GO_API_KEY",
    notConfiguredHttpCode: "OPENCODEGO_NOT_CONFIGURED",
    rejectMetricLabel: "opencodego_config",
    // opencode.ai:Cloudflare 全球 anycast(Go 档服务器美/欧/新加坡),海外部署机直连可达
    // (2026-07-05 部署机直连探针全通);无需绕日本节点。若未来直连劣化再评估切 "proxy"。
    egress: "direct",
  },
};

/**
 * fail-closed guard：若平台全局默认模型(PLATFORM_DEFAULT_MODEL，2026-06-17 起 glm-5.2→ark)路由到某静态 key
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
  ARK_AGENT_PLAN_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
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
