import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
const red = process.env.OC_RETRY_ERROR_UI_RED ?? "";
const retryActivity = /^正在自动重试(?:（第 \d+ 次）|…)$/;
assert.ok(["", "legacy", "history", "phase-a"].includes(red));
let transforms = 0;
async function until(label, check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise((done) => setTimeout(done, 30)); }
  throw new Error(`${label}: timed out`);
}
function historyMode(mode) { return mode === "cold" || mode === "phase-a"; }
function sourceRows(id, exhausted = false, decisionPending = false) {
  return [
    { id, role: "user", text: "请完成核验任务", ts: 1, status: "error", _source: "server",
      _routing: { model: "box-api-claude-opus-5-5", teamMode: false, effortLevel: "high" } },
    { id: `thinking-${id}`, role: "thinking", text: "已完成第一步核验", ts: 2, _source: "server", _clientMessageId: id, _turnTapeId: `tape-${id}` },
    { id: `error-${id}`, role: "assistant", text: "", ts: 3, _source: "server", _clientMessageId: id,
      _turnTapeId: `tape-${id}`, _turnTapeComplete: true, _dispatchOutcome: "error", _errorCode: "engine_error",
      _automaticRecoveryDecisionPending: decisionPending,
      ...(exhausted ? { _automaticRetryRootClientMessageId: id, _automaticRetryAttempt: 10, _automaticRetryMax: 10 } : {}) },
  ];
}

