/**
 * 「管理中心」视觉预览场景集（UI/UX 改造前后的视觉基线）。
 *
 * 每个场景直接渲染整壳 <ManageCenter open tab=… />，因此截图里同时包含 Dialog 外框 +
 * Tab 条 + 目标面板，能一并暴露壳与面板的密度/对齐问题。
 *
 * mock 数据刻意贴近真实用户数据：中文名称、长短不一的描述、混合状态（启用/停用/
 * 冲突/失效/只读/待更新），目的是暴露真实布局问题（文本溢出、行高、徽章换行），
 * 而不是验证功能。
 *
 * 时间字段的确定性约定：
 *   - 走 relativeTime() 的字段（记忆 mtimeMs / 梦境 finishedAt / 审计 lastSuccessAt）
 *     一律用「相对 now 的固定偏移」，这样每次跑出来的文案恒定（"3 天前"）。
 *   - 走 toLocaleString() 的绝对时间（cron nextRunAt / 文献 createdAt）用固定 ISO，
 *     渲染结果本身就是稳定的绝对日期。
 */
import type { ReactNode } from "react";

import { ManageCenter, type ManageTab } from "../../src/components/ManageCenter";
import { ApiError } from "../../src/lib/api";
import { createMemoryAuthSession } from "../../src/lib/authSession";
import type {
  ConnectorsResponse,
  DeclarativeManagementResponse,
  KnowledgePlanetAutomationGroup,
  KnowledgePlanetAutomationView,
  PluginManagementResponse,
} from "../../src/lib/connectors";
import type {
  AutoDreamOptimizerState,
  AutoDreamReportResponse,
  CronJob,
  MarketplaceMyAgent,
  MemoryDocResponse,
  MemoryIndexResponse,
  PublicModel,
  ResearchLibraryDoc,
  SkillSummary,
} from "../../src/lib/types";

import type { ApiMockTable, Scene } from "./types";

// ── 通用工具 ────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 模块加载时刻锚定一次，保证同一批截图内所有相对时间一致。 */
const NOW = Date.now();
const agoMs = (delta: number) => NOW - delta;
const agoIso = (delta: number) => new Date(NOW - delta).toISOString();

const auth = createMemoryAuthSession(() => {}, "preview-token");

const ok =
  <T,>(value: T) =>
  () =>
    Promise.resolve(value);

/** 永不 resolve —— 用于把面板钉在加载态。 */
const pending = () => new Promise<never>(() => {});

/** reject 一个带中文 message 的 ApiError（apiErrorMessage 会直接展示中文正文）。 */
const fail = (status: number, message: string, code?: string) => () =>
  Promise.reject(new ApiError({ status, message, code, requestId: "req_7c1f9ae04b2d" }));

// ── 共享基础数据 ────────────────────────────────────────────────────────────

/** ManageCenter 的 agents prop（全能助手 + 已安装市场智能体）。 */
const AGENTS: { id: string; name: string }[] = [
  { id: "main", name: "全能助手" },
  { id: "agent_research_9f21", name: "科研助理 · 文献综述" },
  { id: "agent_office_3b7c", name: "办公助手" },
  { id: "agent_xhs_mkt", name: "小红书内容运营" },
];

/** GET /api/marketplace/my-agents（技能面板的「适用智能体」标签源）。 */
const MY_AGENTS: MarketplaceMyAgent[] = [
  {
    id: "main",
    slug: "main",
    name: "全能助手",
    description: "默认智能体，覆盖日常问答、检索、写作与工具调用。",
    installed: true,
    isDefault: true,
  },
  {
    id: "agent_research_9f21",
    slug: "research-assistant",
    name: "科研助理 · 文献综述",
    description: "面向论文写作的检索、引用接地与综述生成。",
    avatarEmoji: "🔬",
    installed: true,
    preset: true,
    version: "1.4.2",
  },
  {
    id: "agent_office_3b7c",
    slug: "office-assistant",
    name: "办公助手",
    description: "表格、周报、会议纪要与邮件草拟。",
    avatarEmoji: "🗂️",
    installed: true,
    preset: true,
    version: "2.0.1",
  },
  {
    id: "agent_xhs_mkt",
    slug: "xhs-content-ops",
    name: "小红书内容运营",
    description: "母婴科普选题、长图排版与发布队列管理。",
    avatarEmoji: "📕",
    installed: true,
    version: "0.9.7",
  },
];

const PUBLIC_MODELS: PublicModel[] = [
  {
    id: "deepseek-v4-pro",
    display_name: "DeepSeek V4 Pro",
    input_per_ktok_credits: 1.2,
    output_per_ktok_credits: 4.8,
    cache_read_per_ktok_credits: 0.12,
    cache_write_per_ktok_credits: 1.5,
  },
  {
    id: "deepseek-v4-flash",
    display_name: "DeepSeek V4 Flash",
    input_per_ktok_credits: 0.3,
    output_per_ktok_credits: 1.1,
  },
];

/** 每个场景都可能被面板顺手调用的通用只读接口。 */
const BASE: ApiMockTable = {
  listMyAgents: ok(MY_AGENTS),
  getPublicModels: ok(PUBLIC_MODELS),
};

function shell(tab: ManageTab): ReactNode {
  return (
    <ManageCenter
      open
      tab={tab}
      auth={auth}
      agentId="main"
      agents={AGENTS}
      onTabChange={() => {}}
      onClose={() => {}}
      onOpenMarketplace={() => {}}
    />
  );
}

// ── 全面优化（Auto-Dream 审计） ──────────────────────────────────────────────

