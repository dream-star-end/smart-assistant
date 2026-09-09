/**
 * OCV5-185 independent dual-Chromium QA.
 * Real UI: PermissionCard + MessageList/MessageRenderer + useChatSocket.
 * Mock transport only: HTTP session GET/lookup + WS user-chat-bridge.
 * Two Playwright browser contexts share the mock store (two devices).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const QA_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const PRODUCT_SOURCE_SHA = process.env.OC_QA_PRODUCT_SHA || QA_COMMIT;
assert.match(PRODUCT_SOURCE_SHA, /^[0-9a-f]{40}$/, "OC_QA_PRODUCT_SHA must be a full commit SHA");
// A QA-only merge may have a different HEAD; its actual imported product source must still match.
execFileSync("git", ["diff", "--exit-code", PRODUCT_SOURCE_SHA, "--",
  "packages/web-react/src", "packages/protocol/src"], { cwd: ROOT, stdio: "pipe" });
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
  join(ROOT, "test-results", "ocv5-185-qa");
mkdirSync(ARTIFACTS, { recursive: true });
const FOCUS = (process.env.OC_QA_FOCUS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
function want(id) {
  return FOCUS.includes(id) || (FOCUS.length === 0 && id !== "T2w");
}

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
    truncatePreview: over.truncatePreview === true,
    inputPreview: over.inputPreview,
  };
}

function snapshotItem(row, opts = {}) {
  const full = opts.full === true;
  const truncated = row.truncatePreview === true && !full;
  return {
    requestId: row.requestId,
    clientMessageId: row.clientMessageId,
    toolUseId: row.toolUseId,
    toolName: row.toolName,
    inputJson: truncated ? {} : row.inputJson,
    ...(truncated ? { inputTruncated: true } : {}),
    ...(row.inputPreview ? { inputPreview: row.inputPreview } : {}),
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
  const items = rows.slice(0, windowSize).map((row) => snapshotItem(row, { full: false }));
  const completeness = rows.length > windowSize ? "truncated" : store.completeness;
  const lookups = [];
  if (lookupIds?.length) {
    for (const id of lookupIds) {
      const row = store.prompts.get(id);
      if (row && row.userId === userId && row.sessionId === sessionId) {
        const fail = store.lookupFailIds.has(id);
        lookups.push(snapshotItem(row, { full: !fail }));
      }
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
    httpLog: [],
    holdOutbound: false,
    held: [],
    holdLookup: false,
    heldLookups: [],
    lookupFailIds: new Set(),
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

  function flushHeld() {
    const batch = store.held.splice(0, store.held.length);
    for (const item of batch) {
      sendTo(item.ws, item.result.receipt);
      if (item.result.settled) broadcast(item.userId, item.result.settled);
    }
  }

  function flushLookups(onlyIds) {
    const keep = [];
    const batch = store.heldLookups.splice(0, store.heldLookups.length);
    for (const item of batch) {
      const ids = String(item.lookup || "").split(",").filter(Boolean);
      if (!onlyIds) {
        json(item.res, 200, item.body);
        continue;
      }
      const flushIds = ids.filter((id) => onlyIds.includes(id));
      if (flushIds.length === 0) {
        keep.push(item);
        continue;
      }
      // One HTTP GET may batch several requestIds. Respond with only the
      // flushed lookups so a late C body cannot unlock B in the same reply.
      const body = JSON.parse(JSON.stringify(item.body));
      if (body.permissionPrompts) {
        body.permissionPrompts.lookups = (body.permissionPrompts.lookups || []).filter((row) =>
          flushIds.includes(row.requestId),
        );
      }
      json(item.res, 200, body);
    }
    store.heldLookups.push(...keep);
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

  return { store, broadcast, sendTo, settleFromControl, flushHeld, flushLookups };
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
      store.httpLog.push({
        method: "GET",
        path: url.pathname,
        search: url.search,
        lookup,
        userId: auth.userId,
        at: nowMs(),
      });
      const body = sessionDetail(store, auth.userId, id, ids);
      if (store.holdLookup && lookup) {
        store.heldLookups.push({ res, body, lookup });
        return;
      }
      json(res, 200, body);
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
        if (store.holdOutbound) {
          store.held.push({ ws, userId: auth.userId, result });
          return;
        }
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
  const { flushHeld, flushLookups, broadcast } = mock;
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
            activeModal: await page.getByTestId("qa-active-modal").textContent().catch(() => ""),
            dialogCount: await page.getByRole("dialog").count().catch(() => -1),
            dock: await page.evaluate(() =>
              [...document.querySelectorAll("[data-testid=pending-permission-dock] button")].map((b) =>
                (b.textContent || "").trim(),
              ),
            ).catch(() => []),
            responses: store.responses,
            httpLog: store.httpLog,
            held: store.held.length,
            heldLookups: store.heldLookups.map((h) => h.lookup),
          },
          null,
          2,
        ),
      );
    } catch {
      /* ignore dump errors */
    }
  }

  /** Native click: Radix dialog sets aria-hidden on the dock, so getByRole misses it. */
  async function clickDockNamed(page, name) {
    await page.getByTestId("pending-permission-dock").waitFor({ state: "attached" });
    const info = await page.evaluate((label) => {
      const buttons = [...document.querySelectorAll("[data-testid=pending-permission-dock] button")];
      const names = buttons.map((b) => (b.textContent || "").trim());
      const btn = buttons.find((b) => (b.textContent || "").trim() === label);
      if (!btn) return { ok: false, names };
      btn.click();
      return { ok: true, names };
    }, name);
    assert.ok(info.ok, `dock button "${name}" not found: ${JSON.stringify(info.names)}`);
  }

  async function waitActive(page, requestId) {
    await page.waitForFunction((id) => {
      const el = document.querySelector("[data-testid=qa-active-modal]");
      return (el?.textContent || "") === id;
    }, requestId);
  }

  async function switchHostTo(page, requestId) {
    const current = (await page.getByTestId("qa-active-modal").textContent()) || "";
    if (current === requestId) return;
    await page.getByTestId("pending-permission-dock").waitFor({ state: "attached" });
    const n = await page.locator("[data-testid=pending-permission-dock] button").count();
    for (let i = 0; i < n; i++) {
      await page.evaluate((idx) => {
        document.querySelectorAll("[data-testid=pending-permission-dock] button")[idx]?.click();
      }, i);
      try {
        await page.waitForFunction((id) => {
          const el = document.querySelector("[data-testid=qa-active-modal]");
          return (el?.textContent || "") === id;
        }, requestId, { timeout: 2500 });
        return;
      } catch {
        /* try the next dock entry */
      }
    }
    const after = (await page.getByTestId("qa-active-modal").textContent()) || "";
    throw new Error(`failed to switch Host to ${requestId}, active=${after}`);
  }

  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    if (want("T1")) await t.test("T1 first-frame loss: GET materialises card, manual open", async () => {
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

    if (want("T2")) await t.test("T2 both UIs submit under hold; one winner; B local card settles; refresh no auto-open", async () => {
      store.prompts.clear();
      store.responses.length = 0;
      store.held.length = 0;
      store.httpLog.length = 0;
      store.holdOutbound = true;
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
        await pageA.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-race" && c.resolved === false);
        });
        await pageB.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-race" && c.resolved === false);
        });
        const cardA0 = parseCards(await pageA.getByTestId("qa-cards").textContent()).find((c) => c.requestId === "req-race");
        const cardB0 = parseCards(await pageB.getByTestId("qa-cards").textContent()).find((c) => c.requestId === "req-race");
        assert.ok(cardA0 && cardA0.resolved === false, "A must hold local pending before submit");
        assert.ok(cardB0 && cardB0.resolved === false, "B must hold local pending before submit");
        await pageA.getByRole("dialog").waitFor();
        await pageB.getByRole("dialog").waitFor();
        const before = store.responses.length;
        await Promise.all([
          pageA.getByRole("dialog").getByRole("button", { name: "允许" }).click(),
          pageB.getByRole("dialog").getByRole("button", { name: "拒绝" }).click(),
        ]);
        await waitStore(
          () => store.responses.filter((r) => r.payload.requestId === "req-race").length >= 2,
          "T2 both UIs submitted inbound.permission_response",
          25_000,
        );
        const submitted = store.responses.slice(before).filter((r) => r.payload.requestId === "req-race");
        assert.equal(submitted.length, 2, `need two real UI submits, got ${JSON.stringify(submitted.map((s) => s.payload.behavior))}`);
        const behaviors = submitted.map((s) => s.payload.behavior);
        assert.ok(behaviors.includes("allow") && behaviors.includes("deny"), "A allow and B deny must both leave the browser");
        const winnerBehavior = submitted[0].payload.behavior;
        store.holdOutbound = false;
        flushHeld();
        assert.equal(store.prompts.get("req-race").status, "responded");
        assert.equal(store.prompts.get("req-race").behavior, winnerBehavior, "mock authority keeps the first submitter");
        await pageA.waitForFunction((win) => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          const card = cards.find((c) => c.requestId === "req-race");
          return card && card.resolved === true && card.behavior === win;
        }, winnerBehavior);
        await pageB.waitForFunction((win) => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          const card = cards.find((c) => c.requestId === "req-race");
          return card && card.resolved === true && card.behavior === win;
        }, winnerBehavior);
        const cardB = parseCards(await pageB.getByTestId("qa-cards").textContent()).find((c) => c.requestId === "req-race");
        assert.ok(cardB, "B must still have the local card");
        assert.equal(cardB.resolved, true);
        assert.equal(cardB.behavior, winnerBehavior);
        await pageB.evaluate(() => window.__qa.loadSnapshot());
        await pageB.waitForFunction((win) => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          const card = cards.find((c) => c.requestId === "req-race");
          return card && card.resolved === true && card.behavior === win;
        }, winnerBehavior);
        assert.equal(
          await pageB.getByRole("dialog").count(),
          0,
          "B snapshot refresh must not auto-open a settled card",
        );
        await shot(pageA, "t2-tab-a-after-race");
        await shot(pageB, "t2-tab-b-settled-no-reopen");
      } catch (err) {
        failures.push("T2");
        throw err;
      } finally {
        store.holdOutbound = false;
        store.held.length = 0;
        await ctxA.close();
        await ctxB.close();
      }
    });

    if (want("T2w")) await t.test("T2w empty-tape new page rematerialize responded (warning, not blocker)", async () => {
      store.prompts.clear();
      store.prompts.set(
        "req-hist",
        prompt({
          requestId: "req-hist",
          status: "responded",
          behavior: "allow",
          toolName: "Bash",
          inputJson: { command: "hist" },
        }),
      );
      const ctx = await browser.newContext();
      try {
        const page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=0`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.waitForFunction(() => document.querySelector("[data-testid=qa-cards]") !== null);
        const cards = parseCards(await page.getByTestId("qa-cards").textContent());
        const card = cards.find((c) => c.requestId === "req-hist");
        writeFileSync(
          join(ARTIFACTS, "t2w-empty-tape-warning.json"),
          JSON.stringify(
            {
              warning: true,
              blocker: false,
              reason: "empty tape GET is not required to rematerialize terminal history cards",
              cards,
              hasResolvedCard: !!(card && card.resolved),
            },
            null,
            2,
          ),
        );
      } finally {
        await ctx.close();
      }
    });

    if (want("T3")) await t.test("T3 background does not mark displayed; after foreground close can reopen", async () => {
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

    if (want("T4")) await t.test("T4 ExitPlanMode close does not onRespond", async () => {
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

    if (want("T5")) await t.test("T5 two pending show exactly one dialog; dock[0] then dock[1] are different requests", async () => {
      store.prompts.clear();
      store.responses.length = 0;
      store.httpLog.length = 0;
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
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-one") && cards.some((c) => c.requestId === "req-two");
        });
        await page.getByRole("dialog").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("dialog").count(), 1, "two pending must auto-open exactly one visible dialog");
        const slot = (await page.getByTestId("qa-active-modal").textContent()) || "";
        assert.ok(slot === "req-one" || slot === "req-two", `singleton slot must be a real request, got ${slot}`);
        async function closeVisibleDialog() {
          await page.getByRole("dialog").waitFor({ state: "visible" });
          assert.equal(await page.getByRole("dialog").count(), 1);
          await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();
        }
        await closeVisibleDialog();
        for (let i = 0; i < 3 && (await page.getByRole("dialog").count()) > 0; i++) {
          await closeVisibleDialog();
        }
        await page.waitForFunction(() => document.querySelectorAll("[role=dialog]").length === 0);
        const dock = page.locator("[data-testid=pending-permission-dock] button");
        assert.equal(await dock.count(), 2, "dock must expose both pending requests");
        const respondBefore = store.responses.length;
        await dock.nth(0).click({ force: true });
        await page.getByRole("dialog").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("dialog").count(), 1, "dock[0] must show exactly one visible dialog");
        const id0 = (await page.getByTestId("qa-active-modal").textContent()) || "";
        assert.ok(id0 === "req-one" || id0 === "req-two", `dock[0] must open a real request, got ${id0}`);
        await closeVisibleDialog();
        for (let i = 0; i < 3 && (await page.getByRole("dialog").count()) > 0; i++) {
          await closeVisibleDialog();
        }
        await page.waitForFunction(() => document.querySelectorAll("[role=dialog]").length === 0);
        await dock.nth(1).click({ force: true });
        await page.getByRole("dialog").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("dialog").count(), 1, "dock[1] must show exactly one visible dialog");
        const id1 = (await page.getByTestId("qa-active-modal").textContent()) || "";
        assert.notEqual(id1, id0, `dock[1] must open the other request (id0=${id0} id1=${id1})`);
        assert.ok(id1 === "req-one" || id1 === "req-two");
        assert.equal(store.responses.length, respondBefore, "close/reopen must not send permission_response");
        await shot(page, "t5-dock-sequential");
      } catch (err) {
        failures.push("T5");
        if (page) await failShot(page, "t5").catch(() => {});
        throw err;
      } finally {
        await ctx.close();
      }
    });

    if (want("T6")) await t.test("T6 pending exists then settles; stale pending cannot resurrect; lookup HTTP settles beyond window", async () => {
      store.prompts.clear();
      store.responses.length = 0;
      store.httpLog.length = 0;
      store.windowSize = 16;
      const oldTs = nowMs() - 10_000;
      store.prompts.set(
        "req-old",
        prompt({
          requestId: "req-old",
          toolName: "Bash",
          inputJson: { command: "old" },
          createdAt: oldTs,
          updatedAt: oldTs,
        }),
      );
      store.prompts.set(
        "req-mid",
        prompt({
          requestId: "req-mid",
          toolName: "Bash",
          inputJson: { command: "mid" },
          toolUseId: "toolu_mid",
          createdAt: nowMs() - 5_000,
        }),
      );
      const ctx = await browser.newContext();
      try {
        const page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-old" && c.resolved === false)
            && cards.some((c) => c.requestId === "req-mid" && c.resolved === false);
        });
        const beforeSettle = parseCards(await page.getByTestId("qa-cards").textContent());
        const oldPending = beforeSettle.find((c) => c.requestId === "req-old");
        assert.ok(oldPending, "old pending card must exist in the browser before settle");
        assert.equal(oldPending.resolved, false, "old card must still be pending before settle");
        const oldRow = store.prompts.get("req-old");
        oldRow.status = "responded";
        oldRow.behavior = "allow";
        oldRow.updatedAt = nowMs();
        broadcast(USER_A, {
          type: "outbound.permission_settled",
          sessionKey: `agent:main:webchat:dm:${SESS}`,
          channel: "webchat",
          peer: { id: SESS, kind: "dm" },
          requestId: "req-old",
          behavior: "allow",
          reason: "remote",
        });
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          const card = cards.find((c) => c.requestId === "req-old");
          return card && card.resolved === true && card.behavior === "allow";
        });
        oldRow.status = "pending";
        oldRow.behavior = null;
        oldRow.updatedAt = oldTs;
        await page.evaluate(() => window.__qa.loadSnapshot());
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          const card = cards.find((c) => c.requestId === "req-old");
          return card && card.resolved === true;
        });
        const afterStale = parseCards(await page.getByTestId("qa-cards").textContent()).find((c) => c.requestId === "req-old");
        assert.ok(afterStale, "settled old card must still exist after stale pending snapshot");
        assert.equal(afterStale.resolved, true, "older pending snapshot must not resurrect a newer local settle");

        store.prompts.set(
          "req-fresh",
          prompt({
            requestId: "req-fresh",
            toolName: "Bash",
            inputJson: { command: "fresh" },
            createdAt: nowMs(),
          }),
        );
        store.windowSize = 16;
        await page.evaluate(() => window.__qa.loadSnapshot());
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-fresh" && c.resolved === false)
            && cards.some((c) => c.requestId === "req-mid" && c.resolved === false);
        });
        const midPending = parseCards(await page.getByTestId("qa-cards").textContent()).find((c) => c.requestId === "req-mid");
        assert.ok(midPending && midPending.resolved === false, "unanswered mid card must exist before shrinking the window");
        store.httpLog.length = 0;
        store.windowSize = 1;
        const mid = store.prompts.get("req-mid");
        mid.status = "responded";
        mid.behavior = "deny";
        mid.updatedAt = nowMs();
        await page.evaluate(() => window.__qa.loadSnapshot());
        await waitStore(
          () => store.httpLog.some((h) => typeof h.lookup === "string" && h.lookup.split(",").includes("req-mid")),
          "T6 real hook GET permission_lookup=req-mid",
          15_000,
        );
        const lookupHits = store.httpLog.filter((h) => typeof h.lookup === "string" && h.lookup.split(",").includes("req-mid"));
        assert.ok(lookupHits.length >= 1, `hook must issue permission_lookup HTTP, log=${JSON.stringify(store.httpLog)}`);
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          const card = cards.find((c) => c.requestId === "req-mid");
          return card && card.resolved === true && card.behavior === "deny";
        });
        await shot(page, "t6-settle-stale-and-lookup");
      } catch (err) {
        failures.push("T6");
        throw err;
      } finally {
        store.windowSize = 16;
        await ctx.close();
      }
    });

    if (want("T7")) await t.test("T7 toolUseId/turn bind; non-main agent; account isolation", async () => {
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

    if (want("T8")) await t.test("T8 ordinary no-waiter does not forge success; detached id stays pending until real settle", async () => {
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

    if (want("T9")) await t.test("T9 truncated CJK AskUserQuestion cannot submit until lookup restores UTF-8 questions", async () => {
      store.prompts.clear();
      store.responses.length = 0;
      store.httpLog.length = 0;
      store.holdLookup = true;
      store.heldLookups.length = 0;
      const cjkQuestion = "你".repeat(3000);
      assert.equal(Buffer.byteLength(cjkQuestion, "utf8"), 9000);
      assert.ok(9000 > 8192, "fixture must exceed 8KiB UTF-8");
      store.prompts.set(
        "req-cjk-ask",
        prompt({
          requestId: "req-cjk-ask",
          toolName: "AskUserQuestion",
          truncatePreview: true,
          inputPreview: "你你你…",
          inputJson: {
            questions: [{ question: cjkQuestion, header: "确认", options: [{ label: "是" }, { label: "否" }] }],
          },
        }),
      );
      const ctx = await browser.newContext();
      try {
        const page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-cjk-ask" && c.truncated === true);
        });
        await page.getByTestId("permission-input-loading").first().waitFor();
        assert.equal(await page.getByRole("button", { name: "提交" }).count(), 0, "must not submit before full questions");
        await waitStore(
          () => store.httpLog.some((h) => typeof h.lookup === "string" && h.lookup.split(",").includes("req-cjk-ask")),
          "T9 real hook GET permission_lookup=req-cjk-ask",
          15_000,
        );
        store.holdLookup = false;
        flushLookups();
        await page.getByRole("radio", { name: /是/ }).waitFor();
        const body = await page.locator("body").innerText();
        assert.ok(body.includes(cjkQuestion), "full UTF-8 question must appear after lookup");
        await page.getByRole("radio", { name: /是/ }).click();
        await page.getByRole("button", { name: "提交" }).click();
        await waitStore(
          () => store.prompts.get("req-cjk-ask")?.status === "responded",
          "T9 submit after full input",
          15_000,
        );
        await shot(page, "t9-cjk-ask-full");
      } catch (err) {
        failures.push("T9");
        throw err;
      } finally {
        store.holdLookup = false;
        store.heldLookups.length = 0;
        await ctx.close();
      }
    });

    if (want("T10")) await t.test("T10 truncated CJK ExitPlanMode cannot approve until lookup restores plan", async () => {
      store.prompts.clear();
      store.responses.length = 0;
      store.httpLog.length = 0;
      store.holdLookup = true;
      store.heldLookups.length = 0;
      const cjkPlan = `## 目标\n\n${"你".repeat(3000)}`;
      assert.ok(Buffer.byteLength(cjkPlan, "utf8") > 8192);
      store.prompts.set(
        "req-cjk-plan",
        prompt({
          requestId: "req-cjk-plan",
          toolName: "ExitPlanMode",
          truncatePreview: true,
          inputPreview: "计划预览…",
          inputJson: { plan: cjkPlan, planFilePath: "/tmp/plan.md" },
        }),
      );
      const ctx = await browser.newContext();
      try {
        const page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-cjk-plan" && c.truncated === true);
        });
        await page.getByTestId("permission-input-loading").first().waitFor();
        assert.equal(await page.getByRole("button", { name: "按此计划执行" }).count(), 0, "must not approve truncated plan");
        await waitStore(
          () => store.httpLog.some((h) => typeof h.lookup === "string" && h.lookup.split(",").includes("req-cjk-plan")),
          "T10 real hook GET permission_lookup=req-cjk-plan",
          15_000,
        );
        store.holdLookup = false;
        flushLookups();
        await page.getByRole("button", { name: "按此计划执行" }).waitFor();
        const planText = await page.getByTestId("exit-plan-markdown").innerText();
        assert.ok(planText.includes("你".repeat(20)), "restored plan must keep CJK source");
        assert.ok(planText.length > 1000, "restored plan must be the full body, not preview");
        await shot(page, "t10-cjk-plan-full");
      } catch (err) {
        failures.push("T10");
        throw err;
      } finally {
        store.holdLookup = false;
        store.heldLookups.length = 0;
        await ctx.close();
      }
    });

    if (want("T11")) await t.test("T11 Host short-A to truncated Ask-B/Plan-C: no submit until lookup; late fetch does not pollute", async () => {
      store.prompts.clear();
      store.responses.length = 0;
      store.httpLog.length = 0;
      store.holdLookup = true;
      store.heldLookups.length = 0;
      store.lookupFailIds.clear();
      const qB = `长问B-UNIQUE-${"你".repeat(3000)}`;
      const planC = `## 计划C-UNIQUE\n\n${"你".repeat(3000)}`;
      assert.ok(Buffer.byteLength(qB, "utf8") > 8192);
      assert.ok(Buffer.byteLength(planC, "utf8") > 8192);
      store.prompts.set("req-a", prompt({
        requestId: "req-a",
        toolName: "Bash",
        toolUseId: "toolu_a",
        inputJson: { command: "echo short-a" },
        createdAt: nowMs() - 3000,
      }));
      store.prompts.set("req-b", prompt({
        requestId: "req-b",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_b",
        truncatePreview: true,
        inputPreview: "长问B…",
        inputJson: { questions: [{ question: qB, options: [{ label: "是B" }, { label: "否B" }] }] },
        createdAt: nowMs() - 2000,
      }));
      store.prompts.set("req-c", prompt({
        requestId: "req-c",
        toolName: "ExitPlanMode",
        toolUseId: "toolu_c",
        truncatePreview: true,
        inputPreview: "计划C…",
        inputJson: { plan: planC },
        createdAt: nowMs() - 1000,
      }));
      const ctx = await browser.newContext();
      let page;
      try {
        page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.waitForFunction(() => {
          const cards = JSON.parse(document.querySelector("[data-testid=qa-cards]").textContent || "[]");
          return cards.some((c) => c.requestId === "req-a")
            && cards.some((c) => c.requestId === "req-b" && c.truncated === true)
            && cards.some((c) => c.requestId === "req-c" && c.truncated === true);
        });
        await page.getByTestId("pending-permission-dock").waitFor({ state: "attached" });
        await page.waitForFunction(() => {
          const names = [...document.querySelectorAll("[data-testid=pending-permission-dock] button")].map((b) =>
            (b.textContent || "").trim(),
          );
          return names.includes("打开提问") && names.includes("打开审批") && names.includes("打开计划");
        });
        await page.getByTestId("permission-input-loading").first().waitFor();
        assert.equal(await page.getByRole("button", { name: "按此计划执行" }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "提交" }).count(), 0);
        await clickDockNamed(page, "打开提问");
        await waitActive(page, "req-b");
        await page.getByTestId("permission-modal-host").getByTestId("permission-input-loading").waitFor();
        assert.equal(await page.getByRole("button", { name: "提交" }).count(), 0, "Ask B must not submit while lookup is held");
        assert.equal(await page.getByRole("dialog").getByRole("button", { name: "允许" }).count(), 0);
        await clickDockNamed(page, "打开审批");
        await waitActive(page, "req-a");
        await page.getByRole("dialog").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("dialog").count(), 1);
        assert.ok((await page.getByRole("dialog").getByRole("button", { name: "允许" }).count()) >= 1, "complete short A can show allow");
        await clickDockNamed(page, "打开提问");
        await waitActive(page, "req-b");
        await page.getByTestId("permission-modal-host").getByTestId("permission-input-loading").waitFor();
        assert.equal(await page.getByRole("button", { name: "提交" }).count(), 0);
        flushLookups(["req-c"]);
        await new Promise((r) => setTimeout(r, 400));
        assert.equal((await page.getByTestId("qa-active-modal").textContent()) || "", "req-b");
        assert.equal(await page.getByRole("button", { name: "提交" }).count(), 0, "late Plan C fetch must not unlock Ask B");
        assert.equal(await page.getByRole("button", { name: "按此计划执行" }).count(), 0);
        const hostBefore = await page.getByTestId("permission-modal-host").innerText();
        assert.equal(hostBefore.includes("计划C-UNIQUE"), false, "Host viewing B must not show C plan body");
        flushLookups(["req-b"]);
        await page.getByRole("dialog").waitFor({ state: "visible" });
        await page.getByRole("radio", { name: /是B/ }).waitFor();
        const dialogB = await page.getByRole("dialog").innerText();
        assert.ok(dialogB.includes("长问B-UNIQUE"), "B's original question must appear after its own lookup");
        assert.equal(dialogB.includes("计划C-UNIQUE"), false, "Ask B dialog must not include C plan body");
        const beforeSubmit = store.responses.length;
        await page.getByRole("radio", { name: /是B/ }).click();
        await page.getByRole("button", { name: "提交" }).click();
        await waitStore(() => store.responses.length > beforeSubmit, "T11 submit B", 15_000);
        const sent = store.responses.at(-1);
        assert.equal(sent.payload.requestId, "req-b");
        assert.equal(sent.payload.updatedInput?.answers?.[qB], "是B");
        await shot(page, "t11-host-switch-truncated");
        store.holdLookup = false;
        store.heldLookups.length = 0;
        store.prompts.clear();
        store.lookupFailIds.add("req-b-fail");
        store.prompts.set("req-b-fail", prompt({
          requestId: "req-b-fail",
          toolName: "AskUserQuestion",
          truncatePreview: true,
          inputJson: { questions: [{ question: qB, options: [{ label: "是B" }] }] },
        }));
        const pageFail = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await pageFail.evaluate(() => window.__qa.loadSession());
        await pageFail.getByTestId("permission-input-loading").first().waitFor();
        await waitStore(
          () => store.httpLog.some((h) => typeof h.lookup === "string" && h.lookup.includes("req-b-fail")),
          "T11 failed lookup still issued HTTP",
          15_000,
        );
        assert.equal(await pageFail.getByRole("button", { name: "提交" }).count(), 0, "failed lookup must not expose submit");
        assert.equal(await pageFail.getByRole("button", { name: "允许" }).count(), 0);
      } catch (err) {
        failures.push("T11");
        if (page) await failShot(page, "t11").catch(() => {});
        throw err;
      } finally {
        store.holdLookup = false;
        store.heldLookups.length = 0;
        store.lookupFailIds.clear();
        await ctx.close();
      }
    });

    if (want("T12")) await t.test("T12 Host switches distinct Ask questions without crash; same text different request does not inherit selection", async () => {
      store.prompts.clear();
      store.responses.length = 0;
      store.httpLog.length = 0;
      store.holdLookup = false;
      store.lookupFailIds.clear();
      store.prompts.set("req-q1", prompt({
        requestId: "req-q1",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_q1",
        inputJson: { questions: [{ question: "苹果还是梨？", options: [{ label: "苹果" }, { label: "梨" }] }] },
        createdAt: nowMs() - 2000,
      }));
      store.prompts.set("req-q2", prompt({
        requestId: "req-q2",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_q2",
        inputJson: { questions: [{ question: "猫还是狗？", options: [{ label: "猫" }, { label: "狗" }] }] },
        createdAt: nowMs() - 1000,
      }));
      const ctx = await browser.newContext();
      let page;
      try {
        page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page.evaluate(() => window.__qa.loadSession());
        await page.getByRole("dialog").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("dialog").count(), 1);
        await page.getByTestId("pending-permission-dock").waitFor({ state: "attached" });
        assert.equal(await page.locator("[data-testid=pending-permission-dock] button").count(), 2);
        const firstActive = (await page.getByTestId("qa-active-modal").textContent()) || "";
        assert.ok(firstActive === "req-q1" || firstActive === "req-q2", `auto-open must be q1 or q2, got ${firstActive}`);
        const other = firstActive === "req-q1" ? "req-q2" : "req-q1";
        await switchHostTo(page, other);
        await page.getByRole("dialog").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("dialog").count(), 1);
        if (other === "req-q1") {
          await page.getByRole("radio", { name: /苹果/ }).waitFor();
          await page.getByRole("radio", { name: /苹果/ }).click();
          assert.equal(await page.getByRole("radio", { name: /猫/ }).count(), 0, "switching questions must not keep Q2 radios");
        } else {
          await page.getByRole("radio", { name: /猫/ }).waitFor();
          await page.getByRole("radio", { name: /猫/ }).click();
          assert.equal(await page.getByRole("radio", { name: /苹果/ }).count(), 0, "switching questions must not keep Q1 radios");
        }
        const respondBefore = store.responses.length;
        await switchHostTo(page, firstActive);
        await page.getByRole("dialog").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("dialog").count(), 1);
        if (firstActive === "req-q1") {
          await page.getByRole("radio", { name: /苹果/ }).waitFor();
          assert.equal(await page.getByRole("radio", { name: /猫/ }).count(), 0);
        } else {
          await page.getByRole("radio", { name: /猫/ }).waitFor();
          assert.equal(await page.getByRole("radio", { name: /苹果/ }).count(), 0);
        }
        assert.equal(store.responses.length, respondBefore, "switch must not send permission_response");
        assert.equal(page._qaErrors.length, 0, page._qaErrors.join("\n"));
        await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();
        await page.waitForFunction(() => document.querySelectorAll("[role=dialog]").length === 0);
        assert.equal(store.responses.length, respondBefore, "close must not send permission_response");
        await shot(page, "t12-distinct-questions");
        store.prompts.clear();
        store.prompts.set("req-s1", prompt({
          requestId: "req-s1",
          toolName: "AskUserQuestion",
          toolUseId: "toolu_s1",
          inputJson: { questions: [{ question: "同一题吗？", options: [{ label: "是" }, { label: "否" }] }] },
          createdAt: nowMs() - 2000,
        }));
        store.prompts.set("req-s2", prompt({
          requestId: "req-s2",
          toolName: "AskUserQuestion",
          toolUseId: "toolu_s2",
          inputJson: { questions: [{ question: "同一题吗？", options: [{ label: "是" }, { label: "否" }] }] },
          createdAt: nowMs() - 1000,
        }));
        const page2 = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1`);
        await page2.evaluate(() => window.__qa.loadSession());
        await page2.getByRole("dialog").waitFor({ state: "visible" });
        assert.equal(await page2.getByRole("dialog").count(), 1);
        const firstSame = (await page2.getByTestId("qa-active-modal").textContent()) || "";
        assert.ok(firstSame === "req-s1" || firstSame === "req-s2", `same-text auto-open got ${firstSame}`);
        const otherSame = firstSame === "req-s1" ? "req-s2" : "req-s1";
        await switchHostTo(page2, otherSame);
        await page2.getByRole("dialog").waitFor({ state: "visible" });
        await page2.getByRole("dialog").getByRole("radio", { name: /^是$/ }).click();
        assert.equal(await page2.getByRole("dialog").getByRole("radio", { name: /^是$/ }).getAttribute("aria-checked"), "true");
        const beforeSame = store.responses.length;
        await switchHostTo(page2, firstSame);
        await page2.getByRole("dialog").waitFor({ state: "visible" });
        assert.equal(await page2.getByRole("dialog").count(), 1);
        assert.equal(
          await page2.getByRole("dialog").getByRole("radio", { name: /^是$/ }).getAttribute("aria-checked"),
          "false",
          "same question different requestId must not inherit unsubmitted selection",
        );
        assert.equal(store.responses.length, beforeSame);
        assert.equal(page2._qaErrors.length, 0, page2._qaErrors.join("\n"));
        await shot(page2, "t12-same-question-isolated");
      } catch (err) {
        failures.push("T12");
        if (page) await failShot(page, "t12").catch(() => {});
        throw err;
      } finally {
        await ctx.close();
      }
    });
    for (const [id, split] of [["T13", false], ["T14", true]]) {
      if (want(id)) await t.test(`${id} pinned bar reopens actual singleton Host${split ? " after controlled row unmount" : " in MessageList"}`, async () => {
        store.prompts.clear(); store.responses.length = 0;
        const row = prompt({ requestId: `req-bar-${id}`, expiresAt: nowMs() + 120000 });
        store.prompts.set(row.requestId, row);
        const ctx = await browser.newContext();
        let page;
        try {
          page = await openPage(ctx, `user=${USER_A}&sess=${SESS}&agent=main&live=1${split ? "&split=1" : ""}`);
          await page.evaluate(() => window.__qa.loadSession());
          await page.getByRole("dialog").waitFor({ state: "visible" });
          assert.equal(await page.getByRole("dialog").count(), 1);
          await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();
          const bar = page.locator("#pending-approval-bar-slot [data-testid=pending-approval-bar]");
          await bar.waitFor({ state: "visible" });
          assert.equal(await page.getByRole("dialog").count(), 0);
          assert.equal(await bar.count(), 1);
          if (split) {
            await page.evaluate(() => window.__qa.setMountRows(false));
            await page.waitForFunction(() => !document.querySelector("[data-testid=permission-card]"));
            assert.equal(await page.getByTestId("permission-card").count(), 0, "controlled virtual-row lifecycle really unmounted all cards");
            assert.equal(await bar.count(), 1, "stable Host entry must survive card unmount");
          }
          await bar.getByRole("button", { name: "打开", exact: true }).click();
          await page.getByRole("dialog").waitFor({ state: "visible" });
          assert.equal(await page.getByRole("dialog").count(), 1, "bar must reopen exactly one REAL dialog, not only set local open");
          assert.equal(await bar.count(), 0);
          assert.equal(store.responses.length, 0, "close/reopen cannot respond");
          await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();
          await bar.waitFor({ state: "visible" });
          row.expiresAt = nowMs() + 1500;
          await page.evaluate(() => window.__qa.loadSnapshot());
          await bar.waitFor({ state: "hidden" });
          assert.equal(store.responses.length, 0, "local expiry cannot respond");
          assert.equal(page._qaErrors.length, 0, page._qaErrors.join("\n"));
          await shot(page, `${id.toLowerCase()}-host-bar`);
        } catch (err) {
          failures.push(id);
          if (page) await failShot(page, id.toLowerCase()).catch(() => {});
          throw err;
        } finally { await ctx.close(); }
      });
    }
  } finally {
    writeFileSync(
      join(ARTIFACTS, "summary.json"),
      JSON.stringify(
        {
          freeze: PRODUCT_SOURCE_SHA,
          qaCommit: QA_COMMIT,
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
