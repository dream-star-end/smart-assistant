import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
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
const red = process.env.OC_REQUEST_SIZE_CARD_RED === "1";
const snapshotRed = process.env.OC_REQUEST_SIZE_SNAPSHOT_RED === "1";
const old = "Request too large (max 20MB). Try with a smaller file.";
const partial = "已完成的分析：原始资料均保留。";
const cachedId = "60760760760760760760760760760760";
const cachedTitle = "任务执行失败";
const evidence = process.env.OC_G607_BROWSER_EVIDENCE_DIR
  ?? resolve(here, "../test-results/request-size-card");
let transforms = 0;

test("OCV5-607 request-size cards keep partial answers and hide the fixed English diagnostic",
  { timeout: 180000 }, async (t) => {
    const assetDir = mkdtempSync(join(tmpdir(), "g607-request-card-browser-"));
    mkdirSync(evidence, { recursive: true });
    await build({
      entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
      splitting: true, format: "esm", outdir: assetDir, entryNames: "app",
      chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
      loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
      alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
      define: { "process.env.NODE_ENV": '"production"',
        "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
      plugins: red || snapshotRed ? [{ name: "restore-request-diagnostic-regressions", setup(b) {
        if (red) b.onLoad({ filter: /\/lib\/chat\/render\.ts$/ }, ({ path }) => {
          const source = readFileSync(path, "utf8");
          const needle = '.replace(diagnostic, "").trim()';
          assert.ok(source.includes(needle));
          transforms++;
          return { contents: source.replace(needle, ""), loader: "ts" };
        });
        if (snapshotRed) b.onLoad({ filter: /\/components\/chat\/cards\.tsx$/ }, ({ path }) => {
          const source = readFileSync(path, "utf8");
          const needle = "const legacySize = isLegacyRequestTooLargeDiagnostic(msg._errorCode, msg.text);";
          assert.ok(source.includes(needle));
          transforms++;
          return { contents: source.replace(needle, "const legacySize = false;"), loader: "tsx" };
        });
      }}] : [], logLevel: "warning",
    });
    assert.equal(transforms, Number(red) + Number(snapshotRed));
    const cssDir = join(assetDir, "css-build"); mkdirSync(cssDir);
    await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent",
      plugins: [tailwindcss()], build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false,
        rollupOptions: { input: join(here, "preview-styles.ts"),
          output: { assetFileNames: "styles[extname]" } } } });
    writeFileSync(join(assetDir, "styles.css"),
      readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
    const preview = await startPreviewServer(assetDir);
    // A read-only fixture. Recovery frames cannot generate a mock answer.
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
      browser = await chromium.launch({ executablePath: resolveBrowserExecutable(),
        headless: true, args: ["--no-sandbox"] });
      for (const width of [1280, 390]) {
        for (const shape of ["legacy", "mixed", "separate", "legacy-frozen"]) {
          await t.test(`${width} ${shape}`, async () => {
            const ts = Date.now();
            const cmid = `g607-card-${shape}`;
            const rows = [{ id: cmid, role: "user", text: "请完整处理这些资料。",
              status: "error", ts, _source: "server",
              _routing: { model: "box-api-claude-opus-5-5", effortLevel: "high", teamMode: false } }];
            if (shape === "separate" || shape === "legacy-frozen") rows.push({ id: "partial", role: "assistant", text: partial,
              status: "completed", ts: ts + 1, _source: "server", _clientMessageId: cmid });
            rows.push({ id: "error", role: "assistant",
              text: shape === "mixed" ? `${partial}\n${old}` : old,
              status: shape.startsWith("legacy") ? "completed" : "crashed", ts: ts + 2, _source: "server", _clientMessageId: cmid,
              _errorCode: shape.startsWith("legacy") ? "ENGINE_ERROR" : "request_too_large",
              ...(shape === "legacy-frozen" ? { _errorCardSnapshot: {
                disposition: "card", tone: "red", title: cachedTitle,
                message: "任务执行时遇到内部错误。你的消息已保留，可以直接重试。",
                detail: `${old} request id: ${cachedId}`,
              } } : {}) });
            if (shape === "legacy") rows.push(
              { id: "later-user", role: "user", text: "后续记录。", status: "completed", ts: ts + 3, _source: "server" },
              { id: "later-answer", role: "assistant", text: "后续已完成。", status: "completed", ts: ts + 4, _source: "server", _clientMessageId: "later-user" });
            preview.store.board = structuredClone(rows);
            preview.store.older = []; preview.store.revision++;
            const context = await browser.newContext({ viewport: { width, height: 1100 },
              isMobile: width === 390, hasTouch: width === 390 });
            const page = await context.newPage(); const errors = [];
            page.on("pageerror", (e) => errors.push(e.message));
            try {
              for (const reload of [false, true]) {
                if (reload && shape === "legacy-frozen") {
                  await page.waitForFunction(async ({ id, title, requestId }) => {
                    if (!(await indexedDB.databases()).some((d) => d.name === "ocv5_sessions__u1")) return false;
                    const db = await new Promise((resolve, reject) => {
                      const request = indexedDB.open("ocv5_sessions__u1");
                      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
                    });
                    try {
                      const stored = await new Promise((resolve, reject) => {
                        const request = db.transaction("sessions").objectStore("sessions").get(id);
                        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
                      });
                      return stored?.messages?.some((m) => m.id === "error" && m._errorCardSnapshot?.title === title && m._errorCardSnapshot.detail?.includes(requestId));
                    } finally { db.close(); }
                  }, { id: BOARD_SESSION, title: cachedTitle, requestId: cachedId }, { timeout: 10000 });
                  preview.store.board = preview.store.board.map(({ _errorCardSnapshot: _snapshot, ...row }) => row);
                  preview.store.revision++;
                }
                if (reload) await page.reload(); else await page.goto(preview.url);
                if (shape === "legacy-frozen") await page.getByText(partial, { exact: true }).waitFor();
                // W3:错误卡是懒加载块(错误目录不进首屏),可能比正文晚一帧出现;等卡出来再数。
                await page.getByText("资料暂未处理完成", { exact: true }).waitFor();
                const body = await page.locator("body").innerText();
                assert.equal(await page.getByText("资料暂未处理完成", { exact: true }).count(), 1);
                // W3:卡片正文用错误目录的人话(request_too_large → size)。
                assert.match(body, /请精简消息或分批提交文件/);
                assert.doesNotMatch(body, /Request too large|max 20MB|内部错误/);
                if (shape !== "legacy") assert.ok(body.includes(partial));
                if (shape === "legacy-frozen") {
                  assert.ok(!body.includes(cachedTitle));
                  // W3:请求 ID 在收起的「技术详情」里,展开后可见。
                  const details = page.getByTestId("error-tech-details").filter({ hasText: cachedId });
                  assert.equal(await details.count(), 1, "cached request ID must survive the display projection");
                  await page.getByRole("alert").getByRole("button", { name: /技术详情/ }).click();
                  const detail = await details.innerText();
                  assert.ok(detail.includes(`请求 ID：${cachedId}`));
                  assert.doesNotMatch(detail, /Request too large|max 20MB|内部错误/);
                }
                if (width === 390) assert.ok(await page.evaluate(() =>
                  document.documentElement.scrollWidth <= window.innerWidth + 2));
              }
              await page.screenshot({ path: join(evidence, `${shape}-${width}.png`), fullPage: true });
              assert.deepEqual(errors, []);
              console.log("REQUEST_SIZE_CARD_RECEIPT", JSON.stringify({ width, shape, red, snapshotRed, transforms }));
            } finally { await context.close(); }
          });
        }
      }
    } finally {
      await browser?.close();
      for (const ws of preview.wss.clients) ws.terminate();
      await new Promise((done) => preview.wss.close(done));
      await new Promise((done) => preview.server.close(done));
      rmSync(assetDir, { recursive: true, force: true });
    }
  });

