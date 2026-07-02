import {
  Briefcase,
  GitBranch,
  Globe,
  LayoutDashboard,
  type LucideIcon,
  Presentation,
  Users,
} from "lucide-react";

/** 演示中助手「执行动作」的瞬时提示芯片（检索技能 / 跑代码 / 联网 / 委派…），逐条揭示以还原 agent 干活过程。 */
export type DemoStep = { label: string };

/**
 * 成果预览面板的结构化数据 —— 每个场景一种可视化交付物 mock（迷你图表 / PPT 缩略 /
 * 岗位表 / 代码 diff / 协作账本 / 带来源报告），让「交回能直接用的成果」看得见。
 * 纯展示数据，颜色一律走设计 token（单一强调色 + 中性灰，文字用文本 token）。
 */
export type Artifact =
  | {
      kind: "chart";
      title: string;
      /** 横向条形行：label + 百分比值；tier 决定条色（hot=强调色 / mid=灰 / dim=浅灰）。 */
      bars: { label: string; value: number; tier: "hot" | "mid" | "dim" }[];
      note: string;
    }
  | {
      kind: "slides";
      title: string;
      /** 幻灯片缩略：首页大标题页 + 内容页（h=页标题，body 决定占位样式）。 */
      pages: { h: string; body: "cover" | "lines" | "chart" | "table" }[];
      note: string;
    }
  | {
      kind: "table";
      title: string;
      head: string[];
      rows: string[][];
      note: string;
    }
  | {
      kind: "diff";
      title: string;
      file: string;
      lines: { t: "add" | "del" | "ctx"; code: string }[];
      note: string;
    }
  | {
      kind: "board";
      title: string;
      tasks: { role: string; task: string; state: string }[];
      note: string;
    }
  | {
      kind: "report";
      title: string;
      sources: string;
      bullets: { text: string; refs: string }[];
      note: string;
    };

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
  /** 任务产出的可交付文件（成果面板头部呈现，体现「交出真实成果」）。 */
  deliverable?: string;
  /** 成果预览面板：交付物长什么样，直接画出来。 */
  artifact: Artifact;
  /** 回答用等宽字体渲染（代码场景）。 */
  mono?: boolean;
};

