/**
 * Intelligent UI(OCV5-361,个人版)—— master 侧:总开关、用户偏好、下发给容器的 prompt slot。
 *
 * 链路:容器 gateway 组装系统提示时 GET `/internal/v3/platform-prompt-slots`(容器身份认证)→
 * master 用容器身份推出 uid → 总开关开 且 该用户偏好未关 → 返回 `INTELLIGENT_UI` slot。
 * 开关关闭时这一段根本不进系统提示(零 token 开销)。模型无关:纯文本协议,任何模型都能照写。
 *
 * 总开关:env `OC_INTELLIGENT_UI`,缺省/`1`/`on`/`true` = 启用;`0`/`off`/`false` = 禁用。
 * 用户偏好:`user_preferences.prefs.intelligent_ui`,缺省视为开。
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

const F = "```";

/**
 * 系统提示里的协议说明。改这里 = 改所有模型看到的组件协议;前端 schema 在
 * `packages/web-react/src/components/iui/schema.ts`,字段名两边要一致
 * (`__tests__/intelligentUi.test.ts` 用前端同名字段做了一致性断言)。
 */
export const INTELLIGENT_UI_PROMPT = [
  "# 交互式回答(Intelligent UI)",
  "",
  "用户的界面会把语言标记为 `ui` 的代码块渲染成原生交互组件:表格、图表、关键数字、步骤清单、对比卡、可点选项、计算器、提示框、分段标签、时间线、后续建议。只要组件能让回答更清楚、更好比较、更好操作,就放心用,一条回答里用几个都可以,和文字自由穿插。",
  "",
  "## 写法",
  `- 代码块写成 ${F}ui,块内是**一个**合法 JSON 对象(双引号、无注释、无尾逗号),\`type\` 决定组件;闭围栏 ${F} 独占一行。一个块一个组件。`,
  "- 组件外照常用文字讲清结论和理由,不要只丢一个组件。",
  "- 数字要有依据:table / chart / stats 写 `source`;stats 的每个数字用 `basis` 说明怎么来的;估算要写明是估算。",
  "- calculator 的公式必须算对,假设写进 `assumptions`。公式只能用:数字、输入或输出的 id、`+ - * / % ^`、比较、`&& || !`、`a ? b : c`,函数 `min max round(x,d) floor ceil abs sqrt pow log ln exp if(c,a,b) clamp(x,lo,hi) pmt(每期利率,期数,本金)`。",
  "- 需要用户拍板才能继续的问题,仍按平台的提问规则处理;`choice` 用于回答里让用户点选下一步方向。",
  `- 流程图、结构图用 ${F}mermaid;需要真正运行的小工具或小游戏用 ${F}htmlpreview。`,
  "",
  "## 组件(带 ? 的字段可省略)",
  '- table:{"type":"table","title"?,"columns":["列名" 或 {"label","unit"?,"align"?:"right"}],"rows":[[单元格,…]],"source"?,"note"?} —— 用户可点表头排序',
  '- chart:{"type":"chart","kind":"bar"|"line"|"area"|"pie","title"?,"labels":["类目"],"series":[{"name","values":[数字]}],"unit"?,"x_label"?,"y_label"?,"stacked"?,"source"?,"note"?}',
  '- stats:{"type":"stats","title"?,"items":[{"label","value","unit"?,"delta"?,"basis"?}],"source"?}',
  '- steps:{"type":"steps","title"?,"checkable"?:true,"items":[{"title","detail"?}]} —— checkable 为可勾选清单',
  '- compare:{"type":"compare","title"?,"items":[{"name","tag"?,"summary"?,"points"?,"pros"?,"cons"?,"recommended"?}],"verdict"?}',
  '- choice:{"type":"choice","question"?,"multi"?,"options":["选项" 或 {"label","desc"?}]} —— 点选后作为用户消息发出',
  '- calculator:{"type":"calculator","title"?,"inputs":[{"id","label","kind"?:"number"|"slider"|"select"|"toggle","value","min"?,"max"?,"step"?,"unit"?,"options"?:[{"label","value"}]}],"outputs":[{"id","label","formula","unit"?,"format"?:"number"|"integer"|"currency"|"percent","decimals"?,"primary"?}],"assumptions"?,"note"?} —— 改输入即时重算;slider 必须给 min/max;percent 把 0.25 显示为 25%',
  '- callout:{"type":"callout","tone":"info"|"tip"|"warning"|"danger"|"success","title"?,"body"} —— body 可用 Markdown',
  '- tabs:{"type":"tabs","title"?,"tabs":[{"label","body"}]} —— 分段切换,body 可用 Markdown',
  '- timeline:{"type":"timeline","title"?,"items":[{"time","title","detail"?}]}',
  '- suggestions:{"type":"suggestions","items":["用户可能想接着问的一句话"]} —— 放在回答末尾,点一下直接发送',
  "",
  "## 示例",
  `${F}ui`,
  '{"type":"calculator","title":"房贷月供","inputs":[{"id":"loan","label":"贷款额","value":1000000,"step":10000,"unit":"元"},{"id":"rate","label":"年利率","kind":"slider","value":3.1,"min":2,"max":6,"step":0.05,"unit":"%"},{"id":"years","label":"年限","kind":"select","value":30,"options":[{"label":"20 年","value":20},{"label":"30 年","value":30}]}],"outputs":[{"id":"monthly","label":"每月还款","formula":"pmt(rate/100/12, years*12, loan)","unit":"元","format":"currency","primary":true},{"id":"interest","label":"总利息","formula":"monthly*years*12-loan","unit":"元","format":"currency"}],"assumptions":["等额本息","利率在贷款期内不变"]}',
  F,
].join("\n");

/**
 * platform-prompt-slots 用:给定 uid 算出该用户是否该拿到 INTELLIGENT_UI slot。
 * 读偏好失败 → 不下发(fail-soft:组件协议是增强,不是安全控制)。
 */
export async function resolveIntelligentUiSlot(
  userId: number | bigint | string,
  deps: {
    env?: NodeJS.ProcessEnv;
    readPrefs?: (uid: string) => Promise<{ prefs: { intelligent_ui?: boolean } }>;
  } = {},
): Promise<{ name: string; content: string } | null> {
  if (!isIntelligentUiServerEnabled(deps.env)) return null;
  const readPrefs =
    deps.readPrefs ??
    (async (uid: string) => {
      const { getPreferences } = await import("../user/preferences.js");
      return getPreferences(uid);
    });
  const snap = await readPrefs(String(userId));
  if (!intelligentUiPrefEnabled(snap.prefs)) return null;
  return { name: INTELLIGENT_UI_SLOT_NAME, content: INTELLIGENT_UI_PROMPT };
}
