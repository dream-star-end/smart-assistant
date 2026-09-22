import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { WebSocketServer } from "ws";
import {
  BASH_CMD,
  BOARD_SESSION,
  CSV_BODY,
  CSV_NAME,
  CSV_PATH,
  DASHBOARD_HTML,
  OLD_SESSION,
  OLD_TS,
  READ_PATH,
  STAGE_TEXT,
  WAIT_SESSION,
  answerText,
} from "./process-disclosure-story.mjs";

const CSV_URL = "/api/media-signed?t=inventory-board";
const OLDER_CURSOR = "inventory-older-1";

function streamGapMs() {
  const value = Number(process.env.OC_E2E_STREAM_GAP_MS || 160);
  return Number.isFinite(value) && value >= 0 ? value : 160;
}

function row(seq, id, role, text, extra = {}) {
  const owner = extra._clientMessageId;
  return {
    id,
    role,
    text,
    ts: extra.ts ?? OLD_TS,
    _source: "server",
    _orderSeq: seq,
    _seq: seq,
    _timelineRecord: true,
    _timelineUnitKey: extra._timelineUnitKey || `unit:${seq}:${id}`,
    ...(owner ? { _turnOwnerId: owner } : {}),
    ...extra,
  };
}

function stamp(messages, startSeq) {
  return messages.map((message, index) => {
    const seq = startSeq + index;
    const owner = message._clientMessageId;
    return {
      ...message,
      _orderSeq: seq,
      _seq: seq,
      _timelineRecord: true,
      _timelineUnitKey: `unit:${seq}:${message.id}`,
      ...(owner ? { _clientMessageId: owner, _turnOwnerId: owner } : {}),
    };
  });
}

function sessionListRow(id, title, clock, messageCount) {
  return {
    id,
    agentId: "main",
    title,
    pinned: false,
    createdAt: clock.createdAt,
    lastAt: clock.updatedAt,
    messageCount,
    updatedAt: clock.updatedAt,
    modelId: "glm-5.2",
  };
}

/** Recent gallery clock: created <= first message <= last message <= updated. */
export function boardMessages(clock) {
  const { createdAt, updatedAt } = clock;
  const tUser = createdAt + 8 * 60_000;
  const tStage = tUser + 15_000;
  const tBash = tStage + 10_000;
  const tRead = tBash + 10_000;
  const tAnswer = tRead + 20_000;
  const tRecentUser = updatedAt - 8_000;
  const tRecent = updatedAt - 2_000;
  let n = 1;
  const next = (id, role, text, extra) => row(n++, id, role, text, extra);
  return [
    next("u1", "user", "做一版库存看板", { status: "replied", ts: tUser }),
    next("stage-1", "assistant", STAGE_TEXT, { _clientMessageId: "u1", ts: tStage }),
    next("bash-1", "tool", "终端", {
      _clientMessageId: "u1",
      toolName: "Bash",
      inputJson: { command: BASH_CMD },
      _completed: true,
      output: "ok",
      ts: tBash,
    }),
    next("read-1", "tool", "读取", {
      _clientMessageId: "u1",
      toolName: "Read",
      inputJson: { file_path: READ_PATH },
      _completed: true,
      output: "threshold",
      ts: tRead,
    }),
    next("answer-1", "assistant", answerText(), {
      _clientMessageId: "u1",
      ts: tAnswer,
      usage: {
        costCredits: "12",
        totalTokens: 1840,
        inputTokens: 1200,
        outputTokens: 640,
        traceId: "abc12345xyz",
      },
    }),
    next("u-recent", "user", "数字还在吗？", { status: "replied", ts: tRecentUser }),
    next("a-recent", "assistant", "还在，可售合计 128。", {
      _clientMessageId: "u-recent",
      ts: tRecent,
      usage: { costCredits: "3", totalTokens: 420, inputTokens: 280, outputTokens: 140 },
    }),
  ];
}

/** Two earlier turns of the same inventory task, still inside the recent window. */
export function olderMessages(clock) {
  const t0 = clock.createdAt + 60_000;
  let n = 1;
  const next = (id, role, text, extra) => row(n++, id, role, text, extra);
  return [
    next("u-scope", "user", "先把北仓和南仓的可售范围说清楚", { status: "replied", ts: t0 }),
    next("a-scope", "assistant", "可售只算在架库存。冻结库存不进合计，也不进这张看板。", {
      _clientMessageId: "u-scope",
      ts: t0 + 20_000,
    }),
    next("u-freeze", "user", "冻结库存这次要不要单独列出？", { status: "replied", ts: t0 + 4 * 60_000 }),
    next("a-freeze", "assistant", "先不单列。看板只放北仓和南仓的可售数。", {
      _clientMessageId: "u-freeze",
      ts: t0 + 4 * 60_000 + 20_000,
    }),
  ];
}

