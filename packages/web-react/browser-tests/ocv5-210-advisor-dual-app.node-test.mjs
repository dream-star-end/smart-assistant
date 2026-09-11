/**
 * Real App + two browser contexts against a shared loopback HTTP/WS fixture.
 * Proves collab select/refresh, cross-end preference change, frozen original
 * turn snapshot on reload/retry, consult card metadata, unique Stop, and
 * non-main isolation. Stub HTTP/WS is not a live model or ledger.
 */
import assert from "node:assert/strict";
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
const USER_TEXT = "请咨询顾问核对约束";
const RETRY_TEXT = "retry-anchor keep advisor snapshot";
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

function emptyLiveFrames() {
  return {
    frames: [],
    nextCursor: null,
    hasMore: false,
    streamClientMessageIds: [],
    hasTapeProjection: false,
  };
}

function startFixture() {
  const sessions = new Map();
  const sessionCollab = new Map();
  let defaultCollab = collabDoc();
  const inbounds = [];
  let seq = 0;
  let retryAnchorFailsLeft = 1;
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

  const sessionDetail = (id) => {
    const row = sessions.get(id);
    if (!row) return null;
    return {
      id: row.id,
      userId: user.id,
      agentId: row.agentId,
      title: row.title,
      pinned: false,
      createdAt: row.createdAt,
      lastAt: row.lastAt,
      messages: [],
      isPartial: true,
      totalMessageCount: row.messageCount,
      maxSeq: 0,
      updatedAt: row.updatedAt,
      historyRevision: 0,
      modelId: row.modelId,
    };
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method || "GET";
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
    res.setHeader("content-type", "application/json; charset=utf-8");
    const json = (status, body) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="oc-build" content="ocv5-210-m8"></head><body><div id="root"></div></body></html>',
      );
      return;
    }
    if (path === "/__probe/inbounds") return json(200, { inbounds });
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
      const doc = (sid && sessionCollab.get(sid)) || defaultCollab;
      return json(200, doc);
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
    const liveFrames = path.match(/^\/api\/sessions\/([^/]+)\/live-frames$/);
    if (liveFrames) return json(200, emptyLiveFrames());
    const timeline = path.match(/^\/api\/sessions\/([^/]+)\/timeline$/);
    if (timeline) {
      return json(200, { messages: [], nextCursor: null, hasMore: false, timelineGeneration: 1, historyRevision: 0 });
    }
    const archive = path.match(/^\/api\/sessions\/([^/]+)\/archive$/);
    if (archive) return json(200, { messages: [], hasMore: false });
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
      };
      sessions.set(id, row);
      return json(200, { ok: true, session: row });
    }
    if (path.startsWith("/api/sessions") && method === "PATCH") {
      const id = path.split("/").at(3);
      const row = id && sessions.get(id);
      if (row && data.title) {
        row.title = data.title;
        row.lastAt = Date.now();
        row.updatedAt = row.lastAt;
        row.messageCount = Math.max(row.messageCount, 1);
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
          row.messageCount = (row.messageCount || 0) + 1;
          row.lastAt = Date.now();
          row.updatedAt = row.lastAt;
          if ((!row.title || row.title === "新对话") && text) row.title = text.slice(0, 40);
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
        if (text.includes("retry-anchor") && retryAnchorFailsLeft > 0) {
          retryAnchorFailsLeft -= 1;
          seq += 1;
          send({
            type: "outbound.error",
            sessionKey,
            channel: "webchat",
            peer: { id: sessId, kind: "dm" },
            clientMessageId,
            code: "model_capacity",
            message: "busy",
            isFinal: true,
            frameSeq: seq,
          });
          send({
            type: "sys.recovery_decision",
            peer: { id: sessId, kind: "dm" },
            sourceClientMessageId: clientMessageId,
            errorCode: "model_capacity",
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
        const finalSeq = (seq += 1);
        setTimeout(() => {
          send({ ...base, frameSeq: finalSeq, blocks: [], isFinal: true });
        }, 2000);
      }
    });
  });

  return { http, inbounds, sessions, sessionCollab };
}

async function bootPage(context, origin, bundle) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("oc_auth_hint", "1");
  });
  await page.goto(origin);
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: /切换智能体/ }).waitFor();
  return { page, errors };
}

async function dumpPage(page, inbounds, label) {
  const body = (await page.locator("body").innerText()).slice(-5000);
  return `${label}\ninbounds=${inbounds.length} last=${JSON.stringify(inbounds.at(-1) || null)}\nbody=${body}`;
}

function consultCardToggle(page) {
  return page
    .getByRole("button", { name: "展开咨询顾问详情" })
    .or(page.getByRole("button", { name: "收起咨询顾问详情" }));
}

async function expandConsultCard(page) {
  const expand = page.getByRole("button", { name: "展开咨询顾问详情" });
  if (await expand.count()) await expand.click();
}

async function waitForConsultAdvice(page, inbounds) {
  await consultCardToggle(page).waitFor({ timeout: 15_000 });
  await expandConsultCard(page);
  try {
    await page.getByText(ADVICE).waitFor({ timeout: 10_000 });
  } catch (err) {
    throw new Error(`${err.message}\n${await dumpPage(page, inbounds, "wait-advice")}`);
  }
}