const OPTIMIZER_STATE: AutoDreamOptimizerState = {
  schemaVersion: 2,
  status: "success",
  runId: "run_0f1d5851c9",
  startedAt: agoIso(2 * DAY + 40 * MIN),
  finishedAt: agoIso(2 * DAY),
  lastSuccessAt: agoIso(2 * DAY),
  sessionsReviewed: 137,
  pagesReviewed: 42,
  summary:
    "本周共审计 137 个会话。你在「小红书母婴号」相关任务上重复交代了三次「医疗内容必须带权威源与免责声明」，建议固化为长期记忆；另外发现两条已失效的定时任务和一个从未被调用过的技能，可以清理以减少上下文开销。",
  proposals: [
    {
      id: "prop_mem_muying_disclaimer",
      fingerprint: "fp_a91c",
      category: "memory",
      action: "memory.upsert",
      title: "把「母婴医疗内容必须附权威源 + 免责声明」固化为长期记忆",
      reason:
        "近 30 天内你在 6 个不同会话里重复交代了同一条约束（3 次是在产出被退回后补充的）。固化后智能体在起草母婴科普时会默认带上权威来源与免责声明，不必每次重申。",
      targetId: "memory/xhs-muying-account.md",
      before:
        "---\nname: 小红书母婴号运营手册\ndescription: momo 号的选题、排版与发布节奏\ntype: project\n---\n\n每日 20:00（北京时间）自动发布，队列低于 3 条时补货。",
      after:
        "---\nname: 小红书母婴号运营手册\ndescription: momo 号的选题、排版、发布节奏与医疗内容合规红线\ntype: project\n---\n\n每日 20:00（北京时间）自动发布，队列低于 3 条时补货。\n\n## 医疗内容红线\n- 涉及用药、喂养量、发育指标的结论必须给出权威源（WHO / 中华医学会 / 国家卫健委）。\n- 每篇结尾附「本文不构成医疗建议，具体请遵医嘱」。",
      beforeFingerprint: "fp_before_a91c",
      state: "pending",
      createdAt: agoIso(2 * DAY),
    },
    {
      id: "prop_sched_cleanup",
      fingerprint: "fp_b22e",
      category: "schedule",
      action: "schedule.delete",
      title: "清理两条连续 14 天失败的定时任务",
      reason:
        "「旧站点巡检」与「v3 备份校验」自 7 月 12 日起每次触发都失败（目标服务已下线），继续保留只会产生噪音告警。",
      targetId: "cron/cron_legacy_probe",
      before: '{"id":"cron_legacy_probe","schedule":"*/30 * * * *","enabled":true}',
      after: "（删除）",
      beforeFingerprint: "fp_before_b22e",
      state: "pending",
      createdAt: agoIso(2 * DAY),
    },
    {
      id: "prop_profile_tone",
      fingerprint: "fp_c73d",
      category: "profile",
      action: "profile.update",
      title: "更新用户画像中的沟通偏好：默认中文、先给结论",
      reason: "你在 21 次会话里显式要求「先给结论再展开」，当前画像里没有这条。",
      targetId: "user.md",
      before: "## 沟通偏好\n- 默认中文回复。",
      after:
        "## 沟通偏好\n- 默认中文回复。\n- 先给结论 / 建议，再展开论证；长回答需要带小标题。\n- 涉及架构决策时要给方案对比与显式权衡，不要只报最小改动。",
      beforeFingerprint: "fp_before_c73d",
      state: "conflict",
      createdAt: agoIso(2 * DAY),
      error: "用户画像在生成建议后被改动过，应用前请确认最新内容。",
    },
    {
      id: "prop_plugin_install",
      fingerprint: "fp_d10a",
      category: "plugin",
      action: "plugin.install",
      title: "建议安装「知识星球」插件以自动同步长图发布",
      reason:
        "你在 4 个会话里手工描述了「把这张长图发到星球」的流程；市场已有官方插件可直接完成该动作。",
      targetId: "marketplace/knowledge-planet",
      before: "",
      after: "",
      beforeFingerprint: "fp_before_d10a",
      state: "pending",
      createdAt: agoIso(2 * DAY),
    },
    {
      id: "prop_skill_applied",
      fingerprint: "fp_e55b",
      category: "skill",
      action: "skill.update",
      title: "为 zsxq-publish 技能补充「发布前必须校验字数计数器」步骤",
      reason: "两次发布因超字数被截断。",
      targetId: "skills/zsxq-publish",
      before: "1. 扫码登录\n2. 发主题带图",
      after: "1. 扫码登录\n2. 校验字数计数器\n3. 发主题带图",
      beforeFingerprint: "fp_before_e55b",
      state: "applied",
      createdAt: agoIso(9 * DAY),
      appliedAt: agoIso(9 * DAY),
    },
    {
      id: "prop_setting_dismissed",
      fingerprint: "fp_f01c",
      category: "setting",
      action: "setting.update",
      title: "建议把默认思考深度调到 high",
      reason: "近期复杂任务的一次通过率偏低。",
      targetId: "settings/effort",
      before: "medium",
      after: "high",
      beforeFingerprint: "fp_before_f01c",
      state: "dismissed",
      createdAt: agoIso(12 * DAY),
    },
  ],
};

const OPTIMIZER_EMPTY: AutoDreamOptimizerState = {
  schemaVersion: 2,
  status: "idle",
  sessionsReviewed: 0,
  pagesReviewed: 0,
  proposals: [],
};

const OPTIMIZER_RUNNING: AutoDreamOptimizerState & { progress: Record<string, unknown> } = {
  schemaVersion: 2,
  status: "running",
  runId: "run_2c88fa17b0",
  startedAt: agoIso(6 * MIN),
  lastSuccessAt: agoIso(7 * DAY),
  sessionsReviewed: 118,
  pagesReviewed: 31,
  proposals: OPTIMIZER_STATE.proposals.slice(4),
  progress: {
    stage: "mapping",
    sessionsTotal: 214,
    evidencePagesTotal: 48,
    evidencePagesReviewed: 19,
    mapBatchesTotal: 12,
    mapBatchesCompleted: 5,
    reducePagesTotal: 0,
    reducePagesCompleted: 0,
    synthesisPagesCompleted: 0,
  },
};

// ── 记忆（memdir 文件列表 + 用户画像） ───────────────────────────────────────