export function waitMessages(clock) {
  let t = clock.createdAt + 30_000;
  const at = () => {
    const value = t;
    t += 12_000;
    return value;
  };
  let n = 1;
  const next = (id, role, text, extra) => row(n++, id, role, text, { ts: at(), ...extra });
  return [
    next("u-att", "user", "看板发布前等我确认", { status: "sent" }),
    next("stage-att", "assistant", "我先核对南仓可售，再请你拍板。", { _clientMessageId: "u-att" }),
    next("bash-att", "tool", "终端", {
      _clientMessageId: "u-att",
      toolName: "Bash",
      inputJson: { command: "node scripts/check-available.mjs" },
      _completed: true,
      output: "ok",
    }),
    next("err-att", "tool", "失败命令", {
      _clientMessageId: "u-att",
      toolName: "Bash",
      inputJson: { command: "node scripts/publish-board.mjs" },
      _completed: true,
      error: true,
      output: "南仓对账没有通过，看板先不发布。",
    }),
    next("ask-att", "permission", "冻结库存", {
      _clientMessageId: "u-att",
      toolName: "AskUserQuestion",
      requestId: "ask-board-freeze",
      _resolved: false,
      inputPreview: "冻结库存要不要单独列在看板上？",
      inputJson: {
        questions: [
          {
            question: "冻结库存要不要单独列在看板上？",
            header: "冻结库存",
            options: [
              { label: "不单列", description: "看板只放可售" },
              { label: "单独一列", description: "和可售分开" },
            ],
            multiSelect: false,
          },
        ],
      },
    }),
    next("perm-att", "permission", "执行命令", {
      _clientMessageId: "u-att",
      toolName: "Bash",
      requestId: "req-browser-deny",
      _resolved: false,
      inputPreview: "确认发布库存看板",
      inputJson: { command: "确认发布库存看板" },
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

/** Old absolute date only. Session lifetime stays short so the sidebar is not "1970" or "N万天". */
export function oldMetaMessages() {
  let n = 1;
  const next = (id, role, text, extra) => row(n++, id, role, text, extra);
  return [
    next("u-old", "user", "做一版库存看板", { status: "replied", ts: OLD_TS - 5_000 }),
    next("a-old", "assistant", answerText(), {
      _clientMessageId: "u-old",
      ts: OLD_TS,
      usage: {
        costCredits: "12",
        totalTokens: 1840,
        inputTokens: 1200,
        outputTokens: 640,
        traceId: "abc12345xyz",
      },
    }),
  ];
}

function createStore() {
  const end = Date.now();
  const boardClock = { createdAt: end - 50 * 60_000, updatedAt: end };
  const waitClock = { createdAt: end - 25 * 60_000, updatedAt: end - 30_000 };
  const oldClock = { createdAt: OLD_TS - 120_000, updatedAt: OLD_TS + 5_000 };
  return {
    board: stamp(boardMessages(boardClock), 100),
    older: stamp(olderMessages(boardClock), 1),
    wait: stamp(waitMessages(waitClock), 1),
    old: stamp(oldMetaMessages(), 1),
    clocks: {
      [BOARD_SESSION]: boardClock,
      [WAIT_SESSION]: waitClock,
      [OLD_SESSION]: oldClock,
    },
    revision: 1,
  };
}

function detail(id, title, messages, store, hasMore, cursor) {
  const clock = store.clocks[id];
  const maxSeq = messages.reduce((max, message) => Math.max(max, message._seq || 0), 0);
  return {
    id,
    userId: "u1",
    agentId: "main",
    title,
    pinned: false,
    createdAt: clock.createdAt,
    lastAt: clock.updatedAt,
    messages,
    updatedAt: clock.updatedAt,
    historyRevision: store.revision,
    timelineGeneration: 1,
    timelineCursor: hasMore ? cursor : null,
    timelineHasMore: hasMore,
    timelineSnapshotMaxSeq: maxSeq,
    isPartial: false,
    totalMessageCount: messages.length + (hasMore ? store.older.length : 0),
    maxSeq,
    modelId: "glm-5.2",
  };
}

function listBody(store) {
  return {
    sessions: [
      sessionListRow(BOARD_SESSION, "库存看板", store.clocks[BOARD_SESSION], store.board.length + store.older.length),
      sessionListRow(WAIT_SESSION, "待你确认", store.clocks[WAIT_SESSION], store.wait.length),
      sessionListRow(OLD_SESSION, "旧日期对照", store.clocks[OLD_SESSION], store.old.length),
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

function sessionKey(id) {
  return `agent:main:webchat:dm:${id}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamAnswerTail() {
  return [
    "```htmlpreview",
    DASHBOARD_HTML.replace("可售合计 128。", "可售合计 128。南仓预警已分开标出。"),
    "```",
    "",
    `明细表：${CSV_PATH}`,
    "",
    "这张预览和 CSV 仍是界面验收夹具，不是线上库存。",
  ].join("\n");
}

function warningChunks() {
  const chunks = ["南仓预警已补进看板。\n\n"];
  for (let i = 1; i <= 8; i += 1) {
    const n = String(i).padStart(2, "0");
    chunks.push(`预警段落-${n} 北仓可售 80、南仓可售 48，低于预警线的数量单独标出，冻结库存不进可售合计。\n\n`);
  }
  chunks.push(streamAnswerTail());
  return chunks;
}

export function startPreviewServer(assetDir, options = {}) {
  const store = createStore();
  const unknown = [];
  const stats = {
    hellos: 0,
    inboundMessages: [],
    permissionResponses: [],
    permissionAcks: [],
    outbound: 0,
    outboundByType: {},
  };
  const seqBySession = new Map();
  const nextSeq = (id) => {
    const n = (seqBySession.get(id) || 0) + 1;
    seqBySession.set(id, n);
    return n;
  };

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
      if (path === "/api/e2e-fixture") {
        sendJson(res, 200, {
          fixture: "ocv5-265-app-ws",
          note: "Frontend WebSocket fixture. Not the production LLM backend.",
          hellos: stats.hellos,
          inboundMessages: stats.inboundMessages.map((frame) => ({
            type: frame.type,
            sessionId: frame.peer?.id,
            clientMessageId: frame.clientMessageId,
            text: frame.content?.text,
          })),
          permissionResponses: stats.permissionResponses.map((frame) => ({
            type: frame.type,
            requestId: frame.requestId,
            behavior: frame.behavior,
            controlId: frame.controlId,
          })),
          permissionAcks: stats.permissionAcks,
          outbound: stats.outbound,
          outboundByType: stats.outboundByType,
          unknown,
        });
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
        let body = {};
        if (path === "/api/public/config") body = { turnstile_bypass: true, require_email_verified: false, allow_registration: true };
        else if (path === "/api/auth/refresh") body = { access_token: "test-token", access_exp: Date.now() / 1000 + 3600, remember: true };
        else if (path === "/api/me") body = { user };
        else if (path === "/api/public/models") body = { models: [{ id: "glm-5.2", display_name: "GLM-5.2", engine: "ccb" }] };
        else if (path === "/api/me/preferences") body = { prefs: { default_model: "glm-5.2" } };
        else if (path === "/api/agent/status") body = { runtime_ready: true, container: { id: "c1", status: "running" }, subscription: { status: "active" } };
        else if (path === "/api/sessions/list") body = listBody(store);
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
        } else if (path === `/api/sessions/${BOARD_SESSION}/timeline`) {
          const cursor = url.searchParams.get("cursor");
          if (cursor === OLDER_CURSOR) {
            const maxSeq = store.older.reduce((max, message) => Math.max(max, message._seq || 0), 0);
            body = {
              messages: store.older,
              nextCursor: null,
              hasMore: false,
              timelineGeneration: 1,
              historyRevision: store.revision,
              snapshotMaxSeq: maxSeq,
            };
          } else {
            body = { messages: [], nextCursor: null, hasMore: false, timelineGeneration: 1, historyRevision: store.revision, snapshotMaxSeq: 0 };
          }
        } else if (path === `/api/sessions/${BOARD_SESSION}`) body = detail(BOARD_SESSION, "库存看板", store.board, store, true, OLDER_CURSOR);
        else if (path === `/api/sessions/${WAIT_SESSION}`) body = detail(WAIT_SESSION, "待你确认", store.wait, store, false, null);
        else if (path === `/api/sessions/${OLD_SESSION}`) body = detail(OLD_SESSION, "旧日期对照", store.old, store, false, null);
        else if (path.endsWith("/live-frames")) {
          body = { frames: [], nextCursor: null, hasMore: false, streamClientMessageIds: [], hasTapeProjection: false, view: url.searchParams.get("view") || "frames" };
        } else if (path === "/api/response-rating") body = { ratings: {}, nudges: {} };
        else if (path === "/api/board/tickets/OCV5-265") {
          body = {
            ticket: {
              id: "OCV5-265",
              identifier: "OCV5-265",
              title: "库存看板发布前确认",
              status: "waiting_human",
              version: 1,
              type: "task",
              priority: "medium",
              body: "确认北仓 80、南仓 48 的可售数后再发布。这是界面验收夹具，不是线上任务。",
            },
          };
        } else if (path.startsWith("/api/session-goals/")) body = { goal: null };
        else if (path === `/api/sessions/${BOARD_SESSION}/archive` || path === `/api/sessions/${WAIT_SESSION}/archive`) {
          body = { messages: [], hasMore: false, oldestSeq: null, historyRevision: store.revision };
        } else {
          unknown.push(`${method} ${path}`);
          body = {};
        }
        sendJson(res, 200, body);
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

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("bearer") ? "bearer" : false),
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/ws/user-chat-bridge") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const send = (frame) => {
      if (ws.readyState !== 1) return false;
      const type = frame?.type || "unknown";
      stats.outbound += 1;
      stats.outboundByType[type] = (stats.outboundByType[type] || 0) + 1;
      ws.send(JSON.stringify(frame));
      return true;
    };
    send({ type: "sys.relay_ready", automaticRecoveryOwner: "master-v1" });
    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === "ping") {
        send({ type: "pong", id: frame.id });
        return;
      }
      if (frame.type === "inbound.hello") {
        stats.hellos += 1;
        send({ type: "sys.relay_ready", automaticRecoveryOwner: "master-v1" });
        return;
      }
      if (frame.type === "inbound.permission_response") {
        stats.permissionResponses.push(frame);
        const controlId = String(frame.controlId || "");
        if (!controlId || stats.permissionAcks.includes(controlId)) return;
        stats.permissionAcks.push(controlId);
        const bucket = frame.peer?.id === WAIT_SESSION ? store.wait : store.board;
        const card = bucket.find((message) => message.requestId === frame.requestId);
        if (card) {
          card._resolved = true;
          card._behavior = frame.behavior;
        }
        store.revision += 1;
        const clockId = frame.peer?.id === WAIT_SESSION ? WAIT_SESSION : frame.peer?.id === OLD_SESSION ? OLD_SESSION : BOARD_SESSION;
        store.clocks[clockId].updatedAt = Date.now();
        send({
          type: "outbound.control.receipt",
          controlId,
          controlKind: "permission",
          status: "applied",
          peer: { id: frame.peer?.id, kind: "dm" },
          requestId: frame.requestId,
          attempt: 1,
        });
        return;
      }
      if (frame.type !== "inbound.message") return;
      stats.inboundMessages.push(frame);
      const sessId = frame.peer?.id;
      const clientMessageId = frame.clientMessageId;
      const text = String(frame.content?.text || "");
      send({
        type: "outbound.ack",
        admitted: true,
        peer: { id: sessId, kind: "dm" },
        clientMessageId,
      });
      void playTurn(send, store, sessId, clientMessageId, text, nextSeq).catch((error) => {
        send({
          type: "outbound.error",
          sessionKey: sessionKey(sessId),
          channel: "webchat",
          peer: { id: sessId, kind: "dm" },
          clientMessageId,
          code: "fixture_error",
          message: String(error?.message || error),
          isFinal: true,
          frameSeq: nextSeq(sessId),
          ts: Date.now(),
        });
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        wss,
        port,
        unknown,
        stats,
        store,
        url: `http://127.0.0.1:${port}/s/${BOARD_SESSION}`,
      });
    });
  });
}

