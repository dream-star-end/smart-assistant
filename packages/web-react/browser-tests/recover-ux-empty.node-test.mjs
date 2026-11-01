import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));

test("INC-20261101-RECOVER-UX-EMPTY: a succeeded automatic recovery does not show 发送失败", { timeout: 180000 }, async () => {
  const assets = join(here, ".tmp-recover-ux-empty");
  rmSync(assets, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  try {
    await build({
      entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
      splitting: true, format: "esm", outdir: assets, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
      loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
      alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
      logLevel: "warning",
    });
    const cssDir = join(assets, "css");
    mkdirSync(cssDir);
    await viteBuild({
      root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()],
      build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } },
    });
    writeFileSync(join(assets, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((name) => name.endsWith(".css")))));
    const preview = await startPreviewServer(assets);
    const source = "m-recover-ux-source";
    const child = "m-recover-ux-child";
    preview.store.board = [
      { id: source, role: "user", text: "请只回复hi", ts: 1, status: "error", _source: "server",
        _routing: { model: "box-api-claude-opus-5-5", teamMode: false, effortLevel: "high" } },
      { id: "err-source", role: "assistant", text: "", ts: 2, _source: "server", _clientMessageId: source,
        _errorCode: "engine_error", _turnTapeId: "tape-source", _turnTapeComplete: true },
      { id: child, role: "user", text: "↻ 自动重试", ts: 3, status: "replied", _source: "server",
        _automaticRecovery: true, _isAutoRetry: true, _recoveryOfClientMessageId: source, _recoveryMode: "replay" },
      { id: "ans-child", role: "assistant", text: "你好，我在。", ts: 4, _source: "server", _clientMessageId: child },
    ];
    preview.store.older = [];
    preview.store.revision += 1;
    preview.store.detailDelayUntil = 0;
    const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(preview.url);
      await page.getByText("请只回复hi", { exact: true }).waitFor();
      await page.getByText("你好，我在。", { exact: true }).waitFor();
      assert.equal(await page.getByText("发送失败", { exact: true }).count(), 0, "a succeeded automatic recovery does not show 发送失败");
      assert.equal(await page.getByRole("button", { name: "继续", exact: true }).count(), 0, "a succeeded automatic recovery does not show 继续");
      assert.equal(await page.getByText("↻ 自动重试", { exact: true }).count(), 0);
      await page.reload();
      await page.getByText("你好，我在。", { exact: true }).waitFor();
      assert.equal(await page.getByText("发送失败", { exact: true }).count(), 0, "a succeeded automatic recovery does not show 发送失败");
      assert.equal(await page.getByRole("button", { name: "继续", exact: true }).count(), 0, "a succeeded automatic recovery does not show 继续");
      assert.deepEqual(pageErrors, []);
    } finally {
      await browser.close();
      for (const ws of preview.wss.clients) ws.terminate();
      await new Promise((done) => preview.wss.close(done));
      await new Promise((done) => preview.server.close(done));
    }
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});
