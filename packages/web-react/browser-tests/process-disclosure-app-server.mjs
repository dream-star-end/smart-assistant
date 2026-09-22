import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import {
  BASH_CMD,
  BOARD_SESSION,
  CSV_BODY,
  CSV_NAME,
  CSV_PATH,
  OLD_TS,
  READ_PATH,
  STAGE_TEXT,
  WAIT_SESSION,
  answerText,
  recentTs,
} from "./process-disclosure-story.mjs";

const CSV_URL = "/api/media-signed?t=inventory-board";

function row(seq, id, role, text, extra = {}) {
  return {
    id,
    role,
    text,
    ts: OLD_TS,
    _source: "server",
    _orderSeq: seq,
    _seq: seq,
    _timelineRecord: true,
    _timelineUnitKey: `outer:${seq}:${id}`,
    ...extra,
  };
}

export function boardMessages() {
  const now = recentTs();
  let n = 1;
  const next = (id, role, text, extra) => row(n++, id, role, text, extra);
  return [
    next("u1", "user", "做一版库存看板", { status: "replied" }),
    next("stage-1", "assistant", STAGE_TEXT, { _clientMessageId: "u1" }),
    next("bash-1", "tool", "终端", {
      _clientMessageId: "u1",
      toolName: "Bash",
      inputJson: { command: BASH_CMD },
      _completed: true,
      output: "ok",
    }),
    next("read-1", "tool", "读取", {
      _clientMessageId: "u1",
      toolName: "Read",
      inputJson: { file_path: READ_PATH },
      _completed: true,
      output: "threshold",
    }),
    next("answer-1", "assistant", answerText(), {
      _clientMessageId: "u1",
      ts: OLD_TS,
      usage: {
        costCredits: "12",
        totalTokens: 1840,
        inputTokens: 1200,
        outputTokens: 640,
        traceId: "abc12345xyz",
      },
    }),
    next("u-recent", "user", "数字还在吗？", { status: "replied", ts: now }),
    next("a-recent", "assistant", "还在，可售合计 128。", {
      _clientMessageId: "u-recent",
      ts: now,
      usage: { costCredits: "3", totalTokens: 420, inputTokens: 280, outputTokens: 140 },
    }),
  ];
}

export function waitMessages() {
  let n = 1;
  const next = (id, role, text, extra) => row(n++, id, role, text, extra);
  return [
    next("u-att", "user", "等我确认", { status: "sent" }),
    next("stage-att", "assistant", "我先查一下隐藏命令", { _clientMessageId: "u-att" }),
    next("bash-att", "tool", "终端", {
      _clientMessageId: "u-att",
      toolName: "Bash",
      inputJson: { command: "hidden-probe-cmd" },
      _completed: true,
      output: "ok",
    }),
    next("err-att", "tool", "失败命令", {
      _clientMessageId: "u-att",
      toolName: "Bash",
      inputJson: { command: "broken-probe" },
      _completed: true,
      error: true,
      output: "probe-error-detail",
    }),
    next("ask-att", "permission", "执行命令", {
      _clientMessageId: "u-att",
      toolName: "Bash",
      requestId: "req-browser-deny",
      _resolved: false,
      inputPreview: "ls",
      inputJson: { command: "ls" },
      ts: Date.now(),
    }),
    next("approval-att", "tool", "审批", {
      _clientMessageId: "u-att",
      toolName: "mcp__openclaude-memory__present_task_approval",
      inputJson: { id: "OCV5-265" },
      _completed: false,
      output: "ok",
    }),
    next("answer-att", "assistant", "还差你的确认", { _clientMessageId: "u-att" }),
  ];
}

function detail(id, title, messages) {
  return {
    id,
    userId: "u1",
    agentId: "main",
    title,
    pinned: false,
    createdAt: 1,
    lastAt: 2,
    messages,
    updatedAt: 2,
    historyRevision: 1,
    timelineGeneration: 1,
    timelineCursor: null,
    timelineHasMore: false,
    timelineSnapshotMaxSeq: messages.length,
    isPartial: false,
    totalMessageCount: messages.length,
    maxSeq: messages.length,
    modelId: "glm-5.2",
  };
}

