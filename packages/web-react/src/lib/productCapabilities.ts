/**
 * v5 用户能力单一权威。
 *
 * 这里登记的是「用户能主动进入的一等能力」，不是每个保存/删除/关闭按钮。侧栏、各中心
 * 顶层 Tabs、教程目录、教程动作与同步检查都消费同一份 registry，避免功能入口与教程各自
 * 维护一套清单。稳定 id 会进入 URL 与 localStorage，发布后不得改名；改标题不改 id。
 */

export type ProductFeatureCategory =
  "start" | "create" | "automate" | "extend" | "account";

export type ManageDestinationTab =
  "memory" | "cron" | "skills" | "connectors" | "library";
export type SettingsDestinationSection =
  | "account"
  | "usage"
  | "preferences"
  | "hotkeys"
  | "feedback"
  | "about"
  | "github"
  | "plugins";
export type MarketplaceDestinationTab = "browse" | "installed" | "publish";
export type MarketplaceDestinationKind = "skill" | "agent" | "connector";
export type OrgDestinationSection =
  "overview" | "members" | "skills" | "reports" | "invoices";

export type TutorialDestination =
  | { kind: "new-chat" }
  | { kind: "focus"; target: string }
  | { kind: "agent-picker" }
  | { kind: "settings"; section: SettingsDestinationSection }
  | { kind: "manage"; tab: ManageDestinationTab }
  | {
      kind: "market";
      tab: MarketplaceDestinationTab;
      marketKind?: MarketplaceDestinationKind;
    }
  | { kind: "inbox" }
  | { kind: "github" }
  | { kind: "org"; section: OrgDestinationSection };

export type ProductRequirement =
  "authenticated" | "image2" | "microphone" | "org-manager";

export type ProductCapability = {
  id: string;
  title: string;
  shortTitle: string;
  category: ProductFeatureCategory;
  icon: string;
  aliases: readonly string[];
  destination: TutorialDestination;
  requirements: readonly ProductRequirement[];
};

