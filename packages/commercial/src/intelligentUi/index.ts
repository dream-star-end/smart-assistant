/**
 * Intelligent UI(OCV5-361,个人版)—— master 侧:总开关、用户偏好、下发给容器的 prompt slot。
 *
 * 链路:容器 gateway 组装系统提示时 GET `/internal/v3/platform-prompt-slots`(容器身份认证)→
 * master 用容器身份推出 uid → 总开关开 且 该用户偏好未关 → 返回 `INTELLIGENT_UI` slot。
 * 开关关闭时这一段根本不进系统提示(零 token 开销)。模型无关:纯文本协议,任何模型都能照写。
 *
 * 总开关:env `OC_INTELLIGENT_UI`,缺省/`1`/`on`/`true` = 启用;`0`/`off`/`false` = 禁用。
 * 用户偏好:`user_preferences.prefs.intelligent_ui`,缺省视为开。
 *
 * 输入预测(OCV5-375)也走这个 slot:每条回答末尾由模型写一个 `{"type":"next"}` 块,预测用户
 * 接下来要输入的话,前端不显示它,只把它作为输入框里的浅色预测。它和组件协议各有开关
 * (env `OC_INPUT_PREDICTION` + `user_preferences.prefs.input_prediction`,缺省都开),
 * 两段最短加载索引拼进同一个 slot:容器侧 gateway 只认白名单里的 slot 名,复用它不需要改容器。
 */

export const INTELLIGENT_UI_SLOT_NAME = "INTELLIGENT_UI";

export function isIntelligentUiServerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OC_INTELLIGENT_UI ?? "").trim().toLowerCase();
  return !["0", "off", "false", "no", "disabled"].includes(raw);
}

/** 偏好快照 → 该用户是否开启(缺省开)。 */
export function intelligentUiPrefEnabled(prefs: { intelligent_ui?: boolean } | null | undefined): boolean {
  return prefs?.intelligent_ui !== false;
}

/** `/api/me/preferences` 响应里的 features.intelligent_ui。 */
export function intelligentUiFeatureView(
  prefs: { intelligent_ui?: boolean } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { available: boolean; enabled: boolean } {
  const available = isIntelligentUiServerEnabled(env);
  return { available, enabled: available && intelligentUiPrefEnabled(prefs) };
}

/** 输入预测总开关:env `OC_INPUT_PREDICTION`,取值规则同 OC_INTELLIGENT_UI。 */
export function isInputPredictionServerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OC_INPUT_PREDICTION ?? "").trim().toLowerCase();
  return !["0", "off", "false", "no", "disabled"].includes(raw);
}

export function inputPredictionPrefEnabled(prefs: { input_prediction?: boolean } | null | undefined): boolean {
  return prefs?.input_prediction !== false;
}

/** `/api/me/preferences` 响应里的 features.input_prediction。 */
export function inputPredictionFeatureView(
  prefs: { input_prediction?: boolean } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { available: boolean; enabled: boolean } {
  const available = isInputPredictionServerEnabled(env);
  return { available, enabled: available && inputPredictionPrefEnabled(prefs) };
}

/** Only discovery text is resident. Component definitions live in the trusted platform bundle. */
export const INTELLIGENT_UI_PROMPT =
  "交互式回答已开启；需要原生组件时先用 Bash 加载 `/run/oc/platform/current/bin/oc-system skill ui`。";
export const INPUT_PREDICTION_PROMPT =
  "输入预测已开启；首次生成预测前用 Bash 加载 `/run/oc/platform/current/bin/oc-system skill input-prediction`。";

/**
 * platform-prompt-slots 用:给定 uid 算出该用户是否该拿到 INTELLIGENT_UI slot。
 * 读偏好失败 → 不下发(fail-soft:组件协议是增强,不是安全控制)。
 */
export async function resolveIntelligentUiSlot(
  userId: number | bigint | string,
  deps: {
    env?: NodeJS.ProcessEnv;
    readPrefs?: (uid: string) => Promise<{ prefs: { intelligent_ui?: boolean; input_prediction?: boolean } }>;
  } = {},
): Promise<{ name: string; content: string } | null> {
  const iuiOn = isIntelligentUiServerEnabled(deps.env);
  const predictOn = isInputPredictionServerEnabled(deps.env);
  if (!iuiOn && !predictOn) return null;
  const readPrefs =
    deps.readPrefs ??
    (async (uid: string) => {
      const { getPreferences } = await import("../user/preferences.js");
      return getPreferences(uid);
    });
  const snap = await readPrefs(String(userId));
  const parts = [
    ...(iuiOn && intelligentUiPrefEnabled(snap.prefs) ? [INTELLIGENT_UI_PROMPT] : []),
    ...(predictOn && inputPredictionPrefEnabled(snap.prefs) ? [INPUT_PREDICTION_PROMPT] : []),
  ];
  if (parts.length === 0) return null;
  return { name: INTELLIGENT_UI_SLOT_NAME, content: parts.join("\n\n") };
}