function listBody() {
  return {
    sessions: [
      {
        id: BOARD_SESSION,
        agentId: "main",
        title: "库存看板",
        pinned: false,
        createdAt: 1,
        lastAt: 3,
        messageCount: 7,
        updatedAt: 3,
        modelId: "glm-5.2",
      },
      {
        id: WAIT_SESSION,
        agentId: "main",
        title: "待你确认",
        pinned: false,
        createdAt: 1,
        lastAt: 2,
        messageCount: 7,
        updatedAt: 2,
        modelId: "glm-5.2",
      },
    ],
  };
}

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function indexHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OCV5-265 库存看板验收</title>
<link rel="stylesheet" href="/styles.css">
<div id="root"></div>
<script>
if (!localStorage.getItem("oc_auth_hint")) localStorage.setItem("oc_auth_hint", "1");
if (!localStorage.getItem("oc_theme")) localStorage.setItem("oc_theme", "light");
window.WebSocket = undefined;
</script>
<script type="module" src="/app.js"></script>
`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

export function startPreviewServer(assetDir) {
  const unknown = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname;
      if (path === "/api/media-signed" && url.searchParams.get("t") === "inventory-board") {
        const body = Buffer.from(CSV_BODY, "utf8");
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-length": body.length,
          "content-disposition": `attachment; filename="${CSV_NAME}"`,
        });
        res.end(body);
        return;
      }
      if (path.startsWith("/api/")) {
        const method = req.method || "GET";
        const user = {
          id: "u1",
          email: "test@example.com",
          email_verified: true,
          role: "user",
          display_name: "验收",
          credits: "1000",
        };
        let status = 200;
        let body = {};
        if (path === "/api/public/config") body = { turnstile_bypass: true, require_email_verified: false, allow_registration: true };
        else if (path === "/api/auth/refresh") body = { access_token: "test-token", access_exp: Date.now() / 1000 + 3600, remember: true };
        else if (path === "/api/me") body = { user };
        else if (path === "/api/public/models") body = { models: [{ id: "glm-5.2", display_name: "GLM-5.2", engine: "ccb" }] };
        else if (path === "/api/me/preferences") body = { prefs: { default_model: "glm-5.2" } };
        else if (path === "/api/agent/status") body = { runtime_ready: true, container: { id: "c1", status: "running" }, subscription: { status: "active" } };
        else if (path === "/api/sessions/list") body = listBody();
        else if (path === "/api/marketplace/my-agents") body = { agents: [{ id: "main", slug: "main", name: "全能助手", installed: true, isDefault: true }] };
        else if (path === "/api/collaboration-config") {
          body = {
            rev: 0,
            defaultMode: "solo",
            defaultAdvisorModel: null,
            session: { mode: "solo", advisorModel: null, configVersion: "v1:solo:", source: "default" },
            advisorModels: [],
            advisorConsultParents: [],
          };
        } else if (path === "/api/media-sign" && method === "POST") {
          const data = await readJson(req);
          const urls = {};
          for (const item of data.paths ?? []) {
            if (item === CSV_PATH) urls[item] = CSV_URL;
          }
          body = { urls, expMs: Date.now() + 10 * 60_000 };
        } else if (path === `/api/sessions/${BOARD_SESSION}`) body = detail(BOARD_SESSION, "库存看板", boardMessages());
        else if (path === `/api/sessions/${WAIT_SESSION}`) body = detail(WAIT_SESSION, "待你确认", waitMessages());
        else if (path.endsWith("/live-frames")) {
          body = { frames: [], nextCursor: null, hasMore: false, streamClientMessageIds: [], hasTapeProjection: false };
        } else if (path === "/api/response-rating") body = { ratings: {}, nudges: {} };
        else if (path.startsWith("/api/session-goals/")) body = { goal: null };
        else {
          unknown.push(`${method} ${path}`);
          body = {};
        }
        sendJson(res, status, body);
        return;
      }
      const rel = decodeURIComponent(path).replace(/^\/+/, "");
      if (!rel || rel.includes("..")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(indexHtml());
        return;
      }
      const file = join(assetDir, rel);
      if ((file === assetDir || file.startsWith(assetDir + sep)) && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
        createReadStream(file).pipe(res);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(indexHtml());
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error?.stack || error));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        port,
        unknown,
        url: `http://127.0.0.1:${port}/s/${BOARD_SESSION}`,
      });
    });
  });
}