export const PRODUCT_CAPABILITIES = {
  chatBasics: {
    id: "chat-basics",
    title: "开始一场高质量对话",
    shortTitle: "对话入门",
    category: "start",
    icon: "message",
    aliases: ["聊天", "发送", "提示词", "继续", "重新生成", "评价"],
    destination: { kind: "focus", target: "chat-basics" },
    requirements: ["authenticated"],
  },
  sessions: {
    id: "sessions-history",
    title: "会话、搜索与跨端历史",
    shortTitle: "会话历史",
    category: "start",
    icon: "history",
    aliases: ["侧栏", "历史", "重命名", "删除", "归档", "跨设备"],
    destination: { kind: "focus", target: "sessions-history" },
    requirements: ["authenticated"],
  },
  models: {
    id: "models-reasoning",
    title: "选择模型与思考深度",
    shortTitle: "模型与思考",
    category: "start",
    icon: "cpu",
    aliases: ["GPT", "DeepSeek", "GLM", "推理", "思考档位", "模型"],
    destination: { kind: "focus", target: "models-reasoning" },
    requirements: ["authenticated"],
  },
  files: {
    id: "files-media",
    title: "上传文件、图片与多媒体",
    shortTitle: "文件与附件",
    category: "create",
    icon: "paperclip",
    aliases: ["附件", "PDF", "Excel", "Word", "图片", "视频", "上传"],
    destination: { kind: "focus", target: "files-media" },
    requirements: ["authenticated"],
  },
  voice: {
    id: "voice-input",
    title: "用语音快速描述任务",
    shortTitle: "语音输入",
    category: "create",
    icon: "mic",
    aliases: ["录音", "转写", "麦克风", "口述"],
    destination: { kind: "focus", target: "voice-input" },
    requirements: ["authenticated", "microphone"],
  },
  research: {
    id: "web-research",
    title: "联网调研、引用与文献库",
    shortTitle: "联网与研究",
    category: "create",
    icon: "search",
    aliases: ["搜索", "网页", "文献", "论文", "引用", "研究", "联网"],
    destination: { kind: "manage", tab: "library" },
    requirements: ["authenticated"],
  },
  artifacts: {
    id: "artifacts-download",
    title: "预览并下载 AI 交付物",
    shortTitle: "成果与下载",
    category: "create",
    icon: "download",
    aliases: ["文件", "报告", "PPT", "Excel", "网页", "代码", "产物"],
    destination: { kind: "new-chat" },
    requirements: ["authenticated"],
  },
  containerPreview: {
    id: "container-web-preview",
    title: "预览容器网页并按元素评论",
    shortTitle: "容器网页预览",
    category: "create",
    icon: "monitor",
    aliases: [
      "localhost",
      "网页预览",
      "开发服务器",
      "元素选择",
      "UI 评论",
      "移动端适配",
    ],
    destination: { kind: "new-chat" },
    requirements: ["authenticated"],
  },
  images: {
    id: "image-create-edit",
    title: "生成、圈选与修改图片",
    shortTitle: "图片生成编辑",
    category: "create",
    icon: "image",
    aliases: ["生图", "Image 2", "圈选", "改图", "标注", "下载图片"],
    destination: { kind: "focus", target: "files-media" },
    requirements: ["authenticated", "image2"],
  },
  github: {
    id: "github-repository",
    title: "连接 GitHub 仓库协作开发",
    shortTitle: "GitHub 仓库",
    category: "create",
    icon: "git",
    aliases: ["代码", "仓库", "分支", "提交", "推送", "GitHub"],
    destination: { kind: "github" },
    requirements: ["authenticated"],
  },
  agents: {
    id: "agents",
    title: "切换与安装专属智能体",
    shortTitle: "智能体",
    category: "extend",
    icon: "bot",
    aliases: ["助手", "角色", "专家", "预设", "Agent"],
    destination: { kind: "agent-picker" },
    requirements: ["authenticated"],
  },
  teamMode: {
    id: "team-mode",
    title: "让多个智能体组队完成复杂任务",
    shortTitle: "团队模式",
    category: "extend",
    icon: "users",
    aliases: ["并行", "委派", "队长", "审查", "多 Agent", "团队"],
    destination: { kind: "agent-picker" },
    requirements: ["authenticated"],
  },
  memory: {
    id: "memory-auto-dream",
    title: "长期记忆与 Auto-Dream",
    shortTitle: "记忆",
    category: "automate",
    icon: "brain",
    aliases: ["偏好", "画像", "项目记忆", "梦境", "Auto-Dream"],
    destination: { kind: "manage", tab: "memory" },
    requirements: ["authenticated"],
  },
  schedules: {
    id: "schedules-reminders",
    title: "定时任务与提醒",
    shortTitle: "定时任务",
    category: "automate",
    icon: "clock",
    aliases: ["提醒", "计划任务", "cron", "每日", "每周", "自动执行"],
    destination: { kind: "manage", tab: "cron" },
    requirements: ["authenticated"],
  },
  skills: {
    id: "skills-training",
    title: "技能、评测与训练优化",
    shortTitle: "技能与训练",
    category: "extend",
    icon: "sparkles",
    aliases: ["Skill", "评测", "训练", "自动优化", "SKILL.md"],
    destination: { kind: "manage", tab: "skills" },
    requirements: ["authenticated"],
  },
  connectors: {
    id: "connectors",
    title: "管理插件的外部应用账号",
    shortTitle: "插件账号",
    category: "extend",
    icon: "plug",
    aliases: ["插件", "连接器", "Notion", "飞书", "GitHub", "OAuth", "外部应用", "API"],
    destination: { kind: "manage", tab: "connectors" },
    requirements: ["authenticated"],
  },
  marketplace: {
    id: "marketplace-discovery",
    title: "在 AI 市场发现并安装能力",
    shortTitle: "AI 市场",
    category: "extend",
    icon: "store",
    aliases: ["市场", "安装", "更新", "卸载", "技能市场", "智能体市场", "插件市场"],
    destination: { kind: "market", tab: "browse", marketKind: "skill" },
    requirements: ["authenticated"],
  },
  publish: {
    id: "marketplace-publishing",
    title: "创建并发布技能、智能体与插件",
    shortTitle: "创作与发布",
    category: "extend",
    icon: "upload",
    aliases: ["发布", "上架", "审核", "版本", "创作者", "API 插件"],
    destination: { kind: "market", tab: "publish" },
    requirements: ["authenticated"],
  },
  inbox: {
    id: "inbox",
    title: "站内信与服务通知",
    shortTitle: "站内信",
    category: "account",
    icon: "bell",
    aliases: ["消息", "通知", "未读", "公告", "服务通知"],
    destination: { kind: "inbox" },
    requirements: ["authenticated"],
  },
  preferences: {
    id: "preferences",
    title: "外观、默认模型与使用偏好",
    shortTitle: "偏好设置",
    category: "account",
    icon: "settings",
    aliases: ["主题", "深色", "默认模型", "通知", "Auto-Dream"],
    destination: { kind: "settings", section: "preferences" },
    requirements: ["authenticated"],
  },
  billing: {
    id: "billing-usage",
    title: "套餐、积分、用量与 API Key",
    shortTitle: "账户与用量",
    category: "account",
    icon: "wallet",
    aliases: ["充值", "订阅", "账单", "积分", "Token", "缓存", "API Key"],
    destination: { kind: "settings", section: "account" },
    requirements: ["authenticated"],
  },
  organization: {
    id: "organization",
    title: "组织、成员、共享额度与发票",
    shortTitle: "企业组织",
    category: "account",
    icon: "building",
    aliases: ["企业", "团队", "成员", "席位", "报表", "发票", "共享积分"],
    destination: { kind: "org", section: "overview" },
    requirements: ["authenticated", "org-manager"],
  },
  feedback: {
    id: "feedback-support",
    title: "提交问题、建议与体验反馈",
    shortTitle: "反馈与支持",
    category: "account",
    icon: "message-square",
    aliases: ["Bug", "建议", "客服", "帮助", "体验问题"],
    destination: { kind: "settings", section: "feedback" },
    requirements: ["authenticated"],
  },
} as const satisfies Record<string, ProductCapability>;

