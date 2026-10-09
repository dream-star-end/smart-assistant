import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

// OCV5-367: each step of the process timeline shows how long it took instead of the
// model call's 「共Xk token」. Real MessageList + real Tailwind CSS in Chromium.
// OC_STEP_DURATION_RED_REF=<git ref> bundles every web-react src file from that ref
// instead (negative control, e.g. the commit before the change).
// OC_STEP_DURATION_SHOTS=<dir> also saves screenshots.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "../src");
const repoRoot = resolve(here, "../../..");
const redRef = process.env.OC_STEP_DURATION_RED_REF || "";
const shotsDir = process.env.OC_STEP_DURATION_SHOTS || "";

async function bundle(assetDir) {
  let swapped = 0;
  await build({
    entryPoints: [join(here, "step-duration-harness.tsx")], bundle: true, format: "iife",
    outfile: join(assetDir, "app.js"), jsx: "automatic", loader: { ".css": "empty" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: redRef ? [{ name: "web-react-src-from-ref", setup(b) {
      b.onLoad({ filter: /\.(tsx?|mjs|js)$/ }, ({ path }) => {
        if (!resolve(path).startsWith(srcDir + "/")) return undefined;
        const rel = relative(repoRoot, resolve(path));
        let contents;
        try {
          contents = execFileSync("git", ["show", `${redRef}:${rel}`], { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        } catch {
          return undefined; // file added after the ref
        }
        swapped += 1;
        return { contents, loader: path.endsWith(".tsx") ? "tsx" : path.endsWith(".ts") ? "ts" : "js", resolveDir: dirname(path) };
      });
    } }] : [],
    logLevel: "warning",
  });
  assert.ok(redRef ? swapped > 50 : swapped === 0, `red-ref swapped ${swapped} files`);
  const entry = join(assetDir, "entry.css");
  writeFileSync(entry, `@import ${JSON.stringify(resolve(here, "../src/styles.css"))};\n@source ${JSON.stringify(join(assetDir, "app.js"))};\n`);
  const entryJs = join(assetDir, "entry.ts");
  writeFileSync(entryJs, `import ${JSON.stringify(entry)};\n`);
  const cssDir = join(assetDir, "css-build"); mkdirSync(cssDir);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()], build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: entryJs, output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(assetDir, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
}

/** Label + right-hand meta of every visible step row, in order. */
function steps(page) {
  return page.locator("[data-testid='tool-step'], [data-testid='thinking-step']").evaluateAll((rows) => rows.map((row) => {
    const header = row.querySelector("button, div");
    const duration = row.querySelector("[data-testid='step-duration']");
    return {
      kind: row.getAttribute("data-testid"),
      text: (header?.textContent ?? "").replace(/\s+/g, " ").trim(),
      duration: duration?.textContent ?? null,
      running: duration?.getAttribute("data-step-running") ?? null,
      title: duration?.getAttribute("title") ?? null,
    };
  }));
}

async function expandAll(page) {
  const shell = page.getByTestId("process-toggle").first();
  if ((await shell.getAttribute("aria-expanded")) !== "true") await shell.click();
  for (const toggle of await page.getByTestId("process-detail-toggle").all()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
  await page.locator("[data-testid='tool-step']").first().waitFor();
}

test("OCV5-367: process steps show elapsed time instead of token totals", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-step-duration-"));
  t.after(() => rmSync(assetDir, { recursive: true, force: true }));
  await bundle(assetDir);
  const server = createServer((req, res) => {
    const file = { "/": null, "/app.js": "app.js", "/styles.css": "styles.css" }[req.url];
    if (file === undefined) { res.writeHead(404); res.end(); return; }
    if (file === null) { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css"><body class="bg-bg"><div id="root"></div><script src="/app.js"></script>'); return; }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/css");
    res.end(readFileSync(join(assetDir, file)));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const shot = async (page, name) => {
    if (!shotsDir) return;
    mkdirSync(shotsDir, { recursive: true });
    await page.getByTestId("step-harness").screenshot({ path: join(shotsDir, `${redRef ? "before" : "after"}-${name}.png`) });
  };
  const receipt = { mode: redRef ? `red:${redRef}` : "worktree" };

  for (const width of [1280, 390]) {
    await t.test(`history turn @${width}px: every step shows its duration, no token totals`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, timezoneId: "Asia/Shanghai" });
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(url);
        await page.getByTestId("step-harness").waitFor();
        await expandAll(page);
        await shot(page, `history-${width}`);
        const rows = await steps(page);
        receipt[`history${width}`] = rows.map((r) => [r.kind, r.duration]);
        for (const r of rows) assert.ok(!/token/i.test(r.text), `step row has no token text: ${r.text}`);
        // 首步从用户发出算起;并行的第二条命令与第一条重叠的部分不重复计;长命令含模型写它的时间。
        assert.deepEqual(rows.map((r) => r.duration), ["9.0 秒", "<0.1 秒", "1.3 秒", "21 秒", "3 分 08 秒"]);
        const shared = rows.find((r) => r.text.includes("pwd"));
        assert.match(shared.title, /本步耗时 1\.3 秒.*所在模型调用共 205,000 token/);
        // 折叠的步骤组摘要给出这一组合计用时。
        const groupDurations = await page.getByTestId("process-group-duration").allTextContents();
        assert.ok(groupDurations.length > 0, "collapsed group summary shows a total");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }

  await t.test("live turn: finished steps are fixed, the running step counts up", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(url);
      await page.getByTestId("step-harness").waitFor();
      await page.evaluate(() => window.__stepPage.setScene("live"));
      await page.locator("[data-scene='live']").waitFor();
      await expandAll(page);
      await shot(page, "live");
      const first = await steps(page);
      const done = first.find((r) => r.text.includes("typecheck"));
      const running = first.find((r) => r.text.includes("npm test"));
      assert.equal(done.duration, "8.0 秒");
      assert.equal(done.running, "false");
      assert.equal(running.running, "true", "running step is marked running");
      const seconds = (text) => Number(/^(\d+) 秒$/.exec(text)?.[1]);
      assert.ok(seconds(running.duration) >= 42, `running step counts from the previous step's end: ${running.duration}`);
      await page.waitForTimeout(2200);
      const later = (await steps(page)).find((r) => r.text.includes("npm test"));
      assert.ok(seconds(later.duration) >= seconds(running.duration) + 1, `ticks: ${running.duration} → ${later.duration}`);
      receipt.live = [done.duration, running.duration, later.duration];
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  console.log("STEP_DURATION_RECEIPT", JSON.stringify(receipt));
  assert.ok(existsSync(assetDir));
});
