import type { AtelierIconName } from "../ui/AtelierIcons";
import type { ProductFeatureId } from "../../lib/productCapabilities";

export type PracticalGuideCategory = "all" | "research" | "coding" | "office" | "web-auto";

export interface PracticalGuideCategoryOption {
  id: PracticalGuideCategory;
  label: string;
}

export interface PracticalGuideBasicItem {
  id: string;
  title: string;
  description: string;
  icon: AtelierIconName;
}

export interface PracticalGuideScenario {
  id: string;
  category: Exclude<PracticalGuideCategory, "all">;
  categoryLabel: string;
  title: string;
  deliverable: string;
  capabilities: readonly string[];
  prompt: string;
  tips: readonly [string, string, string];
  relatedTopics: readonly ProductFeatureId[];
}

export const GUIDE_BASICS_STORAGE_KEY = "oc:v5:guide-basics-collapsed:v1";

export const PRACTICAL_GUIDE_CATEGORIES: readonly PracticalGuideCategoryOption[] = [
  { id: "all", label: "全部" },
  { id: "research", label: "科研" },
  { id: "coding", label: "编程" },
  { id: "office", label: "办公交付" },
  { id: "web-auto", label: "建站与自动" },
] as const;

export const PRACTICAL_GUIDE_BASICS: readonly PracticalGuideBasicItem[] = [
  {
    id: "workbench-annotate",
    title: "左聊右看，直接批注",
    description: "右侧工作台预览产出、文档、表格与网页，点选批注直接追加到输入框。",
    icon: "workbench",
  },
  {
    id: "model-swarm-btw",
    title: "按活选模型，大活开蜂群",
    description: "输入框底部模型胶囊切强模型与思考深度，复杂任务开蜂群并行，或敲 /btw 支线快问不打断主线。",
    icon: "swarm",
  },
  {
    id: "files-projects-cron",
    title: "拖文件、建项目、设定时",
    description: "PDF、表格、图片直接拖入，同类长期任务归项目，口头一句话建定时任务。",
    icon: "tasks",
  },
  {
    id: "approval-takeover",
    title: "关键动作会等你拍板",
    description: "高风险操作在对话内弹审批卡，云浏览器遇登录时右侧一键接管。",
    icon: "shield",
  },
] as const;

