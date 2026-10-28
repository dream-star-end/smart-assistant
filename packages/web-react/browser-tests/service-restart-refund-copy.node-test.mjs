import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

// INC-20261028-SERVICE-RESTART-REFUND-COPY in the real App: a turn the server
// closed as SERVICE_RESTART (verified status record, no turn waiver) must not
// claim 「本轮未计费 / 积分已原路退回」. OC_RESTART_REFUND_RED=1 restores only the
// forced waiver in TurnStatusCard and reproduces the t1133 card.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const cardsPath = resolve(here, "../src/components/chat/cards.tsx");
const red = process.env.OC_RESTART_REFUND_RED === "1";
let transformCount = 0;

test("INC-20261028-SERVICE-RESTART-REFUND-COPY: real App SERVICE_RESTART status card without a turn waiver claims no refund", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-restart-refund-browser-"));
  t.after(() => rmSync(assetDir, { recursive: true, force: true }));
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
    splitting: true, format: "esm", outdir: assetDir, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "restore-forced-status-waiver", setup(b) {
      b.onLoad({ filter: /\/components\/chat\/cards\.tsx$/ }, ({ path }) => {
        assert.equal(resolve(path), cardsPath);
        const contents = readFileSync(path, "utf8");
        const needle = 'normalizeTurnErrorCode(msg._errorCode) !== "service_restart" || msg.usage?.waived === true';
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
  // Read-only fixture: history only, no generated answers.
  preview.wss.removeAllListeners("connection");
  preview.wss.on("connection", (ws) => {
    const send = (f) => ws.readyState === 1 && ws.send(JSON.stringify(f));
    send({ type: "sys.relay_ready" });
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "ping") send({ type: "pong", id: f.id });
      if (f.type === "inbound.hello") send({ type: "sys.relay_ready" });
    });
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1280, 390]) await t.test(`${width} SERVICE_RESTART status card`, async () => {
      const ts = Date.now();
      const id = "t1133-restart-turn";
      // As the server stores the t1133 turn: the user row, the verified
      // executed_error status record, and the silent SERVICE_RESTART tape row.
      preview.store.board = structuredClone([
        { id, role: "user", text: "怎么根治", status: "error", ts, _source: "server", _routing: { model: "k3.1-pro", effortLevel: "high", teamMode: false } },
        { id: `turn-status:${id}`, role: "system", text: "", _turnStatusRecord: true, _dispatchTerminal: true, _dispatchLost: true, _errorCode: "SERVICE_RESTART", ts: ts + 1, _source: "server", _clientMessageId: id },
        { id: `restart-${id}`, role: "assistant", text: "任务因服务重启中断，此前已生成的过程已完整保留", _errorDetail: "任务因服务重启中断，此前已生成的过程已完整保留", _errorCode: "SERVICE_RESTART", status: "crashed", ts: ts + 2, _source: "server", _clientMessageId: id },
      ]);
      preview.store.older = []; preview.store.revision += 1;
      const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(preview.url);
        await page.getByText("任务已中断", { exact: true }).waitFor();
        const body = await page.locator("body").innerText();
        assert.equal(await page.getByText("任务已中断", { exact: true }).count(), 1, "one interruption status card");
        assert.doesNotMatch(body, /未计费|原路退回|已免单/, "no refund claim without a turn waiver");
        assert.match(body, /中断前已完成的部分按实际用量计费/);
        assert.deepEqual(errors, []);
        console.log("RESTART_REFUND_COPY_RECEIPT", JSON.stringify({ width, red, transformCount }));
      } catch (error) {
        console.error("RESTART_REFUND_COPY_DIAGNOSTIC", JSON.stringify({ body: (await page.locator("body").innerText()).slice(-1500), errors }));
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