async function playTurn(send, store, sessId, clientMessageId, text, nextSeq) {
  const key = sessionKey(sessId);
  const base = {
    type: "outbound.message",
    sessionKey: key,
    channel: "webchat",
    peer: { id: sessId, kind: "dm" },
    clientMessageId,
    isFinal: false,
  };
  const emit = async (blocks, final = false) => {
    send({
      ...base,
      frameSeq: nextSeq(sessId),
      ts: Date.now(),
      blocks,
      isFinal: final,
    });
    const gap = streamGapMs();
    if (gap > 0) await sleep(gap);
  };
  const bucket = sessId === WAIT_SESSION ? store.wait : store.board;
  const persisted = [];
  const remember = (id, role, textValue, extra = {}) => {
    persisted.push({
      id,
      role,
      text: textValue,
      ts: Date.now() + persisted.length,
      status: role === "user" ? "replied" : undefined,
      _clientMessageId: role === "user" ? undefined : clientMessageId,
      ...extra,
    });
  };
  remember(clientMessageId, "user", text, { status: "replied" });

  if (text.includes("合计还在就行") || sessId === WAIT_SESSION) {
    const reply = sessId === WAIT_SESSION
      ? "这轮先等你确认，看板不会发布。"
      : "还在。可售合计 128，南仓预警已经分开标出。";
    await emit([{ kind: "text", text: reply.slice(0, 8), messageId: `plain-${clientMessageId}` }]);
    await emit([{ kind: "text", text: reply.slice(8), messageId: `plain-${clientMessageId}` }]);
    remember(`plain-${clientMessageId}`, "assistant", reply, { _clientMessageId: clientMessageId });
  } else {
    const bashId = `bash-${clientMessageId}`;
    const readId = `read-${clientMessageId}`;
    const stageId = `stage-${clientMessageId}`;
    const answerId = `answer-${clientMessageId}`;
    const command = "node scripts/summarize-stock.mjs --warn-south";
    let partial = "";
    for (const piece of ['{"command":"node ', "scripts/summarize-stock.mjs --warn-south\"}"]) {
      partial += piece;
      await emit([{
        kind: "tool_use",
        blockId: bashId,
        toolName: "Bash",
        messageId: bashId,
        partial: true,
        partialJsonDelta: piece,
        partialJsonOffset: partial.length - piece.length,
      }]);
    }
    await emit([{
      kind: "tool_use",
      blockId: bashId,
      toolName: "Bash",
      messageId: bashId,
      partial: false,
      inputJson: { command },
    }]);
    await emit([{
      kind: "tool_result",
      blockId: `${bashId}:result`,
      toolUseBlockId: bashId,
      toolName: "Bash",
      isError: false,
      output: "south-warning=separated",
    }]);
    remember(bashId, "tool", "终端", {
      _clientMessageId: clientMessageId,
      toolName: "Bash",
      inputJson: { command },
      _completed: true,
      output: "south-warning=separated",
    });
    await emit([{
      kind: "tool_use",
      blockId: readId,
      toolName: "Read",
      messageId: readId,
      partial: false,
      inputJson: { file_path: "inventory/thresholds.md" },
    }]);
    await emit([{
      kind: "tool_result",
      blockId: `${readId}:result`,
      toolUseBlockId: readId,
      toolName: "Read",
      isError: false,
      output: "south warning separated",
    }]);
    remember(readId, "tool", "读取", {
      _clientMessageId: clientMessageId,
      toolName: "Read",
      inputJson: { file_path: "inventory/thresholds.md" },
      _completed: true,
      output: "south warning separated",
    });
    const stage = "先把南仓预警从可售里拆出来，冻结库存仍然不进看板。";
    await emit([{ kind: "text", text: stage.slice(0, 12), messageId: stageId }]);
    await emit([{ kind: "text", text: stage.slice(12), messageId: stageId }]);
    remember(stageId, "assistant", stage, { _clientMessageId: clientMessageId });
    let answer = "";
    for (const chunk of warningChunks()) {
      answer += chunk;
      await emit([{ kind: "text", text: chunk, messageId: answerId }]);
      if (chunk.includes("预警段落-02")) await sleep(4500);
    }
    remember(answerId, "assistant", answer, {
      _clientMessageId: clientMessageId,
      usage: { costCredits: "6", totalTokens: 960, inputTokens: 400, outputTokens: 560 },
    });
  }

  const start = (bucket.at(-1)?._seq || 0) + 1;
  bucket.push(...stamp(persisted, start));
  store.revision += 1;
  const clockId = sessId === WAIT_SESSION ? WAIT_SESSION : sessId === OLD_SESSION ? OLD_SESSION : BOARD_SESSION;
  store.clocks[clockId].updatedAt = Date.now();
  send({
    ...base,
    frameSeq: nextSeq(sessId),
    ts: Date.now(),
    blocks: [],
    isFinal: true,
  });
}