export type ProductCapabilityKey = keyof typeof PRODUCT_CAPABILITIES;
export type ProductFeatureId =
  (typeof PRODUCT_CAPABILITIES)[ProductCapabilityKey]["id"];

export const PRODUCT_CAPABILITY_LIST = Object.values(
  PRODUCT_CAPABILITIES,
) as ProductCapability[];

const ID_SET = new Set<string>(
  PRODUCT_CAPABILITY_LIST.map((feature) => feature.id),
);

export function isProductFeatureId(
  value: string | null | undefined,
): value is ProductFeatureId {
  return typeof value === "string" && ID_SET.has(value);
}

export function capabilityById(id: ProductFeatureId): ProductCapability {
  const value = PRODUCT_CAPABILITY_LIST.find((feature) => feature.id === id);
  if (!value) throw new Error(`Unknown product capability: ${id}`);
  return value;
}

export const PRODUCT_FEATURE_CATEGORIES: readonly {
  id: ProductFeatureCategory;
  label: string;
  description: string;
}[] = [
  { id: "start", label: "快速开始", description: "从第一条消息到会话与模型" },
  {
    id: "create",
    label: "完成工作",
    description: "文件、研究、图片、代码与成果",
  },
  { id: "automate", label: "记住并自动做", description: "记忆与定时任务" },
  {
    id: "extend",
    label: "扩展能力",
    description: "智能体、团队、技能、插件与市场",
  },
  {
    id: "account",
    label: "账户与团队",
    description: "通知、偏好、用量、组织与反馈",
  },
];
