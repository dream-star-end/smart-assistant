import { PRODUCT_CAPABILITIES, type ProductFeatureId } from "./productCapabilities";

/**
 * 管理中心分区 id。**值是持久契约**：深链 / 教程 destination.tab
 * （productCapabilities 的 ManageDestinationTab 是它的子集）/ 市场回跳都按它路由，
 * 只增不改；顺序与文案在下面的 MANAGE_TABS 里调。
 */
export type ManageTab = "memory" | "skills" | "cron" | "connectors" | "library" | "optimization";

export type ManageTabDef = {
  id: ManageTab;
  /** 药丸标签。窄屏是 3 列宫格，必须两字可读 —— 长名一律不进这里。 */
  label: string;
  featureId: ProductFeatureId;
};

/**
 * 分区注册表 = 顺序 + 文案的单一权威。
 *
 * ① 顺序按使用频率：改记忆 / 看技能 / 查定时是高频，「优化」是收件箱型分区（平时为空，
 *    有待办才值得看），放末位并靠 Tab 徽标做信号，不再占最贵的首位。
 * ② **MANAGE_TABS[0] 就是默认落地页**（见 DEFAULT_MANAGE_TAB）。改造前 TABS[0] 是
 *    「全面优化」而 App 的初始 tab 是 'memory'，首屏永远是"选中的不是第一个"的错位态 ——
 *    两处各写各的是根因，故收敛成一处并有契约测试锁死。
 * ③ 文案缩短是为移动端腾宽（6 个中文 tab 单行需 ~467px，390px 屏容器只有 ~326px）；
 *    「插件账号」→「插件」同时终结全链路（市场品类 / 面板正文 / 卸载确认 / 回跳 toast）
 *    同一概念五个叫法的问题：**「插件」是唯一用户向名词，绑定账号是它的动作而非它的名字**。
 */
export const MANAGE_TABS: readonly ManageTabDef[] = [
  { id: "memory", label: "记忆", featureId: PRODUCT_CAPABILITIES.memory.id },
  { id: "skills", label: "技能", featureId: PRODUCT_CAPABILITIES.skills.id },
  { id: "cron", label: "定时", featureId: PRODUCT_CAPABILITIES.schedules.id },
  { id: "connectors", label: "插件", featureId: PRODUCT_CAPABILITIES.connectors.id },
  { id: "library", label: "文献", featureId: PRODUCT_CAPABILITIES.research.id },
  { id: "optimization", label: "优化", featureId: PRODUCT_CAPABILITIES.memory.id },
];

/**
 * 默认落地页。**恒等于首位 Tab** —— 侧栏入口、App 初始态都取这里，不要再写字面量。
 * 有意不做"有待办就落到优化"的动态落地：落地页随数据漂移会毁掉肌肉记忆，
 * 待办改用 Tab 徽标 + 侧栏信号表达（同一份计数，见 hooks/useOptimizerPending）。
 */
export const DEFAULT_MANAGE_TAB: ManageTab = MANAGE_TABS[0].id;
