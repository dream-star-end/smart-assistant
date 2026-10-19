import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { buildHarnessPage, serveHarnessPage } from "./harness-page.mjs";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const red = process.env.OC_UX_EXPORT_RED === "1";
const shots = process.env.OC_UX_EVIDENCE_DIR;

test("OCV5-507 sharing and Markdown downloads contain final answers and portable artifact references", { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-share-export-"));
  const plugins = red ? [{ name: "old-export-projection", setup(build) {
    build.onLoad({ filter: /\/(exportMarkdown|shareCard)\.ts$/ }, ({ path }) => ({ contents: execFileSync("git", ["show", `98e728220:packages/web-react/src/lib/chat/${path.split("/").pop()}`], { cwd: root, encoding: "utf8" }), loader: "ts" }));
  } }] : [];
  await buildHarnessPage({ harness: "share-export-harness.tsx", assetDir: dir, plugins });
  const server = await serveHarnessPage(dir);
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, acceptDownloads: true });
      await page.addInitScript(() => {
        window.__canvasText = [];
        const fill = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (text, ...args) { window.__canvasText.push(String(text)); return fill.call(this, text, ...args); };
        Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.__copied = text; } }, configurable: true });
      });
      await page.goto(server.url);
      await page.getByRole("button", { name: "复制文字", exact: true }).waitFor();
      await page.getByRole("radio", { name: "全部", exact: true }).click();
      await page.getByRole("button", { name: "复制文字", exact: true }).click();
      await page.waitForFunction(() => window.__copied?.includes("销售"));
      const event = page.waitForEvent("download");
      await page.getByRole("button", { name: "导出 Markdown" }).click();
      const download = await event;
      assert.equal(download.suggestedFilename(), "销售分析.md");
      const md = readFileSync(await download.path(), "utf8");
      const copy = await page.evaluate(() => window.__copied);
      const canvas = await page.evaluate(() => window.__canvasText.join("\n"));
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, `export-${red ? "before" : "after"}-${width}.png`), fullPage: true });
        await download.saveAs(join(shots, `export-${red ? "before" : "after"}-${width}.md`));
        writeFileSync(join(shots, `share-${red ? "before" : "after"}-${width}.json`), JSON.stringify({ copy, canvas }, null, 2));
      }
      assert.ok(!md.includes("## 工具"), "Markdown must not expose tool inputs");
      for (const output of [md, copy, canvas]) {
        assert.ok(!/hidden_tool_fixture|内部思考fixture|正在读取私有|\.openclaude/.test(output), "share artifacts contain only final public content");
        assert.ok(output.includes("sales.csv"));
        assert.ok(output.includes("print(42)"));
      }
      assert.ok(md.includes("生成销售报表"));
      assert.ok(md.includes("## 助手（未完成）"));
      assert.ok(md.includes("已交付的部分报告仍可导出。"));
      assert.ok(!copy.includes("已交付的部分报告"));
      assert.ok(!canvas.includes("已交付的部分报告"));
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});
