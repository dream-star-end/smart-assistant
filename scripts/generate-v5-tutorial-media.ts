#!/usr/bin/env tsx
/**
 * 从正式生产入口 main.tsx → App 自动操作真实 v5 UI，为每个稳定能力生成独立教程媒体。
 * fixture 只存在于 HTTP / WebSocket / 浏览器能力边界，禁止替换或伪造产品 DOM。
 */
import { createHash } from "node:crypto";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import sharp from "sharp";
import { encodeContainerPreviewFrame } from "../packages/protocol/src/containerPreview.ts";
import {
  PRODUCT_CAPABILITY_LIST,
  type ProductFeatureId,
} from "../packages/web-react/src/lib/productCapabilities.ts";
import { TUTORIAL_MEDIA } from "../packages/web-react/src/lib/tutorialCatalog.ts";

const ROOT = resolve(import.meta.dirname, "..");
const WEB_ROOT = join(ROOT, "packages/web-react");
const CAPTURE_DIST = join(WEB_ROOT, "dist-tutorial-capture");
const OUTPUT = join(WEB_ROOT, "public/tutorials");
const PROVENANCE_PATH = join(WEB_ROOT, "tutorial-capture-provenance.json");
const WIDTH = 960;
const PRODUCT_HEIGHT = 500;
const HEIGHT = 540;
const FOOTER_HEIGHT = HEIGHT - PRODUCT_HEIGHT;
const FPS = 8;
const VIDEO_FRAMES = 32;
const PIPELINE_VERSION = 2;
const FIXED_NOW = "2026-07-15T08:00:00.000Z";
const CHROME_FLAGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  "--font-render-hinting=none",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
] as const;

const FEATURE_IDS = PRODUCT_CAPABILITY_LIST.map(
  (item) => item.id as ProductFeatureId,
);

const AGENTS = [
  {
    id: "main",
    slug: "main",
    name: "全能助手",
    description: "统筹复杂工作并交付完整结果",
    installed: true,
    isDefault: true,
  },
  {
    id: "research-assistant",
    slug: "research-assistant",
    name: "科研助手",
    description: "检索文献、核对证据并撰写研究报告",
    avatarEmoji: "🔬",
    model: "deepseek",
    version: "2.1.0",
    installed: true,
    preset: true,
  },
  {
    id: "coding-assistant",
    slug: "coding-assistant",
    name: "编程助手",
    description: "阅读仓库、实现功能并运行测试",
    avatarEmoji: "💻",
    model: "gpt-5.6-sol",
    version: "3.0.0",
    installed: true,
    preset: true,
  },
];

const MODELS = {
  models: [
    {
      id: "deepseek",
      display_name: "DeepSeek V4 Flash",
      supported_efforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      supported_efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      supported_efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  ],
};

const USER = {
  id: "tutorial-user",
  email: "learner@example.invalid",
  email_verified: true,
  role: "user",
  display_name: "教程用户",
  avatar_url: null,
  credits: "2680",
  created_at: "2026-01-01T00:00:00.000Z",
  org: {
    id: "tutorial-org",
    name: "示例研发组",
    role: "owner",
    status: "active",
    billing_enabled: true,
    billing_delegate: false,
  },
};

const SESSION_ROWS = [
  {
    id: "session-client-research",
    agentId: "research-assistant",
    title: "客户研究与竞品分析",
    pinned: true,
    createdAt: 1784059200000,
    lastAt: 1784100600000,
    messageCount: 4,
    updatedAt: 1784100600000,
  },
  {
    id: "session-quarterly-report",
    agentId: "main",
    title: "季度经营复盘",
    pinned: false,
    createdAt: 1783972800000,
    lastAt: 1784097000000,
    messageCount: 5,
    updatedAt: 1784097000000,
  },
  {
    id: "session-preview-review",
    agentId: "coding-assistant",
    title: "容器网页验收",
    pinned: false,
    createdAt: 1783936800000,
    lastAt: 1784066400000,
    messageCount: 2,
    updatedAt: 1784066400000,
  },
  {
    id: "session-mobile-release",
    agentId: "coding-assistant",
    title: "移动端发布检查",
    pinned: false,
    createdAt: 1783886400000,
    lastAt: 1784010600000,
    messageCount: 3,
    updatedAt: 1784010600000,
  },
];

const PREVIEW_VIEWPORT = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  isMobile: false,
} as const;
const PREVIEW_TARGET = {
  selector: "#hero-cta",
  tag: "button",
  role: "button",
  ariaLabel: "开始体验",
  text: "开始体验",
  bounds: { x: 120, y: 570, width: 230, height: 64 },
} as const;

const RICH_MESSAGES = [
  {
    id: "srv-user-1",
    role: "user",
    text: "整理本季度经营数据，并交付一份可下载的复盘报告和发布会主视觉。",
    ts: 1784096400000,
    _seq: 1,
    _source: "server",
    status: "sent",
  },
  {
    id: "srv-assistant-1",
    role: "assistant",
    text: "已完成复盘。核心结论：收入保持增长，续费率改善，下一步优先处理试用转化。\n\n成果文件：`/root/.openclaude/tutorial-quarterly-report.docx`\n\n发布会主视觉：`/root/.openclaude/tutorial-launch-visual.png`",
    ts: 1784096460000,
    completedAt: 1784096465000,
    _seq: 2,
    _source: "server",
    usage: {
      inputTokens: 1240,
      outputTokens: 680,
      costCredits: "18",
      traceId: "tutorial-trace-001",
    },
  },
];

const MARKET_CARD = {
  slug: "evidence-research",
  kind: "skill",
  name: "证据研究助手",
  description: "检索一手资料、交叉核对并生成带引用的研究结论。",
  tags: ["研究", "引用"],
  installCount: 128,
  category: "research-knowledge",
  useCases: ["行业研究与竞品对比", "论文证据梳理"],
  featuredRank: 1,
  usage30d: 486,
  users30d: 96,
  rating: { up: 42, down: 2 },
  benchmark: { withPassRate: 0.92, withoutPassRate: 0.61, cases: 24 },
};

const USAGE = {
  summary: {
    input_tokens: "86520",
    output_tokens: "24360",
    cache_read_tokens: "41200",
    cache_write_tokens: "6300",
    requests_total: "126",
    billed_credits: "780",
    debited_credits: "742",
  },
  legacy_unattributed: {
    requests: "0",
    input_tokens: "0",
    output_tokens: "0",
    cache_read_tokens: "0",
    cache_write_tokens: "0",
    billed_credits: "0",
  },
  savings: {
    savings_credits: "96",
    savings_is_estimate: false,
    savings_unavailable: false,
    savings_rows_skipped: 0,
  },
  cache: { hit_rate: 0.476 },
  sessions: {
    rows: [
      {
        session_id: "session-quarterly-report",
        requests: "18",
        input_tokens: "24500",
        output_tokens: "7200",
        cache_read_tokens: "13400",
        cache_write_tokens: "1800",
        billed_credits: "168",
        last_used_at: FIXED_NOW,
        delegate_credits: "0",
        delegate_requests: "0",
        delegates: [],
      },
    ],
    limit: 20,
    offset: 0,
    has_more: false,
  },
  ledger: {
    rows: [
      {
        id: "ledger-tutorial-1",
        delta: "-18",
        balance_after: "2680",
        reason: "chat",
        ref_type: "session",
        ref_id: "session-quarterly-report",
        memo: "季度经营复盘",
        created_at: FIXED_NOW,
      },
    ],
    next_before: null,
  },
  cutoff_started_at: null,
};

function usageReport(window: string) {
  return {
    window,
    summary: {
      requests: "42",
      input_tokens: "42500",
      output_tokens: "11800",
      cache_read_tokens: "21800",
      cache_write_tokens: "3200",
      credits: "286",
    },
    trend: [
      { bucket: "2026-07-13", requests: "9", credits: "58" },
      { bucket: "2026-07-14", requests: "14", credits: "94" },
      { bucket: "2026-07-15", requests: "19", credits: "134" },
    ],
    models: [
      { model: "DeepSeek V4 Flash", requests: "26", credits: "128" },
      { model: "GPT-5.6-Sol", requests: "16", credits: "158" },
    ],
    ledger: {
      trend: [
        { bucket: "2026-07-13", credited: "0", debited: "58" },
        { bucket: "2026-07-14", credited: "300", debited: "94" },
        { bucket: "2026-07-15", credited: "0", debited: "134" },
      ],
      by_reason: [
        { reason: "chat", debited: "242" },
        { reason: "skill_eval", debited: "44" },
      ],
    },
  };
}

const ORG_TOTALS = {
  requests: "86",
  input_tokens: "125000",
  output_tokens: "34600",
  cache_read_tokens: "68200",
  cache_write_tokens: "8400",
  credits: "980",
};

function orgUsage(window: string) {
  return {
    window,
    summary: ORG_TOTALS,
    members: [
      {
        user_id: "tutorial-user",
        email: "learner@example.invalid",
        display_name: "教程用户",
        ...ORG_TOTALS,
      },
      {
        user_id: "tutorial-colleague",
        email: "colleague@example.invalid",
        display_name: "协作成员",
        requests: "28",
        input_tokens: "42000",
        output_tokens: "9800",
        cache_read_tokens: "19000",
        cache_write_tokens: "2400",
        credits: "310",
      },
    ],
    models: [
      { model: "DeepSeek V4 Flash", ...ORG_TOTALS },
      {
        model: "GPT-5.6-Sol",
        requests: "31",
        input_tokens: "52000",
        output_tokens: "14800",
        cache_read_tokens: "22400",
        cache_write_tokens: "3200",
        credits: "420",
      },
    ],
    trend: [
      { bucket: "2026-07-13T00:00:00.000Z", requests: "22", credits: "220" },
      { bucket: "2026-07-14T00:00:00.000Z", requests: "29", credits: "330" },
      { bucket: "2026-07-15T00:00:00.000Z", requests: "35", credits: "430" },
    ],
  };
}

