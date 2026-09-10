/**
 * Cold-start precise retry of the original failed advisor turn.
 * Loopback HTTP/WS is not a live model or ledger. Fixture serves the current
 * SessionDetail / payload schema so history load is a real App recovery, not
 * empty `{ok:true}` compatibility.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

if (!process.env.OC_E2E_BROWSER) {
  const cached = "/usr/local/share/ms-playwright/chromium-1226/chrome-linux64/chrome";
  if (existsSync(cached)) process.env.OC_E2E_BROWSER = cached;
}

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");

const ADVICE = "check the assertion first";
const RETRY_TEXT = "retry-anchor keep advisor snapshot";
const CORRUPT_TEXT = "corrupt-snapshot should refuse precise retry";
const PARENT_REASON = "一期仅 CCB 主会话可咨询顾问。主模型不会因此被切换。";

function collabDoc(over = {}) {
  return {
    rev: 0,
    defaultMode: "solo",
    defaultAdvisorModel: "gpt-6-astra",
    session: {
      mode: "solo",
      advisorModel: null,
      configVersion: "v1:solo:",
      source: "default",
    },
    advisorModels: [{ id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" }],
    advisorConsultParents: ["ccb"],
    advisorConsultParentReason: PARENT_REASON,
    advisorConsultAllowed: true,
    parentEngine: "ccb",
    ...over,
  };
}

function routingOf(frame) {
  return {
    model: frame.model,
    teamMode: !!frame.teamMode,
    ...(frame.collabMode ? { collabMode: frame.collabMode } : {}),
    ...(frame.advisorModel ? { advisorModel: frame.advisorModel } : {}),
    ...(frame.collabConfigVersion ? { collabConfigVersion: frame.collabConfigVersion } : {}),
    effortLevel: Object.prototype.hasOwnProperty.call(frame, "effortLevel") ? frame.effortLevel : null,
  };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function startFixture(opts = {}) {
  const failOnceTexts = opts.failOnceTexts || [RETRY_TEXT];
  const failRemaining = new Map(failOnceTexts.map((text) => [text, 1]));
  const sessions = new Map();
  const tapes = new Map();
  const payloads = new Map();
  const sessionCollab = new Map();
  let defaultCollab = collabDoc();
  const inbounds = [];
  const httpLog = [];
  let seq = 0;
  let historyRevision = 1;
  const user = {
    id: "u1",
    email: "test@example.com",
    email_verified: true,
    role: "user",
    display_name: "Test",
    credits: "1000",
  };
  const models = [
    { id: "glm-5.2", display_name: "GLM-5.2", engine: "ccb", available: true },
    { id: "gpt-6-astra", display_name: "GPT-6 Astra", engine: "codex", available: true },
  ];

  const tapeOf = (id) => {
    if (!tapes.has(id)) tapes.set(id, []);
    return tapes.get(id);
  };

  const appendTape = (id, row) => {
    const tape = tapeOf(id);
    const nextSeq = (tape.at(-1)?._seq || 0) + 1;
    const rec = {
      ...row,
      ts: row.ts || Date.now(),
      _source: "server",
      _seq: nextSeq,
      _orderSeq: nextSeq,
      _timelineRecord: true,
      _timelineUnitKey: row._timelineUnitKey || `outer:${nextSeq}:${row.id}`,
    };
    tape.push(rec);
    historyRevision += 1;
    const sess = sessions.get(id);
    if (sess) {
      sess.lastAt = rec.ts;
      sess.updatedAt = rec.ts;
      sess.messageCount = tape.filter((m) => m.role === "user").length;
      sess.historyRevision = historyRevision;
    }
    return rec;
  };

  const storePayload = (record) => {
    const bytes = Buffer.from(JSON.stringify(record), "utf8");
    payloads.set(record.id, {
      bytes,
      sha256: sha256Hex(bytes),
      role: record.role,
    });
  };

  const sessionDetail = (id) => {
    const row = sessions.get(id);
    if (!row) return null;
    const messages = tapeOf(id);
    const maxSeq = messages.reduce((n, m) => Math.max(n, m._seq || 0), 0);
    return {
      id: row.id,
      userId: user.id,
      agentId: row.agentId,
      title: row.title,
      pinned: false,
      createdAt: row.createdAt,
      lastAt: row.lastAt,
      messages,
      updatedAt: row.updatedAt,
      historyRevision: row.historyRevision || historyRevision,
      timelineGeneration: 1,
      timelineCursor: null,
      timelineHasMore: false,
      timelineSnapshotMaxSeq: maxSeq,
      isPartial: false,
      totalMessageCount: messages.length,
      maxSeq,
      modelId: row.modelId,
      archivedCount: 0,
      archivedThroughSeq: 0,
    };
  };

  const seedSession = (id, title, messages) => {
    const now = Date.now();
    sessions.set(id, {
      id,
      title,
      ownerUserId: user.id,
      createdAt: now,
      lastAt: now,
      updatedAt: now,
      messageCount: messages.filter((m) => m.role === "user").length,
      modelId: "glm-5.2",
      agentId: "main",
      historyRevision: 1,
    });
    tapes.set(id, []);
    for (const message of messages) appendTape(id, message);
    return id;
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method || "GET";
    httpLog.push({ method, path });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let data = {};
    if (chunks.length) {
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        data = {};
      }
    }
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="oc-build" content="ocv5-210-m9"></head><body><div id="root"></div></body></html>',
      );
      return;
    }
    if (path === "/api/public/config") return json(200, { turnstile_bypass: true, require_email_verified: false, allow_registration: true });
    if (path === "/api/auth/refresh") {
      return json(200, { access_token: "test-token", access_exp: Date.now() / 1000 + 3600, remember: true });
    }
    if (path === "/api/me") return json(200, { user });
    if (path === "/api/public/models") return json(200, { models });
    if (path === "/api/me/preferences") return json(200, { prefs: { default_model: "glm-5.2" } });
    if (path === "/api/agent/status") {
      return json(200, { runtime_ready: true, container: { id: "c1", status: "running" }, subscription: { status: "active" } });
    }
    if (path === "/api/sessions/list") {
      return json(200, {
        sessions: [...sessions.values()].map((row) => ({
          id: row.id,
          agentId: row.agentId,
          title: row.title,
          pinned: false,
          createdAt: row.createdAt,
          lastAt: row.lastAt,
          messageCount: row.messageCount,
          updatedAt: row.updatedAt,
          modelId: row.modelId,
        })),
      });
    }
    if (path === "/api/marketplace/my-agents") {
      return json(200, {
        agents: [
          { id: "main", slug: "main", name: "全能助手", installed: true, isDefault: true },
          { id: "coder", slug: "coder", name: "编程助手", installed: true, isDefault: false },
        ],
      });
    }
    if (path === "/api/collaboration-config" && method === "GET") {
      const sid = url.searchParams.get("sessionId") || "";
      return json(200, (sid && sessionCollab.get(sid)) || defaultCollab);
    }
    if (path === "/api/collaboration-config" && method === "PUT") {
      if (data.sessionId && !sessions.has(data.sessionId)) return json(404, { error: "session not found" });
      const prev = (data.sessionId && sessionCollab.get(data.sessionId)) || defaultCollab;
      const mode = data.mode || "solo";
      const advisorModel = mode === "advisor" ? data.advisorModel || "gpt-6-astra" : null;
      const next = collabDoc({
        rev: (prev.rev || 0) + 1,
        defaultMode: data.asDefault ? mode : prev.defaultMode,
        defaultAdvisorModel: data.asDefault && mode === "advisor" ? advisorModel : prev.defaultAdvisorModel,
        session: {
          mode,
          advisorModel,
          configVersion: mode === "advisor" ? `v1:advisor:${advisorModel}` : `v1:${mode}:`,
          source: data.sessionId ? "session" : "default",
        },
        parentEngine: "ccb",
        advisorConsultAllowed: true,
      });
      if (data.sessionId) sessionCollab.set(data.sessionId, next);
      if (data.asDefault) defaultCollab = { ...next, session: next.session };
      return json(200, next);
    }
    const payloadPath = path.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/payload$/);
    if (payloadPath && method === "GET") {
      const stored = payloads.get(decodeURIComponent(payloadPath[2]));
      if (!stored || opts.omitPayloadIds?.includes(decodeURIComponent(payloadPath[2]))) {
        return json(404, { error: "payload not found" });
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
      if (!range) return json(400, { error: "range required" });
      const start = Number(range[1]);
      const end = Number(range[2]);
      const slice = stored.bytes.subarray(start, end + 1);
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${end}/${stored.bytes.length}`,
        "x-openclaude-content-sha256": stored.sha256,
        "x-openclaude-record-id": decodeURIComponent(payloadPath[2]),
        "x-openclaude-record-role": stored.role,
        "content-encoding": "identity",
      });
      res.end(slice);
      return;
    }
    if (/^\/api\/sessions\/[^/]+\/live-frames$/.test(path)) {
      return json(200, {
        frames: [],
        nextCursor: null,
        hasMore: false,
        streamClientMessageIds: [],
        hasTapeProjection: true,
        tapeProjectionVersion: 1,
      });
    }
    if (/^\/api\/sessions\/[^/]+\/timeline$/.test(path)) {
      const id = path.split("/")[3];
      const detail = sessionDetail(id);
      if (!detail) return json(404, { error: "session not found" });
      return json(200, {
        messages: detail.messages,
        nextCursor: null,
        hasMore: false,
        timelineGeneration: 1,
        historyRevision: detail.historyRevision,
        snapshotMaxSeq: detail.maxSeq,
      });
    }
    if (/^\/api\/sessions\/[^/]+\/inflight-delegates$/.test(path)) return json(200, { items: [] });
    if (/^\/api\/sessions\/[^/]+\/archive$/.test(path)) {
      return json(200, { messages: [], hasMore: false, oldestSeq: null, historyRevision: 1 });
    }
    if (/^\/api\/sessions\/[^/]+\/read$/.test(path) && method === "POST") return json(200, { ok: true });
    if (/^\/api\/sessions\/[^/]+$/.test(path) && method === "GET") {
      const id = path.split("/").at(-1);
      const detail = sessionDetail(id);
      if (!detail) return json(404, { error: "session not found" });
      return json(200, detail);
    }
    if (/^\/api\/sessions\/[^/]+$/.test(path) && method === "PUT") {
      const id = path.split("/").at(-1);
      const now = Date.now();
      const prev = sessions.get(id);
      const row = {
        id,
        title: data.title || prev?.title || "新对话",
        ownerUserId: user.id,
        createdAt: prev?.createdAt || now,
        lastAt: now,
        updatedAt: now,
        messageCount: prev?.messageCount || 0,
        modelId: data.modelId || prev?.modelId || "glm-5.2",
        agentId: data.agentId || prev?.agentId || "main",
        historyRevision: prev?.historyRevision || 1,
      };
      sessions.set(id, row);
      if (!tapes.has(id)) tapes.set(id, []);
      return json(200, { ok: true, applied: true, updatedAt: now });
    }
    if (path.startsWith("/api/sessions") && method === "PATCH") {
      const id = path.split("/").at(3);
      const row = id && sessions.get(id);
      if (row && data.title) {
        row.title = data.title;
        row.lastAt = Date.now();
        row.updatedAt = row.lastAt;
      }
      return json(200, { ok: true, updatedAt: Date.now() });
    }
    if (path.startsWith("/api/")) return json(200, { ok: true });
    json(404, { error: "not found" });
  });

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("bearer") ? "bearer" : [...protocols][0] || false),
  });
  http.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws/user-chat-bridge")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (socket) => {
    const send = (obj) => socket.send(JSON.stringify(obj));
    socket.on("message", (raw) => {
      let f;
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (f.type === "inbound.hello") {
        // Real master owns automatic recovery. The stub must advertise the same
        // owner so cold boot does not locally auto-replay the failed turn.
        send({ type: "sys.relay_ready", automaticRecoveryOwner: "master-v1" });
        return;
      }
      if (f.type === "ping") {
        send({ type: "pong", id: f.id });
        return;
      }
      if (f.type === "inbound.message") {
        inbounds.push(f);
        const sessId = f.peer?.id;
        const clientMessageId = f.clientMessageId;
        const text = String(f.content?.text || "");
        const row = sessId && sessions.get(sessId);
        if (row) {
          row.lastAt = Date.now();
          row.updatedAt = row.lastAt;
          if ((!row.title || row.title === "新对话") && text) row.title = text.slice(0, 80);
        }
        const userRec = {
          id: clientMessageId,
          role: "user",
          text,
          status: "sent",
          _clientMessageId: clientMessageId,
          _routing: routingOf(f),
          _sendAttempt: 0,
        };
        if (sessId) {
          const existing = tapeOf(sessId).find((m) => m.id === clientMessageId && m.role === "user");
          if (existing) {
            existing.status = "sent";
            existing._routing = userRec._routing;
          } else {
            appendTape(sessId, userRec);
          }
          storePayload({ ...userRec, status: "sent" });
        }
        send({
          type: "outbound.ack",
          admitted: true,
          peer: { id: sessId, kind: "dm" },
          clientMessageId,
        });
        const sessionKey = `agent:main:webchat:dm:${sessId}`;
        const base = {
          type: "outbound.message",
          sessionKey,
          channel: "webchat",
          peer: { id: sessId, kind: "dm" },
          clientMessageId,
          isFinal: false,
        };
        const remaining = failRemaining.get(text) || 0;
        if (remaining > 0) {
          failRemaining.set(text, remaining - 1);
          const tapeUser = sessId && tapeOf(sessId).find((m) => m.id === clientMessageId && m.role === "user");
          if (tapeUser) tapeUser.status = "error";
          if (sessId) {
            appendTape(sessId, {
              id: `err-${clientMessageId}`,
              role: "assistant",
              text: "本轮派发未能接入执行通道，已中断。请点击重试。",
              _errorCode: "durable_dispatch_unavailable",
              _clientMessageId: clientMessageId,
              _turnTapeComplete: true,
              _dispatchTerminal: true,
            });
            storePayload({ ...userRec, status: "error" });
          }
          seq += 1;
          send({
            type: "outbound.error",
            sessionKey,
            channel: "webchat",
            peer: { id: sessId, kind: "dm" },
            clientMessageId,
            code: "durable_dispatch_unavailable",
            message: "dispatch unavailable",
            isFinal: true,
            frameSeq: seq,
          });
          send({
            type: "sys.recovery_decision",
            peer: { id: sessId, kind: "dm" },
            sourceClientMessageId: clientMessageId,
            errorCode: "durable_dispatch_unavailable",
            scheduled: false,
            reason: "exhausted",
          });
          return;
        }
        seq += 1;
        send({
          ...base,
          frameSeq: seq,
          blocks: [
            {
              kind: "tool_use",
              blockId: "consult-1",
              toolName: "mcp__openclaude-memory__consult_advisor",
              inputJson: { question: text },
              partial: false,
            },
          ],
        });
        seq += 1;
        send({
          ...base,
          frameSeq: seq,
          blocks: [
            {
              kind: "tool_result",
              blockId: "consult-1-result",
              toolUseBlockId: "consult-1",
              toolName: "mcp__openclaude-memory__consult_advisor",
              isError: false,
              output: JSON.stringify({
                advice: ADVICE,
                status: "settled",
                advisorModel: f.advisorModel || "gpt-6-astra",
              }),
            },
          ],
        });
        if (sessId) {
          appendTape(sessId, {
            id: `tool-${clientMessageId}`,
            role: "tool",
            text: "",
            toolName: "mcp__openclaude-memory__consult_advisor",
            output: JSON.stringify({
              advice: ADVICE,
              status: "settled",
              advisorModel: f.advisorModel || "gpt-6-astra",
            }),
            _completed: true,
            _clientMessageId: clientMessageId,
            _turnTapeComplete: true,
          });
        }
        const finalSeq = (seq += 1);
        send({ ...base, frameSeq: finalSeq, blocks: [], isFinal: true });
      }
    });
  });

  return { http, inbounds, httpLog, sessionCollab, seedSession, payloads };
}

async function bundleApp() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./goal-start-harness.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)) },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}',
    },
    logLevel: "error",
  });
  return bundle.outputFiles[0].text;
}

async function bootPage(context, origin, js) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("oc_auth_hint", "1");
  });
  await page.goto(origin);
  await page.addScriptTag({ content: js });
  await page.getByRole("button", { name: /切换智能体/ }).waitFor();
  return { page, errors };
}

async function dumpPage(page, inbounds, httpLog, label) {
  const body = (await page.locator("body").innerText()).slice(-5000);
  return `${label}\ninbounds=${inbounds.length} last=${JSON.stringify(inbounds.at(-1) || null)}\nhttp=${JSON.stringify(httpLog.slice(-20))}\nbody=${body}`;
}

async function chooseAdvisor(page) {
  await page.getByRole("button", { name: /切换智能体/ }).click();
  await page.getByRole("button", { name: /主模型不切换/ }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}

function preciseRetryOnFailedCard(page) {
  return page
    .locator("div")
    .filter({ hasText: "派发未能接入执行通道" })
    .getByRole("button", { name: "重试" });
}

test("cold App loads original failed turn and precise retry keeps advisor snapshot", {
  timeout: 180_000,
}, async () => {
  const js = await bundleApp();
  const { http, inbounds, httpLog } = startFixture();
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${http.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const a = await bootPage(ctxA, origin, js);
    await chooseAdvisor(a.page);
    await a.page.getByPlaceholder(/和「全能助手」对话/).fill(RETRY_TEXT);
    await a.page.getByRole("button", { name: "发送" }).click();
    await a.page.getByTestId("user-row").filter({ hasText: RETRY_TEXT }).waitFor();
    await a.page.getByText("派发未能接入执行通道", { exact: true }).waitFor();
    const failedInbound = inbounds.at(-1);
    assert.ok(failedInbound);
    assert.equal(failedInbound.content?.text, RETRY_TEXT);
    assert.equal(failedInbound.collabMode, "advisor");
    assert.equal(failedInbound.advisorModel, "gpt-6-astra");
    assert.equal(failedInbound.model, "glm-5.2");
    assert.match(String(failedInbound.collabConfigVersion || ""), /v1:advisor:gpt-6-astra/);
    const sessionId = failedInbound.peer.id;
    assert.equal(await a.page.getByText("正在生成内容").count(), 0);

    const b = await bootPage(ctxB, origin, js);
    const sessionBtn = b.page.getByRole("button", { name: new RegExp(RETRY_TEXT) });
    await sessionBtn.waitFor({ timeout: 15_000 });
    await sessionBtn.click();
    await b.page.getByRole("button", { name: /切换智能体/ }).click();
    await b.page.getByRole("button", { name: /队长切 Astra/ }).click();
    await b.page.keyboard.press("Escape");
    await b.page.getByRole("dialog").waitFor({ state: "hidden" });
    let collabJson;
    for (let i = 0; i < 20; i += 1) {
      const collabRes = await a.page.request.get(
        `${origin}/api/collaboration-config?sessionId=${encodeURIComponent(sessionId)}`,
      );
      collabJson = await collabRes.json();
      if (collabJson?.session?.mode === "team") break;
      await new Promise((done) => setTimeout(done, 200));
    }
    assert.equal(collabJson?.session?.mode, "team");

    await a.page.close();
    const a2 = await bootPage(ctxA, origin, js);
    const restoredUser = a2.page.getByTestId("user-row").filter({ hasText: RETRY_TEXT });
    try {
      await restoredUser.or(a2.page.getByText(RETRY_TEXT)).waitFor({ timeout: 15_000 });
    } catch (err) {
      const named = a2.page.getByRole("button", { name: new RegExp(RETRY_TEXT) }).or(
        a2.page.getByRole("button", { name: /新对话/ }),
      );
      if (await named.count()) await named.first().click();
      else throw new Error(`${err.message}\n${await dumpPage(a2.page, inbounds, httpLog, "cold-boot-session")}`);
    }
    await a2.page.getByText(RETRY_TEXT).first().waitFor();
    const body = await a2.page.locator("body").innerText();
    assert.equal(await a2.page.getByTestId("session-history-error").count(), 0);
    assert.equal(await a2.page.getByTestId("session-history-error-banner").count(), 0);
    assert.doesNotMatch(body, /会话加载失败/);
    assert.doesNotMatch(body, /版本切换中/);
    assert.doesNotMatch(body, /正在生成内容/);
    assert.match(body, /团队/);
    await a2.page.getByText("派发未能接入执行通道", { exact: true }).waitFor();
    assert.equal(
      inbounds.filter((row) => row.content?.recovery?.automatic === true).length,
      0,
      "cold boot must not auto-replay the failed turn; user clicks precise retry",
    );
    assert.equal(await a2.page.getByRole("button", { name: "重新尝试" }).count(), 0);
    const retryCta = preciseRetryOnFailedCard(a2.page);
    try {
      await retryCta.waitFor({ timeout: 10_000 });
    } catch (err) {
      throw new Error(`${err.message}\n${await dumpPage(a2.page, inbounds, httpLog, "cold-precise-retry-cta")}`);
    }
    assert.equal(await retryCta.count(), 1, "exact busy-card retry CTA, not history banner");
    const payloadGets = httpLog.filter((row) => row.path.includes("/payload")).length;
    const before = inbounds.length;
    await retryCta.click();
    for (let i = 0; i < 30 && inbounds.length === before; i += 1) {
      await new Promise((done) => setTimeout(done, 200));
    }
    const retried = inbounds.at(-1);
    assert.ok(inbounds.length > before, await dumpPage(a2.page, inbounds, httpLog, "cold-retry-inbound"));
    assert.equal(retried.content?.text, RETRY_TEXT);
    assert.equal(retried.model, failedInbound.model);
    assert.equal(retried.collabMode, "advisor");
    assert.equal(retried.advisorModel, "gpt-6-astra");
    assert.equal(retried.collabConfigVersion, failedInbound.collabConfigVersion);
    assert.notEqual(retried.collabMode, "team");
    assert.deepEqual(a.errors.filter((e) => !/ResizeObserver/.test(e)), []);
    assert.deepEqual(a2.errors.filter((e) => !/ResizeObserver/.test(e)), []);
    assert.deepEqual(b.errors.filter((e) => !/ResizeObserver/.test(e)), []);
    void payloadGets;
    await ctxA.close();
    await ctxB.close();
  } finally {
    await browser?.close();
    await new Promise((done) => http.close(done));
  }
});

test("cold App refuses precise retry when exact user payload is missing", {
  timeout: 120_000,
}, async () => {
  const js = await bundleApp();
  const corruptId = "m-corrupt-payload";
  const sessionId = "web-corrupt-payload-1";
  const { http, inbounds, seedSession } = startFixture({ omitPayloadIds: [corruptId] });
  seedSession(sessionId, CORRUPT_TEXT, [
    {
      id: corruptId,
      role: "user",
      text: CORRUPT_TEXT,
      status: "error",
      _clientMessageId: corruptId,
      _userPayloadDeferred: true,
      _routing: {
        model: "glm-5.2",
        collabMode: "advisor",
        advisorModel: "gpt-6-astra",
        collabConfigVersion: "v1:advisor:gpt-6-astra",
      },
    },
    {
      id: `err-${corruptId}`,
      role: "assistant",
      text: "本轮派发未能接入执行通道，已中断。请点击重试。",
      _errorCode: "durable_dispatch_unavailable",
      _dispatchTerminal: true,
      _clientMessageId: corruptId,
      _turnTapeComplete: true,
    },
  ]);
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${http.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await bootPage(ctx, origin, js);
    await page.page.getByRole("button", { name: new RegExp(CORRUPT_TEXT) }).click();
    await page.page.getByTestId("user-row").filter({ hasText: CORRUPT_TEXT }).waitFor();
    await page.page.getByText("派发未能接入执行通道", { exact: true }).waitFor();
    assert.equal(await page.page.getByTestId("session-history-error-banner").count(), 0);
    assert.equal(await preciseRetryOnFailedCard(page.page).count(), 0, "deferred user without payload must not expose precise 重试");
    assert.ok((await page.page.getByRole("button", { name: "重新尝试" }).count()) >= 1);
    assert.equal(inbounds.length, 0, "negative control never sends; regenerate is not precise retry");
    await ctx.close();
  } finally {
    await browser?.close();
    await new Promise((done) => http.close(done));
  }
});