const MEMORY_INDEX: MemoryIndexResponse = {
  kind: "index",
  version: "b71f0c2ad9e34556",
  text: [
    "<!-- openclaude-memory-index v2 -->",
    "# Memory Index",
    "",
    "- [沟通与协作偏好](user-preferences.md) — 默认中文、先结论后展开；架构问题要方案对比。",
    "- [小红书母婴号运营手册](xhs-muying-account.md) — momo 号选题日历、20:00 自动发布、补货铁律。",
    "- [V5 商业版发布流程要点](v5-deploy-runbook.md) — 生效面矩阵、部署互斥锁、异常先回退。",
    "- [近期反馈与纠正](feedback-2026-07.md) — 7 月被退回的三类产出与原因。",
    "- [知识星球发布铁律](zsxq-publish-rules.md) — 富文本快捷键会吞正文；图片必须轮询确认。",
    "- [research-agent-citation-grounding-notes](research-agent-citation-grounding-notes.md)",
  ].join("\n"),
  files: [
    {
      file: "user-preferences.md",
      name: "沟通与协作偏好",
      description:
        "默认中文回复；先给结论再展开论证；涉及架构决策时要给方案 A/B/C 对比与显式权衡，不要只报改动量最小的方案。",
      type: "user",
      mtimeMs: agoMs(2 * HOUR),
      size: 1832,
    },
    {
      file: "xhs-muying-account.md",
      name: "小红书母婴号运营手册",
      description: "momo 号的选题日历、长图排版规范、每日 20:00 自动发布与队列补货规则。",
      type: "project",
      mtimeMs: agoMs(28 * HOUR),
      size: 4417,
    },
    {
      file: "v5-deploy-runbook.md",
      name: "V5 商业版发布流程要点",
      description:
        "生效面矩阵（master / dist / runtime 三轴）、部署互斥锁、迁移人工 apply 记账格式，以及「发布期间任何未知异常先回退、后排查」的最高优先级铁律；灰度与 finalize 阶段的处置顺序也在这里。",
      type: "project",
      mtimeMs: agoMs(3 * DAY),
      size: 9126,
    },
    {
      file: "feedback-2026-07.md",
      name: "近期反馈与纠正",
      description: "7 月被退回的三类产出与原因。",
      type: "feedback",
      mtimeMs: agoMs(5 * HOUR),
      size: 742,
    },
    {
      file: "zsxq-publish-rules.md",
      name: "知识星球发布铁律",
      description: "富文本快捷键会吞正文；发布前必须校验字数计数器；图片上传必须轮询确认。",
      type: "reference",
      mtimeMs: agoMs(9 * DAY),
      size: 2054,
    },
    {
      // name 为空 → 回落文件名；type 未登记 → 中性徽章原样展示（测长文件名截断）。
      file: "research-agent-citation-grounding-notes.md",
      name: "",
      description: "",
      type: "scratch",
      mtimeMs: agoMs(16 * DAY),
      size: 388,
    },
  ],
};

const MEMORY_INDEX_EMPTY: MemoryIndexResponse = {
  kind: "index",
  version: "",
  text: "",
  files: [],
};

const DREAM_REPORT: AutoDreamReportResponse = {
  status: "success",
  pendingSessions: 23,
  lastReport: {
    status: "success",
    finishedAt: agoIso(11 * HOUR),
    sessionsReviewed: 18,
    summary:
      "把「母婴科普必须附权威源」与「知识星球发布前校验字数」两条重复出现的约束固化下来，并清理了一条指向已下线服务的旧笔记。",
    created: [{ file: "zsxq-publish-rules.md", action: "created", type: "reference" }],
    updated: [
      { file: "xhs-muying-account.md", action: "updated", type: "project" },
      { file: "user-preferences.md", action: "updated", type: "user" },
    ],
    deleted: [{ file: "v3-legacy-endpoints.md", action: "deleted" }],
  },
};

const DREAM_REPORT_EMPTY: AutoDreamReportResponse = {
  status: "idle",
  pendingSessions: 0,
};

const USER_PROFILE: MemoryDocResponse = {
  target: "user",
  version: "3f2f2ffd9c1a",
  limit: 4000,
  charCount: 486,
  text: [
    "## 基本情况",
    "- 称呼：boss。上海，作息偏晚，重要发布多在夜间窗口。",
    "- 身份：OpenClaude 个人版 / 商业版（Aurora）的产品与架构负责人，同时运营一个小红书母婴科普号。",
    "",
    "## 沟通偏好",
    "- 默认中文；先给结论/建议，再展开论证，长回答带小标题。",
    "- 技术决策要站架构师视角：优先根治而非缝补，多方案要显式写清设计代价与未来债。",
    "- 不接受把妥协方案包装成最优解；短期权衡必须标注「临时方案 + 已知技术债 + 偿还触发条件」。",
    "",
    "## 常用项目",
    "- openclaude-v5-aurora（商业版，canonical 在 /opt/openclaude/openclaude-v5-aurora）",
    "- 个人版 WebChat（vanilla JS ES modules，无 bundler）",
    "- 小红书 momo 号（母婴科普，每日 20:00 自动发布）",
  ].join("\n"),
};

const USER_PROFILE_EMPTY: MemoryDocResponse = {
  target: "user",
  version: "",
  limit: 4000,
  charCount: 0,
  text: "",
};

const memoryWrites: ApiMockTable = {
  putMemory: ok({ ok: true, version: "next-version", charCount: 512, limit: 4000 }),
  putMemoryFile: ok({ ok: true, version: "next-file-version" }),
  deleteMemoryFile: ok(true),
  getMemoryFile: ok({
    content: MEMORY_INDEX.files[0]
      ? [
          "---",
          "name: 沟通与协作偏好",
          "description: 默认中文回复；先给结论再展开论证；架构决策要给方案对比与显式权衡。",
          "type: user",
          "---",
          "",
          "- 默认中文，除非明确要求其他语言。",
          "- 先结论后论证；长回答用小标题分节。",
          "- 架构层面的妥协（语义不对称、权威源分裂）不算「过度工程」的约束范围，该重构就重构。",
          "",
        ].join("\n")
      : "",
    version: "b71f0c2ad9e34556",
  }),
};

// ── 定时任务 ────────────────────────────────────────────────────────────────

