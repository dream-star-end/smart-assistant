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

// INC-20261006-DOUBLE-FAILURE-CARD in the real App: one turn that never started
// carries the verified unbilled status record and an assistant error row. The
// page must show one failure card with one retry button. OC_DOUBLE_CARD_RED=1
// removes only the superseded-error clause from MessageList and reproduces it.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = resolve(here, "../src/components/MessageRenderer.tsx");
const red = process.env.OC_DOUBLE_CARD_RED === "1";
let transformCount = 0;

async function until(label, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((done) => setTimeout(done, 30)); }
  throw new Error(`${label}: timed out`);
}

test("INC-20261006-DOUBLE-FAILURE-CARD: real App shows one failure card and one retry button", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-double-card-browser-"));
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
    splitting: true, format: "esm", outdir: assetDir, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "remove-only-superseded-error-clause", setup(b) {
      b.onLoad({ filter: /\/components\/MessageRenderer\.tsx$/ }, ({ path }) => {
        assert.equal(resolve(path), rendererPath);
        const contents = readFileSync(path, "utf8");
        const needle = "!isErrorCardSupersededByTurnStatus(m, statusRecordTurnIds)";
        assert.equal(contents.split(needle).length - 1, 1);
        transformCount += 1;
        return { contents: contents.replace(needle, "true"), loader: "tsx" };
      });
    }}] : [], logLevel: "warning",
  });
  assert.equal(transformCount, red ? 1 : 0);
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
      scenario.sent.push(id);
      if (frame.content?.recovery?.automatic === true) scenario.attempts.push(frame.content.recovery.attempt);
      send({ type: "outbound.ack", admitted: true, peer, clientMessageId: id });
      const ts = Date.now();
      // The same failed turn as the server stores it: the verified status record
      // (dispatch never started, not billed) and the assistant error row.
      preview.store.board = structuredClone([
        { id, role: "user", text: frame.content.text, status: "error", ts, _source: "server", _routing: { model: "glm-5.2", effortLevel: "high", teamMode: false } },
        { id: `turn-status:${id}`, role: "system", text: "", _turnStatusRecord: true, _dispatchTerminal: true, _errorCode: "dispatch_lost", ts: ts + 1, _source: "server", _clientMessageId: id },
        { id: `error-${id}`, role: "assistant", text: "", _errorCode: "ENGINE_ERROR", ts: ts + 2, _source: "server", _clientMessageId: id },
      ]);
      preview.store.revision += 1;
      send({ type: "outbound.error", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, code: "ENGINE_ERROR", message: "Context exhausted", isFinal: true, ts: ts + 2 });
    });
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1280, 390]) await t.test(`${width} one failure card, one retry`, async () => {
      scenario = { sent: [], seq: 0, attempts: [] };
      preview.store.board = []; preview.store.older = []; preview.store.revision += 1;
      const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(preview.url);
        await page.getByPlaceholder(/对话/).fill("DOUBLE_CARD_REQUEST");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await page.getByText("消息未开始处理", { exact: true }).waitFor();
        // Every replay fails again, so the shared automatic lineage must run 1..10 and stop. Judge
        // the cards only after it has settled; a fixed 1.5s sample landed mid-retry (OCV5-355).
        // Before the fix the lineage restarted at attempt 2 after each server echo: 80 sends in 10s.
        const deadline = Date.now() + 20_000;
        while (scenario.attempts.length < 10 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
        await new Promise((done) => setTimeout(done, 1500));
        assert.deepEqual(scenario.attempts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "automatic retry lineage climbs 1..10 and stops");
        assert.equal(scenario.sent.length, 11, "the original send plus exactly ten automatic retries");
        const body = await page.locator("body").innerText();
        assert.equal(await page.getByText("消息未开始处理", { exact: true }).count(), 1, "the unbilled status card is shown once");
        assert.equal(await page.getByText("任务执行失败", { exact: true }).count(), 0, "the second red card of the same failure is not shown");
        assert.equal(await page.getByRole("button", { name: /重试|重新尝试/ }).count(), 1, "exactly one retry button");
        assert.match(body, /已确认未计费/);
        assert.deepEqual(errors, []);
        console.log("DOUBLE_CARD_RECEIPT", JSON.stringify({ width, cards: 1, retryButtons: 1, red, transformCount }));
      } catch (error) {
        console.error("DOUBLE_CARD_DIAGNOSTIC", JSON.stringify({ scenario, alerts: await page.getByRole("alert").allInnerTexts(), body: (await page.locator("body").innerText()).slice(-1500), errors }));
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