/**
 * 落地页动态演示脚本 —— 每一幕都取材自商业版 agent 在生产环境处理真实用户任务的**实际会话**：
 * 提示词、执行动作序列（检索技能→制定计划→跑 Python→自检→委派…）、回答要点与交付物类型，
 * 都对齐真实 rollout 记录（门店转化率分层分析 / 芯片良率质量调查 PPT / 简历岗位匹配 /
 * GitHub 加功能并 build 推送 / 编程小组协作改稿 / 联网带来源调研），只做了脱敏与精简。
 * 纯展示文案，不发任何真实请求。
 */
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "analysis",
    tab: "数据分析",
    icon: LayoutDashboard,
    prompt:
      "（上传抖音/美团获客数据.xlsx）帮我按人看体验课转正课的转化率，分渠道分课时，哪些值得加投？",
    steps: [
      { label: "检索技能库" },
      { label: "制定分析计划" },
      { label: "跑 Python 清洗透视" },
      { label: "生成分层转化图" },
    ],
    answer:
      "按「体验人数 + 转化率」把课时包分成四层：5 / 8 / 14 课时转化高、量也够，建议加投；1 / 2 课时量大但转化偏低，先优化再投。分层图已生成，可直接拿去分配预算。",
    deliverable: "转化率分层分析.png",
    artifact: {
      kind: "chart",
      title: "体验课 → 正课 转化率（按课时包）",
      bars: [
        { label: "14 课时", value: 68, tier: "hot" },
        { label: "8 课时", value: 61, tier: "hot" },
        { label: "5 课时", value: 57, tier: "hot" },
        { label: "10 课时", value: 44, tier: "mid" },
        { label: "6 课时", value: 41, tier: "mid" },
        { label: "2 课时", value: 18, tier: "dim" },
        { label: "1 课时", value: 12, tier: "dim" },
      ],
      note: "建议加投：5 / 8 / 14 课时包",
    },
  },
  {
    id: "ppt",
    tab: "做 PPT",
    icon: Presentation,
    prompt: "（上传生产过程数据.xlsx）帮我查一下 1 档芯片良率为什么上不去，做成一份质量异常调查 PPT",
    steps: [
      { label: "解析 Excel 数据" },
      { label: "制定排查计划" },
      { label: "跑相关性 / 分组分析" },
      { label: "生成 PPT 并自检预览" },
    ],
    answer:
      "已完成 4 页质量异常调查 PPT 并逐页自检：异常背景与 5M1E 排查 → 1 档 vs 非 1 档指标差异 → 通道级差异分析 → 结论与行动计划。关键影响因子已按程度排序。",
    deliverable: "质量异常调查.pptx",
    artifact: {
      kind: "slides",
      title: "质量异常调查 · 4 页",
      pages: [
        { h: "1档芯片良率异常调查", body: "cover" },
        { h: "过程指标差异", body: "chart" },
        { h: "通道级分析", body: "table" },
        { h: "结论与行动计划", body: "lines" },
      ],
      note: "16:9 · 已自检预览",
    },
  },
  {
    id: "job",
    tab: "找工作",
    icon: Briefcase,
    prompt: "（上传我的简历.pdf）帮我推荐能投的公司和岗位，要求 6k+、双休、佛山/杭州/深圳",
    steps: [
      { label: "解析简历经历" },
      { label: "联网查在招岗位" },
      { label: "按约束匹配打分" },
    ],
    answer:
      "按你的「英语本科 + 两段 B 端销售经验」匹配，优先投外贸 / 跨境电商 B2B / 医药渠道销售。已按 6k+、双休、目标城市筛出岗位表，每条都附了招聘来源，可点开核对。",
    deliverable: "岗位推荐表.xlsx",
    artifact: {
      kind: "table",
      title: "岗位推荐（按匹配度排序）",
      head: ["优先级", "公司 · 岗位", "月薪", "匹配"],
      rows: [
        ["P0", "跨境电商 B2B · 外贸销售", "8-12k", "92%"],
        ["P1", "医药渠道 · 区域销售", "7-10k", "88%"],
        ["P2", "SaaS 服务商 · 大客户销售", "6-9k", "81%"],
      ],
      note: "每条附招聘来源链接 · 已核双休线索",
    },
  },
  {
    id: "code",
    tab: "改代码",
    icon: GitBranch,
    prompt: "连上我的 GitHub 仓库，加一个「接口开关 + 按 IP 限流」的功能，build 通过后提交推送",
    steps: [
      { label: "读代码结构" },
      { label: "制定实现计划" },
      { label: "改多个文件" },
      { label: "npm run build 验证" },
      { label: "git 提交推送" },
    ],
    answer:
      "已实现并推送：新增全局 ApiManagementGuard —— 按「方法 + 路径」匹配、支持通配、接口可一键关闭返回 403、按 IP 做分钟级限流，并保留恢复通道防误关。build 通过，已推送到 main。",
    deliverable: "已推送 main · commit 5125c53",
    artifact: {
      kind: "diff",
      title: "3 个文件改动",
      file: "src/guard/api-management.guard.ts",
      lines: [
        { t: "ctx", code: "@@ 接口开关 + IP 限流 @@" },
        { t: "add", code: "+ matchRule(method, path)  // 支持通配" },
        { t: "add", code: "+ if (rule.disabled) throw new 403()" },
        { t: "add", code: "+ rateLimitByIp(ip, 60/min)" },
        { t: "del", code: "- // TODO: api management" },
      ],
      note: "✓ build 通过 · 已推送 main · 5125c53",
    },
  },
  {
    id: "team",
    tab: "团队协作",
    icon: Users,
    prompt: "组个小组：帮我把这份 PPT 改成新中式红金风格，保持页序和 16:9，改完再复核一遍",
    steps: [
      { label: "队长拆解需求" },
      { label: "研究员定设计方向" },
      { label: "工程师重制 PPT" },
      { label: "审查员独立复核" },
    ],
    answer:
      "小组按「子任务账本」协作完成：研究员定新中式红金方向，工程师重制 14 页并保持原页序与 16:9，审查员独立复核无阻塞问题。队长汇总交付，并如实标注了未覆盖项（原动画未保留）。",
    deliverable: "PPT改版_红金版.pptx",
    artifact: {
      kind: "board",
      title: "子任务账本",
      tasks: [
        { role: "研究员", task: "分析原稿 · 定红金设计方向", state: "完成" },
        { role: "工程师", task: "重制 14 页 · 保持页序 16:9", state: "完成" },
        { role: "审查员", task: "独立复核 · 无阻塞问题", state: "通过" },
      ],
      note: "队长汇总交付 · 未覆盖项已如实标注",
    },
  },
  {
    id: "research",
    tab: "深度调研",
    icon: Globe,
    prompt: "帮我联网调研新茶饮赛道：头部品牌、价格带、近期爆品和用户吐槽，出一份带来源的分析",
    steps: [
      { label: "联网检索 20+ 来源" },
      { label: "抓取门店与价格数据" },
      { label: "交叉核对事实" },
      { label: "汇总成文" },
    ],
    answer:
      "已汇总 6 个头部品牌的价格带、上新节奏与近三月爆品，用户吐槽集中在「排队久 / 甜度不稳」两点，附差异化机会点。全文关键结论都附了来源链接，可逐条核对。",
    deliverable: "新茶饮赛道分析.pdf",
    artifact: {
      kind: "report",
      title: "新茶饮赛道分析",
      sources: "20+ 来源 · 已交叉核对",
      bullets: [
        { text: "6 大头部品牌价格带与定位对比", refs: "[1][3]" },
        { text: "近三月爆品与上新节奏", refs: "[5][7]" },
        { text: "用户吐槽：排队久 / 甜度不稳", refs: "[8][12]" },
        { text: "差异化机会点 ×3", refs: "[15]" },
      ],
      note: "关键结论均附来源链接",
    },
  },
];