const CRON_JOBS: CronJob[] = [
  {
    id: "cron_7f21a3c9",
    label: "每日早报",
    schedule: "0 8 * * *",
    prompt:
      "汇总昨日 V5 线上告警、turn 失败率与积分消耗趋势，挑出异常项并给出处置建议；没有异常就一句话报平安。",
    deliver: "webchat",
    enabled: true,
    oneshot: false,
    nextRunAt: "2026-07-27T08:00:00+08:00",
    lastRunAt: "2026-07-26T08:00:11+08:00",
  },
  {
    id: "cron_muying_publish",
    label: "小红书母婴号每日发布",
    schedule: "0 20 * * *",
    prompt: "从预制队列取出今天的长图与文案发布到 momo 号；队列不足 3 条时发低库存提醒。",
    deliver: "telegram",
    enabled: true,
    oneshot: false,
    nextRunAt: "2026-07-26T20:00:00+08:00",
    lastRunAt: "2026-07-25T20:00:03+08:00",
  },
  {
    id: "cron_weekly_report",
    label: "周报汇总（暂停中）",
    schedule: "0 18 * * 5",
    prompt:
      "把本周 canonical 上合并的 PR、已上线的 release、未偿还的技术债与下周计划整理成周报，按「已上线 / 进行中 / 阻塞项 / 下周」四段输出，每段不超过 5 条。",
    deliver: "webchat",
    enabled: false,
    oneshot: false,
    nextRunAt: "2026-07-31T18:00:00+08:00",
    lastRunAt: "2026-07-17T18:00:24+08:00",
  },
  {
    id: "cron_canary_check",
    // 无 label → 标题回落到 prompt（测长文本截断）。
    prompt: "提醒我 30 分钟后检查 rel-0f1d5851 灰度指标，重点看 turn 失败率与 P95 首字延迟是否回到基线。",
    schedule: "45 14 26 7 *",
    deliver: "local",
    enabled: false,
    oneshot: true,
    lastRunAt: "2026-07-26T14:45:02+08:00",
  },
  {
    id: "cron_health_probe",
    label: "线上健康探针",
    schedule: "*/30 * * * *",
    prompt: "探测 /version、Caddy 与公网健康端点；连续两次失败即推送企微告警。",
    deliver: "local",
    enabled: true,
    oneshot: false,
    heartbeat: true,
    nextRunAt: "2026-07-26T15:00:00+08:00",
    lastRunAt: "2026-07-26T14:30:00+08:00",
  },
  {
    id: "cron_zsxq_digest",
    label: "知识星球每周精选整理与长图预生成（含选题日历核对）",
    schedule: "30 21 * * 0",
    prompt: "整理本周星球高赞提问，产出下周 3 个长图选题草案。",
    deliver: "webchat",
    enabled: true,
    oneshot: false,
    nextRunAt: "2026-07-26T21:30:00+08:00",
  },
];

const cronWrites: ApiMockTable = {
  createCron: ok({ id: "cron_new" }),
  updateCron: ok({ ok: true }),
  deleteCron: ok({ ok: true }),
};

// ── 技能 ────────────────────────────────────────────────────────────────────

const SKILLS: SkillSummary[] = [
  {
    name: "v5-commercial-deploy",
    description:
      "OpenClaude v5（Aurora 商业版）上线的权威流程：生效面矩阵分类（master / dist / runtime 三轴）→ deploy-v5.sh → 逐面执行 → smoke fail-closed，含部署互斥锁与迁移人工 apply 记账格式。",
    version: "3.2.0",
    tags: ["部署", "运维", "v5", "runbook"],
    source: "shared",
    layer: "shared",
    writable: true,
    agentIds: ["main"],
  },
  {
    name: "zsxq-publish",
    description: "知识星球网页版内容发布与管理的完整规程（扫码登录、发主题带图、删除与替换）。",
    version: "1.7.3",
    tags: ["发布", "知识星球"],
    source: "shared",
    layer: "shared",
    writable: true,
    agentIds: ["main", "agent_xhs_mkt"],
  },
  {
    name: "longform-infographic",
    description:
      "生成中文竖版长图信息图（观点图解 / 知识卡片 / 框架梳理），HTML+CSS 手写 → headless Chromium 截图 → 2160px 高清 PNG。",
    version: "2.1.0",
    tags: ["长图", "设计", "内容"],
    source: "hub",
    layer: "hub",
    writable: false,
    agentIds: ["agent_xhs_mkt"],
  },
  {
    name: "muying-content-calendar",
    description: "母婴科普 30 天选题日历维护与补货：队列低于 3 条时按日历生成新长图入队。",
    version: "0.9.1",
    tags: ["母婴", "选题"],
    source: "shared",
    layer: "shared",
    writable: true,
    agentIds: ["agent_xhs_mkt"],
  },
  {
    name: "codex-review-loop",
    description: "在关键代码上应用 Codex 双审工作流：prompt 组织、大 diff 的上下文经济、迭代至 PASS。",
    version: "1.3.0",
    tags: ["review", "codex", "质量"],
    source: "shared",
    layer: "shared",
    writable: true,
    agentIds: ["main"],
  },
  {
    name: "personal-egress-proxy-node-selection",
    description:
      "个人版本机 sing-box 订阅代理的节点测速、IP 纯净度评估与切换 SOP；含家宽节点判据与被墙后的应急路径。",
    version: "1.0.4",
    tags: ["网络", "代理", "SOP"],
    source: "shared",
    layer: "shared",
    writable: true,
    // 显式空数组 = 能力库中、暂未启用（与 undefined 的默认 main 不同）。
    agentIds: [],
  },
  {
    name: "research-citation-grounding",
    description: "科研报告的引用接地核查：verified 徽章只由 master 的 oc-cite 铸造，回查不到一律判未核查。",
    version: "1.1.2",
    tags: ["科研", "引用"],
    source: "hub",
    layer: "hub",
    writable: false,
    agentIds: ["agent_research_9f21"],
  },
  {
    name: "weekly-ops-digest",
    // 无 description：测缺省态下的卡片高度塌陷。
    version: "0.2.0",
    tags: [],
    source: "shared",
    layer: "shared",
    writable: true,
    agentIds: ["main", "agent_office_3b7c"],
  },
];

