import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";
import { BOARD_SESSION } from "./process-disclosure-story.mjs";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const socketPath = resolve(here, "../src/lib/chat/socket.ts");
const red = process.env.OC_RECOVERY_PERSIST_RED === "1";
const signatureRed = process.env.OC_RECOVERY_SIGNATURE_RED === "1";
assert.ok(!(red && signatureRed), "negative controls must be independently attributable");
const renderPath = resolve(here, "../src/lib/chat/render.ts");
const sourceFiles = [here, resolve(here, "../src")].flatMap((root) => {
  const collect = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? collect(join(dir, entry.name)) : [join(dir, entry.name)]);
  return collect(root);
}).sort();
const provenance = Object.fromEntries(sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const sourceDigest = createHash("sha256").update(JSON.stringify(provenance)).digest("hex");
const sourceHash = createHash("sha256").update(readFileSync(socketPath)).digest("hex");
let transformCount = 0;

async function stored(page) {
  return page.evaluate(async (id) => {
    const db = await new Promise((done, fail) => { const q = indexedDB.open("ocv5_sessions__u1"); q.onsuccess = () => done(q.result); q.onerror = () => fail(q.error); });
    try { return await new Promise((done, fail) => { const q = db.transaction("sessions").objectStore("sessions").get(id); q.onsuccess = () => done(q.result ?? null); q.onerror = () => fail(q.error); }); }
    finally { db.close(); }
  }, BOARD_SESSION);
}
async function until(label, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((done) => setTimeout(done, 30)); }
  throw new Error(`${label}: timed out`);
}