function commandPath(name: string): string | null {
  try {
    return (
      execFileSync("bash", ["-lc", `command -v ${name}`], {
        encoding: "utf8",
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function latestCacheBinary(
  product: "chromium" | "ffmpeg",
  suffix: string,
): string | null {
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache)
    .filter((name) => name.startsWith(`${product}-`))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const candidate = join(cache, entry, suffix);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function chromePath(): string {
  const candidates = [
    process.env.TUTORIAL_CHROME,
    commandPath("google-chrome"),
    commandPath("chromium"),
    latestCacheBinary("chromium", "chrome-linux64/chrome"),
    latestCacheBinary("chromium", "chrome-linux/chrome"),
  ];
  const found = candidates.find(
    (value): value is string => !!value && existsSync(value),
  );
  if (!found)
    throw new Error("找不到 Chromium；请设置 TUTORIAL_CHROME=/path/to/chrome");
  return found;
}

function ffmpegPath(): string {
  const candidates = [
    process.env.TUTORIAL_FFMPEG,
    commandPath("ffmpeg"),
    latestCacheBinary("ffmpeg", "ffmpeg-linux"),
  ];
  const found = candidates.find(
    (value): value is string => !!value && existsSync(value),
  );
  if (!found)
    throw new Error(
      "找不到 ffmpeg（需 libvpx）；请设置 TUTORIAL_FFMPEG=/path/to/ffmpeg",
    );
  return found;
}

function playwright(): any {
  const require = createRequire(import.meta.url);
  for (const candidate of [
    process.env.PLAYWRIGHT_CORE_PATH,
    "playwright-core",
    "/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core",
    "/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core",
  ].filter(Boolean) as string[]) {
    try {
      return require(candidate);
    } catch {
      /* 尝试下一个受控位置。 */
    }
  }
  throw new Error("找不到 playwright-core；请设置 PLAYWRIGHT_CORE_PATH");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  };
}

function errorJson(status: number, code: string, message: string) {
  return json({ error: { code, message } }, status);
}

async function fixtureFor(
  method: string,
  url: URL,
  request: any,
  imagePng: Buffer,
) {
  const path = url.pathname;
  if (method === "POST" && path === "/api/auth/refresh")
    return json({
      access_token: "tutorial-access-token",
      access_exp: 4102444800,
      remember: true,
    });
  if (method === "GET" && path === "/api/public/config")
    return json({
      turnstile_site_key: "",
      turnstile_bypass: true,
      require_email_verified: false,
      feature_remote_ssh: false,
      feature_image2: true,
      allow_registration: true,
    });
  if (method === "GET" && path === "/api/public/models") return json(MODELS);
  if (method === "GET" && path === "/api/me")
    return json({ user: USER, lane: null });
  if (path === "/api/me/preferences" && method === "GET")
    return json({
      prefs: {
        theme: "light",
        default_model: "gpt-5.6-sol",
        default_effort: "medium",
        notify_email: true,
        notify_telegram: false,
        auto_dream_enabled: true,
      },
      features: {
        auto_dream: {
          eligible: true,
          available: true,
          enabled: true,
          effective: true,
          minimum_plan_code: "max",
          min_interval_hours: 24,
          min_new_sessions: 5,
        },
      },
    });
  if (path === "/api/me/preferences" && method === "PATCH")
    return json({
      prefs: {
        theme: "dark",
        default_model: "gpt-5.6-sol",
        default_effort: "medium",
        notify_email: true,
        notify_telegram: false,
        auto_dream_enabled: true,
      },
      features: {
        auto_dream: {
          eligible: true,
          available: true,
          enabled: true,
          effective: true,
          minimum_plan_code: "max",
          min_interval_hours: 24,
          min_new_sessions: 5,
        },
      },
    });
  if (method === "GET" && path === "/api/agent/status")
    return json({
      runtime_ready: true,
      ondemand: true,
      subscription: null,
      container: {
        id: "tutorial-container",
        subscription_id: null,
        docker_id: "tutorial-docker",
        docker_name: "tutorial-runtime",
        image: "tutorial-image",
        status: "running",
        last_started_at: FIXED_NOW,
        last_stopped_at: null,
        volume_gc_at: null,
        last_error: null,
      },
    });
  if (method === "GET" && path === "/api/sessions/list")
    return json({ sessions: SESSION_ROWS });
  if (method === "GET" && /^\/api\/sessions\/[^/]+$/.test(path)) {
    const id = basename(path);
    const messages =
      id === "session-quarterly-report"
        ? RICH_MESSAGES
        : id === "session-preview-review"
          ? [
              {
                id: `${id}-u`,
                role: "user",
                text: "请启动前端开发服务器，我会检查桌面布局并按元素给修改意见。",
                ts: 1784066340000,
                _seq: 1,
                _source: "server",
                status: "sent",
              },
              {
                id: `${id}-a`,
                role: "assistant",
                text: "开发服务器已就绪：\n\n[打开 Aurora 项目看板](http://127.0.0.1:4173/)\n\n请在容器预览中操作页面，或切换到“选元素评论”精确标注需要修改的控件。",
                ts: 1784066400000,
                _seq: 2,
                _source: "server",
              },
            ]
          : [
              {
                id: `${id}-u`,
                role: "user",
                text: id.includes("client")
                  ? "对比三家产品最近发布的企业功能。"
                  : "继续完成这个任务。",
                ts: 1784090000000,
                _seq: 1,
                _source: "server",
                status: "sent",
              },
              {
                id: `${id}-a`,
                role: "assistant",
                text: id.includes("client")
                  ? "已完成三家产品的企业能力对比：\n\n| 产品 | 最近变化 | 适用团队 |\n|---|---|---|\n| 星河办公 | 新增知识库权限 | 中型团队 |\n| 云杉协作 | 上线审批流 | 跨部门团队 |\n| 北辰文档 | 强化审计日志 | 合规团队 |\n\n**结论：**先按权限、审批和审计三个维度安排试用，再核对官方发布日期。"
                  : "已恢复上下文，可以从上次结果继续。",
                ts: 1784090060000,
                _seq: 2,
                _source: "server",
              },
            ];
    const agentId = id.includes("client")
      ? "research-assistant"
      : id === "session-preview-review"
        ? "coding-assistant"
        : "main";
    return json({
      id,
      userId: "tutorial-user",
      agentId,
      title: SESSION_ROWS.find((row) => row.id === id)?.title ?? "教程会话",
      pinned: false,
      createdAt: 1784059200000,
      lastAt: 1784100600000,
      messages,
      updatedAt: 1784100600000,
      isPartial: false,
      totalMessageCount: messages.length,
      maxSeq: messages.length,
      archivedCount: 0,
      archivedThroughSeq: 0,
    });
  }
  if (method === "GET" && path.endsWith("/archive"))
    return json({ messages: [], hasMore: false, oldestSeq: null });
  if (method === "PUT" && /^\/api\/sessions\/[^/]+$/.test(path))
    return json({ ok: true, applied: true, updatedAt: Date.parse(FIXED_NOW) });
  if (method === "POST" && /^\/api\/sessions\/[^/]+\/user-message$/.test(path))
    return json({ ok: true });
  if (method === "GET" && path === "/api/marketplace/my-agents")
    return json({ agents: AGENTS });
  if (method === "GET" && path === "/api/me/messages/unread_count")
    return json({ unread_count: 2 });
  if (method === "GET" && path === "/api/me/messages")
    return json({
      messages: [
        {
          id: "tutorial-message-1",
          audience: "user",
          user_id: "tutorial-user",
          title: "定时任务已完成",
          body_md: "“每日行业摘要”已运行完成，研究结论已送达到对应会话。",
          level: "notice",
          created_by: "system",
          created_at: FIXED_NOW,
          expires_at: null,
          read: false,
        },
        {
          id: "tutorial-message-2",
          audience: "all",
          user_id: null,
          title: "本周产品更新",
          body_md: "管理中心新增了更清晰的技能评测与训练记录。",
          level: "info",
          created_by: "system",
          created_at: "2026-07-14T03:00:00.000Z",
          expires_at: null,
          read: false,
        },
      ],
      unread_count: 2,
    });
  if (method === "POST" && /^\/api\/me\/messages\/[^/]+\/read$/.test(path))
    return json({ ok: true, already: false });
  if (method === "POST" && path === "/api/me/messages/read_all")
    return json({ ok: true, inserted: 2 });
  if (method === "GET" && path === "/api/response-rating")
    return json({ ratings: [] });
  if (method === "POST" && path === "/api/client-errors")
    return json({ ok: true });

  if (method === "POST" && path === "/api/uploads")
    return json({
      url: "/api/media/tutorial-upload.xlsx",
      digest: "tutorial-upload",
      size: Number(request.headers()["content-length"] ?? 32),
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  if (method === "POST" && path === "/api/media-sign") {
    const input = request.postDataJSON?.() ?? { paths: [] };
    const paths = Array.isArray(input.paths) ? input.paths : [];
    return json({
      urls: Object.fromEntries(
        paths.map((item: string) => [
          item,
          item.endsWith(".png")
            ? "/tutorial-fixture/launch-visual.png"
            : `/tutorial-fixture/download?name=${encodeURIComponent(basename(item))}`,
        ]),
      ),
      expMs: 4102444800000,
    });
  }
  if (method === "GET" && path === "/tutorial-fixture/launch-visual.png")
    return { status: 200, contentType: "image/png", body: imagePng };
  if (method === "GET" && path === "/tutorial-fixture/download")
    return {
      status: 200,
      contentType: "application/octet-stream",
      headers: { "content-length": "40" },
      body: Buffer.from("OpenClaude tutorial fixture artifact\n"),
    };
  if (method === "POST" && path === "/api/container-preview/ticket") {
    const input = request.postDataJSON?.() ?? {};
    return json({
      ticket: "tutorial-container-preview-ticket",
      expiresAt: Date.parse(FIXED_NOW) + 30_000,
      url: input.url ?? "http://127.0.0.1:4173/",
      viewport: input.viewport ?? PREVIEW_VIEWPORT,
      protocol: "preview-v1",
    });
  }

  if (
    method === "GET" &&
    /^\/api\/me\/sessions\/[^/]+\/github-selection$/.test(path)
  )
    return json({ selected: false });
  if (
    method === "PUT" &&
    /^\/api\/me\/sessions\/[^/]+\/github-selection$/.test(path)
  )
    return json({
      selected: true,
      owner: "openclaude-demo",
      repo: "aurora-workspace",
      branch: "feature/tutorial",
      default_branch: "main",
      status: "pending",
      selection_version: 1,
    });
  if (method === "GET" && path === "/api/me/github")
    return json({
      linked: true,
      login: "openclaude-demo",
      scopes: "repo read:user",
    });
  if (method === "GET" && path === "/api/me/github/repos")
    return json({
      items: [
        {
          owner: { login: "openclaude-demo" },
          name: "aurora-workspace",
          full_name: "openclaude-demo/aurora-workspace",
          default_branch: "main",
          private: true,
          pushed_at: FIXED_NOW,
        },
        {
          owner: { login: "openclaude-demo" },
          name: "research-notes",
          full_name: "openclaude-demo/research-notes",
          default_branch: "main",
          private: false,
          pushed_at: "2026-07-14T00:00:00.000Z",
        },
      ],
    });
  if (
    method === "GET" &&
    /^\/api\/me\/github\/repos\/[^/]+\/[^/]+\/branches$/.test(path)
  )
    return json({
      items: [
        {
          name: "main",
          commit: { sha: "1111111111111111111111111111111111111111" },
        },
        {
          name: "feature/tutorial",
          commit: { sha: "2222222222222222222222222222222222222222" },
        },
      ],
    });

  if (method === "GET" && /^\/api\/agents\/[^/]+\/memory\/memory$/.test(path))
    return json({
      kind: "index",
      text: "# 长期记忆\n\n- 沟通偏好\n- 项目背景",
      version: "tutorial-v1",
      files: [
        {
          file: "communication-style.md",
          name: "沟通偏好",
          description: "先给结论，再列证据与下一步。",
          type: "user",
          mtimeMs: 1784090000000,
          size: 286,
        },
        {
          file: "aurora-launch.md",
          name: "Aurora 发布项目",
          description: "移动端发布的长期背景与验收标准。",
          type: "project",
          mtimeMs: 1784080000000,
          size: 512,
        },
      ],
    });
  if (method === "GET" && /^\/api\/agents\/[^/]+\/memory\/user$/.test(path))
    return json({
      kind: "user",
      text: "# 用户画像\n\n负责 AI 产品与商业化，偏好简洁、可核验的结论。",
      version: "tutorial-user-v1",
    });
  if (
    method === "GET" &&
    /^\/api\/agents\/[^/]+\/memory\/files\/aurora-launch\.md$/.test(path)
  )
    return json({
      content:
        "---\nname: Aurora 发布项目\ndescription: 移动端发布的长期背景与验收标准。\ntype: project\n---\n\n发布前核对移动端教程、真实录制素材与回归测试。",
      version: "tutorial-file-v1",
    });
  if (
    method === "GET" &&
    /^\/api\/agents\/[^/]+\/auto-dream-report$/.test(path)
  )
    return json({
      status: "success",
      pendingSessions: 1,
      lastReport: {
        status: "success",
        finishedAt: FIXED_NOW,
        sessionsReviewed: 7,
        summary: "已复盘近期任务，更新一条项目记忆并保留沟通偏好。",
        created: [
          { file: "launch-checklist.md", action: "created", type: "project" },
        ],
        updated: [
          { file: "aurora-launch.md", action: "updated", type: "project" },
        ],
        deleted: [],
      },
    });
  if (method === "GET" && path === "/api/cron")
    return json({
      jobs: [
        {
          id: "tutorial-cron-1",
          schedule: "0 9 * * 1-5",
          prompt: "汇总过去 24 小时行业动态，只保留官方来源。",
          deliver: "webchat",
          enabled: true,
          oneshot: false,
          label: "每日行业摘要",
          nextRunAt: "2026-07-16T01:00:00.000Z",
          lastRunAt: FIXED_NOW,
        },
        {
          id: "tutorial-cron-2",
          schedule: "30 17 * * 5",
          prompt: "总结本周完成项、风险和下周第一优先级。",
          deliver: "webchat",
          enabled: true,
          oneshot: false,
          label: "每周项目复盘",
          nextRunAt: "2026-07-17T09:30:00.000Z",
          lastRunAt: "2026-07-10T09:30:00.000Z",
        },
      ],
    });
  if (method === "GET" && path === "/api/skills")
    return json({
      skills: [
        {
          name: "evidence-research",
          description: "检索一手资料并生成可回查引用。",
          version: "2.1.0",
          tags: ["研究", "引用"],
          source: "user",
          layer: "user",
          writable: true,
          agentIds: ["main", "research-assistant"],
        },
      ],
    });
  if (method === "GET" && path === "/api/skills/evidence-research")
    return json({
      skill: {
        name: "evidence-research",
        description: "检索一手资料并生成可回查引用。",
        version: "2.1.0",
        tags: ["研究", "引用"],
        source: "user",
        layer: "user",
        writable: true,
        agentIds: ["main", "research-assistant"],
        body: "# Evidence Research\n\n优先官方与论文，逐条核对日期、结论和引用。",
        files: ["SKILL.md", "evals/evals.json"],
      },
    });
  if (method === "GET" && path === "/api/skills/evidence-research/evals")
    return json({
      evals: {
        cases: [
          {
            id: "official-source",
            prompt: "核对产品发布日期",
            assertions: ["引用官方公告"],
          },
        ],
        autoRegression: true,
      },
      lastRun: {
        id: "tutorial-eval",
        status: "done",
        passed: 8,
        total: 9,
        startedAt: "2026-07-14T02:00:00.000Z",
        finishedAt: "2026-07-14T02:03:00.000Z",
      },
    });
  if (method === "GET" && path === "/api/skill-training")
    return json({
      runs: [
        {
          id: "tutorial-training",
          skillName: "evidence-research",
          status: "done",
          startedAt: "2026-07-13T02:00:00.000Z",
          finishedAt: "2026-07-13T02:08:00.000Z",
          summary: "基于失败用例生成 1 个改进草稿。",
        },
      ],
    });

  if (method === "GET" && path === "/api/me/research/library")
    return json({
      documents: [
        {
          docId: "tutorial-doc-001",
          title: "AI 办公产品 2026 趋势报告",
          lang: "zh",
          spanCount: 84,
          createdAt: "2026-07-14T06:00:00.000Z",
        },
        {
          docId: "tutorial-doc-002",
          title: "Agent Evaluation Methods",
          lang: "en",
          spanCount: 62,
          createdAt: "2026-07-13T06:00:00.000Z",
        },
      ],
    });
  if (method === "POST" && path === "/api/me/research/library")
    return json({
      docId: "tutorial-doc-003",
      title: url.searchParams.get("filename"),
      spanCount: 12,
      needsOcr: false,
    });

  if (method === "GET" && path === "/api/connectors")
    return json({
      providers: [
        {
          id: "notion",
          label: "Notion",
          description: "读取与更新授权的 Notion 页面。",
          authKind: "token",
          formFields: [
            {
              key: "token",
              label: "Internal Integration Token",
              type: "password",
              required: true,
            },
          ],
        },
        {
          id: "feishu",
          label: "飞书",
          description: "读取文档并向群聊发送内容。",
          authKind: "oauth2_byoa",
          formFields: [],
        },
        {
          id: "github",
          label: "GitHub",
          description: "读取仓库并协作开发。",
          authKind: "token",
          formFields: [],
        },
      ],
      connections: [
        {
          id: "tutorial-connection-1",
          provider: "notion",
          displayName: "产品知识库",
          accountHint: "Tutorial Workspace",
          status: "active",
          lastErrorCode: null,
          createdAt: FIXED_NOW,
        },
      ],
    });
  if (method === "GET" && path === "/api/connectors/declarative/management")
    return json({ connectors: [], connections: [] });

  if (method === "GET" && path === "/api/marketplace/search")
    return json({
      results: [MARKET_CARD],
      method: url.searchParams.get("q") ? "keyword" : "all",
    });
  if (method === "GET" && path === "/api/marketplace/installed")
    return json({ installed: [] });
  if (method === "GET" && path === "/api/marketplace/evidence-research")
    return json({
      detail: {
        ...MARKET_CARD,
        state: "active",
        ownerUserId: "tutorial-publisher",
        version: "2.1.0",
        versionId: "tutorial-market-version",
        artifactHash: "tutorial-artifact-hash",
        rawArtifact: "# Evidence Research\n\n优先官方来源并输出可回查引用。",
        rawSkillMd: "# Evidence Research",
        riskFlags: [],
        humanMd: "适合需要时效性、证据链和来源核查的研究任务。",
        outcomeExamples: ["给出竞品列表 → 得到带发布日期和官方链接的对比表"],
      },
    });
  if (method === "GET" && path === "/api/marketplace/my-publishes")
    return json({
      publishes: [
        {
          versionId: "tutorial-publish-v1",
          slug: "weekly-brief",
          kind: "skill",
          version: "1.2.0",
          name: "每周简报",
          status: "approved",
          reviewNote: null,
          createdAt: "2026-07-12T04:00:00.000Z",
          reviewedAt: "2026-07-12T04:02:00.000Z",
          isCurrent: true,
          listingState: "active",
        },
      ],
    });

  if (method === "GET" && path === "/api/subscription/me")
    return json({
      ok: true,
      data: {
        subscription: {
          plan_code: "max",
          plan_name: "Max",
          status: "active",
          period_start: "2026-07-01T00:00:00.000Z",
          period_end: "2026-08-01T00:00:00.000Z",
          period_credits: "2180",
          monthly_credits: "5000",
          price_cents: "19900",
          tier: 3,
          paid: true,
        },
        balance: { wallet: "500", period: "2180", total: "2680" },
      },
    });
  if (method === "GET" && path === "/api/me/usage") return json(USAGE);
  if (method === "GET" && path === "/api/me/usage/report")
    return json(usageReport(url.searchParams.get("window") ?? "7d"));
  if (method === "GET" && path === "/api/me/api-keys")
    return errorJson(403, "FORBIDDEN", "此账号未开放 API Key");

  if (method === "GET" && path === "/api/org")
    return json({
      org: {
        id: "tutorial-org",
        name: "示例研发组",
        status: "active",
        role: "owner",
        billing_enabled: true,
        member_count: 2,
        max_members: 5,
        credits: "12600",
      },
    });
  if (method === "GET" && path === "/api/org/subscription")
    return json({
      subscription: {
        plan_code: "team",
        status: "active",
        seats: 5,
        period_start: "2026-07-01T00:00:00.000Z",
        period_end: "2026-08-01T00:00:00.000Z",
        period_credits: "18600",
      },
      plans: [
        {
          code: "team",
          name: "Team",
          seat_price_cents: "9900",
          per_seat_credits: "5000",
          min_seats: 3,
          period_days: 30,
        },
      ],
    });
  if (method === "GET" && path === "/api/org/usage")
    return json(orgUsage(url.searchParams.get("window") ?? "24h"));
  if (method === "GET" && path === "/api/org/members")
    return json({
      members: [
        {
          user_id: "tutorial-user",
          email: "learner@example.invalid",
          display_name: "教程用户",
          org_role: "owner",
          status: "active",
          billing_enabled: true,
          billing_delegate: false,
          monthly_org_budget: null,
          month_org_spent: "670",
          user_status: "active",
          invited_by: null,
          joined_at: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
  if (method === "GET" && path === "/api/org/invitations")
    return json({ invitations: [] });
  if (method === "GET" && path === "/api/org/skills")
    return json({
      installed: [
        { slug: "evidence-research", name: "证据研究助手", version: "2.1.0" },
      ],
      available: [],
    });
  if (method === "GET" && path === "/api/org/orders") return json({ rows: [] });
  if (method === "GET" && path === "/api/org/ledger") return json({ rows: [] });
  if (method === "GET" && path === "/api/org/invoice-profile")
    return json({ profile: null });
  if (method === "GET" && path === "/api/org/invoices")
    return json({ invoices: [] });

  if (method === "POST" && path === "/api/feedback")
    return json({ ok: true, feedback_id: "tutorial-feedback-id" });
  throw new Error(`未知教程 fixture：${method} ${path}${url.search}`);
}

type ActionTrace = {
  step: string;
  selector: string;
  tag: string;
  role: string | null;
  label: string;
  expectedFeatureId: ProductFeatureId;
  matchedFeatureId: string | null;
  matchedControl: boolean;
  dialogTitle: string | null;
  activeTabs: string[];
  assertions: string[];
};
type CaptureStage = { label: string; product: Buffer; dHash: string };
type ScenarioResult = {
  featureId: ProductFeatureId;
  caption: string;
  stages: CaptureStage[];
  actions: ActionTrace[];
  assertions: string[];
  bodyText: string;
};
type ScenarioContext = {
  page: any;
  featureId: ProductFeatureId;
  caption: string;
  stages: CaptureStage[];
  actions: ActionTrace[];
  assertions: string[];
};
type ScenarioDefinition = {
  featureId: ProductFeatureId;
  run: (ctx: ScenarioContext) => Promise<void>;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const xmlEscape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("无法分配教程 preview 随机端口");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}

function runBuild(): void {
  rmSync(CAPTURE_DIST, { recursive: true, force: true });
  execFileSync(
    "npm",
    [
      "exec",
      "--workspace",
      "@openclaude/web-react",
      "--",
      "vite",
      "build",
      "--mode",
      "production",
      "--outDir",
      "dist-tutorial-capture",
    ],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
  const manifestPath = join(CAPTURE_DIST, ".vite/manifest.json");
  const indexPath = join(CAPTURE_DIST, "index.html");
  if (!existsSync(manifestPath) || !existsSync(indexPath))
    throw new Error("教程录制必须使用正式 main.tsx → App 的 production build");
  const manifestText = readFileSync(manifestPath, "utf8");
  if (
    /tutorialCapture|TutorialCaptureStudio|tutorial-capture/.test(manifestText)
  )
    throw new Error("production manifest 意外包含教程专用 UI 入口");
}

async function startPreview(
  port: number,
): Promise<{ child: ChildProcess; output: () => string }> {
  const child = spawn(
    "npm",
    [
      "exec",
      "--workspace",
      "@openclaude/web-react",
      "--",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--outDir",
      "dist-tutorial-capture",
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let logs = "";
  child.stdout?.on("data", (chunk) => (logs += String(chunk)));
  child.stderr?.on("data", (chunk) => (logs += String(chunk)));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null)
      throw new Error(`教程 preview 启动失败：\n${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/index.html`);
      if (response.ok) return { child, output: () => logs };
    } catch {
      // preview 尚未就绪。
    }
    await pause(100);
  }
  if (child.pid) process.kill(-child.pid, "SIGTERM");
  throw new Error(`教程 preview 启动超时：\n${logs}`);
}

async function stopPreview(
  child: ChildProcess | null,
  port: number | null,
): Promise<void> {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
    await Promise.race([once(child, "close").catch(() => []), pause(3000)]);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  if (port != null) {
    try {
      await fetch(`http://127.0.0.1:${port}/index.html`);
      throw new Error(`教程 preview 清理失败：端口 ${port} 仍可访问`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("清理失败"))
        throw error;
    }
  }
}

async function productDHash(input: Buffer): Promise<string> {
  const { data } = await sharp(input)
    .resize(17, 16, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      bits =
        (bits << 1n) | (data[y * 17 + x]! > data[y * 17 + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(64, "0");
}

async function composeFrame(
  stage: CaptureStage,
  caption: string,
  index: number,
  total: number,
): Promise<Buffer> {
  const footer =
    Buffer.from(`<svg width="${WIDTH}" height="${FOOTER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#10131a"/>
    <text x="18" y="25" fill="#f5f7fb" font-size="14" font-family="Inter, Noto Sans CJK SC, sans-serif" font-weight="600">${xmlEscape(stage.label)}</text>
    <text x="${WIDTH - 18}" y="25" text-anchor="end" fill="#9aa4b5" font-size="12" font-family="Inter, Noto Sans CJK SC, sans-serif">${index + 1}/${total} · ${xmlEscape(caption)}</text>
  </svg>`);
  return (
    sharp({
      create: {
        width: WIDTH,
        height: HEIGHT,
        channels: 4,
        background: "#10131a",
      },
    })
      .composite([
        { input: stage.product, left: 0, top: 0 },
        { input: footer, left: 0, top: PRODUCT_HEIGHT },
      ])
      // Playwright 自带的受控 ffmpeg 仅编译了 mjpeg 输入解码器；JPEG 质量固定以保持重跑稳定。
      .jpeg({ quality: 91, chromaSubsampling: "4:2:0" })
      .toBuffer()
  );
}

async function encodeVideo(
  path: string,
  frames: Buffer[],
  ffmpeg: string,
): Promise<void> {
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(FPS),
      "-vcodec",
      "mjpeg",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libvpx",
      "-deadline",
      "good",
      "-cpu-used",
      "2",
      "-crf",
      "35",
      "-b:v",
      "260k",
      "-pix_fmt",
      "yuv420p",
      "-bitexact",
      "-map_metadata",
      "-1",
      "-metadata",
      "creation_time=1970-01-01T00:00:00Z",
      "-y",
      path,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let error = "";
  child.stderr?.on("data", (chunk) => (error += String(chunk)));
  for (const frame of frames) {
    if (!child.stdin!.write(frame)) await once(child.stdin!, "drain");
  }
  child.stdin!.end();
  const [code] = (await once(child, "close")) as [number];
  if (code !== 0)
    throw new Error(`ffmpeg 生成 ${basename(path)} 失败：${error}`);
}

async function nodeEvidence(
  locator: any,
  selector: string,
  expectedFeatureId: ProductFeatureId,
  step: string,
): Promise<ActionTrace> {
  await locator.waitFor({ state: "visible", timeout: 8000 });
  const evidence = await locator.evaluate((node: Element) => {
    const element = node as HTMLElement;
    const featureNode = element.closest(
      "[data-product-feature]",
    ) as HTMLElement | null;
    const controlNode = element.closest(
      'button, input, select, textarea, a[href], [role="button"], [role="menuitem"], [role="switch"], [role="tab"], [data-product-control]',
    ) as HTMLElement | null;
    const dialog = element.closest('[role="dialog"]') as HTMLElement | null;
    const title = dialog?.querySelector(
      '[data-radix-collection-item], h1, h2, [role="heading"]',
    ) as HTMLElement | null;
    const activeTabs = Array.from(
      (dialog ?? document).querySelectorAll(
        '[role="tab"][aria-selected="true"]',
      ),
    )
      .map((item) => (item.textContent ?? "").trim())
      .filter(Boolean);
    const formControl = element as
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const associatedLabel = Array.from(formControl.labels ?? [])
      .map((item) => item.textContent?.trim())
      .find(Boolean);
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      label:
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        associatedLabel ||
        element.getAttribute("name") ||
        (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120) ||
        `${element.tagName.toLowerCase()} control`,
      matchedFeatureId: featureNode?.dataset.productFeature ?? null,
      matchedControl: Boolean(controlNode),
      dialogTitle: title?.textContent?.trim() ?? null,
      activeTabs,
    };
  });
  if (evidence.matchedFeatureId !== expectedFeatureId) {
    throw new Error(
      `${expectedFeatureId} 的动作“${step}”未命中对应真实功能节点；selector=${selector}, matched=${evidence.matchedFeatureId}`,
    );
  }
  return {
    step,
    selector,
    expectedFeatureId,
    assertions: [`visible:${selector}`, `feature:${expectedFeatureId}`],
    ...evidence,
  };
}

async function tracedClick(
  ctx: ScenarioContext,
  selector: string,
  step: string,
): Promise<void> {
  const locator = ctx.page.locator(selector).first();
  ctx.actions.push(await nodeEvidence(locator, selector, ctx.featureId, step));
  await locator.click();
  await pause(180);
}

async function tracedFill(
  ctx: ScenarioContext,
  selector: string,
  value: string,
  step: string,
): Promise<void> {
  const locator = ctx.page.locator(selector).first();
  ctx.actions.push(await nodeEvidence(locator, selector, ctx.featureId, step));
  await locator.fill(value);
  await pause(180);
}

async function tracedSelect(
  ctx: ScenarioContext,
  selector: string,
  value: string,
  step: string,
): Promise<void> {
  const locator = ctx.page.locator(selector).first();
  ctx.actions.push(await nodeEvidence(locator, selector, ctx.featureId, step));
  await locator.selectOption(value);
  await pause(180);
}

async function tracedFiles(
  ctx: ScenarioContext,
  selector: string,
  name: string,
  mimeType: string,
  body: string,
  step: string,
): Promise<void> {
  const locator = ctx.page.locator(selector).first();
  // 原生 file input 按产品设计隐藏；轨迹证明记录用户实际点击的相邻可见按钮，再向 input 注入脱敏 fixture。
  const controlSelector = `${selector} + button`;
  ctx.actions.push(
    await nodeEvidence(
      ctx.page.locator(controlSelector).first(),
      controlSelector,
      ctx.featureId,
      step,
    ),
  );
  await locator.setInputFiles({ name, mimeType, buffer: Buffer.from(body) });
  await pause(300);
}

async function assertVisible(
  ctx: ScenarioContext,
  selector: string,
  description: string,
): Promise<void> {
  await ctx.page
    .locator(selector)
    .first()
    .waitFor({ state: "visible", timeout: 8000 });
  ctx.assertions.push(description);
}

async function stage(ctx: ScenarioContext, label: string): Promise<void> {
  await ctx.page.evaluate(async () => {
    await document.fonts.ready;
  });
  await ctx.page.mouse.move(8, 8);
  // 给懒加载模块、fixture 状态提交和 Chart.js 的 JavaScript 动画完整收敛；仅连续截图
  // 相同还不够，因为“加载前的静止画面”也可能短暂稳定。
  await pause(1_600);
  let previous: Buffer | null = null;
  let product: Buffer | null = null;
  let stableMatches = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await ctx.page.screenshot({
      type: "png",
      animations: "disabled",
      timeout: 60_000,
    });
    if (previous && sha256(previous) === sha256(current)) {
      stableMatches += 1;
      if (stableMatches >= 2) {
        product = current;
        break;
      }
    } else {
      stableMatches = 0;
    }
    previous = current;
    await pause(350);
  }
  if (!product)
    throw new Error(`${ctx.featureId} 的“${label}”在连续截图间仍未稳定`);
  const metadata = await sharp(product).metadata();
  if (metadata.width !== WIDTH || metadata.height !== PRODUCT_HEIGHT)
    throw new Error(`产品截图尺寸错误：${metadata.width}×${metadata.height}`);
  ctx.stages.push({ label, product, dHash: await productDHash(product) });
}

async function plainClick(
  ctx: ScenarioContext,
  selector: string,
): Promise<void> {
  const locator = ctx.page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 8000 });
  await locator.click();
  await pause(180);
}

async function openSidebarEntry(
  ctx: ScenarioContext,
  featureId: ProductFeatureId,
  text: string,
): Promise<void> {
  await plainClick(
    ctx,
    `aside button[data-product-feature="${featureId}"]:has-text("${text}")`,
  );
}

async function openManage(ctx: ScenarioContext): Promise<void> {
  await openSidebarEntry(ctx, "memory-auto-dream", "管理中心");
  await assertVisible(
    ctx,
    '[role="dialog"]:has-text("管理中心")',
    "管理中心已打开",
  );
}

async function selectDialogTab(
  ctx: ScenarioContext,
  label: string,
): Promise<void> {
  await tracedClick(
    ctx,
    `[role="dialog"] [role="tab"]:has-text("${label}")`,
    `切换到${label}`,
  );
}

async function selectRichSession(ctx: ScenarioContext): Promise<void> {
  await plainClick(ctx, 'aside button:has-text("季度经营复盘")');
  await assertVisible(ctx, "main", "季度经营复盘会话已打开");
  await ctx.page.waitForFunction(() => {
    const image = Array.from(document.images).find((item) =>
      item.currentSrc.includes("/tutorial-fixture/launch-visual.png"),
    );
    return Boolean(image?.complete && image.naturalWidth > 0);
  });
}

async function centerInViewport(locator: any): Promise<void> {
  await locator.evaluate((element: Element) =>
    element.scrollIntoView({ behavior: "instant", block: "center" }),
  );
  await pause(180);
}

const SCENARIOS: ScenarioDefinition[] = [
  {
    featureId: "chat-basics",
    async run(ctx) {
      await tracedClick(
        ctx,
        'aside button[data-product-feature="chat-basics"]:has-text("新建会话")',
        "新建独立会话",
      );
      await stage(ctx, "新建会话，准备描述任务");
      await tracedFill(
        ctx,
        'textarea[data-product-feature="chat-basics"]',
        "把今天的会议整理成结论、负责人和截止时间三栏。",
        "输入清晰的交付目标",
      );
      await stage(ctx, "写清目标、字段和交付格式");
      const send = ctx.page.locator('button[aria-label="发送"]').first();
      ctx.actions.push(
        await nodeEvidence(
          send,
          'button[aria-label="发送"]',
          ctx.featureId,
          "发送任务",
        ),
      );
      await send.click();
      await assertVisible(
        ctx,
        'main :text("已根据要求整理")',
        "助手已返回完整交付",
      );
      await stage(ctx, "发送后核对助手的完整交付");
    },
  },
  {
    featureId: "sessions-history",
    async run(ctx) {
      await tracedFill(
        ctx,
        'input[data-product-feature="sessions-history"][placeholder="搜索会话"]',
        "客户研究",
        "搜索已有项目会话",
      );
      await stage(ctx, "在侧栏搜索已有项目");
      await tracedClick(
        ctx,
        'aside [data-product-feature="sessions-history"] button:has-text("客户研究与竞品分析")',
        "切换到客户研究会话",
      );
      await assertVisible(ctx, 'main :text("对比三家产品")', "历史消息已恢复");
      await stage(ctx, "打开会话并恢复历史上下文");
    },
  },
  {
    featureId: "models-reasoning",
    async run(ctx) {
      await tracedClick(
        ctx,
        'button[data-product-feature="models-reasoning"][aria-label="选择对话模型"]',
        "打开模型选择器",
      );
      await stage(ctx, "查看当前可用模型与思考档位");
      await tracedClick(
        ctx,
        '[data-product-feature="models-reasoning"] [role="menuitem"]:has-text("GPT-5.6-Terra")',
        "选择 GPT-5.6-Terra",
      );
      await assertVisible(
        ctx,
        'button[aria-label="选择对话模型"]:has-text("GPT-5.6-Terra")',
        "顶栏已显示新模型",
      );
      await stage(ctx, "确认后续消息使用所选模型");
      await tracedClick(
        ctx,
        'button[data-product-feature="models-reasoning"][aria-label="选择对话模型"]',
        "重新打开选择器核对当前模型",
      );
      await stage(ctx, "在模型列表中核对当前选择与可用范围");
    },
  },
  {
    featureId: "files-media",
    async run(ctx) {
      await tracedFiles(
        ctx,
        'input[type="file"][data-product-feature="files-media"]',
        "季度数据.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "tutorial spreadsheet fixture",
        "选择季度数据附件",
      );
      await assertVisible(ctx, ':text("季度数据.xlsx")', "附件卡片已出现");
      await stage(ctx, "等待附件上传并确认文件卡片");
      await ctx.page
        .locator('textarea[data-product-feature="chat-basics"]')
        .fill("分析附件中的收入趋势，列出异常点和建议。");
      await pause(180);
      await stage(ctx, "在同一条消息里说明分析目标");
    },
  },
  {
    featureId: "voice-input",
    async run(ctx) {
      await tracedClick(
        ctx,
        'button[data-product-feature="voice-input"][aria-label="语音输入"]',
        "开始语音输入",
      );
      await assertVisible(
        ctx,
        'button[aria-label="停止录音"]',
        "录音状态已启动",
      );
      await stage(ctx, "开始录音并观察录音状态");
      await tracedClick(
        ctx,
        'button[data-product-feature="voice-input"][aria-label="停止录音"]',
        "停止录音并转写",
      );
      await ctx.page.waitForFunction(() =>
        (
          document.querySelector("textarea") as HTMLTextAreaElement | null
        )?.value.includes("请整理今天的会议结论"),
      );
      ctx.assertions.push("语音转写文字已进入输入框");
      await stage(ctx, "停止后校对进入输入框的转写文字");
    },
  },
  {
    featureId: "web-research",
    async run(ctx) {
      await openManage(ctx);
      await selectDialogTab(ctx, "文献库");
      await assertVisible(
        ctx,
        ':text("AI 办公产品 2026 趋势报告")',
        "已加载真实文献库列表",
      );
      await stage(ctx, "进入文献库查看已解析资料");
      await tracedFiles(
        ctx,
        '[role="dialog"] input[type="file"]',
        "行业报告.md",
        "text/markdown",
        "# 行业报告\n\n这是脱敏教程资料。",
        "上传新的研究资料",
      );
      await assertVisible(ctx, ':text("已入库")', "上传资料已入库");
      await stage(ctx, "上传资料并确认解析入库");
    },
  },
  {
    featureId: "artifacts-download",
    async run(ctx) {
      await selectRichSession(ctx);
      const artifact = ctx.page
        .locator('[data-product-feature="artifacts-download"]')
        .first();
      await artifact.waitFor({ state: "visible", timeout: 8000 });
      await centerInViewport(artifact);
      ctx.assertions.push("成果文件卡片已渲染");
      await stage(ctx, "在历史消息中找到成果文件卡片");
      await tracedClick(
        ctx,
        'a[data-product-feature="artifacts-download"]',
        "下载成果文件",
      );
      await centerInViewport(artifact);
      await artifact.hover();
      await stage(ctx, "触发签名下载并保留成果卡片入口");
    },
  },
  {
    featureId: "container-web-preview",
    async run(ctx) {
      await plainClick(ctx, 'aside button:has-text("容器网页验收")');
      await assertVisible(
        ctx,
        'a[data-container-local-preview="true"]:has-text("打开 Aurora 项目看板")',
        "会话已渲染可验证的容器本地网页链接",
      );
      await stage(ctx, "在真实会话中找到容器网页预览入口");
      await tracedClick(
        ctx,
        'a[data-product-feature="container-web-preview"][data-container-local-preview="true"]',
        "打开容器内网页预览",
      );
      await assertVisible(
        ctx,
        '[data-product-feature="container-web-preview"] canvas[aria-label="可交互网页画面"]',
        "隔离浏览器预览已打开",
      );
      await ctx.page.waitForFunction(() => {
        const canvas = document.querySelector(
          '[data-product-feature="container-web-preview"] canvas',
        ) as HTMLCanvasElement | null;
        return canvas?.width === 1280 && canvas.height === 800;
      });
      ctx.assertions.push("真实预览控件已绘制容器网页画面");
      await stage(ctx, "在桌面视口验收容器内真实网页");
      await tracedClick(
        ctx,
        '[data-product-feature="container-web-preview"] button:has-text("评论")',
        "切换到元素评论模式",
      );
      const canvas = ctx.page.locator(
        '[data-product-feature="container-web-preview"] canvas[aria-label="网页画面，点按选择评论元素"]',
      );
      await canvas.click({ position: { x: 90, y: 250 } });
      await assertVisible(
        ctx,
        '[data-product-feature="container-web-preview"] textarea[aria-label="描述网页修改"]',
        "已选中页面主按钮并打开评论输入",
      );
      await tracedFill(
        ctx,
        '[data-product-feature="container-web-preview"] textarea[aria-label="描述网页修改"]',
        "改成主品牌色，移动端占满一行，并把文案改为“立即开始”。",
        "填写针对所选元素的修改意见",
      );
      await stage(ctx, "选中具体按钮并填写可执行修改意见");
      await tracedClick(
        ctx,
        '[data-product-feature="container-web-preview"] button:has-text("添加评论")',
        "保存元素评论",
      );
      await assertVisible(
        ctx,
        '[data-product-feature="container-web-preview"] button:has-text("1 条评论")',
        "评论数量已更新，页面锚点仍然可见",
      );
      await stage(ctx, "保存后核对页面锚点与评论数量");
      await tracedClick(
        ctx,
        '[data-product-feature="container-web-preview"] button:has-text("1 条评论")',
        "打开网页修改评论清单",
      );
      await assertVisible(
        ctx,
        '[role="dialog"]:has-text("网页修改评论") :text("#hero-cta")',
        "元素选择器与评论已加入修改清单",
      );
      await assertVisible(
        ctx,
        '[role="dialog"]:has-text("网页修改评论") :text("改成主品牌色")',
        "修改意见已保留在评论清单",
      );
    },
  },
  {
    featureId: "image-create-edit",
    async run(ctx) {
      await selectRichSession(ctx);
      await assertVisible(
        ctx,
        'button[data-product-feature="image-create-edit"][aria-label="编辑图片"]',
        "图片编辑入口已渲染",
      );
      await tracedClick(
        ctx,
        'button[data-product-feature="image-create-edit"][aria-label="编辑图片"]',
        "打开图片编辑器",
      );
      await assertVisible(
        ctx,
        '[role="dialog"] button[data-product-feature="image-create-edit"]:has-text("编辑")',
        "图片查看器已打开并显示编辑入口",
      );
      await stage(ctx, "在图片查看器核对下载与编辑操作");
      await tracedClick(
        ctx,
        '[role="dialog"] button[data-product-feature="image-create-edit"]:has-text("编辑")',
        "进入圈选编辑模式",
      );
      await assertVisible(
        ctx,
        '[role="dialog"] [aria-label="关闭图片编辑器"]',
        "圈选图片编辑器已打开",
      );
      await stage(ctx, "进入真实图片查看与圈选编辑界面");
    },
  },
  {
    featureId: "github-repository",
    async run(ctx) {
      await tracedClick(
        ctx,
        '[data-product-feature="github-repository"][aria-label="关联 GitHub 仓库"]',
        "打开仓库关联面板",
      );
      await assertVisible(
        ctx,
        '[role="dialog"]:has-text("GitHub")',
        "仓库关联面板已打开",
      );
      await stage(ctx, "确认 GitHub 已关联并查看仓库列表");
      await tracedClick(
        ctx,
        '[role="dialog"][data-product-feature="github-repository"] button:has-text("aurora-workspace")',
        "选择仓库",
      );
      await assertVisible(
        ctx,
        '[role="dialog"] :text("feature/tutorial")',
        "分支列表已加载",
      );
      await tracedClick(
        ctx,
        '[role="dialog"][data-product-feature="github-repository"] button:has-text("feature/tutorial")',
        "选择目标分支",
      );
      await stage(ctx, "选择仓库与目标分支");
      await tracedClick(
        ctx,
        '[role="dialog"][data-product-feature="github-repository"] button:has-text("确认绑定")',
        "确认绑定仓库与分支",
      );
      await assertVisible(
        ctx,
        '[data-product-feature="github-repository"][aria-label*="aurora-workspace"]',
        "输入框下方已显示绑定仓库",
      );
      await stage(ctx, "确认仓库已绑定到当前会话");
    },
  },
  {
    featureId: "agents",
    async run(ctx) {
      await tracedClick(
        ctx,
        'header button[data-product-feature="agents"]',
        "打开智能体选择器",
      );
      await assertVisible(
        ctx,
        '[role="dialog"]:has-text("选择智能体")',
        "智能体选择器已打开",
      );
      await stage(ctx, "查看已安装的专业智能体");
      await tracedClick(
        ctx,
        '[role="dialog"] button[data-product-feature="agents"]:has-text("编程助手")',
        "切换到编程助手",
      );
      await assertVisible(ctx, 'header :text("编程助手")', "顶栏已切换智能体");
      await stage(ctx, "确认当前会话使用编程助手");
      await tracedClick(
        ctx,
        'header button[data-product-feature="agents"]',
        "重新打开选择器核对当前智能体",
      );
      await stage(ctx, "在智能体目录中核对当前角色与专业说明");
    },
  },
  {
    featureId: "team-mode",
    async run(ctx) {
      await plainClick(ctx, 'header button[data-product-feature="agents"]');
      await assertVisible(
        ctx,
        '[role="dialog"]:has-text("选择智能体")',
        "智能体选择器已打开",
      );
      await tracedClick(
        ctx,
        '[role="dialog"] [role="switch"][data-product-feature="team-mode"]',
        "启用团队模式",
      );
      await assertVisible(
        ctx,
        '[role="switch"][aria-checked="true"]',
        "团队模式开关已启用",
      );
      await stage(ctx, "启用团队模式并核对队长计费说明");
      await plainClick(
        ctx,
        '[role="dialog"] button[data-product-feature="agents"]:has-text("全能助手")',
      );
      await assertVisible(
        ctx,
        'header button[data-product-feature="team-mode"][aria-label="团队模式已开启"]',
        "顶栏已常驻显示团队模式状态",
      );
      await stage(ctx, "在工作区顶栏确认团队模式与队长引擎已生效");
      await tracedClick(
        ctx,
        'header button[data-product-feature="team-mode"][aria-label="团队模式已开启"]',
        "打开团队模式状态说明",
      );
      await assertVisible(
        ctx,
        ':text("团队模式已开启：队长引擎")',
        "团队模式状态与关闭入口已显示",
      );
      await stage(ctx, "在工作区顶栏核对团队模式状态与关闭入口");
    },
  },
  {
    featureId: "memory-auto-dream",
    async run(ctx) {
      await openManage(ctx);
      await assertVisible(
        ctx,
        '[data-product-feature="memory-auto-dream"] :text("沟通偏好")',
        "长期记忆列表已加载",
      );
      await stage(ctx, "查看长期记忆与项目背景");
      await assertVisible(
        ctx,
        '[aria-label="Auto-Dream 梦境报告"]',
        "Auto-Dream 报告已加载",
      );
      await tracedClick(
        ctx,
        '[data-product-feature="memory-auto-dream"] [aria-label="Auto-Dream 梦境报告"] button',
        "打开 Auto-Dream 更新的记忆",
      );
      await stage(ctx, "展开查看本次自动复盘报告");
    },
  },
  {
    featureId: "schedules-reminders",
    async run(ctx) {
      await openManage(ctx);
      await selectDialogTab(ctx, "定时任务");
      await assertVisible(ctx, ':text("每日行业摘要")', "定时任务列表已加载");
      await stage(ctx, "查看任务状态与下一次执行时间");
      await tracedClick(
        ctx,
        '[data-product-feature="schedules-reminders"] button:has-text("新建")',
        "打开新建定时任务表单",
      );
      await stage(ctx, "打开新建表单配置计划与交付方式");
    },
  },
  {
    featureId: "skills-training",
    async run(ctx) {
      await openManage(ctx);
      await selectDialogTab(ctx, "技能");
      await assertVisible(ctx, ':text("evidence-research")', "技能列表已加载");
      await tracedClick(
        ctx,
        '[data-product-feature="skills-training"] button:has-text("evidence-research")',
        "打开技能详情",
      );
      await stage(ctx, "查看技能正文与版本信息");
      await tracedClick(
        ctx,
        '[data-product-feature="skills-training"] button:has-text("评测")',
        "打开评测与训练区",
      );
      await stage(ctx, "查看评测结果和训练优化入口");
    },
  },
  {
    featureId: "connectors",
    async run(ctx) {
      await openManage(ctx);
      await selectDialogTab(ctx, "连接器");
      await assertVisible(ctx, ':text("产品知识库")', "已绑定连接器已加载");
      await stage(ctx, "查看已绑定的 Notion 产品知识库");
      await tracedClick(
        ctx,
        '[data-product-feature="connectors"] button:has-text("Notion"), [data-product-feature="connectors"] button:has-text("绑定")',
        "查看连接器绑定入口",
      );
      await stage(ctx, "查看可绑定账号与连接器状态");
    },
  },
  {
    featureId: "marketplace-discovery",
    async run(ctx) {
      await openSidebarEntry(ctx, "marketplace-discovery", "市场");
      await assertVisible(
        ctx,
        '[role="dialog"]:has-text("AI 市场")',
        "AI 市场已打开",
      );
      await tracedFill(
        ctx,
        '[data-product-feature="marketplace-discovery"] input[placeholder*="搜索"]',
        "研究",
        "搜索研究类能力",
      );
      await pause(450);
      await assertVisible(ctx, ':text("证据研究助手")', "搜索结果已加载");
      await stage(ctx, "搜索并比较匹配的市场能力");
      await tracedClick(
        ctx,
        '[data-product-feature="marketplace-discovery"] button:has-text("证据研究助手"), [data-product-feature="marketplace-discovery"] article:has-text("证据研究助手")',
        "打开市场条目详情",
      );
      await assertVisible(
        ctx,
        '[role="dialog"] :text("适用场景")',
        "条目详情已打开",
      );
      await stage(ctx, "核对详情、适用场景与版本");
    },
  },
  {
    featureId: "marketplace-publishing",
    async run(ctx) {
      await openSidebarEntry(ctx, "marketplace-discovery", "市场");
      await selectDialogTab(ctx, "发布");
      await assertVisible(
        ctx,
        '[data-product-feature="marketplace-publishing"]',
        "发布面板已打开",
      );
      await stage(ctx, "进入公开市场的创作发布页");
      const input = ctx.page
        .locator('[data-product-feature="marketplace-publishing"] input')
        .first();
      const selector = '[data-product-feature="marketplace-publishing"] input';
      ctx.actions.push(
        await nodeEvidence(input, selector, ctx.featureId, "填写技能名称"),
      );
      await input.fill("周报整理助手");
      await stage(ctx, "填写技能定义并核对发布记录");
    },
  },
  {
    featureId: "inbox",
    async run(ctx) {
      await tracedClick(
        ctx,
        'header button[data-product-feature="inbox"][aria-label="站内信"]',
        "打开站内信",
      );
      await assertVisible(
        ctx,
        '[role="dialog"]:has-text("站内信")',
        "站内信已打开",
      );
      await stage(ctx, "查看全部服务通知");
      await tracedClick(
        ctx,
        '[role="dialog"] [role="tab"][data-product-feature="inbox"]:has-text("未读")',
        "筛选未读消息",
      );
      await tracedClick(
        ctx,
        '[role="dialog"] [data-product-feature="inbox"] button:has-text("定时任务已完成")',
        "展开一条未读通知",
      );
      await stage(ctx, "筛选未读并展开通知详情");
    },
  },
  {
    featureId: "preferences",
    async run(ctx) {
      await plainClick(ctx, 'aside button[aria-label="设置"]');
      await selectDialogTab(ctx, "偏好");
      await assertVisible(
        ctx,
        '[data-product-feature="preferences"] :text("默认模型")',
        "偏好页已加载",
      );
      await stage(ctx, "查看外观、默认模型与 Auto-Dream");
      await tracedClick(
        ctx,
        '[data-product-feature="preferences"] button:has-text("深色")',
        "切换深色主题",
      );
      await assertVisible(ctx, "html.dark", "深色主题已生效");
      await stage(ctx, "切换主题并确认界面即时生效");
    },
  },
  {
    featureId: "billing-usage",
    async run(ctx) {
      await tracedClick(
        ctx,
        'aside button[data-product-feature="billing-usage"][aria-label="设置"]',
        "打开账户与计费",
      );
      await assertVisible(
        ctx,
        '[data-product-feature="billing-usage"] :text("Max")',
        "套餐与余额已加载",
      );
      await stage(ctx, "查看当前套餐与可用积分");
      await selectDialogTab(ctx, "用量");
      await assertVisible(
        ctx,
        '[data-product-feature="billing-usage"] canvas',
        "用量趋势图已加载",
      );
      await stage(ctx, "查看趋势、模型消耗与缓存命中");
    },
  },
  {
    featureId: "organization",
    async run(ctx) {
      await openSidebarEntry(ctx, "organization", "组织");
      await assertVisible(
        ctx,
        '[role="dialog"]:has-text("示例研发组")',
        "组织中心已打开",
      );
      await assertVisible(
        ctx,
        '[data-product-feature="organization"]',
        "组织概览已加载",
      );
      await stage(ctx, "查看组织成员数与共享额度");
      await selectDialogTab(ctx, "报表");
      await assertVisible(
        ctx,
        '[data-product-feature="organization"] canvas',
        "组织用量图表已加载",
      );
      await stage(ctx, "查看组织用量趋势与模型分布");
    },
  },
  {
    featureId: "feedback-support",
    async run(ctx) {
      await plainClick(ctx, 'aside button[aria-label="设置"]');
      await selectDialogTab(ctx, "反馈");
      await assertVisible(
        ctx,
        '[data-product-feature="feedback-support"] form',
        "反馈表单已打开",
      );
      await stage(ctx, "选择反馈类型并阅读隐私说明");
      await tracedSelect(
        ctx,
        '[data-product-feature="feedback-support"] select',
        "ux",
        "选择体验问题",
      );
      await tracedFill(
        ctx,
        '[data-product-feature="feedback-support"] textarea',
        "在教程中心切换章节后，希望能继续保留上次阅读位置。复现：打开教程，选择任一章节，再关闭并重新打开。",
        "填写复现步骤与期望结果",
      );
      await stage(ctx, "填写可复现描述并准备提交");
    },
  },
];

function browserInitScript(): string {
  return `(() => {
    const fixed = ${JSON.stringify(Date.parse(FIXED_NOW))};
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    }
    Object.setPrototypeOf(FixedDate, NativeDate);
    globalThis.Date = FixedDate;
    let seed = 123456789;
    Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    navigator.sendBeacon = () => false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {}, readText: async () => '' } });
    const track = { stop() {}, kind: 'audio', enabled: true, readyState: 'live' };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
    class TutorialMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = 'inactive';
      mimeType;
      ondataavailable = null;
      onstop = null;
      constructor(_stream, options = {}) { super(); this.mimeType = options.mimeType || 'audio/webm'; }
      start() { this.state = 'recording'; }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        const event = { data: new Blob(['tutorial-audio'], { type: this.mimeType }) };
        queueMicrotask(() => { this.ondataavailable?.(event); this.onstop?.(); });
      }
      requestData() { this.ondataavailable?.({ data: new Blob(['tutorial-audio'], { type: this.mimeType }) }); }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: TutorialMediaRecorder });
  })()`;
}

function chatReply(
  peer: { id?: string; kind?: string },
  agentId: string | undefined,
) {
  const peerId = String(peer?.id ?? "tutorial-peer");
  const safePeer = peerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    type: "outbound.message",
    sessionKey: `agent:${agentId || "main"}:webchat:dm:${safePeer}`,
    channel: "webchat",
    peer: { id: peerId, kind: "dm" },
    blocks: [
      {
        kind: "text",
        text: "已根据要求整理：\n\n| 结论 | 负责人 | 截止时间 |\n|---|---|---|\n| 完成需求确认 | 产品负责人 | 7 月 18 日 |\n| 交付验收版本 | 研发负责人 | 7 月 22 日 |",
        messageId: "tutorial-reply-1",
      },
    ],
    isFinal: true,
    frameSeq: 1,
    ts: Date.parse(FIXED_NOW),
    meta: { stopReason: "end_turn" },
  };
}

async function captureScenario(
  browser: any,
  baseUrl: string,
  definition: ScenarioDefinition,
  imagePng: Buffer,
  previewJpeg: Buffer,
): Promise<ScenarioResult> {
  const fixtureErrors: string[] = [];
  const blockedExternal = new Set<string>();
  const consoleErrors: string[] = [];
  let expectedApiKeyForbiddenResponses = 0;
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: PRODUCT_HEIGHT },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    permissions: ["microphone"],
  });
  await context.addInitScript({ content: browserInitScript() });
  const page = await context.newPage();
  page.on("response", (response: any) => {
    const url = new URL(response.url());
    if (
      url.origin === baseUrl &&
      url.pathname === "/api/me/api-keys" &&
      response.status() === 403
    )
      expectedApiKeyForbiddenResponses += 1;
  });
  page.on("console", (message: any) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error: Error) => consoleErrors.push(error.message));
  await page.route("**/*", async (route: any, request: any) => {
    const url = new URL(request.url());
    const local = url.origin === baseUrl;
    if (
      local &&
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/tutorial-fixture/")
    ) {
      await route.continue();
      return;
    }
    if (!local) {
      blockedExternal.add(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    try {
      const response = await fixtureFor(
        request.method(),
        url,
        request,
        imagePng,
      );
      await route.fulfill(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fixtureErrors.push(message);
      await route.fulfill(errorJson(500, "UNKNOWN_TUTORIAL_FIXTURE", message));
    }
  });
  await page.routeWebSocket("**/*", (socket: any) => {
    const url = new URL(socket.url());
    if (url.origin !== baseUrl.replace(/^http/, "ws")) {
      fixtureErrors.push(`未知外部 WebSocket：${url.href}`);
      socket.close({ code: 1008, reason: "blocked" });
      return;
    }
    if (url.pathname === "/ws/container-preview") {
      const protocols = socket.protocols() as string[];
      if (
        protocols[0] !== "preview-v1" ||
        protocols[1] !== "tutorial-container-preview-ticket"
      ) {
        fixtureErrors.push(`容器网页预览协议错误：${protocols.join(",")}`);
        socket.close({ code: 1002, reason: "bad tutorial preview protocol" });
        return;
      }
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            type: "preview.status",
            status: "loading",
            message: "正在载入脱敏本地页面",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "preview.ready",
            protocolVersion: 1,
            url: "http://127.0.0.1:4173/",
            title: "Aurora 项目看板",
            viewport: PREVIEW_VIEWPORT,
          }),
        );
        socket.send(
          Buffer.from(
            encodeContainerPreviewFrame(
              {
                highQuality: true,
                pageRevision: 1,
                frameSequence: 1,
                pixelWidth: PREVIEW_VIEWPORT.width,
                pixelHeight: PREVIEW_VIEWPORT.height,
              },
              previewJpeg,
            ),
          ),
        );
      }, 40);
    }
    socket.onMessage((raw: string | Buffer) => {
      if (typeof raw !== "string") return;
      let message: any;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (url.pathname === "/ws/voice-transcribe") {
        if (message.type === "start")
          socket.send(JSON.stringify({ type: "ready" }));
        if (message.type === "stop") {
          socket.send(JSON.stringify({ type: "stopping" }));
          socket.send(
            JSON.stringify({
              type: "polish",
              text: "请整理今天的会议结论，并列出负责人和截止时间。第一项由产品负责人在周五前确认需求，第二项由研发负责人下周二交付验收版本。所有不确定日期请明确标注，不要自动发送。",
            }),
          );
        }
        return;
      }
      if (url.pathname === "/ws/user-chat-bridge") {
        if (message.type === "ping")
          socket.send(JSON.stringify({ type: "pong" }));
        if (message.type === "inbound.hello") {
          for (const peer of message.peers ?? [])
            socket.send(
              JSON.stringify({
                type: "sys.relay_ready",
                peer: { id: peer.peerId, kind: "dm" },
              }),
            );
        }
        if (message.type === "inbound.message")
          socket.send(JSON.stringify(chatReply(message.peer, message.agentId)));
        return;
      }
      if (url.pathname === "/ws/container-preview") {
        if (message.type === "preview.select")
          socket.send(
            JSON.stringify({
              type: "preview.selection",
              target: PREVIEW_TARGET,
            }),
          );
        if (message.type === "preview.resolve")
          socket.send(
            JSON.stringify({
              type: "preview.resolved",
              selector: message.selector,
              target: PREVIEW_TARGET,
            }),
          );
        if (
          [
            "preview.select",
            "preview.resolve",
            "preview.close",
            "preview.pointer",
            "preview.wheel",
            "preview.key",
            "preview.text",
            "preview.navigate",
            "preview.resize",
          ].includes(message.type)
        )
          return;
        fixtureErrors.push(`未知容器网页预览消息：${message.type}`);
        return;
      }
      fixtureErrors.push(`未知教程 WebSocket：${url.pathname}`);
      socket.close({ code: 1008, reason: "unknown tutorial socket" });
    });
  });

  try {
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
    try {
      await page
        .locator('textarea[data-product-feature="chat-basics"]')
        .waitFor({ state: "visible", timeout: 15000 });
    } catch (error) {
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "(body 不可读)");
      throw new Error(
        `正式 App 未进入工作区。\n页面：${body}\nfixture：${fixtureErrors.join(" | ")}\nconsole：${consoleErrors.join(" | ")}`,
        { cause: error },
      );
    }
    await page.locator("aside").waitFor({ state: "visible", timeout: 8000 });
    await page.evaluate(async () => {
      try {
        await fetch("https://blocked.invalid/tutorial-network-self-test");
      } catch {
        /* 必须被 route 拦截。 */
      }
    });
    if (
      ![...blockedExternal].some((url) =>
        url.startsWith("https://blocked.invalid/"),
      )
    )
      throw new Error("外网阻断自检未命中");

    const media = TUTORIAL_MEDIA[definition.featureId];
    const scenario: ScenarioContext = {
      page,
      featureId: definition.featureId,
      caption: media.caption,
      stages: [],
      actions: [],
      assertions: [],
    };
    await stage(scenario, "真实工作区已就绪");
    await definition.run(scenario);
    if (scenario.actions.length === 0)
      throw new Error(`${definition.featureId} 缺少真实控件动作轨迹`);
    if (scenario.stages.length < 2)
      throw new Error(`${definition.featureId} 至少需要两个真实界面阶段`);
    const bodyText = await page.locator("body").innerText();
    if (fixtureErrors.length) throw new Error(fixtureErrors.join("\n"));
    let forbiddenAllowance = expectedApiKeyForbiddenResponses;
    const meaningfulConsoleErrors = consoleErrors.filter((line) => {
      if (
        /blocked\.invalid|Failed to load resource.*ERR_BLOCKED_BY_CLIENT/.test(
          line,
        )
      )
        return false;
      if (
        forbiddenAllowance > 0 &&
        line ===
          "Failed to load resource: the server responded with a status of 403 (Forbidden)"
      ) {
        forbiddenAllowance -= 1;
        return false;
      }
      return true;
    });
    if (meaningfulConsoleErrors.length)
      throw new Error(
        `浏览器控制台错误：\n${meaningfulConsoleErrors.join("\n")}`,
      );
    return {
      featureId: definition.featureId,
      caption: media.caption,
      stages: scenario.stages,
      actions: scenario.actions,
      assertions: scenario.assertions,
      bodyText,
    };
  } finally {
    await context.close();
  }
}

function scanPrivacy(label: string, text: string): void {
  const forbidden = [
    {
      name: "真实邮箱",
      re: /\b[A-Z0-9._%+-]+@(?!example\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    },
    {
      name: "JWT/token",
      re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/,
    },
    { name: "生产域名", re: /(?:https?:\/\/)?(?:www\.)?claudeai\.chat\b/i },
    {
      name: "非回环 IP",
      re: /\b(?!(?:127\.0\.0\.1)\b)(?:\d{1,3}\.){3}\d{1,3}\b/,
    },
    {
      name: "主机路径",
      re: /\/(?:root|home\/(?!oai\/share\/tutorial-)|opt\/openclaude)\//,
    },
  ];
  for (const rule of forbidden) {
    const found = text.match(rule.re);
    if (found)
      throw new Error(`${label} 隐私扫描发现${rule.name}：${found[0]}`);
  }
}

function fontPath(pattern: string): string {
  const fcMatch = commandPath("fc-match");
  if (!fcMatch) throw new Error("找不到 fc-match，无法锁定中文字体来源");
  const result = execFileSync(fcMatch, ["-f", "%{file}", pattern], {
    encoding: "utf8",
  }).trim();
  if (!result || !existsSync(result)) throw new Error(`找不到字体：${pattern}`);
  return result;
}

function toolchainRecord(
  chrome: string,
  ffmpeg: string,
): Record<string, unknown> {
  const playwrightPackage =
    "/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core/package.json";
  if (!existsSync(playwrightPackage))
    throw new Error("无法读取受控 playwright-core package.json");
  const interFont = join(
    ROOT,
    "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  );
  if (!existsSync(interFont)) throw new Error("无法读取锁定的 Inter 字体");
  const cjkFont = fontPath("Noto Sans CJK SC");
  const ffmpegDetails = execFileSync(ffmpeg, ["-version"], {
    encoding: "utf8",
  });
  if (!/--enable-libvpx/.test(ffmpegDetails))
    throw new Error("ffmpeg 未启用 libvpx，不能生成 VP8 WebM");
  return {
    node: process.version,
    chrome: execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim(),
    playwrightCore: JSON.parse(readFileSync(playwrightPackage, "utf8")).version,
    ffmpeg: ffmpegDetails.split("\n")[0],
    sharp: JSON.parse(
      readFileSync(join(ROOT, "node_modules/sharp/package.json"), "utf8"),
    ).version,
    fonts: {
      inter: {
        file: "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
        sha256: sha256(readFileSync(interFont)),
      },
      cjk: {
        family: "Noto Sans CJK SC",
        file: cjkFont,
        sha256: sha256(readFileSync(cjkFont)),
      },
    },
    viewport: {
      product: `${WIDTH}x${PRODUCT_HEIGHT}`,
      final: `${WIDTH}x${HEIGHT}`,
      deviceScaleFactor: 1,
    },
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    chromeFlags: CHROME_FLAGS,
  };
}

function assertToolchainApproved(
  toolchain: Record<string, unknown>,
  accept: boolean,
): void {
  if (!existsSync(PROVENANCE_PATH)) {
    if (!accept)
      throw new Error(
        "首次生成教程媒体必须显式传 --accept-toolchain 审批受控录制工具链",
      );
    return;
  }
  const previous = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"));
  const changed =
    JSON.stringify(previous.toolchain) !== JSON.stringify(toolchain);
  if (changed && !accept)
    throw new Error(
      "教程录制工具链已变化；核对 Chromium/Playwright/ffmpeg/字体后传 --accept-toolchain",
    );
}

function sourceTreeHash(): string {
  const diff = execFileSync(
    "git",
    [
      "diff",
      "--binary",
      "HEAD",
      "--",
      "packages/web-react/src",
      "packages/web-react/vite.config.ts",
      "scripts/generate-v5-tutorial-media.ts",
      "scripts/check-v5-tutorials.ts",
    ],
    { cwd: ROOT },
  );
  return sha256(diff);
}

async function renderMedia(
  result: ScenarioResult,
  outputDir: string,
  ffmpeg: string,
) {
  // “真实工作区已就绪”只用于来源审计，不占用成片时长；每章从自己的首个操作画面开始，
  // 避免所有视频都以同一张工作区基线开场，造成用户看到的“章节重复”。
  const videoStages = result.stages.slice(1);
  if (videoStages.length < 2)
    throw new Error(`${result.featureId} 至少需要两个章节专属操作阶段`);
  const frames: Buffer[] = [];
  for (let index = 0; index < VIDEO_FRAMES; index += 1) {
    const stageIndex = Math.min(
      videoStages.length - 1,
      Math.floor((index * videoStages.length) / VIDEO_FRAMES),
    );
    frames.push(
      await composeFrame(
        videoStages[stageIndex]!,
        result.caption,
        stageIndex,
        videoStages.length,
      ),
    );
  }
  const posterPath = join(outputDir, `${result.featureId}.webp`);
  const videoPath = join(outputDir, `${result.featureId}.webm`);
  await sharp(frames.at(-1)!)
    .webp({ quality: 72, effort: 6 })
    .toFile(posterPath);
  await encodeVideo(videoPath, frames, ffmpeg);
  return {
    poster: {
      sha256: sha256(readFileSync(posterPath)),
      bytes: statSync(posterPath).size,
    },
    video: {
      sha256: sha256(readFileSync(videoPath)),
      bytes: statSync(videoPath).size,
    },
  };
}

async function main(): Promise<void> {
  const acceptToolchain = process.argv.includes("--accept-toolchain");
  if (
    SCENARIOS.length !== FEATURE_IDS.length ||
    new Set(SCENARIOS.map((item) => item.featureId)).size !==
      FEATURE_IDS.length ||
    FEATURE_IDS.some((id) => !SCENARIOS.some((item) => item.featureId === id))
  ) {
    throw new Error(
      `${FEATURE_IDS.length} 个产品能力与录制场景必须严格一一对应`,
    );
  }
  if (
    Object.keys(TUTORIAL_MEDIA).length !== FEATURE_IDS.length ||
    FEATURE_IDS.some((id) => !TUTORIAL_MEDIA[id])
  )
    throw new Error("教程媒体目录与产品能力不一一对应");

  const chrome = chromePath();
  const ffmpeg = ffmpegPath();
  const toolchain = toolchainRecord(chrome, ffmpeg);
  assertToolchainApproved(toolchain, acceptToolchain);
  const tempOutput = join(WEB_ROOT, `.tutorial-media-${process.pid}`);
  rmSync(tempOutput, { recursive: true, force: true });
  mkdirSync(tempOutput, { recursive: true });
  let preview: ChildProcess | null = null;
  let port: number | null = null;
  let browser: any = null;
  try {
    runBuild();
    port = await freePort();
    const started = await startPreview(port);
    preview = started.child;
    const { chromium } = playwright();
    browser = await chromium.launch({
      headless: true,
      executablePath: chrome,
      args: [...CHROME_FLAGS],
    });
    const imagePng = await sharp({
      create: { width: 720, height: 420, channels: 4, background: "#d9e5ff" },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="720" height="420" xmlns="http://www.w3.org/2000/svg"><rect width="720" height="420" fill="#eaf0ff"/><circle cx="560" cy="110" r="130" fill="#9eb8ff"/><path d="M0 330 L190 180 L330 300 L470 190 L720 365 L720 420 L0 420Z" fill="#4f6ca8"/><text x="38" y="68" font-family="Noto Sans CJK SC" font-size="28" font-weight="700" fill="#182442">Aurora 发布会主视觉</text><text x="40" y="102" font-family="Noto Sans CJK SC" font-size="17" fill="#4e5c77">脱敏教程素材 · 可进入真实图片编辑器</text></svg>',
          ),
        },
      ])
      .png()
      .toBuffer();
    const previewJpeg = await sharp({
      create: {
        width: PREVIEW_VIEWPORT.width,
        height: PREVIEW_VIEWPORT.height,
        channels: 4,
        background: "#f6f8fc",
      },
    })
      .composite([
        {
          input:
            Buffer.from(`<svg width="1280" height="800" xmlns="http://www.w3.org/2000/svg">
        <rect width="1280" height="800" fill="#f7f9fd"/>
        <rect width="1280" height="74" fill="#ffffff"/>
        <circle cx="58" cy="37" r="20" fill="#3157d5"/>
        <text x="92" y="45" font-family="Noto Sans CJK SC" font-size="24" font-weight="700" fill="#172033">Aurora Project</text>
        <text x="835" y="44" font-family="Noto Sans CJK SC" font-size="17" fill="#59657a">工作台　项目　数据</text>
        <rect x="1125" y="20" width="108" height="36" rx="18" fill="#edf1fb"/>
        <text x="1179" y="44" text-anchor="middle" font-family="Noto Sans CJK SC" font-size="15" fill="#3157d5">教程账号</text>
        <rect x="54" y="120" width="1172" height="620" rx="30" fill="#e9efff"/>
        <circle cx="1080" cy="222" r="176" fill="#b9c9ff" opacity="0.8"/>
        <circle cx="1000" cy="356" r="112" fill="#718de8" opacity="0.48"/>
        <rect x="96" y="165" width="180" height="34" rx="17" fill="#dbe4ff"/>
        <text x="186" y="188" text-anchor="middle" font-family="Noto Sans CJK SC" font-size="15" font-weight="600" fill="#3157d5">本周项目进展</text>
        <text x="96" y="292" font-family="Noto Sans CJK SC" font-size="58" font-weight="800" fill="#172033">把复杂协作，</text>
        <text x="96" y="364" font-family="Noto Sans CJK SC" font-size="58" font-weight="800" fill="#3157d5">变成清晰行动。</text>
        <text x="98" y="430" font-family="Noto Sans CJK SC" font-size="21" fill="#59657a">统一查看里程碑、成员进度与关键数据，</text>
        <text x="98" y="466" font-family="Noto Sans CJK SC" font-size="21" fill="#59657a">让团队始终围绕同一个目标推进。</text>
        <rect x="120" y="570" width="230" height="64" rx="16" fill="#3157d5"/>
        <text x="235" y="611" text-anchor="middle" font-family="Noto Sans CJK SC" font-size="21" font-weight="700" fill="#ffffff">开始体验</text>
        <rect x="376" y="570" width="180" height="64" rx="16" fill="#ffffff" stroke="#cbd5eb" stroke-width="2"/>
        <text x="466" y="611" text-anchor="middle" font-family="Noto Sans CJK SC" font-size="20" font-weight="600" fill="#43506a">查看数据</text>
        <rect x="754" y="496" width="408" height="190" rx="24" fill="#ffffff" opacity="0.92"/>
        <text x="792" y="544" font-family="Noto Sans CJK SC" font-size="16" fill="#6c7890">本周完成率</text>
        <text x="792" y="605" font-family="Inter" font-size="48" font-weight="700" fill="#172033">86%</text>
        <rect x="792" y="635" width="320" height="12" rx="6" fill="#e5eaf4"/>
        <rect x="792" y="635" width="275" height="12" rx="6" fill="#4f72df"/>
      </svg>`),
        },
      ])
      .jpeg({ quality: 88, chromaSubsampling: "4:2:0" })
      .toBuffer();

    const scenarioRecords: Record<string, unknown> = {};
    const exactPosters = new Set<string>();
    const exactVideos = new Set<string>();
    const exactOperationalStages = new Map<string, string>();
    const scenarioErrors: string[] = [];
    for (const definition of SCENARIOS) {
      process.stdout.write(`录制 ${definition.featureId} ... `);
      try {
        const result = await captureScenario(
          browser,
          `http://127.0.0.1:${port}`,
          definition,
          imagePng,
          previewJpeg,
        );
        scanPrivacy(`${definition.featureId} 页面`, result.bodyText);
        scanPrivacy(
          `${definition.featureId} 轨迹`,
          JSON.stringify({
            actions: result.actions,
            assertions: result.assertions,
            caption: result.caption,
          }),
        );
        for (const item of result.stages.slice(1)) {
          const owner = exactOperationalStages.get(item.dHash);
          if (owner)
            throw new Error(
              `${definition.featureId} 的操作画面“${item.label}”与 ${owner} 完全重复`,
            );
          exactOperationalStages.set(
            item.dHash,
            `${definition.featureId} 的操作画面“${item.label}”`,
          );
        }
        const files = await renderMedia(result, tempOutput, ffmpeg);
        if (
          exactPosters.has(files.poster.sha256) ||
          exactVideos.has(files.video.sha256)
        )
          throw new Error(
            `${definition.featureId} 与其他章节生成了完全重复的媒体`,
          );
        exactPosters.add(files.poster.sha256);
        exactVideos.add(files.video.sha256);
        scenarioRecords[definition.featureId] = {
          mediaVersion: TUTORIAL_MEDIA[definition.featureId].version,
          caption: result.caption,
          stages: result.stages.map((item) => ({
            label: item.label,
            dHash: item.dHash,
          })),
          actions: result.actions,
          assertions: result.assertions,
          poster: files.poster,
          video: files.video,
        };
        process.stdout.write("完成\n");
      } catch (error) {
        const message =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        scenarioErrors.push(`${definition.featureId}: ${message}`);
        process.stdout.write("失败（继续审计其余场景）\n");
      }
    }
    if (scenarioErrors.length)
      throw new Error(
        `教程录制有 ${scenarioErrors.length} 个场景失败：\n\n${scenarioErrors.join("\n\n")}`,
      );

    const provenance = {
      schema: 1,
      pipelineVersion: PIPELINE_VERSION,
      generatedAt: FIXED_NOW,
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim(),
      sourceTreeHash: sourceTreeHash(),
      productionEntry: "index.html -> src/main.tsx -> App",
      fixtureBoundary: "HTTP / WebSocket / browser capabilities only",
      networkPolicy:
        "local static + explicit fixtures; unknown local and all external requests fail",
      toolchain,
      scenarios: scenarioRecords,
    };
    scanPrivacy("provenance", JSON.stringify(provenance));
    for (const name of readdirSync(OUTPUT)) {
      if (/\.(?:webp|webm)$/.test(name)) rmSync(join(OUTPUT, name));
    }
    mkdirSync(OUTPUT, { recursive: true });
    for (const name of readdirSync(tempOutput))
      renameSync(join(tempOutput, name), join(OUTPUT, name));
    writeFileSync(PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`);
    console.log(
      `已从正式 v5 App 生成 ${FEATURE_IDS.length} 组独立教程媒体（${FEATURE_IDS.length * 2} 个文件）。`,
    );
  } finally {
    await browser?.close().catch(() => {});
    await stopPreview(preview, port);
    rmSync(CAPTURE_DIST, { recursive: true, force: true });
    rmSync(tempOutput, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