const skillDetails: ApiMockTable = {
  getSkill: ok({
    name: "v5-commercial-deploy",
    description: SKILLS[0].description,
    version: "3.2.0",
    tags: SKILLS[0].tags,
    source: "shared",
    layer: "shared",
    writable: true,
    agentIds: ["main"],
    files: ["SKILL.md", "references/deploy-matrix.md", "scripts/preflight.sh"],
    body: [
      "# v5 商业版上线",
      "",
      "## 1. 生效面矩阵",
      "改动落在 master / dist / runtime 三轴中的哪一条，决定要跑哪几步：",
      "- master：容器内源码走 release 轴，不再重建镜像。",
      "- dist：前端产物，必须 `--with-dist` 单次重启。",
      "- runtime：tuple / egress / env / 迁移，禁手改单键。",
      "",
      "## 2. 部署互斥",
      "deploy 全局 flock；锁被占时等待，勿 kill。",
    ].join("\n"),
  }),
  deleteSkill: ok({ ok: true }),
  getSkillEvals: ok({ evals: { version: 1, cases: [] } }),
};

// ── 文献库 ──────────────────────────────────────────────────────────────────

const LIBRARY_DOCS: ResearchLibraryDoc[] = [
  {
    docId: "doc_9f21ae04b2d17c3388e1",
    title: "婴幼儿喂养指南（2025 修订版）· 中华医学会儿科学分会",
    lang: "zh",
    spanCount: 412,
    createdAt: "2026-07-21T10:24:00+08:00",
  },
  {
    docId: "doc_3b7c55a1e9004fd2210b",
    title: "Attention Is All You Need",
    lang: "en",
    spanCount: 96,
    createdAt: "2026-07-19T22:07:00+08:00",
  },
  {
    docId: "doc_c0790a60d4415b8877ff",
    title:
      "面向大规模多智能体系统的可观测性实践：从 turn tape 到跨进程因果链的一致性重建（内部技术白皮书 v2）",
    lang: "zh",
    spanCount: 1287,
    createdAt: "2026-07-16T09:41:00+08:00",
  },
  {
    docId: "doc_f01c2288aa9b431d7e60",
    title: null,
    lang: "other",
    spanCount: 8,
    createdAt: "2026-07-14T17:53:00+08:00",
  },
  {
    docId: "doc_a91c7731bd0e4f229c45",
    title: "WHO Guideline on Complementary Feeding of Infants and Young Children 6–23 Months",
    lang: "en",
    spanCount: 638,
    createdAt: "2026-07-11T08:16:00+08:00",
  },
];

const libraryWrites: ApiMockTable = {
  deleteResearchDoc: ok({ ok: true }),
  uploadResearchDoc: ok({ docId: "doc_new", title: "新入库文档", lang: "zh", spanCount: 24 }),
};

// ── 插件账号（连接器 + 运行时 Plugin） ───────────────────────────────────────

const CONNECTORS: ConnectorsResponse = {
  providers: [
    {
      id: "imap",
      label: "邮箱（IMAP / SMTP）",
      description: "读取与发送邮件。支持 QQ 邮箱、Gmail、企业邮箱等标准 IMAP 服务。",
      authKind: "basic_form",
      formFields: [
        { key: "host", label: "IMAP 服务器", type: "text", required: true, placeholder: "imap.qq.com" },
        { key: "username", label: "邮箱地址", type: "text", required: true },
        {
          key: "password",
          label: "授权码",
          type: "password",
          required: true,
          helpText: "QQ 邮箱需使用授权码而非登录密码。",
          helpUrl: "https://service.mail.qq.com/",
        },
      ],
    },
    {
      id: "webdav",
      label: "WebDAV 网盘",
      description: "在坚果云、Nextcloud 等 WebDAV 网盘中读写文件。",
      authKind: "basic_form",
      formFields: [
        { key: "url", label: "服务器地址", type: "url", required: true },
        { key: "username", label: "账号", type: "text", required: true },
        { key: "password", label: "密码 / 应用密码", type: "password", required: true },
      ],
    },
    {
      id: "github",
      label: "GitHub",
      description: "读取仓库、Issue 与 PR（只读，复用账号页的 GitHub 授权）。",
      authKind: "oauth2_byoa",
      formFields: [],
    },
    {
      id: "feishu",
      label: "飞书",
      description: "读取与发送飞书消息、维护多维表格记录。",
      authKind: "oauth2_byoa",
      formFields: [
        { key: "clientId", label: "App ID", type: "text", required: true },
        { key: "clientSecret", label: "App Secret", type: "password", required: true },
      ],
    },
  ],
  connections: [
    {
      id: "conn_imap_1",
      provider: "imap",
      displayName: "工作邮箱",
      accountHint: "ma****k24@qq.com · imap.qq.com",
      status: "active",
      lastErrorCode: null,
      createdAt: agoIso(46 * DAY),
    },
    {
      id: "conn_imap_2",
      provider: "imap",
      displayName: "",
      accountHint: "momo.muying@163.com · imap.163.com",
      status: "error",
      lastErrorCode: "RELINK_REQUIRED",
      createdAt: agoIso(120 * DAY),
    },
    {
      id: "conn_webdav_1",
      provider: "webdav",
      displayName: "坚果云 · 长图素材",
      accountHint: "dav.jianguoyun.com/dav/openclaude-assets",
      status: "active",
      lastErrorCode: null,
      createdAt: agoIso(17 * DAY),
    },
    {
      id: "conn_github_1",
      provider: "github",
      displayName: "个人账号",
      accountHint: "maamonk24",
      status: "active",
      lastErrorCode: null,
      createdAt: agoIso(210 * DAY),
    },
  ],
};

