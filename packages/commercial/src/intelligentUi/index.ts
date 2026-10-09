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
  "用户的界面会把语言标记为 `ui` 的代码块渲染成原生交互组件。只要组件能让回答更清楚、更好比较、更好操作、更好看,就放心用,一条回答里用几个都可以,和文字自由穿插。",
  "",
  "## 写法",
  `- 代码块写成 ${F}ui,块内是**一个**合法 JSON 对象(双引号、无注释、无尾逗号),\`type\` 决定组件;闭围栏 ${F} 独占一行。一个块一个组件。`,
  "- 组件外照常用文字讲清结论和理由,不要只丢一个组件。多数组件可写 `title` 和 `subtitle`(标题下一行说明)。",
  "- 数字要有依据:table / chart / stats / progress / kv 写 `source`;stats 的数字用 `basis` 说明来历;估算写明是估算。",
  "- calculator 的公式必须算对,假设写进 `assumptions`。公式只能用:数字、输入或输出的 id、`+ - * / % ^`、比较、`&& || !`、`a ? b : c`,函数 `min max round(x,d) floor ceil abs sqrt pow log ln exp if(c,a,b) clamp(x,lo,hi) pmt(每期利率,期数,本金)`。",
  "- 图片(cards / gallery / compare 的 image)只用 https 地址或你生成在工作区里的图片文件路径;拿不到真实图片就用 icon,不要编造图片地址。",
  "- icon 可选:leaf sprout flower tree carrot apple salad soup beef fish pizza cake coffee wine utensils chef home bed sofa building store hotel plane car train bike ship pin mountain tent walk globe sun moon cloud snow water fire energy heart star gift book study brain work fitness health music camera game shirt gem paint tool money savings shopping package calendar clock shield idea target trophy rocket people baby dog cat phone laptop。",
  "- 需要用户拍板才能继续的问题,仍按平台的提问规则处理;choice / form 用于在回答里让用户点选或填写后继续。",
  "- 测验、知识问答、计算器、表单、清单、对比、路线这类上面组件能做的事,一律用 ui 组件写,不要为它们另做 htmlpreview 网页;平台其它段落说小游戏、交互 demo 用 htmlpreview,遇到这类场景以本段为准。",
  `- 只有组件做不到、必须自己写代码运行的东西(Canvas、动画、实时操作的游戏)才用 ${F}htmlpreview;流程图、结构图用 ${F}mermaid。`,
  "",
  "## 组件(带 ? 的字段可省略)",
  '- table:{"type":"table","columns":["列名" 或 {"label","unit"?,"align"?:"right","bar"?:true}],"rows":[[单元格]],"highlight"?:行号,"source"?,"note"?} —— 可排序;数字列 bar 画数据条;单元格写 ✓ / ✗ 显示为图标',
  '- chart:{"type":"chart","kind":"bar"|"line"|"area"|"pie","labels":["类目"],"series":[{"name","values":[数字]}],"unit"?,"x_label"?,"y_label"?,"stacked"?,"source"?}',
  '- stats:{"type":"stats","items":[{"label","value","unit"?,"delta"?,"basis"?,"trend"?:[数字]}],"source"?} —— trend 画迷你走势线',
  '- steps:{"type":"steps","checkable"?:true,"items":[{"title","detail"?}]} —— checkable 为可勾选清单',
  '- compare:{"type":"compare","items":[{"name","tag"?,"price"?,"image"?,"summary"?,"points"?,"pros"?,"cons"?,"recommended"?}],"verdict"?}',
  '- calculator:{"type":"calculator","inputs":[{"id","label","kind"?:"number"|"slider"|"select"|"toggle","value","min"?,"max"?,"step"?,"unit"?,"options"?:[{"label","value"}]}],"outputs":[{"id","label","formula","unit"?,"format"?:"number"|"integer"|"currency"|"percent","decimals"?,"primary"?,"tone"?:"up"|"down"}],"breakdown"?:[输出 id],"chart"?:{"kind":"area"|"line"|"bar","x":输入 id,"from","to":数字或输入 id,"series":[输出 id],"x_label"?},"assumptions"?} —— 改输入即时重算;primary 大号显示,tone 的输出显示在它下面;breakdown 画占比条;chart 扫描 x 画曲线;slider 必须给 min/max',
  '- tabs:{"type":"tabs","tabs":[{"label","body"?,"block"?:另一个组件}]} —— 分段切换;body 可用 Markdown,block 放一个完整组件(不能再放 tabs)',
  '- cards:{"type":"cards","layout"?:"list"|"grid","items":[{"title","subtitle"?,"body"?,"image"?,"icon"?,"tags"?,"meta"?,"url"?}]} —— 菜单、景点、书单、商品',
  '- gallery:{"type":"gallery","images":[{"src","caption"?}],"caption"?} —— 1 大 2 小拼贴',
  '- swatches:{"type":"swatches","colors":[{"hex":"#rrggbb","name"?}]} —— 色板',
  '- tiles:{"type":"tiles","columns"?:2-4,"items":[{"title","subtitle"?,"icon"?,"tone"?:"green"|"amber"|"sky"|"rose"|"violet"|"slate","span"?}],"caption"?} —— 彩色方块网格(分区、布局示意)',
  '- recipe:{"type":"recipe","servings","unit"?,"ingredients":[{"name","amount"?,"unit"?,"note"?}],"steps"?,"meta"?:[{"label","value"}]} —— 改份数自动换算用量',
  '- quiz:{"type":"quiz","questions":[{"question","options":[],"answer":正确选项序号(0 起),"explain"?}]} —— 本地判分,答完显示解析;出题考考大家、饭桌或课堂问答、自测题都用它',
  '- progress:{"type":"progress","items":[{"label","value","max"?,"unit"?,"tone"?:"good"|"warn"|"bad","note"?}],"source"?} —— 进度、预算、营养',
  '- kv:{"type":"kv","items":[{"label","value"}],"source"?} —— 规格、要点',
  '- route:{"type":"route","stops":[{"name","detail"?,"note"?,"highlight"?}],"legs"?:[{"mode"?,"distance"?,"duration"?}]} —— 行程路线,legs 比 stops 少一段',
  '- timeline:{"type":"timeline","items":[{"time","title","detail"?}]}',
  '- callout:{"type":"callout","tone":"info"|"tip"|"warning"|"danger"|"success","title"?,"body"} —— body 可用 Markdown',
  '- choice:{"type":"choice","question"?,"multi"?,"options":["选项" 或 {"label","desc"?}]} —— 点选后作为用户消息发出',
  '- form:{"type":"form","fields":[{"id","label","kind"?:"text"|"number"|"select"|"chips"|"date","options"?,"multi"?,"unit"?,"placeholder"?,"required"?}],"submit"?} —— 填完作为一条用户消息发出',
  '- suggestions:{"type":"suggestions","items":["用户可能想接着问的一句话"]} —— 放在回答末尾,点一下直接发送',
  "",
  "## 示例",
  `${F}ui`,
  '{"type":"tabs","title":"理财计算器","tabs":[{"label":"定投","block":{"type":"calculator","inputs":[{"id":"monthly","label":"每月投入","value":3000,"step":500,"unit":"元"},{"id":"years","label":"年限","kind":"slider","value":20,"min":1,"max":40,"step":1,"unit":"年"}],"outputs":[{"id":"value","label":"预计终值","formula":"monthly*((1+0.005)^(years*12)-1)/0.005","unit":"元","format":"integer","primary":true},{"id":"invested","label":"累计投入","formula":"monthly*12*years","unit":"元","format":"integer"},{"id":"growth","label":"预计收益","formula":"value-invested","unit":"元","format":"integer","tone":"up"}],"breakdown":["invested","growth"],"chart":{"kind":"area","x":"years","from":0,"to":"years","series":["value","invested"]},"assumptions":["年化 6%,按月复利"]}},{"label":"房贷","block":{"type":"calculator","inputs":[{"id":"loan","label":"贷款额","value":1000000,"step":10000,"unit":"元"},{"id":"rate","label":"年利率","kind":"slider","value":3.1,"min":2,"max":6,"step":0.05,"unit":"%"}],"outputs":[{"id":"monthly","label":"每月还款","formula":"pmt(rate/1200, 360, loan)","unit":"元","format":"currency","primary":true}],"assumptions":["30 年等额本息"]}}]}',
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
