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
      "按「体验人数 + 转化率」把课时包分成四层：\n· 重点：5 / 8 / 14 课时 —— 转化高、量也够，建议加投\n· 次要：6 / 10 课时\n· 观察：7 课时 —— 样本太小，先放放\n· 待优化：1 / 2 课时 —— 量大但转化偏低\n图表已生成，可直接拿去分配预算。",
    deliverable: "转化率分层分析.png",
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
      "已完成 4 页质量异常调查 PPT 并自检预览：\n1. 异常背景 + 5M1E 初步排查\n2. 1 档 vs 非 1 档 过程指标差异\n3. 4 个 Group 通道级差异分析\n4. 汇总结论与行动计划\n关键影响因子已按程度排序。",
    deliverable: "质量异常调查.pptx",
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
      "按你的「英语本科 + 两段 B 端销售经验」匹配，最适合优先投：外贸 / 跨境电商 B2B / 医药渠道销售。\n已按「6k+、双休倾向、目标城市」筛出一张岗位表：优先级 / 公司岗位 / 薪资双休线索 / 匹配理由 —— 每条都附了招聘来源，可点开核对。",
    deliverable: "岗位推荐表.xlsx",
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
      "已实现并推送：新增全局 ApiManagementGuard —— 按「方法 + 路径」匹配、支持通配、接口可一键关闭返回 403、按 IP 做分钟级限流，并保留恢复通道防误关。\nbuild 通过，已推送到 main。",
    deliverable: "已推送 main · commit 5125c53",
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
      "小组按「子任务账本」协作完成：\n· 研究员：分析原稿、定新中式红金方向\n· 工程师：重制 14 页，保持原页序与 16:9\n· 审查员：独立复核，无阻塞问题\n队长汇总交付，并如实标注了未覆盖项（原动画未保留）。",
    deliverable: "PPT改版_红金版.pptx",
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
      "已汇总 6 个头部品牌的价格带、上新节奏与近三月爆品，并按维度做了对比。\n用户吐槽集中在「排队久 / 甜度不稳」两点，附差异化机会点。\n全文关键结论都附了来源链接，可点开逐条核对。",
    deliverable: "新茶饮赛道分析.pdf",
  },
];
