import {fixtureSwitchQuote,fixtureExecutionModel} from "./model-switch-cost-fixture.mjs";
/**
 * Real App + two browser contexts against a shared loopback HTTP/WS fixture.
 * Proves collab select/refresh, cross-end preference change, frozen original
 * turn snapshot on reload/retry, consult card metadata, unique Stop, and
 * non-main isolation. Stub HTTP/WS is not a live model or ledger.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
import { clickSend, waitUntil } from "../../../scripts/lib/user-contract-browser.mjs";

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

function startFixture({ defaultMode = "solo" } = {}) {
  const sessions = new Map();
  const goals = new Map();
  const sessionCollab = new Map();
  let defaultCollab = collabDoc({ defaultMode, session: { mode: defaultMode, advisorModel: null, configVersion: `v1:${defaultMode}:`, source: "default" } });
  const inbounds = [];
  let writeStatus = 0;
  let sessionWriteStatus = 0;
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
      if (writeStatus) return json(writeStatus, { error: "fixture: collaboration save rejected" });
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
    const goalPath = path.match(/^\/api\/session-goals\/([^/]+)$/);
    if (goalPath) {
      const sessionId = goalPath[1];
      if (method === "PUT") {
        if (!sessions.has(sessionId)) return json(404, { error: "session not found" });
        const goal = { sessionId, goalId: "11111111-1111-4111-8111-111111111111", objective: data.objective, status: "active",
          tokenBudget: null, creditBudget: null, tokensUsed: 0, creditsUsed: "0", timeUsedSeconds: 0,
          stateRevision: (goals.get(sessionId)?.stateRevision ?? 0) + 1, snapshotRevision: 1,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), statusChangedAt: new Date().toISOString() };
        goals.set(sessionId, goal);
        return json(200, { goal });
      }
      return json(200, { goal: goals.get(sessionId) ?? null });
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
      if (sessionWriteStatus) return json(sessionWriteStatus, { error: "fixture session unavailable" });
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
    if(method==='POST'&&/^\/api\/me\/sessions\/[^/]+\/model-switch-estimate$/.test(path)){
      const sid=decodeURIComponent(path.split('/')[4]);
      const executed=[...inbounds].reverse().find(frame=>frame.peer?.id===sid);
      const row=sessions.get(sid);
      return json(200,fixtureSwitchQuote(data,{empty:!executed&&!row?.messageCount,sourceModel:fixtureExecutionModel(executed)??row?.modelId??'glm-5.2'}));
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
        if (f.content?.displayText === "继续" && !f.content?.recovery) {
          send({ ...base, frameSeq: ++seq,
            blocks: [{ kind: "text", text: "ADVISOR_TASK_CONTINUED" }], isFinal: true });
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

  return { http, inbounds, sessions, sessionCollab, setWriteStatus: status => { writeStatus = status; }, setSessionWriteStatus: status => { sessionWriteStatus = status; } };
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
  try { await page.getByRole("button", { name: /切换智能体/ }).waitFor(); }
  catch (error) { throw new Error(`${error.message}; page errors=${JSON.stringify(errors)}; body=${await page.locator("body").innerText()}`); }
  return { page, errors };
}

async function dumpPage(page, inbounds, label) {
  const body = (await page.locator("body").innerText()).slice(-5000);
  return `${label}\ninbounds=${inbounds.length} last=${JSON.stringify(inbounds.at(-1) || null)}\nbody=${body}`;
}

// 工具卡表头按钮的可及名 = 标签 + 摘要 + 状态(aria-labelledby,tools 审计 T-22),
// 展开/收起状态由 aria-expanded 表达,不再藏在「展开…详情」文案里。
function consultCardToggle(page) {
  return page.getByRole("button", { name: /咨询顾问/, expanded: false })
    .or(page.getByRole("button", { name: /咨询顾问/, expanded: true }));
}

async function ensureConsultProcessOpen(page) {
  const shell = page.getByTestId("process-disclosure");
  await shell.waitFor();
  assert.equal(await shell.count(), 1, "consult belongs to the unique process shell");
  const toggle = shell.getByTestId("process-toggle");
  assert.equal(await toggle.count(), 1);
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const group = shell.getByTestId("process-detail-toggle");
  await group.waitFor();
  assert.equal(await group.count(), 1, "consult belongs to the unique tool group");
  if (await group.getAttribute("aria-expanded") !== "true") await group.click();
}

async function expandConsultCard(page) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await ensureConsultProcessOpen(page);
    const collapsed = page.getByRole("button", { name: /咨询顾问/, expanded: false });
    if ((await collapsed.count()) === 0) {
      if ((await page.getByRole("button", { name: /咨询顾问/, expanded: true }).count()) >= 2) return;
    } else {
      try {
        await collapsed.first().click({ timeout: 1_500 });
        continue;
      } catch {
        // Live turn completion auto-collapses process-toggle (`explicit === undefined`); reopen on next pass.
      }
    }
    await page.waitForTimeout(100);
  }
}

async function waitForConsultAdvice(page, inbounds) {
  await ensureConsultProcessOpen(page);
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
    await a.page.getByRole("button", { name: /主模型不变/ }).click();
    await a.page.keyboard.press("Escape");
    await a.page.getByRole("dialog").waitFor({ state: "hidden" });
    await a.page.getByPlaceholder(/和「全能助手」对话/).fill(USER_TEXT);
    await a.page.getByRole("button", { name: "发送" }).click();
    try {
      await a.page.getByTestId("message-text").waitFor({ timeout: 15_000 });
      await ensureConsultProcessOpen(a.page);
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
    // 合并取舍(发布准备 t-1268 / 集成⑤收尾):卡片文案以 canonical OCV5-220 为准(顾问 <型号> · 状态 · 时长),
    // 与 bodyCards.test 同口径;canonical 自带的「实际顾问型号」旧断言随之对齐。
    assert.match(cardText, /顾问 gpt-6-astra/);
    assert.match(cardText, /用量未返回/);
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
      await a.page.getByRole("button", { name: "继续" }).waitFor({ timeout: 15_000 });
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
    await b.page.getByRole("button", { name: /队长切换为/ }).click();
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
    assert.match(afterTeamSwitch, /顾问 gpt-6-astra/);

    const beforeRetry = inbounds.length;
    await a.page.getByRole("button", { name: "继续" }).first().click();
    for (let i = 0; i < 25 && inbounds.length === beforeRetry; i += 1) {
      await new Promise((done) => setTimeout(done, 200));
    }
    const retried = inbounds.at(-1);
    assert.ok(retried && inbounds.length > beforeRetry, "Continue must dispatch one newly admitted inbound.message");
    assert.equal(inbounds.length, beforeRetry + 1, "one Continue admits one follow-up");
    assert.notEqual(retried.content?.text, RETRY_TEXT, "Continue does not replay the original task");
    assert.ok(retried.content?.text.includes(RETRY_TEXT), "Continue retains the original goal as context");
    assert.match(retried.content.text, /不要重新执行已经完成的步骤/);
    assert.equal(retried.content.displayText, "继续");
    assert.equal(retried.content.recovery, undefined, "manual continuation uses normal admission");
    assert.equal(retried.peer.id, failedInbound.peer.id);
    assert.notEqual(retried.clientMessageId, failedInbound.clientMessageId);
    assert.equal(retried.collabMode, "advisor", "Continue must keep original advisor snapshot, not later team pref");
    assert.equal(retried.advisorModel, "gpt-6-astra");
    assert.match(String(retried.collabConfigVersion || ""), /v1:advisor:gpt-6-astra/);
    await a.page.getByText("ADVISOR_TASK_CONTINUED", { exact: true }).waitFor();
    await expandConsultCard(a.page);
    // UI-3:同一条顾问工具展开后是人话步骤行,技术详情里还有原卡。两枚按钮是这一条,不是续跑复制的第二条。
    assert.equal(await consultCardToggle(a.page).count(), 2, "completed advisor tool remains once across Continue");
    await a.page.getByText(ADVICE, { exact: true }).waitFor();

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
    assert.match(afterReload, /顾问 gpt-6-astra/);
    assert.match(afterReload, new RegExp(ADVICE));
    assert.match(afterReload, /用量未返回/);

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

let collabAppBundle;
async function buildCollabApp() {
  if (!collabAppBundle) collabAppBundle = build({
    entryPoints: [fileURLToPath(new URL("./goal-start-harness.tsx", import.meta.url))],
    bundle: true, write: false, format: "iife", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)) },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    logLevel: "error",
    plugins: process.env.OC_COLLAB_BASELINE ? [{
      name: "collab-baseline",
      setup(builder) {
        builder.onLoad({ filter: /src\/(?:App\.tsx|hooks\/use(?:ComposerSend\.ts|SessionModelAndCollab\.tsx|AppNavigationActions\.tsx|DraftSessionMaterialization\.ts))$/ }, args => {
          const path = args.path.slice(args.path.indexOf("packages/web-react/"));
          return { contents: execFileSync("git", ["show", `${process.env.OC_COLLAB_BASELINE}:${path}`],
            { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8" }), loader: "tsx" };
        });
      },
    }] : [],
  });
  return collabAppBundle;
}

async function fixtureIdle(page) {
  await page.waitForFunction(() => {
    const send = document.querySelector('button[aria-label="发送"]');
    return send && !document.querySelector('button[aria-label="停止"]');
  });
}

async function sendFixtureTurn(page, inbounds, text) {
  await page.getByPlaceholder(/和「全能助手」对话/).fill(text);
  // The shared helper uses a trusted click without Playwright's unrelated
  // navigation barrier; completion is established from the real frame and UI.
  await clickSend(page);
  const frame = await waitUntil(() => inbounds.find(f => f.content?.text === text), 20_000, "fixture did not receive the actual turn");
  await fixtureIdle(page);
  return frame;
}

// Regression fixture keeps account defaults separate from each session override.
// A single shared doc makes a missing first-send PUT look successful.
for (const entry of ["header", "picker", "goal", "github"]) test(`team close persists solo through first send and reload (${entry})`, { timeout: 120_000 }, async () => {
  const bundle = await buildCollabApp();
  const fixture = startFixture({ defaultMode: "team" });
  const { http, inbounds, sessionCollab } = fixture;
  await new Promise(done => http.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const { page, errors } = await bootPage(context, origin, bundle.outputFiles[0].text);
    await page.getByRole("button", { name: "团队模式已开启", exact: true }).waitFor();
    if (entry === "picker") {
      await page.getByRole("button", { name: /切换智能体/ }).click();
      await page.getByRole("button", { name: /主模型独立完成/ }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    } else {
      await page.getByRole("button", { name: "团队模式已开启", exact: true }).click();
      await page.getByRole("button", { name: "关闭团队模式", exact: true }).click();
    }
    if (entry === "goal" || entry === "github") {
      const saved = page.waitForResponse(r => r.url().includes("/api/collaboration-config") && r.request().method() === "PUT");
      if (entry === "goal") {
        await page.getByRole("button", { name: "更多选项", exact: true }).click();
        await page.getByText("设定目标", { exact: true }).click();
        await page.getByPlaceholder("这次会话要达成什么？").fill("关闭团队首发回归");
        await page.getByRole("button", { name: "设置并开始", exact: true }).click();
      } else await page.getByRole("button", { name: "关联 GitHub 仓库", exact: true }).first().click();
      assert.equal((await saved).status(), 200, "materialization persists the same draft intent");
      if (entry === "github") await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }
    assert.equal(await page.getByRole("button", { name: "团队模式已开启", exact: true }).count(), 0);
    const first = entry === "goal"
      ? await waitUntil(() => inbounds.find(f => f.content?.text === "关闭团队首发回归"), 20_000, "goal did not start its actual first turn")
      : await sendFixtureTurn(page, inbounds, "关闭团队首发回归");
    await fixtureIdle(page);
    assert.ok(first, "first frame reached the actual WS fixture");
    assert.equal(first.teamMode, undefined);
    assert.equal(first.collabMode, "solo");
    assert.equal(sessionCollab.get(first.peer.id)?.session.mode, "solo", "explicit solo must be saved before activating the new session");
    await page.getByRole("button", { name: "发送", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "团队模式已开启", exact: true }).count(), 0, "first-send GET must not reopen team");
    await page.close();
    const reopened = await bootPage(context, origin, bundle.outputFiles[0].text);
    await reopened.page.getByRole("button", { name: "关闭团队首发回归", exact: true }).click();
    await reopened.page.getByRole("button", { name: /切换智能体/ }).click();
    assert.equal(await reopened.page.getByRole("button", { name: /主模型独立完成/ }).getAttribute("aria-pressed"), "true");
    await reopened.page.keyboard.press("Escape");
    await reopened.page.getByRole("dialog").waitFor({ state: "hidden" });
    await sendFixtureTurn(reopened.page, inbounds, "关闭团队第二轮回归");
    assert.equal(inbounds.at(-1).peer.id, first.peer.id);
    assert.equal(inbounds.at(-1).collabMode, "solo");
    assert.equal(inbounds.at(-1).teamMode, undefined);
    assert.deepEqual(errors, []);
    assert.deepEqual(reopened.errors, []);
    // The user's explicit account default is independent of this session's pick.
    const defaults = await (await fetch(`${origin}/api/collaboration-config`)).json();
    assert.equal(defaults.defaultMode, "team");
    await context.close();
  } finally {
    await browser.close();
    await new Promise(done => http.close(done));
  }
});

test("legacy device team flag cannot activate team before account config arrives", { timeout: 120_000 }, async () => {
  const bundle = await buildCollabApp();
  const { http, inbounds } = startFixture();
  await new Promise(done => http.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  let release;
  const configGate = new Promise(done => { release = done; });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem("oc_v5_team_mode", "1"));
    await context.route("**/api/collaboration-config**", async route => {
      if (route.request().method() === "GET") await configGate;
      await route.continue();
    });
    const { page, errors } = await bootPage(context, `http://127.0.0.1:${http.address().port}`, bundle.outputFiles[0].text);
    await page.getByRole("button", { name: /切换智能体/ }).click();
    assert.equal(await page.getByRole("button", { name: /主模型独立完成/ }).getAttribute("aria-pressed"), "true", "a previous account's legacy flag must not select team while GET is pending");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await sendFixtureTurn(page, inbounds, "GET未返回也可发送");
    assert.equal(inbounds.at(-1).collabMode, "solo");
    assert.equal(inbounds.at(-1).teamMode, undefined);
    const loaded = page.waitForResponse(r => r.url().includes("/api/collaboration-config") && r.request().method() === "GET");
    release();
    await loaded;
    await page.getByRole("button", { name: /切换智能体/ }).click();
    assert.equal(await page.getByRole("button", { name: /队长切换为/ }).getAttribute("aria-pressed"), "false");
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    release();
    await browser.close();
    await new Promise(done => http.close(done));
  }
});

