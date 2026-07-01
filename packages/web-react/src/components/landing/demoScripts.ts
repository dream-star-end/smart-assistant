import {
  Briefcase,
  FileText,
  GitBranch,
  Globe,
  LayoutDashboard,
  type LucideIcon,
  Users,
} from "lucide-react";

/** 演示中助手「执行动作」的瞬时提示芯片（读表格 / 联网 / 跑代码 / 委派…），逐条揭示以展示 agent 干活过程。 */
export type DemoStep = { label: string };

export type DemoScenario = {
  id: string;
  /** 能力标签（Tab 文案）。 */
  tab: string;
  icon: LucideIcon;
  /** 用户输入（直接整段显示，不打字）。 */
  prompt: string;
  /** 出答案前依次亮起的执行动作（可选）。 */
  steps?: DemoStep[];
  /** 助手回答（逐字打字；\n 保留换行）。 */
  answer: string;
  /** 任务产出的可交付文件（答案打完后作为附件芯片呈现，体现「交出真实成果」）。 */
  deliverable?: string;
  /** 回答用等宽字体渲染（代码场景）。 */
  mono?: boolean;
};

/**
 * 落地页动态演示脚本 —— 场景取材自真实用户会话（连锁门店运营做经营看板、科研评阅长文档、
 * 求职者投简历、开发者连 GitHub 改代码、科研团队多智能体协作、联网做行业调研），
 * 刻意避开玩具例子，突出「上传文件 → 多步用工具干活 → 交出可用交付物」的 agent 能力。
 * 纯展示文案，不发任何真实请求。
 */
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "dashboard",
    tab: "数据看板",
    icon: LayoutDashboard,
    prompt:
      "（上传门店销售明细.xlsx）帮我做一个能按年份、地区切换的业绩看板，再分析这个月业绩下滑主要出在哪个板块",
    steps: [
      { label: "读取 Excel 12 张表" },
      { label: "清洗 8600 行订单" },
      { label: "生成交互式图表" },
      { label: "归因下滑板块" },
    ],
    answer:
      "已生成可交互看板：三年各月业绩曲线，支持按年份 / 地区切换对比。\n本月环比 −14%，其中约 72% 的降幅来自「私教续卡」板块；体验课转化率同比反而 +5%。\n下滑归因与改进建议已一并写进报告。",
    deliverable: "门店业绩看板.html",
  },
  {
    id: "report",
    tab: "写报告",
    icon: FileText,
    prompt:
      "（上传技术报告.docx）读完这份 58 页报告，帮我评阅论证漏洞，再给一份带图表和参考文献的修订版 Word",
    steps: [
      { label: "解析 2.4MB 文档" },
      { label: "联网核对 12 篇文献" },
      { label: "补充仿真配图" },
      { label: "导出 Word" },
    ],
    answer:
      "已通读全文：指出 3 处论证链断点、5 处术语前后不一致，并在修订版里逐条补齐、标注修改说明。\n新增 4 张示意图与 12 条可溯源参考文献，排版沿用原模板。",
    deliverable: "技术报告_修订版.docx",
  },
  {
    id: "job",
    tab: "找工作",
    icon: Briefcase,
    prompt:
      "（上传我的简历.pdf）帮我推荐能投的岗位方向，要求薪资 6k+、双休、佛山/杭州/深圳，也说说我能转的 AI 相关方向",
    steps: [
      { label: "解析简历经历" },
      { label: "联网查在招岗位" },
      { label: "按约束匹配打分" },
    ],
    answer:
      "结合你的销售经历匹配了三条路径：\n① 本行销售岗（佛山 / 深圳，6–9k、双休）— 匹配度最高，附 5 家在招公司\n② B 端客户运营 — 可迁移「大客户攻坚」经验\n③ AI 应用方向 — 给了一份 4 周入门路线\n完整对照表已导出。",
    deliverable: "求职方向对照表.xlsx",
  },
  {
    id: "code",
    tab: "改代码",
    icon: GitBranch,
    prompt: "连上我的 GitHub 仓库（Vue3 项目），把移动端两个页面重新设计一下，build 通过后提交并推送",
    steps: [
      { label: "clone 仓库" },
      { label: "重构 2 个页面组件" },
      { label: "本地 build 验证" },
      { label: "git commit & push" },
    ],
    answer:
      "已 clone 仓库并重设计「我的项目」「项目物料清单」两个移动端页面，统一了导航与卡片样式。\nnpm run build 通过，改动已提交并推送到 main 分支。\n附上改动点清单与前后对比截图。",
    deliverable: "已推送 GitHub · 6 个文件变更",
  },
  {
    id: "team",
    tab: "团队协作",
    icon: Users,
    prompt: "组一个科研小组，帮我综述钠离子电池负极材料的最新进展，要有证据和引用",
    steps: [
      { label: "队长拆成 4 个子问题" },
      { label: "研究员检索 18 篇论文" },
      { label: "工程师复现关键数据" },
      { label: "审查员复核证据链" },
    ],
    answer:
      "四人小组协作完成：\n· 研究员梳理了硬碳 / 合金类 / 转化型三条技术路线\n· 工程师复算了关键容量与循环数据（附对比图）\n· 审查员逐条核对引用，标出 2 处结论待确认\n队长汇总成「结论 / 证据 / 局限 / 下一步」四段式综述。",
    deliverable: "钠电负极材料综述.docx",
  },
  {
    id: "research",
    tab: "深度调研",
    icon: Globe,
    prompt: "帮我联网调研新茶饮赛道：头部品牌、价格带、近期爆品和用户吐槽，出一份带图表的分析报告",
    steps: [
      { label: "联网检索 20+ 来源" },
      { label: "抓取门店与价格数据" },
      { label: "交叉核对事实" },
      { label: "生成图表成文" },
    ],
    answer:
      "已汇总 6 个头部品牌的价格带、上新节奏与近三月爆品，并按维度做了对比图。\n用户吐槽集中在「排队久 / 甜度不稳」两点，附差异化机会点。\n全文结论均标注来源，可点开溯源。",
    deliverable: "新茶饮赛道分析.pdf",
  },
];
