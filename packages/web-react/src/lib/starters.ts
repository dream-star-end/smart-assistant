import {
  Brain,
  Clock,
  FileSpreadsheet,
  FileText,
  GitBranch,
  Globe,
  ListChecks,
  type LucideIcon,
  Paperclip,
  PenLine,
  Presentation,
  SlidersHorizontal,
  Telescope,
  Terminal,
} from "lucide-react";

export type StarterDeliverable = "file" | "code" | "research" | "automation" | "chat";
export type StarterPrerequisite = "attachment" | "repo" | "context";

export type Starter = {
  id: string;
  label: string;
  prompt: string;
  deliverable: StarterDeliverable;
  outcome: string;
  icon: LucideIcon;
  /** 有前置条件的示例只能用于落地页复制，不能作为会直接发送的首任务卡。 */
  requires?: StarterPrerequisite;
};

export type ClickToRunStarter = Starter & { requires?: undefined };
type DifferentiatedStarter = ClickToRunStarter & {
  deliverable: Exclude<StarterDeliverable, "chat">;
};

/** 全站 starter 文案的单一权威源。 */
export const STARTERS = {
  budget_xlsx: {
    id: "budget_xlsx",
    label: "做表格",
    prompt:
      "帮我做一张 2026 年家庭预算表：收入、固定支出、可变支出各一张分表，带公式自动汇总和一张月度趋势图，做完把 .xlsx 文件发给我",
    deliverable: "file",
    outcome: "产出 .xlsx 文件",
    icon: FileSpreadsheet,
  },
  weekly_brief: {
    id: "weekly_brief",
    label: "联网调研",
    prompt:
      "联网查一下最近一周值得关注的 AI 新工具，挑 3 个，逐个说清适用场景和上手成本，每条都附上原始链接",
    deliverable: "research",
    outcome: "结论 + 原始链接",
    icon: Globe,
  },
  rename_script: {
    id: "rename_script",
    label: "跑脚本",
    prompt:
      "写一个 Python 脚本：把一个文件夹里的发票 PDF 批量重命名成「日期_金额」。先造几个样例文件把它真跑一遍，再把脚本和运行结果发我",
    deliverable: "code",
    outcome: "脚本 + 跑通结果",
    icon: Terminal,
  },
  goal_breakdown: {
    id: "goal_breakdown",
    label: "拆目标",
    prompt:
      "帮我把「三个月内做出一个能收费的小产品」拆成每周可执行的动作清单，标出关键节点和最容易卡住的地方",
    deliverable: "chat",
    outcome: "一份可执行清单",
    icon: ListChecks,
  },
  deck_pptx: {
    id: "deck_pptx",
    label: "做 PPT",
    prompt:
      "帮我做一份 10 页的产品介绍 PPT：封面、痛点、方案、功能、案例、报价、联系方式，风格简洁商务，做完把 .pptx 文件发我",
    deliverable: "file",
    outcome: "产出 .pptx 文件",
    icon: Presentation,
  },
  weekly_report: {
    id: "weekly_report",
    label: "写周报",
    prompt:
      "帮我写一份工作周报：本周进展、卡住的问题、下周计划三段，先按软件研发岗填一份样例让我照着改，最后导出 .docx 文件",
    deliverable: "file",
    outcome: "产出 .docx 文件",
    icon: FileText,
  },
  api_service: {
    id: "api_service",
    label: "写服务",
    prompt:
      "用 FastAPI 写一个待办事项的 REST 服务，SQLite 存储，带 pytest 用例。跑通测试后把代码和测试输出发我",
    deliverable: "code",
    outcome: "代码 + 测试通过",
    icon: Terminal,
  },
  lit_review: {
    id: "lit_review",
    label: "做综述",
    prompt:
      "联网综述一下锂金属负极枝晶抑制的研究进展：按技术路线分类，每类给代表性工作、结论和局限，并标注文献出处",
    deliverable: "research",
    outcome: "分类综述 + 出处",
    icon: Telescope,
  },
  hypothesis_split: {
    id: "hypothesis_split",
    label: "拆假设",
    prompt:
      "帮我把「短视频投放能不能提升复购」拆成可验证的假设，每条给出衡量指标、需要的数据和最小验证方案",
    deliverable: "chat",
    outcome: "可验证的假设表",
    icon: ListChecks,
  },
  scheduled_digest: {
    id: "scheduled_digest",
    label: "定时任务",
    prompt: "每个工作日早上 9 点，汇总昨晚的行业动态要点发给我",
    deliverable: "automation",
    outcome: "每天自动送到",
    icon: Clock,
  },
  memory_profile: {
    id: "memory_profile",
    label: "长期记忆",
    prompt: "记住：我是做母婴电商的，之后回答商业问题都贴着我的行业来",
    deliverable: "chat",
    outcome: "之后都记得",
    icon: Brain,
  },
  copywriting: {
    id: "copywriting",
    label: "写文案",
    prompt: "给新品上线写 3 版朋友圈文案，语气分别专业、亲切、俏皮",
    deliverable: "chat",
    outcome: "3 版可直接用",
    icon: PenLine,
  },
  excel_pivot: {
    id: "excel_pivot",
    label: "上传文件",
    prompt: "（上传 Excel）帮我做一张月度费用透视表，把异常项标出来，做完把文件发回给我",
    deliverable: "file",
    outcome: "回传做好的 .xlsx",
    icon: Paperclip,
    requires: "attachment",
  },
  github_pr: {
    id: "github_pr",
    label: "连 GitHub",
    prompt: "连上我的仓库，优化首页加载速度，跑通构建后提交推送",
    deliverable: "code",
    outcome: "构建跑通并推送",
    icon: GitBranch,
    requires: "repo",
  },
  model_switch: {
    id: "model_switch",
    label: "换模型",
    prompt: "换个更擅长推理的模型，再帮我推演一遍这个定价方案",
    deliverable: "chat",
    outcome: "换个脑子重算",
    icon: SlidersHorizontal,
    requires: "context",
  },
} satisfies Record<string, Starter>;

/** 前两张在类型层强制为非纯聊天交付物，所有卡片都必须自包含。 */
export const FIRST_TASK_STARTERS: readonly [
  DifferentiatedStarter,
  DifferentiatedStarter,
  ...ClickToRunStarter[],
] = [
  STARTERS.budget_xlsx,
  STARTERS.weekly_brief,
  STARTERS.rename_script,
  STARTERS.goal_breakdown,
];

export const PRESET_AGENT_STARTERS: Readonly<
  Record<string, readonly ClickToRunStarter[]>
> = {
  "coding-assistant": [STARTERS.rename_script, STARTERS.api_service],
  "office-assistant": [STARTERS.deck_pptx, STARTERS.budget_xlsx, STARTERS.weekly_report],
  "research-assistant": [STARTERS.lit_review, STARTERS.weekly_brief, STARTERS.hypothesis_split],
};

export const LANDING_STARTERS: readonly Starter[] = [
  STARTERS.excel_pivot,
  STARTERS.scheduled_digest,
  STARTERS.memory_profile,
  STARTERS.weekly_brief,
  STARTERS.copywriting,
  STARTERS.rename_script,
  STARTERS.github_pr,
  STARTERS.model_switch,
];

export function isDifferentiated(starter: Starter): boolean {
  return starter.deliverable !== "chat";
}

export function isClickToRun(starter: Starter): boolean {
  return starter.requires === undefined;
}