test("closing an existing team stays solo on save failure and can persist on explicit retry", { timeout: 180_000 }, async (t) => {
  const bundle = await buildCollabApp();
  for (const status of [409, 503]) await t.test(String(status), async () => {
    const { http, inbounds, sessionCollab, setWriteStatus } = startFixture({ defaultMode: "team" });
    await new Promise(done => http.listen(0, "127.0.0.1", done));
    const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const { page, errors } = await bootPage(context, `http://127.0.0.1:${http.address().port}`, bundle.outputFiles[0].text);
      await page.getByRole("button", { name: "团队模式已开启", exact: true }).waitFor();
      await sendFixtureTurn(page, inbounds, "已有团队会话");
      const sid = inbounds.at(-1).peer.id;
      assert.equal(sessionCollab.get(sid)?.session.mode, "team");
      setWriteStatus(status);
      const rejected = page.waitForResponse(r => r.url().includes("/api/collaboration-config") && r.request().method() === "PUT");
      const reread = status === 409 ? page.waitForResponse(r => r.url().includes("/api/collaboration-config") && r.request().method() === "GET") : null;
      await page.getByRole("button", { name: "团队模式已开启", exact: true }).click();
      await page.getByRole("button", { name: "关闭团队模式", exact: true }).click();
      assert.equal((await rejected).status(), status);
      if (reread) await reread;
      await page.getByRole("button", { name: /切换智能体/ }).click();
      assert.equal(await page.getByRole("button", { name: /主模型独立完成/ }).getAttribute("aria-pressed"), "true", "a failed save or CAS reread must not reopen team");
      // apiErrorMessage deliberately replaces technical English with this user-facing fallback.
      await page.getByRole("dialog").getByText(status === 409 ? /协作配置更新后保存失败/ : /协作配置保存失败/).waitFor();
      setWriteStatus(0);
      const saved = page.waitForResponse(r => r.url().includes("/api/collaboration-config") && r.request().method() === "PUT");
      await page.getByRole("button", { name: /主模型独立完成/ }).click();
      assert.equal((await saved).status(), 200);
      assert.equal(sessionCollab.get(sid)?.session.mode, "solo");
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await sendFixtureTurn(page, inbounds, "关闭团队后续单人");
      assert.equal(inbounds.at(-1).teamMode, undefined);
      assert.equal(inbounds.at(-1).collabMode, "solo");
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
      await new Promise(done => http.close(done));
    }
  });
});

