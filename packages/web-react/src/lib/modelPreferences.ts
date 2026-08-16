import { DEFAULT_CODEX_ENGINE_MODEL } from "@openclaude/protocol";
import type { PublicModel } from "./types";

export type PreferenceEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** preferences 内层快照（后端 strict allowlist；theme enum 用 auto 而非 system）。 */
export type PrefsView = {
  theme?: "light" | "dark" | "auto";
  default_model?: string;
  default_effort?: PreferenceEffort;
  notify_email?: boolean;
  notify_telegram?: boolean;
  qq_proactive_push?: boolean;
  wechat_show_tool_calls?: boolean;
  wechat_proactive_push?: boolean;
  auto_dream_enabled?: boolean;
  auto_optimizer_enabled?: boolean;
  hotkeys?: Record<string, string>;
};

export type AutoDreamFeatureView = {
  eligible: boolean;
  available: boolean;
  enabled: boolean;
  optimizer_enabled?: boolean;
  legacy_enabled?: boolean;
  effective: boolean;
  minimum_plan_code: string;
  min_interval_hours: number;
  min_new_sessions: number;
};

/** preferences 快照 → 内层 prefs（兼容 {prefs,updated_at} 包裹 / 平铺历史形态）。 */
export function extractPrefs(snap: unknown): PrefsView {
  if (!snap || typeof snap !== "object") return {};
  const obj = snap as Record<string, unknown>;
  const inner = obj.prefs;
  if (inner && typeof inner === "object") return inner as PrefsView;
  return obj as PrefsView;
}

export function extractAutoDreamFeature(snap: unknown): AutoDreamFeatureView | null {
  if (!snap || typeof snap !== "object") return null;
  const feature = (snap as { features?: { auto_dream?: unknown } }).features?.auto_dream;
  if (!feature || typeof feature !== "object") return null;
  const row = feature as Record<string, unknown>;
  if (
    typeof row.eligible !== "boolean" ||
    typeof row.available !== "boolean" ||
    typeof row.enabled !== "boolean" ||
    typeof row.effective !== "boolean" ||
    typeof row.minimum_plan_code !== "string" ||
    typeof row.min_interval_hours !== "number" ||
    typeof row.min_new_sessions !== "number"
  ) return null;
  // 显式重建公开投影，旧版本服务端即使暂时仍返回 model_* 也不会流入 UI 状态。
  return {
    eligible: row.eligible,
    available: row.available,
    enabled: row.enabled,
    ...(typeof row.optimizer_enabled === "boolean"
      ? { optimizer_enabled: row.optimizer_enabled }
      : {}),
    ...(typeof row.legacy_enabled === "boolean"
      ? { legacy_enabled: row.legacy_enabled }
      : {}),
    effective: row.effective,
    minimum_plan_code: row.minimum_plan_code,
    min_interval_hours: row.min_interval_hours,
    min_new_sessions: row.min_new_sessions,
  };
}

/** 只接受当前用户模型列表中仍可见且健康的偏好；否则回落首个健康模型。 */
export function initialModelFromPreferences(
  models: PublicModel[],
  prefs: PrefsView,
): string | undefined {
  const preferred = prefs.default_model
    ? models.find((m) => m.id === prefs.default_model && m.degraded !== true)
    : undefined;
  return preferred?.id ?? models.find((m) => m.degraded !== true)?.id ?? models[0]?.id;
}

/**
 * 会话打开/切换时的选择器恢复解析:**会话自己的持久化选择优先**,其次用户
 * default_model 偏好,再回落首个健康模型(与 initialModelFromPreferences 同口径)。
 * 会话存的 modelId 只是 UI 恢复提示 —— 恢复时必须仍在当前用户可见列表且未降级,
 * 否则视为不存在(模型下架/撤权/降级后不粘死,也杜绝脏值流入发送帧)。
 */
export function resolveSessionModel(
  models: PublicModel[],
  sessionModelId: string | undefined,
  prefs: PrefsView,
): string | undefined {
  const own = sessionModelId
    ? models.find((m) => m.id === sessionModelId && m.degraded !== true)
    : undefined;
  return own?.id ?? initialModelFromPreferences(models, prefs);
}

/**
 * 用户全局 effort 仅在当前执行模型的 API capability 投影允许时发送。
 * unsupported / 未设置均返回 undefined，让具体模型沿用自身默认。
 */
export function effortForModel(
  models: PublicModel[],
  modelId: string | undefined,
  // null(会话显式「跟随模型默认」)与 undefined(未设置)在函数内同路径:都落到
  // 返回 null = 发送显式清除,让 runner 回模型自身默认。
  preferred: PreferenceEffort | null | undefined,
): PreferenceEffort | null | undefined {
  if (!modelId) return undefined;
  const model = models.find((m) => m.id === modelId);
  if (!model) return undefined;
  if (!preferred) return null;
  return model.supported_efforts?.includes(preferred) ? preferred : null;
}

/** Team mode replaces main's selected model at the bridge, so effort follows Sol's capability. */
export function effectiveEffortModelId(
  selectedModelId: string | undefined,
  teamLeaderActive: boolean,
): string | undefined {
  return teamLeaderActive ? DEFAULT_CODEX_ENGINE_MODEL : selectedModelId;
}
