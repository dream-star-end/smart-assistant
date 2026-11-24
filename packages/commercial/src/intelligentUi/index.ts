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
 * 两段轻量常驻提示拼进同一个 slot:容器侧 gateway 只认白名单里的 slot 名,复用它不需要改容器。
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

const F = "```";

/**
 * 常驻只放轻量触发目录与极简输入预测格式；完整组件字段协议按需经 `oc-system skill ui` 加载。
 * 避免 9.5 KB 完整 schema 常驻占窗，也避免新模型因只看到条件式加载指针而不触发组件或预测（OCV5-884）。
 */
export const INTELLIGENT_UI_PROMPT = [
  "交互式回答(Intelligent UI)已开启：当原生组件能让回答更直观、更好对比或便于交互操作时优先使用（表格/图表/指标 `table/chart/stats/progress/kv`、对比/步骤/时间线/路线/大纲 `compare/steps/timeline/route/outline`、计算器/测验/表单/点选/标签页 `calculator/quiz/form/choice/tabs/suggestions`、卡片/成稿/提示框/交付物/文献/命令流/模板/闪卡 `cards/draft/callout/deliverables/citations/runbook/prompt_template/flashcards`）。",
  "写 `ui` 组件块前，先用 Bash 加载 `/run/oc/platform/current/bin/oc-system skill ui` 查字段协议（同会话加载一次即可）。",
].join("\n");

export const INPUT_PREDICTION_PROMPT = [
  `输入预测已开启：每条回答末尾单独附一个 ${F}ui 块，预测用户接下来最可能输入的一句话（仅显示在输入框供 Tab 采用，不会出现在回答里）：`,
  `${F}ui`,
  '{"type":"next","text":"用户接下来最可能输入的话"}',
  F,
  "要求：用用户口吻、≤30字、可直接发出、不写客套（如谢谢/好的没问题）；猜不出则不写；写了必须是整条回答最后一个块且后面无文字（需完整细则可查 `/run/oc/platform/current/bin/oc-system skill input-prediction`）。",
].join("\n");

export type IntelligentUiSurface = "webchat" | "taskboard";

export function buildIntelligentUiPrompt(options: { componentsEnabled: boolean; predictionEnabled: boolean; surface?: IntelligentUiSurface }): string | null {
  const parts = [
    ...(options.componentsEnabled ? [INTELLIGENT_UI_PROMPT] : []),
    ...(options.surface !== "taskboard" && options.predictionEnabled ? [INPUT_PREDICTION_PROMPT] : []),
  ];
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * platform-prompt-slots 用:给定 uid 算出该用户是否该拿到 INTELLIGENT_UI slot。
 * 读偏好失败 → 不下发(fail-soft:组件协议是增强,不是安全控制)。
 */
export async function resolveIntelligentUiSlot(
  userId: number | bigint | string,
  deps: {
    env?: NodeJS.ProcessEnv;
    surface?: IntelligentUiSurface;
    readPrefs?: (uid: string) => Promise<{ prefs: { intelligent_ui?: boolean; input_prediction?: boolean } }>;
  } = {},
): Promise<{ name: string; content: string } | null> {
  const iuiOn = isIntelligentUiServerEnabled(deps.env);
  const predictOn = deps.surface !== "taskboard" && isInputPredictionServerEnabled(deps.env);
  if (!iuiOn && !predictOn) return null;
  const readPrefs =
    deps.readPrefs ??
    (async (uid: string) => {
      const { getPreferences } = await import("../user/preferences.js");
      return getPreferences(uid);
    });
  const snap = await readPrefs(String(userId));
  const content = buildIntelligentUiPrompt({
    componentsEnabled: iuiOn && intelligentUiPrefEnabled(snap.prefs),
    predictionEnabled: predictOn && inputPredictionPrefEnabled(snap.prefs),
    surface: deps.surface,
  });
  return content === null ? null : { name: INTELLIGENT_UI_SLOT_NAME, content };
}
