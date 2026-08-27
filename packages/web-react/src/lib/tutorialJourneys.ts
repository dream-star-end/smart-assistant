import type { ProductFeatureId } from "./productCapabilities";

/** 案例卡片与详情页统一使用的待采集声明，禁止把 pending_capture 包装成已完成故事。 */
export const TUTORIAL_PENDING_CAPTURE_LABEL = "示例待真实运行采集";

export type TutorialQuickstartStep = {
  id: string;
  title: string;
  body: string;
  topicId: ProductFeatureId;
};

export type TutorialScenarioPath = {
  id: string;
  title: string;
  description: string;
  topicIds: readonly ProductFeatureId[];
};

/**
 * 教程中心默认主线：约 10 分钟走完第一次任务。
 * 只引用现有 TUTORIAL_TOPICS id，不自带媒体、不假设新录制。
 */
export const TUTORIAL_QUICKSTART = {
  id: "first-ten-minutes",
  title: "10 分钟走完第一次任务",
  summary:
    "先发一条任务，补上材料和约束，选好模型，看它怎么做，拿走成果后再从历史继续。",
  estimatedMinutes: 10,
  steps: [
    {
      id: "send-first-task",
      title: "发第一个任务",
      body: "第一句先讲清最终要拿到什么。不必一次写完美，把模糊想法交给工作区即可。",
      topicId: "chat-basics",
    },
    {
      id: "add-materials",
      title: "补材料与约束",
      body: "把文件、图片、受众、格式和不能做的事一起给它，减少来回解释。",
      topicId: "files-media",
    },
    {
      id: "pick-model",
      title: "选模型",
      body: "按任务选模型。需要更强推理或特定引擎时再换，不必每次都改。",
      topicId: "models-reasoning",
    },
    {
      id: "watch-process",
      title: "看执行过程",
      body: "运行时看思考、工具卡和进度。方向不对再停止或追问，不要反复催促。",
      topicId: "chat-basics",
    },
    {
      id: "take-delivery",
      title: "拿交付并用反馈迭代",
      body: "从成果卡片拿走文件，指出具体问题让它改，而不是从头重说一遍。",
      topicId: "artifacts-download",
    },
    {
      id: "continue-from-history",
      title: "用会话历史继续",
      body: "同一件事下次从历史里接着做，不必重新交代背景。",
      topicId: "sessions-history",
    },
  ],
} as const satisfies {
  id: string;
  title: string;
  summary: string;
  estimatedMinutes: number;
  steps: readonly TutorialQuickstartStep[];
};

export const TUTORIAL_SCENARIO_PATHS = [
  {
    id: "writing-office",
    title: "写作与办公",
    description: "写报告、方案和邮件，并留下可继续改的成品。",
    topicIds: ["chat-basics", "files-media", "artifacts-download", "memory-auto-dream"],
  },
  {
    id: "coding-github",
    title: "编程与 GitHub",
    description: "改仓库、修问题、看预览，再把结果交回去。",
    topicIds: ["github-repository", "models-reasoning", "container-web-preview", "artifacts-download"],
  },
  {
    id: "research-literature",
    title: "研究与文献",
    description: "查资料、读文献、整理证据，写成可核对的结论。",
    topicIds: ["web-research", "files-media", "artifacts-download", "memory-auto-dream"],
  },
  {
    id: "automation-connectors",
    title: "自动化与连接器",
    description: "接上外部账号，让重复工作按点执行。",
    topicIds: ["connectors", "schedules-reminders", "skills-training", "marketplace-discovery"],
  },
  {
    id: "team-delegation",
    title: "团队协作与委派",
    description: "把大任务拆给多个助手，并查看团队如何推进。",
    topicIds: ["taskboard", "team-mode", "agents", "inbox"],
  },
] as const satisfies readonly TutorialScenarioPath[];
