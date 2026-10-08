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
// billed, and offer one retry that resends the same message, which then runs.
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

test("INC-20261008-PROJECT-CONTEXT-SILENT-DROP: a held turn explains itself and one retry runs it", { timeout: 180000 }, async (t) => {
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
      scenario.sent.push({ id, text: frame.content.text });
      send({ type: "outbound.ack", admitted: true, peer, clientMessageId: id });
      const ts = Date.now();
      if (scenario.sent.length === 1) {
        // First attempt: master unreachable, turn held before dispatch.
        send({ type: "outbound.error", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, code: "project_context_unavailable", message: "项目信息暂时没有加载出来，这一轮还没有开始，也不会计费。请稍后用下方按钮重新发送。", isFinal: false, ts });
        send({ type: "outbound.message", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, blocks: [{ kind: "text", text: "[error] PROJECT_CONTEXT_UNAVAILABLE" }], isFinal: true, ts: ts + 1 });
        return;
      }
      // Retry: master is back, the turn runs normally.
      preview.store.board = structuredClone([
        { id, role: "user", text: frame.content.text, status: "completed", ts, _source: "server" },
        { id: `reply-${id}`, role: "assistant", text: "PROJECT_TURN_RAN", status: "completed", ts: ts + 1, _source: "server", _clientMessageId: id },
      ]);
      preview.store.revision += 1;
      send({ type: "outbound.message", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, blocks: [{ kind: "text", text: "PROJECT_TURN_RAN" }], isFinal: true, ts: ts + 1 });
    });
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1280, 390]) await t.test(`${width} held turn card, then one retry runs`, async () => {
      scenario = { sent: [], seq: 0 };
      preview.store.board = []; preview.store.older = []; preview.store.revision += 1;
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
        const retry = page.getByRole("button", { name: /重试|重新尝试/ });
        assert.equal(await retry.count(), 1, "exactly one retry button");
        await retry.click();
        await page.getByText("PROJECT_TURN_RAN").first().waitFor({ timeout: 15000 });
        assert.equal(scenario.sent.length, 2, "the retry resent once");
        assert.equal(scenario.sent[1].text, "PROJECT_HELD_REQUEST", "the retry resent the same message");
        assert.deepEqual(errors, []);
        console.log("PROJECT_HELD_RECEIPT", JSON.stringify({ width, cards: 1, retries: 1, red, transformCount }));
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
