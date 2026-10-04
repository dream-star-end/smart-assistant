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

// INC-20261002-CONTINUE-CARD-LINGERS in the real App: a turn fails after a
// Bash step whose effect is not proven read-only, so recovery is manual. The
// user clicks 从断点继续 on the committed card; the continuation runs and the
// card must leave the timeline. OC_CONTINUE_CARD_RED=1 removes only the
// manual-continuation clause from MessageList and reproduces the incident.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = resolve(here, "../src/components/MessageRenderer.tsx");
const red = process.env.OC_CONTINUE_CARD_RED === "1";
let transformCount = 0;

async function until(label, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((done) => setTimeout(done, 30)); }
  throw new Error(`${label}: timed out`);
}

test("INC-20261002-CONTINUE-CARD-LINGERS: real App click on 从断点继续 retires the committed card", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-continue-card-browser-"));
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
    splitting: true, format: "esm", outdir: assetDir, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "remove-only-manual-continuation-clause", setup(b) {
      b.onLoad({ filter: /\/components\/MessageRenderer\.tsx$/ }, ({ path }) => {
        assert.equal(resolve(path), rendererPath);
        const contents = readFileSync(path, "utf8");
        const needle = "manuallyContinuedSourceIds.has(m._clientMessageId))";
        assert.equal(contents.split(needle).length - 1, 1);
        transformCount += 1;
        return { contents: contents.replace(needle, "false)"), loader: "tsx" };
      });
    }}] : [], logLevel: "warning",
  });
  assert.equal(transformCount, red ? 1 : 0);
  const cssDir = join(assetDir, "css-build"); mkdirSync(cssDir);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()], build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(assetDir, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
  const preview = await startPreviewServer(assetDir);
  // Keep the real HTTP/session fixture; replace only its LLM/WS story.
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
      const recovery = frame.content?.recovery;
      const id = frame.clientMessageId;
      const peer = { id: BOARD_SESSION, kind: "dm" };
      const sessionKey = `agent:main:webchat:dm:${BOARD_SESSION}`;
      if (recovery) {
        scenario.children.push({ id, automatic: recovery.automatic, mode: recovery.mode, source: recovery.sourceClientMessageId });
        if (scenario.decline) {
          return send({ type: "outbound.ack", peer, clientMessageId: id, sourceClientMessageId: scenario.source, recoverySkipped: true, recoverySkippedReason: "source_not_recoverable" });
        }
        send({ type: "outbound.ack", admitted: true, peer, clientMessageId: id });
        // The continuation is running a tool and has produced no text yet:
        // the state the incident was reported in (工具执行中).
        const bashId = `bash-${id}`;
        send({ type: "outbound.message", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, blocks: [{ kind: "tool_use", blockId: bashId, toolName: "Bash", messageId: bashId, partial: false, inputJson: { command: "echo CONTINUE_RESUMED_TOOL" } }], isFinal: false });
        scenario.running = true;
        scenario.finish = () => {
          send({ type: "outbound.message", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, blocks: [{ kind: "tool_result", blockId: `${bashId}:result`, toolUseBlockId: bashId, toolName: "Bash", isError: false, output: "ok" }], isFinal: false });
          preview.store.board.push({ id, role: "user", text: frame.content.displayText, ts: Date.now(), status: "replied", _source: "server" }, { id: `answer-${id}`, role: "assistant", text: "CONTINUE_RESUMED_ANSWER", ts: Date.now() + 1, _clientMessageId: id, _source: "server" });
          send({ type: "outbound.message", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, blocks: [{ kind: "text", text: "CONTINUE_RESUMED_ANSWER", messageId: `answer-${id}` }], isFinal: true });
        };
        return;
      }
      assert.equal(scenario.source, null, "only one original Composer request");
      scenario.source = id;
      send({ type: "outbound.ack", admitted: true, peer, clientMessageId: id });
      const ts = Date.now();
      // The Bash step completed without an authoritative effect record, so the
      // checkpoint is not provably safe and recovery stays manual.
      const rows = [
        { id, role: "user", text: frame.content.text, status: "error", ts, _source: "server", _routing: { model: "glm-5.2", effortLevel: "high", teamMode: false } },
        { id: `tool-${id}`, role: "tool", text: "终端", toolName: "Bash", inputJson: { command: "echo CONTINUE_SAVED_TOOL" }, output: "CONTINUE_TOOL_RESULT", _completed: true, ts: ts + 1, _source: "server", _turnTapeId: "tape-continue", _clientMessageId: id },
        { id: `error-${id}`, role: "assistant", text: "", _errorCode: "ENGINE_ERROR", ts: ts + 2, _source: "server", _turnTapeId: "tape-continue", _clientMessageId: id },
      ];
      preview.store.board = structuredClone(rows);
      preview.store.revision += 1;
      send({ type: "outbound.error", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, code: "ENGINE_ERROR", message: "Context exhausted", isFinal: true, ts: ts + 2 });
    });
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const [width, decline] of [[1280, false], [390, false], [1280, true]]) await t.test(`${width} ${decline ? "declined continuation brings the card back" : "running continuation retires the card"}`, async () => {
      scenario = { source: null, children: [], seq: 0, decline, finish: null, running: false };
      preview.store.board = []; preview.store.older = []; preview.store.revision += 1;
      const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(preview.url);
        await page.getByPlaceholder(/对话/).fill("CONTINUE_ORIGINAL_REQUEST");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        const card = page.getByRole("alert");
        await card.waitFor();
        const resume = page.getByRole("button", { name: "从断点继续" });
        await resume.waitFor();
        assert.equal(await card.count(), 1, "one committed failure card");
        assert.equal(scenario.children.length, 0, "an unproven Bash effect is never continued automatically");
        if (width === 390) await resume.tap(); else await resume.click();
        await until("the manual continuation reaches the server", () => scenario.children.length === 1);
        assert.deepEqual(scenario.children[0], { id: scenario.children[0].id, automatic: false, mode: "checkpoint", source: scenario.source });
        if (decline) {
          await until("the declined card is back with its notice", async () =>
            (await card.count()) === 1 && (await card.innerText()).includes("未从断点继续"));
          assert.equal(await page.getByRole("button", { name: "从断点继续" }).count(), 0, "a declined continuation is not offered again");
          assert.deepEqual(errors, []);
          console.log("CONTINUE_CARD_RECEIPT", JSON.stringify({ width, decline, children: 1, cardBack: true, red, transformCount }));
          return;
        }
        await until("the continuation is running its tool", () => scenario.running === true);
        const settle = () => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 400)));
        await settle();
        // While the continuation runs the source card is resolved, not a live failure.
        assert.equal(await card.count(), 0, "running continuation: the committed failure card is retired");
        assert.equal(await page.getByRole("button", { name: /重新尝试|从断点继续/ }).count(), 0, "running continuation: no retry or resume button remains");
        scenario.finish();
        await page.getByText("CONTINUE_RESUMED_ANSWER", { exact: true }).waitFor();
        await settle();
        assert.equal(await card.count(), 0, "finished continuation: the card stays retired");
        assert.equal(await page.getByRole("button", { name: /重新尝试|从断点继续/ }).count(), 0, "finished continuation: no retry or resume button");
        assert.deepEqual(errors, []);
        console.log("CONTINUE_CARD_RECEIPT", JSON.stringify({ width, decline, children: 1, retired: true, red, transformCount }));
      } catch (error) {
        console.error("CONTINUE_CARD_DIAGNOSTIC", JSON.stringify({ scenario: { ...scenario, finish: undefined }, alerts: await page.getByRole("alert").allInnerTexts(), body: (await page.locator("body").innerText()).slice(-1500), errors }));
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