const DECL_MANAGEMENT: DeclarativeManagementResponse = {
  connectors: [
    {
      slug: "notion",
      label: "Notion",
      description: "读取与写入 Notion 页面、数据库记录。写入类动作默认逐次确认。",
      installation: "default",
      official: true,
      available: true,
      canBind: true,
      listingState: "listed",
      installedVersion: "2.3.0",
      installedVersionId: "cv_notion_230",
      latestVersion: "2.3.0",
      latestVersionId: "cv_notion_230",
      updateAvailable: false,
      connectionCount: 1,
      contract: {
        versionId: 230,
        slug: "notion",
        label: "Notion",
        description: "读取与写入 Notion 页面、数据库记录。",
        authMode: "oauth2-auth-code",
        requiredBindSources: [],
        clientProvisioning: "platform",
        actions: [
          { id: "search", effect: "read" },
          { id: "page.get", effect: "read" },
          { id: "page.append", effect: "write" },
        ],
      },
    },
    {
      slug: "tapd",
      label: "TAPD 项目协作",
      description:
        "读取需求与缺陷列表、创建缺陷单。由第三方开发者发布，安装后按签名契约执行，出站域名受白名单约束。",
      installation: "marketplace",
      official: false,
      available: true,
      canBind: true,
      listingState: "listed",
      installedVersion: "1.2.0",
      installedVersionId: "cv_tapd_120",
      latestVersion: "1.4.1",
      latestVersionId: "cv_tapd_141",
      updateAvailable: true,
      connectionCount: 0,
      contract: {
        versionId: 120,
        slug: "tapd",
        label: "TAPD 项目协作",
        description: "读取需求与缺陷列表、创建缺陷单。",
        authMode: "static-token",
        requiredBindSources: ["api_token", "workspace_id"],
        actions: [
          { id: "story.list", effect: "read" },
          { id: "bug.create", effect: "write" },
        ],
      },
    },
    {
      slug: "legacy-crm",
      label: "旧版 CRM 同步",
      description: "该 API 插件已从市场下架，保留在此供你解绑历史账号。",
      installation: "orphan",
      official: false,
      available: false,
      canBind: false,
      listingState: "delisted",
      installedVersion: null,
      installedVersionId: null,
      latestVersion: null,
      latestVersionId: null,
      updateAvailable: false,
      connectionCount: 1,
      contract: null,
    },
  ],
  connections: [
    {
      id: "dconn_notion_1",
      slug: "notion",
      displayName: "个人 Notion 空间",
      accountHint: "OpenClaude Workspace",
      connectorVersionId: "cv_notion_230",
      createdAt: agoIso(31 * DAY),
    },
    {
      id: "dconn_legacy_1",
      slug: "legacy-crm",
      displayName: "旧 CRM（待清理）",
      accountHint: "crm.internal.example.com",
      connectorVersionId: null,
      createdAt: agoIso(190 * DAY),
    },
  ],
};

const PLUGIN_MANAGEMENT: PluginManagementResponse = {
  catalog: [
    {
      versionId: "pv_kp_181",
      slug: "knowledge-planet",
      pluginType: "managed-browser",
      label: "知识星球",
      description:
        "在隔离浏览器中代你读取星球主题与提问，并可在你授权后发布带 AI 标识的文字评论。登录状态加密保存，绝不进入模型上下文。",
      accountMode: "required",
      actions: [
        { id: "topic.list", description: "读取星球主题列表", readOnly: true },
        { id: "topic.get", description: "读取单条主题正文与评论", readOnly: true },
        { id: "comment.create", description: "发布文字评论", readOnly: false },
      ],
      installed: true,
      installedVersion: "1.8.1",
      latestVersionId: "pv_kp_181",
      latestVersion: "1.8.1",
      installedCurrent: true,
      updateAvailable: false,
      available: true,
    },
    {
      versionId: "pv_weibo_042",
      slug: "weibo",
      pluginType: "managed-browser",
      label: "微博",
      description: "读取时间线与私信，代你发布微博（含图片）。首次使用需在微博客户端扫码授权。",
      accountMode: "required",
      actions: [
        { id: "timeline.list", description: "读取时间线", readOnly: true },
        { id: "status.create", description: "发布微博", readOnly: false },
        { id: "status.upload", description: "上传图片", readOnly: false },
      ],
      installed: true,
      installedVersion: "0.4.2",
      latestVersionId: "pv_weibo_050",
      latestVersion: "0.5.0",
      installedCurrent: true,
      updateAvailable: true,
      available: true,
    },
    {
      versionId: "pv_pdf_113",
      slug: "pdf-toolkit",
      pluginType: "sandboxed-local",
      label: "PDF 工具箱",
      description: "在沙箱内拆分、合并、抽取 PDF 文本与表格。无需账号。",
      accountMode: "none",
      actions: [
        { id: "pdf.extract", description: "抽取文本与表格", readOnly: true },
        { id: "pdf.split", description: "拆分 / 合并", readOnly: false },
      ],
      installed: true,
      installedVersion: "1.1.3",
      latestVersionId: "pv_pdf_113",
      latestVersion: "1.1.3",
      installedCurrent: true,
      updateAvailable: false,
      available: true,
    },
  ],
  accounts: [
    {
      id: "pacc_kp_1",
      provider: "knowledge-planet",
      pluginType: "managed-browser",
      displayName: "momo 的知识星球",
      accountHint: "微信昵称：momo · 3 个星球",
      status: "active",
      actions: [
        { id: "topic.list", description: "读取星球主题列表", readOnly: true },
        { id: "comment.create", description: "发布文字评论", readOnly: false },
      ],
      versionId: "pv_kp_181",
      executable: true,
      writeControl: {
        available: true,
        enabled: true,
        disclaimerVersion: 3,
        acceptedVersion: 3,
        acceptedAt: agoIso(6 * DAY),
        disclaimerText:
          "开启后，AI 可代你在知识星球发布文字评论。所有写入动作默认仍需你在对话中逐次确认；请确认你已理解由此产生的内容责任。",
        preapproval: {
          available: true,
          enabled: false,
          disclaimerVersion: 2,
          acceptedVersion: null,
          acceptedAt: null,
          disclaimerText:
            "开启「免逐次确认」后，Agent 可直接执行所有已开放的写入动作，不再展示确认卡。请仅在你完全信任当前任务范围时开启。",
        },
      },
    },
    {
      id: "pacc_weibo_1",
      provider: "weibo",
      pluginType: "managed-browser",
      displayName: "母婴科普 momo",
      accountHint: "@momo母婴日记",
      status: "error",
      actions: [{ id: "timeline.list", description: "读取时间线", readOnly: true }],
      versionId: "pv_weibo_042",
      executable: false,
      writeControl: {
        available: true,
        enabled: false,
        disclaimerVersion: 2,
        acceptedVersion: null,
        acceptedAt: null,
        disclaimerText: "开启后，AI 可代你发布微博。写入动作默认逐次确认。",
        preapproval: {
          available: false,
          enabled: false,
          disclaimerVersion: null,
          acceptedVersion: null,
          acceptedAt: null,
          disclaimerText: null,
        },
      },
    },
  ],
};