export const PRACTICAL_GUIDE_SCENARIOS: readonly PracticalGuideScenario[] = [
  {
    id: "research-paper-review",
    category: "research",
    categoryLabel: "科研",
    title: "科研读论文与写综述",
    deliverable: "拆出多篇论文的核心方法对比表、技术脉络与带溯源页码的综述初稿，右侧工作台直接核对。",
    capabilities: ["附件多模态", "联网检索", "工作台"],
    prompt:
      "请阅读我上传的几篇论文 PDF，并结合近两年公开文献写一份结构化综述：先用对比表列出各篇的问题定义、核心方法、数据集与局限性，再归纳三条主要技术路线；所有关键数据和结论必须标注对应出处与页码，无法核实的内容请明确注明，不要猜测。",
    tips: [
      "把已有 PDF 直接拖进输入框再补一句联网检索范围，能大幅减少漏读和跑偏。",
      "要求每条结论附来源链接或页码，生成后在右侧工作台逐条核对原文最省心。",
      "需要微调某段表述时，直接在右侧工作台点选批注，不必让整篇重写。",
    ],
    relatedTopics: ["web-research", "files-media", "artifacts-download"],
  },
  {
    id: "data-sheet-analysis",
    category: "research",
    categoryLabel: "科研",
    title: "表格与公开数据分析",
    deliverable: "自动清洗 Excel/CSV 数据、跑统计分析并交付带可视化图表的交互报告和结果表。",
    capabilities: ["文件上传", "代码执行", "交互报告"],
    prompt:
      "请分析我上传的数据表：先排查缺失值、重复记录与异常值并列出清洗规则，再按核心维度汇总趋势、分布与显著差异，生成一份带可视化图表的交互分析报告和清洗后的新 Excel；请把统计口径和关键计算步骤附在文末以便复核。",
    tips: [
      "上传前给工作表和列名起明确名字，多表关联分析时不容易引用错字段。",
      "写清关注的时间范围、分组维度和异常值处理规则，结果会比笼统提问准很多。",
      "先在右侧工作台检查图表和汇总口径，确认无误再一键下载本地 Excel。",
    ],
    relatedTopics: ["files-media", "artifacts-download"],
  },
  {
    id: "code-bugfix-pr-review",
    category: "coding",
    categoryLabel: "编程",
    title: "代码开发、修 Bug 与 PR 审查",
    deliverable: "直连真实仓库定位根因、改码补单测并跑通验收，高风险操作在对话内等你拍板。",
    capabilities: ["GitHub 仓库", "高思考 / 蜂群", "对话审批"],
    prompt:
      "请在当前绑定的仓库中先定位问题根因并给出最小改动方案，确认边界后再改源码并补充回归单测；跑通测试与构建后，汇报改动文件清单、验证输出和待确认风险，不要未经确认直接推送或合并主分支。",
    tips: [
      "首条指令写清改动边界、禁碰目录和验收命令，可避免顺手改动无关模块。",
      "跨文件重构或复杂排查时，在输入框底部模型胶囊调高思考深度或开启蜂群并行推进。",
      "遇到写入、推送或敏感命令时，对话内会弹出审批卡展示影响半径，核对后再拍板。",
    ],
    relatedTopics: ["github-repository", "models-reasoning", "team-mode"],
  },
  {
    id: "office-deep-delivery",
    category: "office",
    categoryLabel: "办公交付",
    title: "PPT / Word / Excel 深度交付",
    deliverable: "直接生成可编辑的 .pptx / .docx / .xlsx 成品，并在右侧工作台逐页或按单元格批注修订。",
    capabilities: ["工作台产出", "逐页 / 单元格批注"],
    prompt:
      "请基于我提供的材料整理一份 10 页以内的汇报 PPT（.pptx）和一页管理层摘要 Word（.docx）：每页聚焦一个明确结论并配关键数据支撑，结尾列出行动项、负责人与时间节点；生成后请在右侧工作台展示以便我逐页批注。",
    tips: [
      "开头明确说出要 .pptx、.docx 还是 .xlsx，以及受众是谁，避免只得到纯文字大纲。",
      "在右侧工作台预览时，点具体幻灯片或表格单元格留批注，多条批注会顺序追加到输入框。",
      "要求每次修订附一段简短变更清单，多轮改稿时一眼能核对改了哪里。",
    ],
    relatedTopics: ["artifacts-download", "files-media", "chat-basics"],
  },
  {
    id: "site-build-and-host",
    category: "web-auto",
    categoryLabel: "建站与自动",
    title: "一句话做网站并长期上线",
    deliverable: "快速搭出响应式网页，在右侧容器预览点选元素逐条调样式，定稿后直接托管上线。",
    capabilities: ["容器预览", "元素评论", "站点托管"],
    prompt:
      "请帮我做一个简洁清晰的产品展示与联系页面，同时适配桌面端和手机端，包含核心介绍、特性展示、常见问题和留资表单；先启动容器预览让我逐个元素评论微调，确认视觉和交互达标后再准备上线版本。",
    tips: [
      "打开右侧容器预览后，切到「选元素评论」直接点按钮或模块留言，比文字形容位置准确得多。",
      "在预览栏切换手机视口检查一遍，确认窄屏排版无溢出、按钮好点。",
      "可以一次累计多条元素评论统一发回修改，几轮就能收口到上线标准。",
    ],
    relatedTopics: ["container-web-preview", "artifacts-download"],
  },
  {
    id: "scheduled-monitor-digest",
    category: "web-auto",
    categoryLabel: "建站与自动",
    title: "自动定时巡检与日报提醒",
    deliverable: "用自然语言定好周期规则，按时自动拉取变化、汇总日报并沿用你的长期偏好格式送达。",
    capabilities: ["定时任务", "长期记忆"],
    prompt:
      "请帮我创建一个定时任务：每个工作日 18:00 汇总今天这个项目的关键进展、待解决风险和明日第一优先级，按「结论 / 风险 / 下一步」三段输出并发送到网页对话；请先用当前上下文试跑一版给我确认格式。",
    tips: [
      "先试跑一次核对模板和口径，满意后再设为周期执行，省得每天收到冗余消息。",
      "把固定的汇报结构、术语偏好写入长期记忆，后续定时任务都会自动沿用。",
      "在「管理中心 → 定时任务」可随时查看下一次执行时间、暂停或调整周期。",
    ],
    relatedTopics: ["schedules-reminders", "memory-auto-dream", "inbox"],
  },
  {
    id: "cloud-browser-takeover",
    category: "office",
    categoryLabel: "办公交付",
    title: "跨网页实操与云浏览器接管",
    deliverable: "在云端实时浏览器里跨站查价、采资料与整理对比，遇登录或验证时右侧一键接管。",
    capabilities: ["云端实时浏览器", "一键接管"],
    prompt:
      "请用云端浏览器依次查看这几个公开页面的最新方案、价格与更新记录，整理成一张横向对比表并保留原文链接；如果页面需要登录或人机校验，请暂停并提醒我接管，等我处理完再继续收集整理。",
    tips: [
      "切到右侧工作台的「浏览器」标签，就能实时看见 AI 当前打开和操作到哪一步。",
      "遇到账号登录或验证码时点一键接管亲自操作，绝不要把密码或验证码发到对话框里。",
      "涉及外部提交、发布或下单等写入动作，明确要求先停下来汇报再等你确认。",
    ],
    relatedTopics: ["web-research", "connectors"],
  },
  {
    id: "swarm-parallel-btw",
    category: "coding",
    categoryLabel: "编程",
    title: "多线并行：蜂群分工 + /btw 快问",
    deliverable: "大任务由蜂群多角色并行拆解推进，期间用 /btw 支线快问随查随答，不打断主线执行。",
    capabilities: ["蜂群模式", "/ 命令"],
    prompt:
      "这个任务包含多个可独立推进的子模块，请拆成并行分工：一路负责资料调研与接口核对，一路负责主逻辑实现，一路负责边界测试与验收；各路完成后汇总成统一交付说明和未决事项清单。",
    tips: [
      "行首输入 /swarm 或在输入框底部模型胶囊开启蜂群，即可让复杂任务自动分工并行；按 ⌥/Alt+S 随时开合蜂群看板。",
      "主线执行期间想顺手查概念或问细节，行首敲 /btw 或 /ask 开支线快问，默认继承主强模型且不打断主线。",
      "单点小问题保持单兵更快更省，只有能拆成独立子目标的复杂任务再开蜂群。",
    ],
    relatedTopics: ["team-mode", "models-reasoning", "taskboard"],
  },
] as const;

export function visibleScenarioRelatedTopics(
  relatedTopics: readonly ProductFeatureId[],
  taskboardEnabled: boolean,
): readonly ProductFeatureId[] {
  return taskboardEnabled
    ? relatedTopics
    : relatedTopics.filter((topicId) => topicId !== "taskboard");
}
