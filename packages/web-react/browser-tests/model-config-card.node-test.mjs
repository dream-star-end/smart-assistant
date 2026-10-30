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

// INC-20261006-MODEL-CONFIG-CARD-BILLING-COPY in the real App: a Box turn that
// already ran 22 upstream calls (275 credits) is cut mid-turn by the egress
// epoch fence (409 MODEL_CONFIG_CHANGED_RETRY_TURN). The card must not claim
// the whole turn was unbilled, and the button it names must be the one it
// shows: Continue preserves the task and never repeats completed work.
// OC_MODEL_CONFIG_CARD_RED=1 swaps the copy back to the 2026-10-06 wording.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const purePath = resolve(here, "../src/lib/chat/pure.ts");
const red = process.env.OC_MODEL_CONFIG_CARD_RED === "1";
const OLD_COPY =
  "平台的模型配置刚刚更新，本轮已停止（不计费）。你的消息没有丢：点它下方的「重试」即可原样重发。";
let transformCount = 0;

test("INC-20261006-MODEL-CONFIG-CARD-BILLING-COPY: mid-turn config-changed card tells the billing truth and names the button it shows", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-model-config-card-browser-"));
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
    splitting: true, format: "esm", outdir: assetDir, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "restore-old-model-config-copy", setup(b) {
      b.onLoad({ filter: /\/lib\/chat\/pure\.ts$/ }, ({ path }) => {
        assert.equal(resolve(path), purePath);
        const contents = readFileSync(path, "utf8");
        const re = /(model_config_changed_retry_turn:\s*\n\s*)"[^"]*"/;
        assert.match(contents, re);
        transformCount += 1;
        return { contents: contents.replace(re, `$1${JSON.stringify(OLD_COPY)}`), loader: "ts" };
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
      scenario.sent.push(frame);
      send({ type: "outbound.ack", admitted: true, peer, clientMessageId: id });
      const ts = Date.now();
      if (frame.content?.displayText === "继续" && !frame.content?.recovery) {
        preview.store.board.push({ id, role: "user", text: "继续", _modelText: frame.content.text,
          status: "replied", ts, _source: "server" },
          { id: `continued-${id}`, role: "assistant", text: "MODEL_CONFIG_CONTINUED",
            ts: ts + 1, _source: "server", _clientMessageId: id });
        preview.store.revision += 1;
        send({ type: "outbound.message", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq,
          blocks: [{ kind: "text", text: "MODEL_CONFIG_CONTINUED" }], isFinal: true });
        return;
      }
      // The turn as the server stores it after the egress fence: the user row,
      // the assistant text produced before the cut (billed), and the error row.
      preview.store.board = structuredClone([
        { id, role: "user", text: frame.content.text, status: "error", ts, _source: "server", _routing: { model: "box-api-claude-opus-5-5", effortLevel: "high", teamMode: false } },
        { id: `partial-${id}`, role: "assistant", text: "The dry-run passed, and it rolled back as expected. Now applying it for real:", status: "completed", ts: ts + 1, _source: "server", _clientMessageId: id },
        { id: `error-${id}`, role: "assistant", text: "", _errorCode: "MODEL_CONFIG_CHANGED_RETRY_TURN", usage: { costCredits: "275", waived: false }, ts: ts + 2, _source: "server", _clientMessageId: id },
      ]);
      scenario.original = structuredClone(preview.store.board);
      preview.store.revision += 1;
      send({ type: "outbound.error", peer, sessionKey, clientMessageId: id, frameSeq: ++scenario.seq, code: "MODEL_CONFIG_CHANGED_RETRY_TURN", message: "model configuration changed, please retry in a new turn", isFinal: true, ts: ts + 2 });
    });
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1280, 390]) await t.test(`${width} billing truth and one same-session Continue`, async () => {
      scenario = { sent: [], seq: 0 };
      preview.store.board = []; preview.store.older = []; preview.store.revision += 1;
      const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(preview.url);
        await page.getByPlaceholder(/对话/).fill("MODEL_CONFIG_CARD_REQUEST");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await page.getByText("模型配置已更新，请重发", { exact: true }).waitFor();
        await new Promise((done) => setTimeout(done, 1500));
        const body = await page.locator("body").innerText();
        assert.equal(await page.getByText("模型配置已更新，请重发", { exact: true }).count(), 1, "the config-changed card is shown once");
        assert.doesNotMatch(body, /本轮已停止（不计费）/, "the card must not claim the whole turn was unbilled");
        assert.match(body, /停止前已完成的调用照常计费/, "the card says the completed calls were billed");
        assert.match(body, /被拒的这一次不计费/, "the card says only the rejected call is unbilled");
        const go = page.getByRole("button", { name: "继续", exact: true });
        assert.equal(await go.count(), 1, "one Continue instead of replaying completed work");
        assert.equal(await page.getByRole("button", { name: /^(重试|重新尝试|重新发送)$/ }).count(), 0);
        assert.doesNotMatch(body, /「重新尝试」|「重试」|原样重发/);
        await go.click();
        await page.getByText("MODEL_CONFIG_CONTINUED", { exact: true }).waitFor();
        assert.equal(scenario.sent.length, 2);
        const follow = scenario.sent[1];
        assert.equal(follow.peer.id, BOARD_SESSION);
        assert.notEqual(follow.clientMessageId, scenario.sent[0].clientMessageId);
        assert.equal(follow.content.recovery, undefined);
        assert.equal(follow.content.displayText, "继续");
        assert.notEqual(follow.content.text, "MODEL_CONFIG_CARD_REQUEST");
        assert.match(follow.content.text, /MODEL_CONFIG_CARD_REQUEST/);
        assert.match(follow.content.text, /不要重新执行已经完成的步骤/);
        assert.deepEqual(preview.store.board.slice(0, scenario.original.length), scenario.original);
        assert.deepEqual(errors, []);
        console.log("MODEL_CONFIG_CARD_RECEIPT", JSON.stringify({ width, cards: 1, continueButtons: 1, red, transformCount }));
      } catch (error) {
        console.error("MODEL_CONFIG_CARD_DIAGNOSTIC", JSON.stringify({ scenario, alerts: await page.getByRole("alert").allInnerTexts(), body: (await page.locator("body").innerText()).slice(-1500), errors }));
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