const KP_GROUPS: KnowledgePlanetAutomationGroup[] = [
  { id: "2851155", name: "OpenClaude 用户交流", memberCount: 1284 },
  { id: "4855182", name: "母婴科普内容共创", memberCount: 376 },
  { id: "1188252", name: "AI 工程实践（付费）", memberCount: 92 },
];

const KP_AUTOMATION: KnowledgePlanetAutomationView = {
  control: {
    available: true,
    enabled: true,
    disclaimerVersion: 2,
    acceptedVersion: 2,
    acceptedAt: agoIso(4 * DAY),
    disclaimerText:
      "开启无人值守自动回复后，新主题可在你离线时由 AI 自动计费并发布回复。仅发送带 AI 标识的文字评论。",
    accountDailyLimit: 20,
    pausedReason: null,
  },
  rules: [
    {
      id: "kpr_1",
      groupId: "2851155",
      name: "新提问自动答疑",
      instructions: "只回答与 OpenClaude 使用相关的提问，给出可执行步骤；不确定时明确说不确定。",
      triggerKind: "new_question",
      enabled: true,
      dailyLimit: 8,
      cooldownMinutes: 30,
      maxReplyChars: 600,
      consecutiveFailures: 0,
      pausedReason: null,
      lastCursorAt: agoIso(3 * HOUR),
      nextRunAt: agoIso(-25 * MIN),
      createdAt: agoIso(4 * DAY),
      updatedAt: agoIso(3 * HOUR),
    },
    {
      id: "kpr_2",
      groupId: "4855182",
      name: "母婴选题灵感回应（医疗内容一律不给结论）",
      instructions: "只做选题延展与结构建议；涉及用药、喂养量、发育指标一律引导用户咨询医生。",
      triggerKind: "new_topic",
      enabled: false,
      dailyLimit: 4,
      cooldownMinutes: 120,
      maxReplyChars: 400,
      consecutiveFailures: 3,
      pausedReason: "consecutive_failures",
      lastCursorAt: agoIso(2 * DAY),
      nextRunAt: agoIso(-2 * HOUR),
      createdAt: agoIso(9 * DAY),
      updatedAt: agoIso(2 * DAY),
    },
  ],
  recentRuns: [
    {
      id: "kprun_1",
      ruleId: "kpr_1",
      sourceTopicId: "48844288521118",
      status: "succeeded",
      reasonCode: null,
      upstreamCommentId: "c_991",
      createdAt: agoIso(3 * HOUR),
      finishedAt: agoIso(3 * HOUR - 40_000),
    },
    {
      id: "kprun_2",
      ruleId: "kpr_1",
      sourceTopicId: "48844285112288",
      status: "skipped",
      reasonCode: "cooldown",
      upstreamCommentId: null,
      createdAt: agoIso(5 * HOUR),
      finishedAt: agoIso(5 * HOUR - 2_000),
    },
    {
      id: "kprun_3",
      ruleId: "kpr_2",
      sourceTopicId: "88512241184428",
      status: "failed",
      reasonCode: "upstream_error",
      upstreamCommentId: null,
      createdAt: agoIso(2 * DAY),
      finishedAt: agoIso(2 * DAY - 9_000),
    },
  ],
};

const connectorWrites: ApiMockTable = {
  renameConnector: ok({ ok: true }),
  deleteConnector: ok({ ok: true }),
  unbindDeclarativeConnector: ok({ ok: true }),
  revokePluginAccount: ok({ ok: true }),
  setPluginWriteAccess: ok({ ok: true }),
  setPluginWritePreapproval: ok({ ok: true }),
  setKnowledgePlanetAutomation: ok({ ok: true }),
};

// ── 场景 ────────────────────────────────────────────────────────────────────

