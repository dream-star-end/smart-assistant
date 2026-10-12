import { PRODUCT_CAPABILITIES, type ProductFeatureId } from "./productCapabilities";

/**
 * 管理中心分区 id。**值是持久契约**：教程 destination.tab
 * （productCapabilities 的 ManageDestinationTab 是它的子集）/ 项目页与市场回跳都按它路由，
 * 改名会让旧入口失效；顺序与文案在下面的 MANAGE_TABS 里调。
 *
 * 已下线的分区 id（'library' 文献、'optimization' 优化，OCV5-360）不再属于本联合类型；
 * 任何仍带着它们的旧入口都经 normalizeManageTab 回落到默认分区，而不是渲染空白。
 */
export type ManageTab = "memory" | "skills" | "cron" | "connectors";

export type ManageTabDef = {
  id: ManageTab;
  /** 分区名。窄屏导航是图标 + 两字标签的四段分段控件，必须两字可读 —— 长名一律不进这里。 */
  label: string;
  /** 一句话说明「这里管什么」（桌面导航栏副标题 / 读屏 aria-describedby）。用户向口语，不写实现名词。 */
  blurb: string;
  featureId: ProductFeatureId;
};

/**
 * 分区注册表 = 顺序 + 文案的单一权威。
 *
 * ① 顺序按使用频率：改记忆 / 看技能 / 查定时是高频，插件其次。
 * ② **MANAGE_TABS[0] 就是默认落地页**（见 DEFAULT_MANAGE_TAB）。曾经 TABS[0] 与 App 的
 *    初始 tab 各写各的，首屏出现"选中的不是第一个"的错位态，故收敛成一处并有契约测试锁死。
 * ③ 文案保持两字，移动端是四段分段控件（390px 屏容器内单行等分）；
 *    「插件」是唯一用户向名词，绑定账号是它的动作而非它的名字。
 */
export const MANAGE_TABS: readonly ManageTabDef[] = [
  { id: "memory", label: "记忆", blurb: "它记住的关于你和项目的事", featureId: PRODUCT_CAPABILITIES.memory.id },
  { id: "skills", label: "技能", blurb: "沉淀下来、可以反复用的做法", featureId: PRODUCT_CAPABILITIES.skills.id },
  { id: "cron", label: "定时", blurb: "到点自动去做的任务", featureId: PRODUCT_CAPABILITIES.schedules.id },
  { id: "connectors", label: "插件", blurb: "已连接的应用和账号", featureId: PRODUCT_CAPABILITIES.connectors.id },
];

/** 作用范围（个人 / 工作项目）只对这几个分区生效；其余分区不显示范围选择。 */
export const SCOPED_MANAGE_TABS: ReadonlySet<ManageTab> = new Set(["memory", "skills", "cron"]);

/**
 * 默认落地页。**恒等于首位 Tab** —— 侧栏入口、App 初始态都取这里，不要再写字面量。
 * 有意不做随数据变化的动态落地：落地页漂移会毁掉肌肉记忆。
 */
export const DEFAULT_MANAGE_TAB: ManageTab = MANAGE_TABS[0].id;

const MANAGE_TAB_IDS: ReadonlySet<string> = new Set(MANAGE_TABS.map((t) => t.id));

export function isManageTab(value: unknown): value is ManageTab {
  return typeof value === "string" && MANAGE_TAB_IDS.has(value);
}

/**
 * 入口防御：任何外部来的分区值（旧版教程/书签/状态里残留的 'library'、'optimization'，
 * 或其它未知值）一律回落到默认分区，绝不让管理中心以"没有任何分区被选中"的空白态打开。
 */
export function normalizeManageTab(value: unknown): ManageTab {
  return isManageTab(value) ? value : DEFAULT_MANAGE_TAB;
}