test("INC-20260725-RECOVERY-RETRY-LOOP: real App REST and IndexedDB reload fence", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-recovery-browser-"));
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
    splitting: true, format: "esm", outdir: assetDir, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "remove-only-recovery-persistence", setup(b) {
      b.onLoad({ filter: /\/lib\/chat\/socket\.ts$/ }, ({ path }) => {
        assert.equal(resolve(path), socketPath);
        let contents = readFileSync(path, "utf8");
        const start = contents.indexOf("  toStored(sessId: string)");
        const end = contents.indexOf("  loadStored(", start);
        assert.ok(start >= 0 && end > start, "exact persistence method boundary");
        let method = contents.slice(start, end);
        const field = "      messages,\n      createdAt: s.createdAt,";
        const decisions = "      ...(s._automaticRecoveryDecisions\n        ? { _automaticRecoveryDecisions: { ...s._automaticRecoveryDecisions } }\n        : {}),";
        assert.equal(method.split(field).length - 1, 1);
        assert.equal(method.split(decisions).length - 1, 1);
        method = method.replace(field, "      messages: messages.map((m) => { const clean = { ...m }; delete clean._automaticRecoveryAttempted; return clean; }),\n      createdAt: s.createdAt,").replace(decisions, "");
        contents = contents.slice(0, start) + method + contents.slice(end);
        transformCount += 1;
        return { contents, loader: "ts" };
      });
    }}] : signatureRed ? [{ name: "remove-only-notice-signature", setup(b) {
      b.onLoad({ filter: /\/lib\/chat\/render\.ts$/ }, ({ path }) => {
        assert.equal(resolve(path), renderPath);
        const contents = readFileSync(path, "utf8");
        const needle = '        JSON.stringify([Object.prototype.hasOwnProperty.call(m, "_recoverySkippedNotice"), m._recoverySkippedNotice ?? null]),\n';
        assert.equal(contents.split(needle).length - 1, 1);
        transformCount += 1;
        return { contents: contents.replace(needle, ""), loader: "ts" };
      });
    }}] : [], logLevel: "warning",
  });
  assert.equal(transformCount, red || signatureRed ? 1 : 0);
  const cssDir = join(assetDir, "css-build"); mkdirSync(cssDir);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()], build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(assetDir, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
  const preview = await startPreviewServer(assetDir);
  // Keep the existing real HTTP/session fixture. Replace only its LLM/WS story;
  // no real backend credentials or production model requests are used.
  preview.wss.removeAllListeners("connection");
  let scenario;
  preview.wss.on("connection", (ws) => {
    const send = (frame) => ws.readyState === 1 && ws.send(JSON.stringify(frame));
    send({ type: "sys.relay_ready" }); // legacy fallback: no master-v1 ownership
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ping") return send({ type: "pong", id: frame.id });
      if (frame.type === "inbound.hello") { scenario.hello += 1; return send({ type: "sys.relay_ready" }); }
      if (frame.type !== "inbound.message") return;
      scenario.inbound.push(frame);
      const recovery = frame.content?.recovery;
      const id = frame.clientMessageId;
      const peer = { id: BOARD_SESSION, kind: "dm" };
      if (recovery) {
        assert.equal(recovery.sourceClientMessageId, scenario.source);
        assert.equal(recovery.automatic, true);
        assert.equal(recovery.mode, "checkpoint");
        scenario.children.push(id);
        if (scenario.reject) {
          scenario.skipped += 1;
          return send({ type: "outbound.ack", peer, clientMessageId: id, sourceClientMessageId: scenario.source, recoverySkipped: true, recoverySkippedReason: "source_not_recoverable" });
        }
        send({ type: "outbound.ack", admitted: true, peer, clientMessageId: id });
        preview.store.board.push({ id, role: "user", text: frame.content.displayText, ts: Date.now(), status: "replied", _source: "server" }, { id: `answer-${id}`, role: "assistant", text: "RECOVERY_COMPLETED_ONCE", ts: Date.now()+1, _clientMessageId: id, _source: "server" });
        return send({ type: "outbound.message", peer, sessionKey: `agent:main:webchat:dm:${BOARD_SESSION}`, clientMessageId: id, frameSeq: ++scenario.seq, blocks: [{ kind: "text", text: "RECOVERY_COMPLETED_ONCE", messageId: `answer-${id}` }], isFinal: true });
      }
      assert.equal(scenario.source, null, "only one original Composer request");
      scenario.source = id;
      send({ type: "outbound.ack", admitted: true, peer, clientMessageId: id });
      const ts = Date.now();
      const rows = [
        { id, role: "user", text: frame.content.text, status: "error", ts, _source: "server", _routing: { model: "glm-5.2", effortLevel: "high", teamMode: false } },
        { id: `thinking-${id}`, role: "thinking", text: "RECOVERY_SAVED_THINKING", ts: ts+1, _source: "server", _turnTapeId: "tape-recovery", _clientMessageId: id },
        { id: `tool-${id}`, role: "tool", text: "终端", toolName: "Bash", inputJson: { command: "echo RECOVERY_SAVED_TOOL" }, output: "RECOVERY_TOOL_RESULT", _completed: true, _toolEffect: { authority: "gateway-v1", registryEntrySha256: "a".repeat(64), outcome: "completed", safety: "read_only" }, ts: ts+2, _source: "server", _turnTapeId: "tape-recovery", _clientMessageId: id },
        { id: `error-${id}`, role: "assistant", text: "", _errorCode: "ENGINE_ERROR", ts: ts+3, _source: "server", _turnTapeId: "tape-recovery", _clientMessageId: id },
      ];
      scenario.original = structuredClone(rows);
      preview.store.board = structuredClone(rows);
      preview.store.revision += 1;
      send({ type: "outbound.error", peer, sessionKey: `agent:main:webchat:dm:${BOARD_SESSION}`, clientMessageId: id, frameSeq: ++scenario.seq, code: "ENGINE_ERROR", message: "Context exhausted", isFinal: true, ts: ts+3 });
    });
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const [width, reject] of [[1280,true],[390,true],[1280,false]]) await t.test(`${width} ${reject ? "rejected across REST and reload" : "recoverable control"}`, async () => {
      scenario = { source: null, original: null, inbound: [], children: [], skipped: 0, hello: 0, seq: 0, reject };
      preview.store.board = []; preview.store.older = []; preview.store.revision += 1;
      const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width===390, hasTouch: width===390 });
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let detailResponses = 0;
      page.on("response", (response) => { if (new URL(response.url()).pathname === `/api/sessions/${BOARD_SESSION}` && response.status() === 200) detailResponses += 1; });
      try {
        await page.goto(preview.url);
        await page.getByPlaceholder(/对话/).fill("RECOVERY_ORIGINAL_REQUEST");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await until("real automatic checkpoint child", () => scenario.children.length===1);
        assert.equal(scenario.inbound.filter((f) => !f.content.recovery).length, 1);
        if (!reject) {
          await page.getByText("RECOVERY_COMPLETED_ONCE", { exact: true }).waitFor();
          assert.equal(scenario.children.length, 1);
          console.log("RECOVERY_RECEIPT", JSON.stringify({ width, reject, originals: 1, children: 1, completed: true, sourceHash, sourceDigest, transformCount }));
          return;
        }
        assert.equal(scenario.skipped, 1);
        const notice = "未从断点继续：服务端没有确认到可恢复的中断断点，原任务仍已保留。";
        await page.getByText(notice, { exact: true }).waitFor();
        const committed = await until("IDB decision commit", async () => {
          const s = await stored(page); if (!s) return false;
          const user = s.messages.find((m) => m.id===scenario.source);
          return red ? (!s._automaticRecoveryDecisions && user && !user._automaticRecoveryAttempted && s.messages.every((m) => !scenario.children.includes(m.id)) && s) : (s._automaticRecoveryDecisions?.[scenario.source]===true && user?._automaticRecoveryAttempted===true && s.messages.every((m) => !scenario.children.includes(m.id)) && s);
        });
        assert.ok(committed);
        const assertOriginalError = (snapshot) => {
          const error = snapshot.messages.find((m) => m.id===`error-${scenario.source}`);
          assert.ok(error, "original source error identity retained in actual client cache");
          assert.equal(error._clientMessageId, scenario.source);
          assert.equal(error._errorCode, "ENGINE_ERROR");
          assert.equal(error.text, "");
        };
        assertOriginalError(committed);
        async function resync() {
          preview.store.revision += 1;
          const revision = preview.store.revision, before = detailResponses;
          for (const ws of preview.wss.clients) ws.send(JSON.stringify({ type: "outbound.resume_failed", peer: { id: BOARD_SESSION, kind: "dm" }, reason: "no_buffer", to: 0 }));
          await until("REST response received", () => detailResponses > before);
          await until("REST processed and committed", async () => (await stored(page))?._historyRevision===revision);
          await page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 0)));
          assert.equal(scenario.children.length, 1, "repeated REST must not submit another recovery child");
        }
        await resync(); await resync();
        const before = detailResponses;
        preview.store.revision += 1;
        const reloadRevision = preview.store.revision;
        assert.notEqual(committed._historyRevision, reloadRevision);
        await page.reload();
        await until("reload hydrates old server error", () => detailResponses > before);
        // The user's bubble, not the sr-only page <h1> (a6c4442b3) that carries the same text once the
        // session title is the first message; an unscoped exact match is ambiguous after reload (OCV5-355).
        await page.getByTestId("user-row").getByTestId("message-text").filter({ hasText: /^RECOVERY_ORIGINAL_REQUEST$/ }).waitFor();
        await until("reload processed old REST", async () => (await stored(page))?._historyRevision===preview.store.revision);
        if (red) await until("RED observes second child after reload", () => scenario.children.length>=2);
        assert.equal(scenario.children.length, 1, "reload must not submit second recovery child");
        await resync();
        const snapshot = await stored(page);
        assertOriginalError(snapshot);
        await page.getByText(notice, { exact: true }).waitFor();
        assert.equal(snapshot._automaticRecoveryDecisions?.[scenario.source], true);
        assert.equal(snapshot.messages.filter((m) => scenario.children.includes(m.id)).length, 0);
        // Process projections are deliberately refetchable rather than in IDB;
        // assert their original server identities and actual rendered disclosure.
        assert.deepEqual(preview.store.board, scenario.original);
        const shell = page.getByTestId("process-disclosure");
        assert.equal(await shell.count(), 1, "one source turn has one unique process shell");
        const toggle = shell.getByTestId("process-toggle");
        if (await toggle.getAttribute("aria-expanded")!=="true") await toggle.click();
        const detailToggle = shell.getByTestId("process-detail-toggle");
        if (await detailToggle.count() && await detailToggle.getAttribute("aria-expanded")!=="true") await detailToggle.click();
        const thinkingToggle = shell.getByTestId("thinking-step").getByRole("button", { name: "思考", exact: true });
        assert.equal(await thinkingToggle.count(), 1, "one source thinking step");
        console.log("RECOVERY_THINKING_CONTROL", JSON.stringify({ width, name: await thinkingToggle.innerText(), expanded: await thinkingToggle.getAttribute("aria-expanded") }));
        if (await thinkingToggle.getAttribute("aria-expanded") !== "true") await thinkingToggle.click();
        await shell.getByText("RECOVERY_SAVED_THINKING", { exact: true }).waitFor();
        const tool = shell.getByTestId("tool-step");
        assert.equal(await tool.count(), 1, "one source tool step");
        const toolToggle = tool.getByRole("button", { name: /终端/ });
        assert.equal(await toolToggle.count(), 1, "one source command toggle");
        if (await toolToggle.getAttribute("aria-expanded") !== "true") await toolToggle.click();
        const output = tool.locator("pre");
        assert.equal(await output.count(), 1, "one raw source command/output surface");
        await output.waitFor({ state: "visible" });
        const outputLines = (await output.textContent()).split("\n");
        assert.equal(outputLines.filter((line) => line === "$ echo RECOVERY_SAVED_TOOL").length, 1);
        assert.equal(outputLines.filter((line) => line === "RECOVERY_TOOL_RESULT").length, 1);
        assert.equal(await page.getByTestId("user-row").count(), 1);
        assert.deepEqual(errors, []);
        console.log("RECOVERY_RECEIPT", JSON.stringify({ width, reject, originals: 1, children: scenario.children.length, skipped: scenario.skipped, detailResponses, reload: true, sourceHash, sourceDigest, transformCount }));
      } catch (error) { console.error("RECOVERY_DIAGNOSTIC", JSON.stringify({ scenario, stored: await stored(page), detailResponses, body: (await page.locator("body").innerText()).slice(-4000), errors })); throw error; } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    for (const ws of preview.wss.clients) ws.terminate();
    await new Promise((done) => preview.wss.close(done));
    await new Promise((done) => preview.server.close(done));
    assert.deepEqual(Object.fromEntries(sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])), provenance, "all App consumer sources and driver unchanged");
    console.log("RECOVERY_PROVENANCE", JSON.stringify({ sourceDigest, sourceFiles: sourceFiles.length, red, signatureRed, transformCount }));
  }
});
