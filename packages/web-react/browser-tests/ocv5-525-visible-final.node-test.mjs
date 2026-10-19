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
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const red = process.env.OC_VISIBLE_FINAL_RED === "1";
const summary = "方案已复核，修改已推送。完整总结应该直接可见。";
const owner = "u-visible-final";
const stamp = (id, role, text, extra = {}) => ({ id, role, text, ts: Date.now() - 60_000, _source: "server", _clientMessageId: owner, ...extra });
function board() {
  const rows = [stamp(owner, "user", "接手任务并复核方案", { status: "replied" })];
  for (let n = 0; n < 30; n++) rows.push(stamp(`bash-${n}`, "tool", "", { toolName: "Bash", inputJson: { command: `probe-${n}` }, _completed: true, output: "ok" }));
  for (let n = 0; n < 12; n++) rows.push(stamp(`tool-${n}`, "tool", "", { toolName: "ExecuteExtraTool", _completed: true, output: "ok" }));
  for (let n = 0; n < 13; n++) rows.push(stamp(`thinking-${n}`, "thinking", "核对方案中的证据。"));
  for (let n = 0; n < 8; n++) rows.push(stamp(`narration-${n}`, "assistant", "正在核对已有工具结果。"));
  rows.push(stamp("summary-visible-final", "assistant", summary));
  rows.push(stamp("tool-approval", "tool", "", { toolName: "ExecuteExtraTool", _completed: true, output: "ok" }));
  rows.push(stamp("prediction-visible-final", "assistant", '```ui\n{"type":"next","text":"通过"}\n```', { status: "completed", usage: { costCredits: "583", traceId: "trace-visible-final", totalTokens: 5845449 } }));
  return rows.map((r, i) => ({ ...r, _orderSeq: i + 1 }));
}

test("OCV5-525: completed summary stays visible when the last assistant is only input prediction", { timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oc-visible-final-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let ablations = 0;
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true, splitting: true, format: "esm", outdir: dir, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "legacy-raw-final", setup(api) {
      api.onLoad({ filter: /\/lib\/assistantVisibleContent\.ts$/ }, () => {
        ablations++;
        return { contents: 'export function hasVisibleAssistantContent(text: string): boolean { return text.trim().length > 0; }', loader: "ts" };
      });
    }}] : [], logLevel: "warning",
  });
  assert.equal(ablations, red ? 1 : 0, "negative control changes the production display predicate only");
  const css = join(dir, "css"); mkdirSync(css);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()], build: { outDir: css, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(dir, "styles.css"), readFileSync(join(css, readdirSync(css).find((n) => n.endsWith(".css")))));
  const server = await startPreviewServer(dir);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1280, 390]) await t.test(`${width}: summary, prediction and replay`, async () => {
      server.store.board = board(); server.store.older = []; server.store.revision++;
      const context = await browser.newContext({ viewport: { width, height: 1100 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(server.url);
        await page.getByTestId("process-toggle").waitFor();
        await page.getByTestId("composer-prediction").waitFor();
        const shots = process.env.OC_VISIBLE_FINAL_SHOTS;
        if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${red ? "before" : "after"}-${width}.png`), fullPage: true }); }
        assert.equal(await page.getByText(summary, { exact: true }).count(), 1, "the completed task summary is visible without expanding steps");
        assert.equal(await page.getByText(summary, { exact: true }).evaluate((el) => el.closest('[data-testid="process-disclosure"]') === null), true);
        assert.equal(await page.getByTestId("assistant-row").count(), 1, "no empty assistant row for the prediction block");
        assert.match(await page.getByTestId("composer-prediction").innerText(), /通过/, "input prediction still consumes the raw tail");
        await page.getByRole("button", { name: "更多操作", exact: true }).last().click();
        await page.getByRole("menuitem", { name: "复制请求ID trace-visible-final", exact: true }).waitFor();
        assert.equal(await page.getByLabel("消耗 583 积分", { exact: true }).last().isVisible(), true, "the total charge stays available on the answer");
        await page.keyboard.press("Escape");
        await page.reload();
        await page.getByText(summary, { exact: true }).waitFor();
        assert.equal(await page.getByTestId("assistant-row").count(), 1);
        // First open of the lazy share dialog must retain the Markdown download on both layouts.
        if (width === 390) {
          await page.locator('button[data-product-control][aria-label="更多操作"]').click();
          await page.getByRole("menuitem", { name: "分享", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "分享会话", exact: true }).click();
        }
        const exportButton = page.getByRole("button", { name: "导出 Markdown", exact: true });
        await exportButton.waitFor({ state: "visible" });
        await exportButton.evaluate((button) => {
          button.addEventListener("click", () => {
            const title = document.querySelector("h1.sr-only")?.textContent?.trim();
            if (!title) throw new Error("missing current session heading at export click");
            button.setAttribute("data-ocv5-export-title", title);
          }, { capture: true, once: true });
        });
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          exportButton.click(),
        ]);
        const titleAtClick = await exportButton.getAttribute("data-ocv5-export-title");
        assert.ok(titleAtClick, "the download title is captured at the actual user click");
        assert.equal(download.suggestedFilename(), `${titleAtClick}.md`);
        assert.ok(readFileSync(await download.path(), "utf8").includes(summary), "cold lazy export includes the actual final answer");
        assert.deepEqual(errors, []);
        console.log("VISIBLE_FINAL_RECEIPT", JSON.stringify({ width, red, ablations, visibleSummary: true, replay: true, prediction: "通过", markdownExport: true }));
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    for (const ws of server.wss.clients) ws.terminate();
    await new Promise((done) => server.wss.close(done));
    await new Promise((done) => server.server.close(done));
  }
});
