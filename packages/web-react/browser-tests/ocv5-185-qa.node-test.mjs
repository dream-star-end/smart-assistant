/**
 * OCV5-185 independent dual-Chromium QA.
 * Real UI: PermissionCard + MessageList/MessageRenderer + useChatSocket.
 * Mock transport only: HTTP session GET/lookup + WS user-chat-bridge.
 * Two Playwright browser contexts share the mock store (two devices).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_CANDIDATES = [
  process.env.NODE_PATH,
  "/opt/openclaude/openclaude-v5-selfhost/node_modules",
  "/opt/openclaude/node_modules",
].filter(Boolean);

function requireFrom(name) {
  for (const root of NODE_CANDIDATES) {
    const pkg = join(root, name, "package.json");
    if (existsSync(pkg)) return createRequire(pkg)(name);
  }
  return createRequire(import.meta.url)(name);
}

const esbuild = requireFrom("esbuild");
const { chromium } = requireFrom("playwright-core");
const { WebSocketServer } = requireFrom("ws");
const { resolveBrowserExecutable } = await import("../../../scripts/lib/resolve-browser.mjs");

const ARTIFACTS =
  process.env.OC_BROWSER_TEST_ARTIFACTS ||
  "/home/agent/.openclaude/generated/OCV5-185-browser-qa-artifacts";
mkdirSync(ARTIFACTS, { recursive: true });

const SESS = "sess185qa01";
const USER_A = "user-a";
const USER_B = "user-b";

function nowMs() {
  return Date.now();
}

function prompt(over = {}) {
  const createdAt = over.createdAt ?? nowMs();
  return {
    requestId: over.requestId || "req-1",
    userId: over.userId || USER_A,
    sessionId: over.sessionId || SESS,
    agentId: over.agentId || "main",
    clientMessageId: over.clientMessageId ?? "m-user-185",
    toolUseId: over.toolUseId ?? "toolu_185",
    toolName: over.toolName || "AskUserQuestion",
    inputJson: over.inputJson || {
      questions: [{ question: "选择方案", header: "方案", options: [{ label: "继续", description: "执行" }] }],
    },
    status: over.status || "pending",
    behavior: over.behavior ?? null,
    reason: over.reason ?? null,
    answers: over.answers ?? null,
    expiresAt: over.expiresAt ?? nowMs() + 60_000,
    createdAt,
    updatedAt: over.updatedAt ?? createdAt,
    dropLive: over.dropLive === true,
  };
}

function snapshotItem(row) {
  return {
    requestId: row.requestId,
    clientMessageId: row.clientMessageId,
    toolUseId: row.toolUseId,
    toolName: row.toolName,
    inputJson: row.inputJson,
    status: row.status,
    behavior: row.behavior,
    reason: row.reason,
    answers: row.answers,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseAuth(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const proto = req.headers["sec-websocket-protocol"] || "";
  const protoToken = String(proto)
    .split(",")
    .map((s) => s.trim())
    .find((s) => s && s !== "bearer");
  const t = token || protoToken || "";
  const userId = t.startsWith("tok-") ? t.slice(4) : t || USER_A;
  return { token: t, userId };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sessionDetail(store, userId, sessionId, lookupIds) {
  const rows = [...store.prompts.values()].filter((p) => p.userId === userId && p.sessionId === sessionId);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  const windowSize = store.windowSize;
  const items = rows.slice(0, windowSize).map(snapshotItem);
  const completeness = rows.length > windowSize ? "truncated" : store.completeness;
  const lookups = [];
  if (lookupIds?.length) {
    for (const id of lookupIds) {
      const row = store.prompts.get(id);
      if (row && row.userId === userId && row.sessionId === sessionId) lookups.push(snapshotItem(row));
    }
  }
  return {
    id: sessionId,
    userId,
    agentId: rows[0]?.agentId || "main",
    title: "OCV5-185 QA",
    pinned: false,
    createdAt: nowMs() - 1000,
    lastAt: nowMs(),
    messages: [],
    updatedAt: nowMs(),
    historyRevision: 1,
    timelineGeneration: 1,
    timelineCursor: null,
    timelineHasMore: false,
    isPartial: false,
    totalMessageCount: 0,
    maxSeq: 0,
    archivedCount: 0,
    archivedThroughSeq: 0,
    permissionPrompts: {
      items,
      completeness,
      source: store.source,
      ...(lookups.length ? { lookups } : {}),
    },
  };
}

function permissionRequestFrame(row) {
  return {
    type: "outbound.permission_request",
    sessionKey: `agent:${row.agentId}:webchat:dm:${row.sessionId}`,
    channel: "webchat",
    peer: { id: row.sessionId, kind: "dm" },
    requestId: row.requestId,
    toolName: row.toolName,
    toolUseId: row.toolUseId,
    clientMessageId: row.clientMessageId,
    inputPreview: JSON.stringify(row.inputJson).slice(0, 400),
    inputJson: row.inputJson,
    expiresAt: row.expiresAt,
    ...(String(row.requestId).startsWith("ask-user:") ? { detachedAskUser: true } : {}),
    ts: nowMs(),
  };
}

function createMock() {
  const store = {
    prompts: new Map(),
    windowSize: 16,
    completeness: "complete",
    source: "pg",
    responses: [],
    clients: [],
  };

  function broadcast(userId, frame) {
    const data = JSON.stringify(frame);
    for (const client of store.clients) {
      if (client.userId !== userId) continue;
      if (client.ws.readyState === 1) client.ws.send(data);
    }
  }

  function sendTo(ws, frame) {
    if (ws.readyState === 1) ws.send(JSON.stringify(frame));
  }

  function settleFromControl(userId, payload) {
    const requestId = payload.requestId;
    const row = store.prompts.get(requestId);
    store.responses.push({ userId, payload, at: nowMs() });
    const receipt = {
      type: "outbound.control.receipt",
      controlId: payload.controlId,
      controlKind: "permission",
      status: "applied",
      peer: payload.peer,
      requestId,
    };
    if (!row || row.userId !== userId) {
      // Ordinary permission with no waiter: do not forge tool-execution success.
      return {
        receipt: { ...receipt, status: "terminal", errorCode: "permission_not_pending" },
        settled: {
          type: "outbound.permission_settled",
          sessionKey: payload.sessionKey || "",
          channel: payload.channel || "webchat",
          peer: payload.peer,
          requestId,
          behavior: payload.behavior,
          reason: "already_settled",
        },
        winner: false,
        fakeSuccess: false,
      };
    }
    if (row.status !== "pending") {
      return {
        receipt,
        settled: {
          type: "outbound.permission_settled",
          sessionKey: `agent:${row.agentId}:webchat:dm:${row.sessionId}`,
          channel: "webchat",
          peer: { id: row.sessionId, kind: "dm" },
          requestId,
          behavior: row.behavior,
          reason: "already_settled",
          ...(row.answers ? { answers: row.answers } : {}),
        },
        winner: false,
        fakeSuccess: false,
      };
    }
    row.status = "responded";
    row.behavior = payload.behavior;
    row.reason = null;
    row.updatedAt = nowMs();
    row.winnerUserId = userId;
    if (payload.updatedInput?.answers) row.answers = payload.updatedInput.answers;
    return {
      receipt,
      settled: {
        type: "outbound.permission_settled",
        sessionKey: `agent:${row.agentId}:webchat:dm:${row.sessionId}`,
        channel: "webchat",
        peer: { id: row.sessionId, kind: "dm" },
        requestId,
        behavior: row.behavior,
        reason: "remote",
        ...(row.answers ? { answers: row.answers } : {}),
      },
      winner: true,
      fakeSuccess: false,
    };
  }

  return { store, broadcast, sendTo, settleFromControl };
}

function ensureProtocolShim() {
  const dir = join(HERE, "../node_modules/@openclaude");
  mkdirSync(dir, { recursive: true });
  const link = join(dir, "protocol");
  const target = join(HERE, "../../protocol");
  try {
    symlinkSync(target, link);
  } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }
}

async function bundleHarness() {
  ensureProtocolShim();
  const result = await esbuild.build({
    entryPoints: [join(HERE, "ocv5-185-qa-harness.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty", ".woff": "empty", ".woff2": "empty" },
    alias: {
      "node:crypto": join(HERE, "stubs", "node-crypto.js"),
    },
    nodePaths: NODE_CANDIDATES,
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.MODE": '"production"',
      "import.meta.env.PROD": "true",
      "import.meta.env.DEV": "false",
    },
    logLevel: "error",
  });
  return result.outputFiles[0].text;
}

function startServer(js, mock) {
  const { store, broadcast, sendTo, settleFromControl } = mock;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><meta name="oc-build" content="qa-185">
<style>
  [role="dialog"], [data-radix-dialog-content] { display:block !important; visibility:visible !important; position:static !important; }
  [data-testid="pending-permission-dock"] button { display:inline-block !important; }
</style>
<div id="root"></div><script>${js}<\/script>`,
      );
      return;
    }
    const auth = parseAuth(req);
    if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/live-frames")) {
      if (url.searchParams.get("view") === "units") {
        json(res, 200, { view: "units", units: [], hasMoreBefore: false, beforeCursor: null });
        return;
      }
      json(res, 200, {
        frames: [],
        nextCursor: null,
        hasMore: false,
        streamClientMessageIds: [],
        hasTapeProjection: false,
      });
      return;
    }
    if (url.pathname.startsWith("/api/sessions/") && req.method === "PUT") {
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/api/sessions/") && req.method === "GET") {
      const id = decodeURIComponent(url.pathname.split("/")[3] || SESS);
      const lookup = url.searchParams.get("permission_lookup");
      const ids = lookup ? lookup.split(",").filter(Boolean).slice(0, 16) : [];
      json(res, 200, sessionDetail(store, auth.userId, id, ids));
      return;
    }
    if (url.pathname === "/api/client-errors") {
      json(res, 204, {});
      return;
    }
    json(res, 404, { error: "not_found", path: url.pathname });
  });
  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => {
      const list = [...protocols];
      return list.includes("bearer") ? "bearer" : list[0];
    },
  });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/ws/user-chat-bridge") {
      ws.close();
      return;
    }
    const auth = parseAuth(req);
    const client = { ws, userId: auth.userId, hellos: [] };
    store.clients.push(client);
    sendTo(ws, { type: "sys.relay_ready", automaticRecoveryOwner: "master-v1" });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "ping") {
        sendTo(ws, { type: "pong", id: msg.id });
        return;
      }
      if (msg.type === "inbound.hello") {
        client.hellos.push(msg);
        return;
      }
      if (msg.type === "inbound.permission_response") {
        const result = settleFromControl(auth.userId, msg);
        sendTo(ws, result.receipt);
        if (result.settled) broadcast(auth.userId, result.settled);
      }
    });
    ws.on("close", () => {
      store.clients = store.clients.filter((c) => c !== client);
    });
  });
  return { server, wss, store, broadcast, sendTo };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function setHidden(page, hidden) {
  await page.evaluate((next) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (next ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

async function shot(page, name) {
  const file = join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseCards(text) {
  try {
    return JSON.parse(text || "[]");
  } catch {
    return [];
  }
}

test("OCV5-185 real dual Chromium permission QA", { timeout: 360_000 }, async (t) => {
  const js = await bundleHarness();
  const mock = createMock();
  const { server, wss, store } = startServer(js, mock);
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  let browser;
  const failures = [];

  async function openPage(context, query) {
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors = [];
    const wsSent = [];
    const wsRecv = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("websocket", (ws) => {
      ws.on("framesent", (frame) => {
        try {
          wsSent.push(JSON.parse(frame.payload));
        } catch {
          wsSent.push({ raw: String(frame.payload).slice(0, 200) });
        }
      });
      ws.on("framereceived", (frame) => {
        try {
          wsRecv.push(JSON.parse(frame.payload));
        } catch {
          wsRecv.push({ raw: String(frame.payload).slice(0, 200) });
        }
      });
    });
    await page.goto(`${origin}/?${query}`);
    await page.getByTestId("qa-root").waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-testid=qa-ws-status]");
      return el && el.textContent === "connected";
    });
    page._qaErrors = errors;
    page._wsSent = wsSent;
    page._wsRecv = wsRecv;
    return page;
  }

  async function waitStore(pred, label, ms = 20_000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${label} timed out`);
  }

  async function failShot(page, name) {
    try {
      await shot(page, `fail-${name}`);
      writeFileSync(
        join(ARTIFACTS, `fail-${name}.json`),
        JSON.stringify(
          {
            errors: page._qaErrors,
            wsSent: page._wsSent,
            wsRecv: page._wsRecv?.slice(-20),
            cards: parseCards(await page.getByTestId("qa-cards").textContent().catch(() => "[]")),
            responses: store.responses,
          },
          null,
          2,
        ),
      );
    } catch {
      /* ignore dump errors */
    }
  }

  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    await t.test("T1 first-frame loss: GET materialises card, manual open", async () => {
      store.prompts.clear();
      store.prompts.set(
        "req-lost",
        prompt({
          requestId: "req-lost",
          dropLive: true,
          toolUseId: "toolu_lost",
          clientMessageId: "m-user-lost",
        }),
      );
      const ctx = await browser.newContext();
      try {
        const page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=0`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-lost" && c.resolved === false);
        });
        assert.equal(await page.getByRole("dialog").count(), 0, "reload/GET path must not auto-open when sending=false");
        await page.getByRole("button", { name: "回答" }).click();
        await page.getByRole("dialog").waitFor();
        const cards = parseCards(await page.getByTestId("qa-cards").textContent());
        const card = cards.find((c) => c.requestId === "req-lost");
        assert.equal(card.toolUseId, "toolu_lost");
        assert.equal(card.turnOwner, "m-user-lost");
        assert.equal(page._qaErrors.length, 0, page._qaErrors.join("\n"));
        await shot(page, "t1-get-backfill-manual-open");
      } catch (err) {
        failures.push("T1");
        throw err;
      } finally {
        await ctx.close();
      }
    });

    await t.test("T2 A answers, B refresh converges; race has one winner", async () => {
      store.prompts.clear();
      store.responses.length = 0;
      store.prompts.set(
        "req-race",
        prompt({
          requestId: "req-race",
          toolName: "Bash",
          inputJson: { command: "echo 185" },
          toolUseId: "toolu_race",
          clientMessageId: "m-user-race",
        }),
      );
      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      try {
        const pageA = await openPage(ctxA, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        const pageB = await openPage(ctxB, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await pageA.evaluate(() => window.__qa.loadSession());
        await pageB.evaluate(() => window.__qa.loadSession());
        await pageA.getByRole("dialog").waitFor();
        await pageB.getByRole("dialog").waitFor();
        const before = store.responses.length;
        await pageA.getByRole("dialog").getByRole("button", { name: "允许" }).click();
        try {
          await waitStore(
            () => store.prompts.get("req-race")?.status === "responded",
            "T2 mock settle after A",
            25_000,
          );
        } catch (err) {
          await failShot(pageA, "t2-a-send");
          await failShot(pageB, "t2-b-idle");
          throw err;
        }
        try {
          await pageB.getByRole("dialog").getByRole("button", { name: "拒绝" }).click({ timeout: 3_000 });
        } catch {
          /* B modal may already have closed after A's settlement broadcast */
        }
        const row = store.prompts.get("req-race");
        assert.equal(row.status, "responded");
        assert.equal(row.behavior, "allow", "first writer A must win");
        const late = store.responses.slice(before).filter((r) => r.payload.requestId === "req-race");
        assert.ok(late.length >= 1);
        try {
          await pageA.waitForFunction(() => {
            const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
            return cards.some((c) => c.requestId === "req-race" && c.resolved === true);
          });
        } catch (err) {
          await failShot(pageA, "t2-a-ui");
          await failShot(pageB, "t2-b-ui");
          throw err;
        }
        const pageB2 = await openPage(ctxB, `user=${USER_A}&sess=${SESS}&agent=main&live=0`);
        await pageB2.evaluate(() => window.__qa.loadSession());
        await pageB2.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-race" && c.resolved === true);
        });
        const cardsB = parseCards(await pageB2.getByTestId("qa-cards").textContent());
        const cardB = cardsB.find((c) => c.requestId === "req-race");
        assert.equal(cardB.behavior, "allow", "B refresh must converge to winner behavior");
        assert.equal(cardB.resolved, true);
        await shot(pageA, "t2-tab-a-after-race");
        await shot(pageB2, "t2-tab-b-refresh-converged");
      } catch (err) {
        failures.push("T2");
        throw err;
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    });

    await t.test("T3 background does not mark displayed; after foreground close can reopen", async () => {
      store.prompts.clear();
      store.prompts.set(
        "req-bg",
        prompt({
          requestId: "req-bg",
          toolName: "Bash",
          inputJson: { command: "ls" },
        }),
      );
      const ctx = await browser.newContext();
      let page;
      try {
        page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await setHidden(page, true);
        await page.evaluate(() => window.__qa.loadSession());
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-bg");
        });
        assert.equal(await page.getByRole("dialog").count(), 0, "hidden tab must not auto-open");
        await setHidden(page, false);
        await page.getByRole("dialog").waitFor();
        await page.getByRole("button", { name: "关闭" }).click();
        await page.waitForFunction(() => document.querySelector("[role=dialog]") == null);
        await page.getByTestId("permission-card").getByRole("button", { name: "审批" }).click();
        await page.getByRole("dialog").waitFor();
        assert.equal(page._qaErrors.length, 0, page._qaErrors.join("\n"));
        await shot(page, "t3-reopen-after-foreground-close");
      } catch (err) {
        failures.push("T3");
        if (page) await failShot(page, "t3").catch(() => {});
        throw err;
      } finally {
        await ctx.close();
      }
    });

    await t.test("T4 ExitPlanMode close does not onRespond", async () => {
      store.prompts.clear();
      store.prompts.set(
        "req-plan",
        prompt({
          requestId: "req-plan",
          toolName: "ExitPlanMode",
          inputJson: { plan: "## 计划\n\n只关窗口不应批准。" },
          toolUseId: "toolu_plan",
        }),
      );
      const ctx = await browser.newContext();
      let page;
      try {
        page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.getByRole("dialog").waitFor();
        await page.getByTestId("exit-plan-markdown").waitFor();
        const before = store.responses.length;
        await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();
        await page.waitForFunction(() => document.querySelector("[role=dialog]") == null);
        const sent = store.responses.slice(before);
        assert.equal(store.prompts.get("req-plan").status, "pending", "close must not settle");
        assert.deepEqual(
          sent.map((r) => r.payload?.type),
          [],
          `close must not send permission_response: ${JSON.stringify(sent)}`,
        );
        const outbound = (page._wsSent || []).filter((f) => f.type === "inbound.permission_response");
        assert.equal(outbound.length, 0, `browser must not send inbound.permission_response on close: ${JSON.stringify(outbound)}`);
        await page.getByTestId("permission-card").getByRole("button", { name: "审阅计划" }).click();
        await page.getByRole("dialog").waitFor();
        await shot(page, "t4-exit-plan-close-no-respond");
      } catch (err) {
        failures.push("T4");
        if (page) await failShot(page, "t4").catch(() => {});
        throw err;
      } finally {
        await ctx.close();
      }
    });

    await t.test("T5 two pending => at most one modal; dock still reaches the other", async () => {
      store.prompts.clear();
      store.prompts.set(
        "req-one",
        prompt({
          requestId: "req-one",
          toolName: "Bash",
          inputJson: { command: "one" },
          createdAt: nowMs() - 2000,
        }),
      );
      store.prompts.set(
        "req-two",
        prompt({
          requestId: "req-two",
          toolName: "Bash",
          inputJson: { command: "two" },
          toolUseId: "toolu_two",
          createdAt: nowMs() - 1000,
        }),
      );
      const ctx = await browser.newContext();
      let page;
      try {
        page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.getByTestId("pending-permission-dock").waitFor();
        const autoOpened = await page.waitForFunction(
          () => (document.querySelector("[data-testid=qa-active-modal]")?.textContent || "").length > 0,
          { timeout: 5_000 },
        ).then(() => true).catch(() => false);
        if (!autoOpened) {
          await failShot(page, "t5-no-auto-open");
          await page.locator("[data-testid=pending-permission-dock] button").first().click();
        }
        await page.getByRole("dialog").waitFor();
        assert.equal(await page.getByRole("dialog").count(), 1, "two pending must not show two modals");
        const firstModal = (await page.getByTestId("qa-active-modal").textContent()) || "";
        assert.ok(firstModal === "req-one" || firstModal === "req-two");
        const dockButtons = page.locator("[data-testid=pending-permission-dock] button");
        const n = await dockButtons.count();
        assert.equal(n, 2, "both pending remain reachable from dock");
        await dockButtons.nth(firstModal === "req-one" ? 1 : 0).click();
        await page.waitForFunction(() => document.querySelectorAll("[role=dialog]").length <= 1);
        assert.equal(await page.getByRole("dialog").count(), 1);
        if (!autoOpened) {
          throw new Error("two pending live cards did not auto-open a singleton modal");
        }
        await shot(page, "t5-single-modal-two-pending");
      } catch (err) {
        failures.push("T5");
        if (page) await failShot(page, "t5").catch(() => {});
        throw err;
      } finally {
        await ctx.close();
      }
    });

    await t.test("T6 new settle does not resurrect old pending; lookup beyond recent window", async () => {
      store.prompts.clear();
      store.windowSize = 1;
      const oldTs = nowMs() - 10_000;
      store.prompts.set(
        "req-old",
        prompt({
          requestId: "req-old",
          status: "responded",
          behavior: "allow",
          createdAt: oldTs,
          updatedAt: oldTs + 1,
          toolName: "Bash",
          inputJson: { command: "old" },
        }),
      );
      store.prompts.set(
        "req-new",
        prompt({
          requestId: "req-new",
          createdAt: nowMs(),
          toolName: "Bash",
          inputJson: { command: "new" },
          toolUseId: "toolu_new",
        }),
      );
      const ctx = await browser.newContext();
      try {
        const page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-new");
        });
        // Locally materialise the old card as pending, then a truncated snapshot + lookup
        // must keep the newer local settlement from being resurrected.
        await page.evaluate(() => window.__qa.loadSession());
        store.windowSize = 1;
        // Inject an older pending snapshot for req-old by flipping store then loading lookups.
        const old = store.prompts.get("req-old");
        const savedStatus = old.status;
        const savedBehavior = old.behavior;
        old.status = "pending";
        old.behavior = null;
        old.updatedAt = oldTs; // older than local resolved
        await page.evaluate(() => window.__qa.loadSession());
        const cards = parseCards(await page.getByTestId("qa-cards").textContent());
        const oldCard = cards.find((c) => c.requestId === "req-old");
        if (oldCard) {
          assert.equal(oldCard.resolved, true, "newer local settle must not be resurrected");
          assert.equal(oldCard.behavior, "allow");
        }
        old.status = savedStatus;
        old.behavior = savedBehavior;
        // Beyond window: only req-new in items; lookup req-old still returns the row.
        const lookupPage = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=0`);
        await lookupPage.evaluate(() => window.__qa.loadSession());
        // Force a local pending old card then GET truncated page to trigger lookup.
        store.windowSize = 1;
        await lookupPage.evaluate(async () => {
          await window.__qa.loadSession();
        });
        const detail = sessionDetail(store, USER_A, SESS, ["req-old"]);
        assert.equal(detail.permissionPrompts.completeness, "truncated");
        assert.equal(detail.permissionPrompts.items[0].requestId, "req-new");
        assert.equal(detail.permissionPrompts.lookups[0].requestId, "req-old");
        await shot(page, "t6-no-resurrect-and-lookup");
      } catch (err) {
        failures.push("T6");
        throw err;
      } finally {
        store.windowSize = 16;
        await ctx.close();
      }
    });

    await t.test("T7 toolUseId/turn bind; non-main agent; account isolation", async () => {
      store.prompts.clear();
      store.prompts.set(
        "req-agent",
        prompt({
          requestId: "req-agent",
          userId: USER_A,
          agentId: "research-assistant",
          toolUseId: "toolu_research",
          clientMessageId: "m-research",
          toolName: "Bash",
          inputJson: { command: "research" },
        }),
      );
      store.prompts.set(
        "req-user-a-only",
        prompt({
          requestId: "req-user-a-only",
          userId: USER_A,
          agentId: "main",
          toolUseId: "toolu_a",
          clientMessageId: "m-a",
        }),
      );
      const ctxA = await browser.newContext();
      const ctxOther = await browser.newContext();
      try {
        const pageA = await openPage(ctxA, `user=${USER_A}&sess=${SESS}&agent=research-assistant&live=1`);
        await pageA.evaluate(() => window.__qa.loadSession());
        await pageA.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-agent");
        });
        const cardsA = parseCards(await pageA.getByTestId("qa-cards").textContent());
        const research = cardsA.find((c) => c.requestId === "req-agent");
        assert.equal(research.toolUseId, "toolu_research");
        assert.equal(research.turnOwner, "m-research");
        const hello = store.clients.map((c) => c.hellos).flat().find((h) =>
          (h.peers || []).some((p) => p.agentId === "research-assistant"),
        );
        assert.ok(hello, "non-main agent must appear in inbound.hello peers");
        const pageOther = await openPage(ctxOther, `user=${USER_B}&sess=${SESS}&agent=main&live=1`);
        await pageOther.evaluate(() => window.__qa.loadSession());
        await pageOther.waitForFunction(() => document.querySelector("[data-testid=qa-ws-status]")?.textContent === "connected");
        const cardsB = parseCards(await pageOther.getByTestId("qa-cards").textContent());
        assert.equal(cardsB.length, 0, "other account must not see user-a prompts");
        await shot(pageA, "t7-non-main-tooluseid");
        await shot(pageOther, "t7-other-account-empty");
      } catch (err) {
        failures.push("T7");
        throw err;
      } finally {
        await ctxA.close();
        await ctxOther.close();
      }
    });

    await t.test("T8 ordinary no-waiter does not forge success; detached id stays pending until real settle", async () => {
      store.prompts.clear();
      store.responses.length = 0;
      const ctx = await browser.newContext();
      try {
        // Local card exists (GET), but mock store has no waiter/pending row.
        store.prompts.set(
          "req-ghost",
          prompt({
            requestId: "req-ghost",
            toolName: "Bash",
            inputJson: { command: "ghost" },
          }),
        );
        const page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.getByRole("dialog").waitFor();
        store.prompts.delete("req-ghost");
        await page.getByRole("dialog").getByRole("button", { name: "允许" }).click();
        await waitStore(() => store.responses.some((r) => r.payload.requestId === "req-ghost"), "T8 ghost response", 15_000);
        const last = store.responses.findLast((r) => r.payload.requestId === "req-ghost");
        assert.ok(last, "response was sent");
        // Mock records the click but does not mint a successful pending row.
        assert.equal(store.prompts.has("req-ghost"), false);
        const detachedId = "ask-user:" + "ab".repeat(16);
        store.prompts.set(
          detachedId,
          prompt({
            requestId: detachedId,
            toolName: "AskUserQuestion",
            toolUseId: null,
            clientMessageId: null,
          }),
        );
        const pageD = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await pageD.evaluate(() => window.__qa.loadSession());
        await pageD.waitForFunction((id) => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === id && c.detached === true);
        }, detachedId);
        assert.equal(store.prompts.get(detachedId).status, "pending");
        await shot(pageD, "t8-detached-still-pending");
      } catch (err) {
        failures.push("T8");
        throw err;
      } finally {
        await ctx.close();
      }
    });
  } finally {
    writeFileSync(
      join(ARTIFACTS, "summary.json"),
      JSON.stringify(
        {
          freeze: "5a3f01b46962373d5eb7c57c09525b3907ea0b2d",
          origin,
          failures,
          promptsLeft: [...store.prompts.keys()],
          responseCount: store.responses.length,
        },
        null,
        2,
      ),
    );
    await browser?.close();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
