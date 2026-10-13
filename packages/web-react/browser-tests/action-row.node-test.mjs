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

// INC-20261012-TURN-DUPLICATE-ACTION-ROW in the real App (OCV5-390): one visible turn made of the
// source attempt (text before a tool, the tool, an error) and its hidden automatic recovery child
// (text before a tool, the tool, the final answer) shows exactly one copy / more row, under the final
// answer; when the retries end on an error, none. OC_ACTION_ROW_RED=1 removes only the lineage and the
// error-ended gate from MessageRenderer and reproduces the duplicate rows.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = resolve(here, "../src/components/MessageRenderer.tsx");
const red = process.env.OC_ACTION_ROW_RED === "1";
let transformCount = 0;

async function until(label, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((done) => setTimeout(done, 30)); }
  throw new Error(`${label}: timed out`);
}


const ts0 = Date.now() - 60_000;
const s = (id, extra) => ({ id, ts: ts0 + Number(id.split("-").pop()), _source: "server", ...extra });
function board(ending) {
  const user = "m-action-row-u";
  const child = "m-action-row-r";
  return [
    s(`${user}-0`, { id: user, role: "user", text: "看看这两张截图", status: "replied", _routing: { model: "box-claude-haiku-5-5", effortLevel: "high", teamMode: false } }),
    s("a1-pre-1", { role: "assistant", text: "我先看一下截图。", _clientMessageId: user }),
    s("a1-read-2", { role: "tool", text: "", toolName: "Read", inputJson: { file_path: "a.png" }, _completed: true, output: "ok", _clientMessageId: user }),
    s("a1-err-3", { role: "assistant", text: "", _errorCode: "ENGINE_ERROR", _clientMessageId: user }),
    s(`${child}-4`, { id: child, role: "user", text: "AUTO_RECOVERY_CONTROL_ROW", _automaticRecovery: true, _isAutoRetry: true, _recoveryOfClientMessageId: user }),
    s("a2-pre-5", { role: "assistant", text: "我看一下手机亮色这张。", _clientMessageId: child }),
    s("a2-read-6", { role: "tool", text: "", toolName: "Read", inputJson: { file_path: "b.png" }, _completed: true, output: "ok", _clientMessageId: child }),
    ending === "answer"
      ? s("a2-final-7", { role: "assistant", text: "两张截图都看完了：布局一致。", _clientMessageId: child })
      : s("a2-err-7", { role: "assistant", text: "", _errorCode: "ENGINE_ERROR", _clientMessageId: child }),
  ];
}

test("INC-20261012-TURN-DUPLICATE-ACTION-ROW: real App shows one action row per turn, under its final answer only", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-action-row-browser-"));
  t.after(() => rmSync(assetDir, { recursive: true, force: true }));
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true,
    splitting: true, format: "esm", outdir: assetDir, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "remove-turn-lineage-and-error-gate", setup(b) {
      b.onLoad({ filter: /\/components\/MessageRenderer\.tsx$/ }, ({ path }) => {
        assert.equal(resolve(path), rendererPath);
        let contents = readFileSync(path, "utf8");
        for (const [needle, replacement] of [
          ["turnFinalAssistantFlags(renderableMessages, recoveryParents)", "turnFinalAssistantFlags(renderableMessages)"],
          ["turnRatingFlags(renderableMessages, ratingFinal, recoveryParents)", "ratingFinal"],
        ]) {
          assert.equal(contents.split(needle).length - 1, 1, needle);
          contents = contents.replace(needle, replacement);
        }
        transformCount += 1;
        return { contents, loader: "tsx" };
      });
    }}] : [], logLevel: "warning",
  });
  assert.equal(transformCount, red ? 1 : 0);
  const cssDir = join(assetDir, "css-build"); mkdirSync(cssDir);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()], build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(assetDir, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
  const preview = await startPreviewServer(assetDir);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1280, 390]) for (const ending of ["answer", "error"]) {
      await t.test(`${width} ${ending}: ${ending === "answer" ? "one row, under the final answer" : "no row on any text"}`, async () => {
        preview.store.board = board(ending); preview.store.older = []; preview.store.revision += 1;
        const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390 });
        const page = await context.newPage(); const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        try {
          await page.goto(preview.url);
          await page.getByText(ending === "answer" ? "两张截图都看完了：布局一致。" : "看看这两张截图", { exact: true }).first().waitFor();
          await new Promise((done) => setTimeout(done, 800));
          await page.screenshot({ path: join(process.env.OC_ACTION_ROW_SHOTS ?? assetDir, `action-row-${red ? "red" : "green"}-${width}-${ending}.png`), fullPage: true });
          const count = async (name) => {
            let n = 0;
            for (const b of await page.getByRole("button", { name, exact: true }).all()) {
              // the turn's assistant action rows only (not the user bubble, not the mobile top bar menu)
              if (await b.evaluate((el) => el.closest("[data-testid=assistant-footer]") !== null)) n += 1;
            }
            return n;
          };
          const copies = await count("复制");
          const more = await count("更多操作");
          assert.equal(await page.getByText("AUTO_RECOVERY_CONTROL_ROW").count(), 0, "the recovery control row stays hidden");
          assert.equal(copies, ending === "answer" ? 1 : 0, "copy buttons on the turn's assistant rows");
          assert.equal(more, ending === "answer" ? 1 : 0, "more-actions buttons on the turn's assistant rows");
          if (ending === "answer") {
            const footerText = await page.getByRole("button", { name: "复制", exact: true }).last()
              .evaluate((el) => el.closest("[data-testid=assistant-footer]")?.parentElement?.textContent ?? "");
            assert.match(footerText, /两张截图都看完了/);
          }
          assert.deepEqual(errors, []);
          console.log("ACTION_ROW_RECEIPT", JSON.stringify({ width, ending, copies, more, red, transformCount }));
        } finally { await context.close(); }
      });
    }
  } finally {
    await browser?.close();
    for (const ws of preview.wss.clients) ws.terminate();
    await new Promise((done) => preview.wss.close(done));
    await new Promise((done) => preview.server.close(done));
  }
});
