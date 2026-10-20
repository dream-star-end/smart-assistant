import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createServer } from "node:http";
import { buildHarnessPage, serveHarnessPage } from "./harness-page.mjs";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const red = process.env.OC_UX_ARTIFACT_RED === "1";
const shots = process.env.OC_UX_EVIDENCE_DIR;

test("OCV5-508 generated Markdown links download authenticated file bytes", { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-artifact-link-"));
  const plugins = red ? [{ name: "old-artifact-anchor", setup(build) {
    build.onLoad({ filter: /\/MarkdownImpl\.tsx$/ }, () => ({ contents: execFileSync("git", ["show", "98e728220:packages/web-react/src/components/MarkdownImpl.tsx"], { cwd: root, encoding: "utf8" }), loader: "tsx" }));
  } }] : [];
  await buildHarnessPage({ harness: "artifact-link-harness.tsx", assetDir: dir, plugins });
  const assets = await serveHarnessPage(dir);
  let signs = [];
  const bytes = "name,total\nA,42\n";
  // A real HTTP attachment is required: route.fulfill plus aborting the probe fetch cancels Chromium's native download.
  const http = createServer(async (req, res) => {
    if (req.url === "/api/media-sign") {
      let body = ""; for await (const chunk of req) body += chunk;
      const { paths } = JSON.parse(body); signs.push(paths);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Object.fromEntries(paths.map((p) => [p, "/api/media?signed=fixture"]))));
      return;
    }
    if (req.url === "/api/media?signed=fixture") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename*=UTF-8''%E6%8A%A5%E8%A1%A8%202026.csv", "content-length": String(Buffer.byteLength(bytes)) });
      res.end(bytes); return;
    }
    const upstream = await fetch(new URL(req.url ?? "/", assets.url));
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const server = { url: `http://127.0.0.1:${http.address().port}/` };
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, acceptDownloads: true });
      signs = [];
      await page.route("https://example.test/preview.png", (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><text x="2" y="20">Report</text></svg>' }));
      await page.goto(server.url);
      const link = page.getByRole("link", { name: "下载季度报表", exact: true });
      await link.waitFor();
      if (!red) await page.waitForFunction(() => document.querySelector('a[data-product-feature]')?.getAttribute("href") === "#");
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, `artifact-${red ? "before" : "after"}-${width}.png`), fullPage: true });
        writeFileSync(join(shots, `artifact-${red ? "before" : "after"}-${width}.json`), JSON.stringify({ href: await link.getAttribute("href"), signs, rawPathStatus: (await page.request.get(`${server.url}home/agent/.openclaude/generated/sales.csv`)).status() }, null, 2));
      }
      assert.equal(await link.getAttribute("href"), "#", "artifact href must not navigate to the server filesystem");
      const downloadEvent = page.waitForEvent("download");
      await link.click();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), "报表 2026.csv");
      assert.equal(readFileSync(await download.path(), "utf8"), bytes);
      assert.deepEqual(signs, [["/home/agent/.openclaude/generated/报表 2026.csv", "/home/agent/.openclaude/generated/report.pdf"]], "same path shares signing cache; readOnly does not sign");
      assert.equal(await page.getByRole("link", { name: "帮助文档" }).getAttribute("href"), "/help/report.csv");
      assert.equal(await page.getByRole("link", { name: "只读文件" }).getAttribute("href"), "/home/agent/.openclaude/generated/%E6%8A%A5%E8%A1%A8%202026.csv");
      assert.equal(await page.getByRole("link", { name: "下载 report.pdf" }).getAttribute("href"), "#");
      assert.equal(await page.getByAltText("报告缩略图").evaluate((el) => el.closest("a")), null);
      assert.equal(await page.locator("a a").count(), 0);
      if (shots) await download.saveAs(join(shots, `artifact-downloaded-${width}.csv`));
      await page.close();
    }
  } finally { await browser.close(); http.closeAllConnections(); await new Promise((done) => http.close(done)); await assets.close(); }
});
