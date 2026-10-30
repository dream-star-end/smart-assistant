import assert from "node:assert/strict";
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

// INC-20261008-PROJECT-CONTEXT-SILENT-DROP in the real App: the gateway could
// not read the session's project from the master, so it held the turn before
// dispatch (outbound.error project_context_unavailable + [error] final, exactly
// the frames server.ts sends). The page must say why, say nothing ran or was
// billed, and offer one Continue that carries the original goal as context.
// OC_PROJECT_HELD_RED=1 removes the code's copy from pure.ts/render.ts, i.e. a
// client that does not know the hold, and must fail.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const purePath = resolve(here, "../src/lib/chat/pure.ts");
const renderPath = resolve(here, "../src/lib/chat/render.ts");
const red = process.env.OC_PROJECT_HELD_RED === "1";
let transformCount = 0;

test("INC-20261008-PROJECT-CONTEXT-SILENT-DROP: a held turn explains itself and continues in the same conversation", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-project-held-browser-"));
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
    splitting: true, format: "esm", outdir: assetDir, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "forget-project-context-unavailable", setup(b) {
      b.onLoad({ filter: /\/lib\/chat\/(pure|render)\.ts$/ }, ({ path }) => {
        assert.ok([purePath, renderPath].includes(resolve(path)));
        const contents = readFileSync(path, "utf8");
        const re = /\n\s*project_context_unavailable:\s*"[^"]*",/;
        assert.match(contents, re);
        transformCount += 1;
        return { contents: contents.replace(re, ""), loader: "ts" };
      });
    }}] : [], logLevel: "warning",
  });
  assert.equal(transformCount, red ? 2 : 0);
  const cssDir = join(assetDir, "css-build"); mkdirSync(cssDir);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()], build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(assetDir, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
  const preview = await startPreviewServer(assetDir);
  preview.wss.removeAllListeners("connection");
  let scenario;
  preview.wss.on("connection", (ws) => {
    const send = (frame) => ws.readyState === 1 && ws.send(JSON.stringify(frame));
    send({ type: "sys.relay_ready" });
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ping") return send({ type: "pong", id: frame.id });
      if (frame.type === "inbound.hello") return send({ type: "sys.relay_ready" });
      if (frame.type !== "inbound.message") return;
      const id = frame.clientMessageId;
      const peer = { id: BOARD_SESSION, kind: "dm" };
      const sessionKey = `agent:main:webchat:dm:${BOARD_SESSION}`;
      scenario.sent.push({ id, text: frame.content.text, frame: structuredClone(frame) });
      send({ type: "outbound.ack", admitted: true, peer, clientMessageId: id });
      const ts = Date.now();
      if (scenario.sent.length === 1) {
        // First attempt: master unreachable, turn held before dispatch.
        preview.store.board.push(
          { id, role: "user", text: frame.content.text, status: "error", ts, _source: "server",
            _routing: { model: frame.model, teamMode: false, effortLevel: frame.effortLevel ?? null } },
          { id: `held-${id}`, role: "assistant", text: "", status: "crashed", ts: ts + 1,
            _source: "server", _clientMessageId: id, _errorCode: "project_context_unavailable" },
        );
        preview.store.revision += 1;
        send({ type: "outbound.error", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, code: "project_context_unavailable", message: "项目信息暂时没有加载出来，这一轮还没有开始，也不会计费。请稍后用下方按钮重新发送。", isFinal: false, ts });
        send({ type: "outbound.message", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, blocks: [{ kind: "text", text: "[error] PROJECT_CONTEXT_UNAVAILABLE" }], isFinal: true, ts: ts + 1 });
        return;
      }
      // Continue is a new admitted follow-up; the held request stays intact.
      preview.store.board.push(
        { id, role: "user", text: frame.content.displayText ?? frame.content.text,
          _modelText: frame.content.text, status: "completed", ts, _source: "server" },
        { id: `reply-${id}`, role: "assistant", text: "PROJECT_TURN_RAN", status: "completed", ts: ts + 1, _source: "server", _clientMessageId: id },
      );
      preview.store.revision += 1;
      send({ type: "outbound.message", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, blocks: [{ kind: "text", text: "PROJECT_TURN_RAN" }], isFinal: true, ts: ts + 1 });
    });
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1280, 390]) await t.test(`${width} held turn card, then one explicit continuation`, async () => {
      scenario = { sent: [], seq: 0 };
      const at = Date.now() - 10_000;
      preview.store.board = [
        { id: "held-prior-user", role: "user", text: "保留之前的项目上下文", status: "replied", ts: at, _source: "server" },
        { id: "held-prior-answer", role: "assistant", text: "PROJECT_HELD_CONTEXT_ALREADY_SAVED",
          ts: at + 1, _source: "server", _clientMessageId: "held-prior-user" },
      ];
      preview.store.older = []; preview.store.revision += 1;
      const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(preview.url);
        await page.getByPlaceholder(/对话/).fill("PROJECT_HELD_REQUEST");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await page.getByText("项目信息暂未加载", { exact: true }).waitFor({ timeout: 15000 });
        const body = await page.locator("body").innerText();
        assert.equal(await page.getByText("项目信息暂未加载", { exact: true }).count(), 1, "one held-turn card");
        assert.match(body, /还没有开始，也不会计费/, "the card says nothing ran and nothing was billed");
        assert.doesNotMatch(body, /「重试」|「重新尝试」/, "the card does not name a button that may not be the one shown");
        const go = page.getByRole("button", { name: "继续", exact: true });
        assert.equal(await go.count(), 1, "exactly one Continue button");
        assert.equal(await page.getByRole("button", { name: /^(重试|重新尝试|重新发送|从断点继续)$/ }).count(), 0);
        assert.equal(scenario.sent.length, 1, "the held turn never retries before a human click");
        const originalRows = structuredClone(preview.store.board);
        await go.click();
        await page.getByText("PROJECT_TURN_RAN").first().waitFor({ timeout: 15000 });
        assert.equal(scenario.sent.length, 2, "one explicit continuation is sent");
        const continuation = scenario.sent[1].frame;
        assert.notEqual(continuation.clientMessageId, scenario.sent[0].id);
        assert.equal(continuation.peer.id, BOARD_SESSION);
        assert.equal(continuation.content.displayText, "继续");
        assert.notEqual(continuation.content.text, "PROJECT_HELD_REQUEST", "the original instruction is not replayed");
        assert.match(continuation.content.text, /原任务目标/);
        assert.ok(continuation.content.text.includes("PROJECT_HELD_REQUEST"), "the never-executed goal remains in continuation context");
        assert.match(continuation.content.text, /不要重新执行已经完成的步骤/);
        assert.equal(scenario.sent[0].frame.model, "glm-5.2", "the source has an explicit model snapshot");
        assert.equal(continuation.model, scenario.sent[0].frame.model, "Continue keeps the original model snapshot");
        assert.equal(continuation.content.recovery, undefined, "a pre-execution hold grants no automatic recovery privilege");
        assert.deepEqual(preview.store.board.slice(0, originalRows.length), originalRows, "existing context and held rows stay unchanged");
        await page.getByText("PROJECT_HELD_CONTEXT_ALREADY_SAVED", { exact: true }).waitFor();
        assert.ok(page.url().includes(`/s/${BOARD_SESSION}`));
        await page.reload();
        await page.getByText("PROJECT_TURN_RAN").first().waitFor();
        await page.getByText("PROJECT_HELD_CONTEXT_ALREADY_SAVED", { exact: true }).waitFor();
        assert.equal(scenario.sent.length, 2, "reload does not replay either request");
        assert.deepEqual(errors, []);
        console.log("PROJECT_HELD_RECEIPT", JSON.stringify({ width, cards: 1, continuations: 1,
          sessionId: continuation.peer.id, sourceId: scenario.sent[0].id, continuationId: continuation.clientMessageId, red, transformCount }));
      } catch (error) {
        console.error("PROJECT_HELD_DIAGNOSTIC", JSON.stringify({ scenario, alerts: await page.getByRole("alert").allInnerTexts(), body: (await page.locator("body").innerText()).slice(-1500), errors }));
        throw error;
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    for (const ws of preview.wss.clients) ws.terminate();
    await new Promise((done) => preview.wss.close(done));
    await new Promise((done) => preview.server.close(done));
  }
});
