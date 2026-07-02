import {
  Briefcase,
  GitBranch,
  Globe,
  LayoutDashboard,
  type LucideIcon,
  Presentation,
  Users,
} from "lucide-react";

/** 演示中助手「执行动作」的瞬时提示（拆计划 / 跑代码 / 联网 / 委派…），逐条揭示以还原 agent 干活过程。 */
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
      pages: { h: string; body: "cover" | "lines" | "chart" | "table"; sub?: string }[];
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
  /** 长程任务元信息（答案打完后呈现）：自主执行了多少步、跑了多久 —— 体现「交出去就不用管」。 */
  runMeta?: string;
  /** 任务产出的可交付文件（成果面板头部呈现，体现「交出真实成果」）。 */
  deliverable?: string;
  /** 成果预览面板：交付物长什么样，直接画出来。 */
  artifact: Artifact;
  /** 回答用等宽字体渲染（代码场景）。 */
  mono?: boolean;
};

/**
 * 落地页动态演示脚本 —— 全部为**虚构的示意场景与示意数据**（不含任何真实用户数据），
 * 用于展示 agent 处理长程复杂任务的工作方式：拆解计划 → 反复执行 / 自检修正 → 交付成果。
 * 纯展示文案，不发任何真实请求。
 */
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "analysis",
    tab: "数据分析",
    icon: LayoutDashboard,
    prompt:
      "（上传门店经营数据.xlsx）分析 12 家门店上季度的坪效和外卖占比，找出拖后腿的门店和原因，出图给我",
    steps: [
      { label: "制定 6 步分析计划" },
      { label: "跑 Python 清洗 3 万行流水 · 21 轮" },
      { label: "发现 2 处口径异常，自动修正重跑" },
      { label: "逐店交叉验证 · 生成对比图" },
    ],
    answer:
      "12 家门店按坪效分了三档：城西、老街两店垫底，主因是外卖占比不足 15%、午市空转严重；中心、湖畔等 4 店健康。图表已生成，附了每家店的原因标注和整改建议。",
    runMeta: "自主执行 46 步 · 全程 14 分钟，无需盯着",
    deliverable: "门店坪效诊断.png",
    artifact: {
      kind: "chart",
      title: "门店坪效指数（上季度）",
      bars: [
        { label: "中心店", value: 86, tier: "mid" },
        { label: "湖畔店", value: 79, tier: "mid" },
        { label: "科技园", value: 74, tier: "mid" },
        { label: "北广场", value: 66, tier: "dim" },
        { label: "东门店", value: 58, tier: "dim" },
        { label: "老街店", value: 41, tier: "hot" },
        { label: "城西店", value: 33, tier: "hot" },
      ],
      note: "拖后腿：城西 / 老街 —— 外卖占比 <15%",
    },
  },
  {
    id: "ppt",
    tab: "做 PPT",
    icon: Presentation,
    prompt: "（上传季度销售数据.xlsx）做一份 10 页的季度经营复盘 PPT，图表齐全，能直接给管理层汇报",
    steps: [
      { label: "解析数据 · 定 10 页大纲" },
      { label: "跑分析产出 8 张图表" },
      { label: "生成 PPT 初稿" },
      { label: "逐页自检排版 · 3 轮修正" },
    ],
    answer:
      "10 页复盘 PPT 已完成：营收结构 → 渠道对比 → 毛利变化 → 问题诊断 → 下季度行动计划，8 张图表全部由数据现算。逐页预览自检了 3 轮，排版和数字口径都核过，可直接上会。",
    runMeta: "自主执行 58 步 · 全程 22 分钟，含 3 轮自检修正",
    deliverable: "季度经营复盘.pptx",
    artifact: {
      kind: "slides",
      title: "季度经营复盘 · 10 页",
      pages: [
        { h: "Q2 经营复盘", body: "cover", sub: "管理层汇报版 · 数据现算" },
        { h: "营收结构", body: "chart" },
        { h: "渠道对比", body: "table" },
        { h: "下季度行动计划", body: "lines" },
      ],
      note: "16:9 · 逐页自检 3 轮",
    },
  },
  {
    id: "job",
    tab: "找工作",
    icon: Briefcase,
    prompt: "（上传我的简历.pdf）帮我在目标城市找匹配的岗位，筛掉不双休的，按匹配度排一张表",
    steps: [
      { label: "解析简历 · 提炼优势画像" },
      { label: "联网检索 40+ 在招岗位" },
      { label: "逐条核对薪资与双休线索" },
      { label: "匹配打分 · 排序成表" },
    ],
    answer:
      "按你的经历匹配出三类优先方向，联网核对了 40 多个在招岗位，筛掉了大小周和线索存疑的，最终留下 12 个，按匹配度排成一张表，每条都附招聘页链接可以直接投。",
    runMeta: "自主执行 31 步 · 逐条核对来源，全程 9 分钟",
    deliverable: "岗位推荐表.xlsx",
    artifact: {
      kind: "table",
      title: "岗位推荐（按匹配度排序）",
      head: ["优先级", "方向 · 岗位", "月薪", "匹配"],
      rows: [
        ["P0", "智能硬件 · 海外渠道销售", "9-13k", "93%"],
        ["P1", "跨境电商 · 大客户经理", "8-12k", "87%"],
        ["P2", "企业服务 · 解决方案销售", "7-10k", "82%"],
      ],
      note: "共 12 条 · 每条附招聘页链接，双休已核",
    },
  },
  {
    id: "code",
    tab: "改代码",
    icon: GitBranch,
    prompt: "连上我的 GitHub 仓库，把报表导出从同步接口改成异步任务队列，加上进度查询，测试通过后提交推送",
    steps: [
      { label: "通读仓库结构 · 120+ 文件" },
      { label: "制定 5 步改造计划" },
      { label: "改 6 个文件" },
      { label: "跑测试 · 4 轮修复直到全绿" },
      { label: "git 提交推送" },
    ],
    answer:
      "已完成并推送：导出改为异步任务队列，新增进度查询接口，失败自动重试 3 次并保留原同步接口兜底。中途测试挂了 4 次，都自己修好了 —— 最终 42 个测试全绿，没来打扰你一次。",
    runMeta: "自主执行 73 步 · 全程 26 分钟，含 4 轮测试修复",
    deliverable: "已推送 main · 测试 42/42",
    artifact: {
      kind: "diff",
      title: "6 个文件改动",
      file: "src/export/async-export.service.ts",
      lines: [
        { t: "ctx", code: "@@ 导出改异步任务队列 @@" },
        { t: "add", code: "+ enqueueExportJob(params)  // 入队" },
        { t: "add", code: "+ GET /exports/:id/progress" },
        { t: "add", code: "+ retry(3) + fallbackSync()" },
        { t: "del", code: "- return syncExport(params)" },
      ],
      note: "✓ 测试 42/42 全绿 · 已推送 main",
    },
  },
  {
    id: "team",
    tab: "团队协作",
    icon: Users,
    prompt: "组个小组：把这份 30 页的产品手册翻成英文，术语前后要统一，翻完交叉审校一遍再交给我",
    steps: [
      { label: "队长拆解 30 页 · 分派子任务" },
      { label: "翻译员分章推进" },
      { label: "术语官统一 200+ 术语" },
      { label: "审校员逐页交叉复核" },
    ],
    answer:
      "小组按「子任务账本」协作完成：翻译员分章翻完 30 页，术语官统一了 216 条术语，审校员交叉复核修正 37 处。队长汇总交付，全程自主协作，你只需要看最终稿。",
    runMeta: "3 名成员并行 · 全程 38 分钟自主协作",
    deliverable: "产品手册_EN.docx",
    artifact: {
      kind: "board",
      title: "子任务账本",
      tasks: [
        { role: "翻译员", task: "分章翻译 30 页", state: "完成" },
        { role: "术语官", task: "统一术语表 216 条", state: "完成" },
        { role: "审查员", task: "交叉复核 · 修正 37 处", state: "通过" },
      ],
      note: "队长汇总交付 · 过程账本可回看",
    },
  },
  {
    id: "research",
    tab: "深度调研",
    icon: Globe,
    prompt: "调研跨境电商物流赛道：主要玩家、价格模式、近期政策变化，出一份带来源的分析报告",
    steps: [
      { label: "联网检索 30+ 来源" },
      { label: "抓取价格与时效数据" },
      { label: "交叉核对矛盾信息" },
      { label: "成文 · 逐条核对引用" },
    ],
    answer:
      "报告已成文：5 家头部服务商的价格模式与时效对比、近半年 3 项政策变化的影响、以及「时效 vs 成本」的机会区间。检索了 34 个来源，矛盾数据做了交叉核对，关键结论都附来源可点开验证。",
    runMeta: "检索 34 个来源 · 全程 17 分钟",
    deliverable: "跨境物流赛道分析.pdf",
    artifact: {
      kind: "report",
      title: "跨境电商物流赛道分析",
      sources: "34 个来源 · 已交叉核对",
      bullets: [
        { text: "5 家头部服务商价格模式对比", refs: "[1][4]" },
        { text: "近半年 3 项政策变化及影响", refs: "[6][9]" },
        { text: "时效 vs 成本的机会区间", refs: "[11]" },
        { text: "风险与合规要点 ×4", refs: "[14]" },
      ],
      note: "关键结论均附来源链接",
    },
  },
];