test("solo first send stays queued when session creation fails and reconnect sends it once", { timeout: 120_000 }, async () => {
  const bundle = await buildCollabApp();
  const { http, inbounds, setSessionWriteStatus } = startFixture({ defaultMode: "team" });
  await new Promise(done => http.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await context.addInitScript(() => { window.__realWebSocket = window.WebSocket; window.WebSocket = undefined; });
    const { page, errors } = await bootPage(context, `http://127.0.0.1:${http.address().port}`, bundle.outputFiles[0].text);
    await page.getByRole("button", { name: "团队模式已开启", exact: true }).click();
    await page.getByRole("button", { name: "关闭团队模式", exact: true }).click();
    setSessionWriteStatus(503);
    const text = "session建行失败也必须保留我的首条消息";
    await page.getByPlaceholder(/和「全能助手」对话/).fill(text);
    await clickSend(page);
    await page.getByTestId("queued-send-row").filter({ hasText: text }).waitFor();
    assert.equal(await page.getByRole("button", { name: "团队模式已开启", exact: true }).count(), 0);
    assert.equal(inbounds.length, 0, "offline queue must not pretend the turn reached a server");
    setSessionWriteStatus(0);
    await page.evaluate(() => { window.WebSocket = window.__realWebSocket; window.dispatchEvent(new Event("online")); });
    const frame = await waitUntil(() => inbounds.find(f => f.content?.text === text), 20_000, "queued turn did not flush on reconnect");
    assert.equal(frame.collabMode, "solo");
    assert.equal(frame.teamMode, undefined);
    await fixtureIdle(page);
    await page.getByTestId("message-text").filter({ hasText: text }).waitFor();
    assert.equal(inbounds.filter(f => f.content?.text === text).length, 1);
    assert.equal(await page.getByTestId("queued-send-row").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await new Promise(done => http.close(done));
  }
});

test("first-send cost confirmation keeps the draft and commits solo only after acceptance", { timeout: 120_000 }, async () => {
  const bundle = await buildCollabApp();
  const { http, inbounds, sessionCollab } = startFixture({ defaultMode: "team" });
  await new Promise(done => http.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const { page, errors } = await bootPage(context, origin, bundle.outputFiles[0].text);
    const quotes = [];
    const approvedQuotes = new Set();
    await page.route("**/api/me/sessions/*/model-switch-estimate", async route => {
      const input = route.request().postDataJSON();
      quotes.push(input);
      const scope = JSON.stringify([input.sessionId, input.requestId, input.targetModel,
        input.agentId, input.teamMode === true, input.text, input.mediaCount]);
      if (input.quoteToken === "fixture-quote-615") approvedQuotes.add(scope);
      // The real socket revalidates the acknowledged receipt before dispatch.
      const confirmed = approvedQuotes.has(scope) &&
        (input.quoteToken === "fixture-quote-615" || input.consent === "fixture-consent-615");
      const quote = { ...fixtureSwitchQuote(input, { empty: false, sourceModel: "gpt-6-luna" }),
        requiresConfirmation: !confirmed,
        ...(confirmed ? { consent: "fixture-consent-615" } : { quoteToken: "fixture-quote-615" }),
      };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(quote) });
    });
    await page.getByRole("button", { name: "团队模式已开启", exact: true }).click();
    await page.getByRole("button", { name: "关闭团队模式", exact: true }).click();
    const text = "先确认首轮费用，再按我关闭后的单人模式发送";
    await page.getByPlaceholder(/和「全能助手」对话/).fill(text);
    await clickSend(page);
    const confirm = page.getByRole("dialog");
    await confirm.getByRole("button", { name: "确认切换", exact: true }).waitFor();
    assert.equal(await confirm.count(), 1);
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    assert.equal(inbounds.length, 0, "cancelled cost consent must not send");
    assert.equal(await page.getByTestId("queued-send-row").count(), 0);
    assert.equal(await page.getByPlaceholder(/和「全能助手」对话/).inputValue(), text);
    assert.equal(new URL(page.url()).pathname, "/", "cancelled consent must not promote the draft");
    const cancelledRequestId = quotes[0].requestId;
    await clickSend(page);
    await confirm.getByRole("button", { name: "确认切换", exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    const frame = await waitUntil(() => inbounds.find(f => f.content?.text === text), 20_000, "confirmed cost consent did not send");
    await fixtureIdle(page);
    const accepted = quotes.find(q => q.quoteToken === "fixture-quote-615");
    assert.ok(accepted, "the authoritative confirmation endpoint was called");
    assert.notEqual(accepted.requestId, cancelledRequestId);
    assert.equal(frame.clientMessageId, accepted.requestId);
    assert.equal(frame.modelSwitchConsent, "fixture-consent-615");
    assert.equal(frame.collabMode, "solo");
    assert.equal(frame.teamMode, undefined);
    assert.equal(inbounds.filter(f => f.content?.text === text).length, 1);
    assert.equal(sessionCollab.get(frame.peer.id)?.session.mode, "solo");
    await page.close();
    const reopened = await bootPage(context, origin, bundle.outputFiles[0].text);
    await reopened.page.getByRole("button", { name: new RegExp(text) }).click();
    await reopened.page.getByRole("button", { name: /切换智能体/ }).click();
    assert.equal(await reopened.page.getByRole("button", { name: /主模型独立完成/ }).getAttribute("aria-pressed"), "true");
    assert.deepEqual(errors, []);
    assert.deepEqual(reopened.errors, []);
    await context.close();
  } finally {
    await browser.close();
    await new Promise(done => http.close(done));
  }
});


test("one collaboration conflict saves the clicked solo mode without asking again", { timeout: 120_000 }, async () => {
  const bundle = await buildCollabApp();
  const { http, inbounds, sessionCollab } = startFixture({ defaultMode: "team" });
  await new Promise(done => http.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const { page, errors } = await bootPage(context, `http://127.0.0.1:${http.address().port}`, bundle.outputFiles[0].text);
    await page.getByRole("button", { name: "团队模式已开启", exact: true }).waitFor();
    await sendFixtureTurn(page, inbounds, "冲突前团队会话");
    const sid = inbounds.at(-1).peer.id;
    const puts = [];
    await context.route("**/api/collaboration-config**", async route => {
      if (route.request().method() === "PUT") {
        puts.push(route.request().postDataJSON());
        if (puts.length === 1) {
          const fresh = sessionCollab.get(sid);
          sessionCollab.set(sid, { ...fresh, rev: fresh.rev + 1 });
          await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "conflict" }) });
          return;
        }
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "团队模式已开启", exact: true }).click();
    await page.getByRole("button", { name: "关闭团队模式", exact: true }).click();
    await waitUntil(() => sessionCollab.get(sid)?.session.mode === "solo", 10_000, "clicked mode was not saved after conflict");
    assert.equal(puts.length, 2);
    assert.equal(puts[1].expectedRev, puts[0].expectedRev + 1);
    assert.equal(puts[1].mode, "solo");
    assert.equal(await page.getByText(/再选一次/).count(), 0);
    await sendFixtureTurn(page, inbounds, "冲突后直接发送");
    assert.equal(inbounds.at(-1).collabMode, "solo");
    assert.equal(inbounds.at(-1).teamMode, undefined);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await new Promise(done => http.close(done));
  }
});