test("INC-20261019-RECOVERABLE-ERROR-RED-CARD: real App retries stay soft and only terminal failures paint a card", { timeout: 180000 }, async (t) => {
  const assets = mkdtempSync(join(tmpdir(), "oc-retry-ui-"));
  t.after(() => rmSync(assets, { recursive: true, force: true }));
  const shots = process.env.OC_RETRY_ERROR_UI_SHOTS ?? assets;
  mkdirSync(shots, { recursive: true });
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
    splitting: true, format: "esm", outdir: assets, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "remove-one-real-retry-ui-fix", setup(b) {
      b.onLoad({ filter: /\/lib\/chat\/(socket|automaticRecoverySnapshot)\.ts$/ }, ({ path }) => {
        if ((red === "phase-a") !== path.endsWith("/automaticRecoverySnapshot.ts")) return;
        let contents = readFileSync(path, "utf8");
        const needle = red === "legacy"
          ? "    if (!masterOwned && !this.deps.syncSession) return false;"
          : red === "history" ? "    applyAutomaticRecoverySnapshot(s, msgs, archive?.automaticRecoveries, {"
          : "      if (!job && !decisionPending) {";
        assert.equal(contents.split(needle).length - 1, 1);
        const replacement = red === "legacy" ? "    if (!masterOwned) return false;"
          : red === "history" ? "    applyAutomaticRecoverySnapshot(s, msgs, undefined, {"
          : "      if (!job) {";
        contents = contents.replace(needle, replacement);
        transforms += 1;
        return { contents, loader: "ts" };
      });
    }}] : [], logLevel: "warning",
  });
  assert.equal(transforms, red ? 1 : 0);
  const cssDir = join(assets, "css"); mkdirSync(cssDir);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()], build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(assets, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((name) => name.endsWith(".css")))));
  const preview = await startPreviewServer(assets);
  preview.wss.removeAllListeners("connection");
  let scenario;
  preview.wss.on("connection", (ws) => {
    const peer = { id: BOARD_SESSION, kind: "dm" };
    const send = (frame) => ws.readyState === 1 && ws.send(JSON.stringify(frame));
    const ready = () => send({ type: "sys.relay_ready", ...(historyMode(scenario.mode) ? { automaticRecoveryOwner: "master-v1" } : {}) });
    ready();
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ping") return send({ type: "pong", id: frame.id });
      if (frame.type === "inbound.hello") return ready();
      if (frame.type !== "inbound.message") return;
      scenario.sends += 1;
      const id = frame.clientMessageId;
      const sessionKey = `agent:main:webchat:dm:${BOARD_SESSION}`;
      send({ type: "outbound.ack", admitted: true, peer, clientMessageId: id });
      if (frame.content?.recovery) {
        assert.equal(frame.content.recovery.sourceClientMessageId, scenario.source);
        assert.equal(frame.content.recovery.mode, "checkpoint");
        preview.store.board.push({ id, role: "user", text: frame.content.displayText, ts: 4,
          status: "replied", _source: "server", _automaticRecovery: true, _recoveryOfClientMessageId: scenario.source },
          { id: `answer-${id}`, role: "assistant", text: "恢复后任务已完成", ts: 5, _source: "server", _clientMessageId: id });
        preview.store.revision += 1;
        send({ type: "outbound.message", peer, sessionKey, clientMessageId: id,
          frameSeq: ++scenario.seq, blocks: [{ kind: "text", text: "恢复后任务已完成" }], isFinal: true });
        return;
      }
      scenario.source = id;
      preview.store.board = sourceRows(id, scenario.mode === "terminal");
      preview.store.revision += 1;
      // Keep the authority read pending long enough to inspect the actual
      // transient UI. This delays the HTTP fixture, not product retry timers.
      scenario.hold = true;
      send({ type: "outbound.error", peer, sessionKey, clientMessageId: id,
        frameSeq: ++scenario.seq, code: "engine_error", message: "temporary model error" });
      send({ type: "outbound.message", peer, sessionKey, clientMessageId: id,
        frameSeq: ++scenario.seq, blocks: [{ kind: "text", text: "[error] temporary model error" }], isFinal: true });
    });
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1280, 390]) for (const mode of ["success", "terminal", "cold", "phase-a"]) {
      await t.test(`${width} ${mode}`, async () => {
        scenario = { mode, source: historyMode(mode) ? `m-${mode}-proof-source` : null, sends: 0, seq: 0, active: true, decisionPending: mode === "phase-a", hold: false, releaseReads: [] };
        preview.store.board = historyMode(mode) ? sourceRows(scenario.source, false, scenario.decisionPending) : [];
        preview.store.older = []; preview.store.revision += 1; preview.store.detailDelayUntil = 0;
        const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390 });
        const page = await context.newPage(); const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        let closing = false;
        await page.route(`**/api/sessions/${BOARD_SESSION}**`, async (route) => {
          try {
            const isDetail = new URL(route.request().url()).pathname === `/api/sessions/${BOARD_SESSION}`;
            if (isDetail && scenario.hold) await new Promise((done) => scenario.releaseReads.push(done));
            const response = await route.fetch();
            if (!historyMode(scenario.mode) || !isDetail) return await route.fulfill({ response });
            const body = await response.json();
            body.automaticRecoveries = scenario.active && !scenario.decisionPending ? [{ sourceClientMessageId: scenario.source,
              rootClientMessageId: scenario.source, clientMessageId: "m-cold-proof-child", errorCode: "engine_error", mode: "checkpoint", attempt: 1 }] : [];
            await route.fulfill({ response, json: body });
          } catch (error) { if (!closing) throw error; }
        });
        const shot = (stage) => page.screenshot({ path: join(shots, `retry-error-${red || "green"}-${width}-${mode}-${stage}.png`), fullPage: true });
        try {
          await page.goto(preview.url);
          if (!historyMode(mode)) {
            await page.getByPlaceholder(/对话/).fill("请完成核验任务");
            await page.getByRole("button", { name: "发送", exact: true }).click();
          }
          await until("pending retry activity or the old red card", async () =>
            await page.getByText(retryActivity).first().isVisible() ||
            await page.getByText("任务执行失败", { exact: true }).first().isVisible());
          await shot("pending");
          assert.equal(await page.getByText("任务执行失败", { exact: true }).count(), 0, "recoverable errors never paint a red card");
          assert.equal(await page.getByText(retryActivity).count(), 1, "one shared retry activity");
          assert.equal(await page.getByText("发送失败", { exact: true }).count(), 0, "a recovering source is not a failed send");
          scenario.hold = false;
          for (const done of scenario.releaseReads.splice(0)) done();
          if (historyMode(mode)) {
            await page.reload();
            await page.getByText(retryActivity).waitFor();
            assert.equal(await page.getByText("任务执行失败", { exact: true }).count(), 0);
            if (mode === "phase-a") {
              scenario.decisionPending = false;
              preview.store.board = sourceRows(scenario.source);
              preview.store.revision += 1;
              await page.reload();
              await page.getByText(retryActivity).waitFor();
              assert.equal(await page.getByText("任务执行失败", { exact: true }).count(), 0,
                "phase B job adoption never flashes a terminal card");
            }
            scenario.active = false;
            await page.reload();
          }
          if (mode === "success") {
            await page.getByText("恢复后任务已完成", { exact: true }).waitFor();
            assert.equal(scenario.sends, 2, "one source plus one existing checkpoint recovery");
            await page.reload();
            await page.getByText("恢复后任务已完成", { exact: true }).waitFor();
            assert.equal(await page.getByText("任务执行失败", { exact: true }).count(), 0);
            assert.equal(await page.getByText(retryActivity).count(), 0, "success remains settled after reload");
            assert.equal(await page.getByText("发送失败", { exact: true }).count(), 0, "a recovered source remains delivered after reload");
          } else {
            await page.getByText("任务执行失败", { exact: true }).waitFor();
            assert.equal(await page.getByText("任务执行失败", { exact: true }).count(), 1, "a confirmed terminal failure paints exactly one card");
            assert.equal(await page.getByText(retryActivity).count(), 0);
            if (mode === "terminal") assert.equal(scenario.sends, 1, "exhausted budget never dispatches again");
          }
          await shot("final");
          assert.deepEqual(pageErrors, []);
          console.log("RETRY_UI_RECEIPT", JSON.stringify({ width, mode, red, transforms, sends: scenario.sends }));
        } finally {
          closing = true; scenario.hold = false;
          for (const done of scenario.releaseReads.splice(0)) done();
          await context.close();
        }
      });
    }
  } finally {
    await browser?.close();
    for (const ws of preview.wss.clients) ws.terminate();
    await new Promise((done) => preview.wss.close(done));
    await new Promise((done) => preview.server.close(done));
  }
});