test("real App two contexts: collab refresh, frozen turn, consult card, unique Stop, non-main isolation", {
  timeout: 180_000,
}, async () => {
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
  const js = bundle.outputFiles[0].text;
  const { http, inbounds } = startFixture();
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
    await a.page.getByRole("button", { name: /切换智能体/ }).click();
    await a.page.getByRole("button", { name: /主模型不切换/ }).click();
    await a.page.keyboard.press("Escape");
    await a.page.getByRole("dialog").waitFor({ state: "hidden" });
    await a.page.getByPlaceholder(/和「全能助手」对话/).fill(USER_TEXT);
    await a.page.getByRole("button", { name: "发送" }).click();
    try {
      await a.page.getByTestId("message-text").waitFor({ timeout: 15_000 });
      await consultCardToggle(a.page).waitFor({ timeout: 15_000 });
    } catch (err) {
      throw new Error(`${err.message}\n${await dumpPage(a.page, inbounds, "wait-card")}`);
    }
    const composerStop = await a.page.getByRole("button", { name: "停止" }).count();
    const trackerStop = await a.page.getByRole("button", { name: "停止本轮" }).count();
    assert.equal(composerStop, 1, "composer is the unique in-flight Stop");
    assert.equal(trackerStop, 0, "advisor consult must not add a second Stop");
    await waitForConsultAdvice(a.page, inbounds);
    const cardText = await a.page.locator("body").innerText();
    assert.match(cardText, /实际顾问型号 gpt-6-astra/);
    assert.match(cardText, /用量未随工具结果返回/);
    assert.equal(cardText.includes("input_tokens"), false);
    assert.match(cardText, /GLM-5\.2/);
    const inbound = inbounds.at(-1);
    assert.ok(inbound, "loopback WS must receive inbound.message");
    assert.equal(inbound.collabMode, "advisor");
    assert.equal(inbound.advisorModel, "gpt-6-astra");
    assert.match(String(inbound.collabConfigVersion || ""), /v1:advisor:gpt-6-astra/);
    const sessionId = inbound.peer.id;

    await a.page.getByRole("button", { name: "发送" }).waitFor({ timeout: 15_000 });
    await a.page.getByPlaceholder(/和「全能助手」对话/).fill(RETRY_TEXT);
    await a.page.getByRole("button", { name: "发送" }).click();
    try {
      await a.page.getByRole("button", { name: "重试" }).waitFor({ timeout: 15_000 });
    } catch (err) {
      throw new Error(`${err.message}\n${await dumpPage(a.page, inbounds, "wait-retry")}`);
    }
    const failedInbound = inbounds.at(-1);
    assert.equal(failedInbound.content?.text, RETRY_TEXT);
    assert.equal(failedInbound.collabMode, "advisor");
    assert.equal(failedInbound.advisorModel, "gpt-6-astra");

    const b = await bootPage(ctxB, origin, js);
    const sessionBtn = b.page.getByRole("button", { name: new RegExp(USER_TEXT) });
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
    assert.equal(collabJson?.session?.mode, "team", "shared HTTP collab GET must see B's team switch");

    await expandConsultCard(a.page);
    const afterTeamSwitch = await a.page.locator("body").innerText();
    assert.match(afterTeamSwitch, new RegExp(ADVICE));
    assert.match(afterTeamSwitch, /实际顾问型号 gpt-6-astra/);

    const beforeRetry = inbounds.length;
    await a.page.getByRole("button", { name: "重试" }).first().click();
    for (let i = 0; i < 25 && inbounds.length === beforeRetry; i += 1) {
      await new Promise((done) => setTimeout(done, 200));
    }
    const retried = inbounds.at(-1);
    assert.ok(retried && inbounds.length > beforeRetry, "retry must dispatch inbound.message");
    assert.equal(retried.content?.text, RETRY_TEXT);
    assert.equal(retried.collabMode, "advisor", "retry must keep original advisor snapshot, not later team pref");
    assert.equal(retried.advisorModel, "gpt-6-astra");
    assert.match(String(retried.collabConfigVersion || ""), /v1:advisor:gpt-6-astra/);

    await a.page.close();
    const a2 = await bootPage(ctxA, origin, js);
    const reopened = a2.page.getByRole("button", { name: new RegExp(USER_TEXT) });
    await reopened.waitFor({ timeout: 15_000 });
    await reopened.click();
    try {
      await waitForConsultAdvice(a2.page, inbounds);
    } catch (err) {
      throw new Error(`${err.message}\n${await dumpPage(a2.page, inbounds, "after-reload")}`);
    }
    const afterReload = await a2.page.locator("body").innerText();
    assert.match(afterReload, /实际顾问型号 gpt-6-astra/);
    assert.match(afterReload, new RegExp(ADVICE));
    assert.match(afterReload, /用量未随工具结果返回/);

    await a2.page.getByRole("button", { name: "新建会话" }).click();
    await a2.page.getByRole("button", { name: /切换智能体/ }).click();
    await a2.page.getByRole("button", { name: /编程助手/ }).click();
    await a2.page.keyboard.press("Escape");
    await a2.page.getByRole("dialog").waitFor({ state: "hidden" });
    await a2.page.getByPlaceholder(/和「编程助手」对话|和「全能助手」对话/).fill("非 main 不应继承顾问");
    await a2.page.getByRole("button", { name: "发送" }).click();
    await a2.page.getByTestId("message-text").filter({ hasText: "非 main 不应继承顾问" }).waitFor();
    const last = inbounds.at(-1);
    assert.ok(last);
    assert.notEqual(last.collabMode, "advisor");
    assert.equal(last.advisorModel, undefined);
    assert.deepEqual(a.errors.filter((e) => !/ResizeObserver/.test(e)), []);
    assert.deepEqual(a2.errors.filter((e) => !/ResizeObserver/.test(e)), []);
    assert.deepEqual(b.errors.filter((e) => !/ResizeObserver/.test(e)), []);
    await ctxA.close();
    await ctxB.close();
  } finally {
    await browser?.close();
    await new Promise((done) => http.close(done));
  }
});