export const manageScenes: Scene[] = [
  // ── 全面优化 ──
  {
    id: "manage-optimization",
    label: "全面优化 · 有待确认建议",
    group: "管理中心",
    api: {
      ...BASE,
      getAutoDreamOptimizer: ok(OPTIMIZER_STATE),
      runAutoDreamOptimizer: ok(OPTIMIZER_STATE),
      cancelAutoDreamOptimizer: ok(OPTIMIZER_STATE),
      mutateAutoDreamProposal: ok(OPTIMIZER_STATE),
    },
    render: () => shell("optimization"),
  },
  {
    id: "manage-optimization-empty",
    label: "全面优化 · 空态（暂无建议）",
    group: "管理中心",
    api: {
      ...BASE,
      getAutoDreamOptimizer: ok(OPTIMIZER_EMPTY),
      runAutoDreamOptimizer: ok(OPTIMIZER_EMPTY),
    },
    render: () => shell("optimization"),
  },
  {
    id: "manage-optimization-running",
    label: "全面优化 · 审计进行中（进度条）",
    group: "管理中心",
    api: {
      ...BASE,
      getAutoDreamOptimizer: ok(OPTIMIZER_RUNNING),
      cancelAutoDreamOptimizer: ok(OPTIMIZER_RUNNING),
    },
    render: () => shell("optimization"),
  },
  {
    id: "manage-optimization-error",
    label: "全面优化 · 加载失败",
    group: "管理中心",
    api: {
      ...BASE,
      getAutoDreamOptimizer: fail(500, "优化报告服务暂时不可用，请稍后重试。"),
    },
    render: () => shell("optimization"),
  },

  // ── 记忆 ──
  {
    id: "manage-memory",
    label: "记忆 · 有数据（核心记忆 + 梦境报告 + 用户画像）",
    group: "管理中心",
    viewports: ["desktop", "mobile"],
    api: {
      ...BASE,
      ...memoryWrites,
      getMemoryIndex: ok(MEMORY_INDEX),
      getAutoDreamReport: ok(DREAM_REPORT),
      getMemory: ok(USER_PROFILE),
    },
    render: () => shell("memory"),
  },
  {
    id: "manage-memory-empty",
    label: "记忆 · 空态（无记忆、无画像、无梦境报告）",
    group: "管理中心",
    api: {
      ...BASE,
      ...memoryWrites,
      getMemoryIndex: ok(MEMORY_INDEX_EMPTY),
      getAutoDreamReport: ok(DREAM_REPORT_EMPTY),
      getMemory: ok(USER_PROFILE_EMPTY),
    },
    render: () => shell("memory"),
  },
  {
    id: "manage-memory-error",
    label: "记忆 · 两段各自报错",
    group: "管理中心",
    api: {
      ...BASE,
      // 500 而非 502/503：避免触发 loadWithColdStartRetry 的冷启重试，直接落错误态。
      getMemoryIndex: fail(500, "加载记忆失败：容器网关暂时不可达。"),
      getAutoDreamReport: fail(500, "梦境报告暂不可用。"),
      getMemory: fail(500, "加载用户画像失败：容器网关暂时不可达。"),
    },
    render: () => shell("memory"),
  },

  // ── 定时任务 ──
  {
    id: "manage-cron",
    label: "定时任务 · 有数据（启用/停用/一次性混合）",
    group: "管理中心",
    viewports: ["desktop", "mobile"],
    api: { ...BASE, ...cronWrites, listCron: ok(CRON_JOBS) },
    render: () => shell("cron"),
  },
  {
    id: "manage-cron-empty",
    label: "定时任务 · 空态",
    group: "管理中心",
    api: { ...BASE, ...cronWrites, listCron: ok([] as CronJob[]) },
    render: () => shell("cron"),
  },
  {
    id: "manage-cron-error",
    label: "定时任务 · 加载失败（带重试）",
    group: "管理中心",
    api: { ...BASE, listCron: fail(503, "定时任务服务暂时不可用，请稍后重试。") },
    render: () => shell("cron"),
  },

  // ── 技能 ──
  {
    id: "manage-skills",
    label: "技能 · 有数据（自建 / 市场 / 只读混合，触发过滤框）",
    group: "管理中心",
    api: { ...BASE, ...skillDetails, listSkills: ok(SKILLS) },
    render: () => shell("skills"),
  },
  {
    id: "manage-skills-empty",
    label: "技能 · 空态",
    group: "管理中心",
    api: { ...BASE, ...skillDetails, listSkills: ok([] as SkillSummary[]) },
    render: () => shell("skills"),
  },
  {
    id: "manage-skills-error",
    label: "技能 · 加载失败（带重试）",
    group: "管理中心",
    api: { ...BASE, listSkills: fail(500, "加载技能失败：容器网关暂时不可达。") },
    render: () => shell("skills"),
  },

  // ── 插件账号 ──
  {
    id: "manage-connectors",
    label: "插件账号 · 有数据（Plugin + 声明式 + v1 连接器）",
    group: "管理中心",
    api: {
      ...BASE,
      ...connectorWrites,
      getConnectors: ok(CONNECTORS),
      getDeclarativeManagement: ok(DECL_MANAGEMENT),
      getPluginManagement: ok(PLUGIN_MANAGEMENT),
      getKnowledgePlanetAutomation: ok(KP_AUTOMATION),
      listKnowledgePlanetAutomationGroups: ok(KP_GROUPS),
    },
    render: () => shell("connectors"),
  },
  {
    id: "manage-connectors-empty",
    label: "插件账号 · 空态（无可绑定应用）",
    group: "管理中心",
    api: {
      ...BASE,
      getConnectors: ok({ providers: [], connections: [] } as ConnectorsResponse),
      getDeclarativeManagement: ok({ connectors: [], connections: [] } as DeclarativeManagementResponse),
      getPluginManagement: ok({ catalog: [], accounts: [] } as PluginManagementResponse),
    },
    render: () => shell("connectors"),
  },
  {
    id: "manage-connectors-error",
    label: "插件账号 · v1 目录加载失败",
    group: "管理中心",
    api: {
      ...BASE,
      getConnectors: fail(500, "加载应用连接失败，请稍后重试。"),
      getDeclarativeManagement: ok({ connectors: [], connections: [] } as DeclarativeManagementResponse),
      getPluginManagement: ok({ catalog: [], accounts: [] } as PluginManagementResponse),
    },
    render: () => shell("connectors"),
  },

  // ── 文献库 ──
  {
    id: "manage-library",
    label: "文献库 · 有数据（中英混合、长标题、无标题）",
    group: "管理中心",
    api: { ...BASE, ...libraryWrites, listResearchLibrary: ok(LIBRARY_DOCS) },
    render: () => shell("library"),
  },
  {
    id: "manage-library-empty",
    label: "文献库 · 空态",
    group: "管理中心",
    api: { ...BASE, ...libraryWrites, listResearchLibrary: ok([] as ResearchLibraryDoc[]) },
    render: () => shell("library"),
  },
  {
    id: "manage-library-error",
    label: "文献库 · 加载失败（带重试）",
    group: "管理中心",
    api: { ...BASE, listResearchLibrary: fail(500, "加载文献库失败，请稍后重试。") },
    render: () => shell("library"),
  },

  // ── 切 Tab 加载态 ──
  {
    id: "manage-loading",
    label: "切 Tab 加载态（定时任务面板 pending）",
    group: "管理中心",
    api: { ...BASE, listCron: pending },
    render: () => shell("cron"),
  },
];
