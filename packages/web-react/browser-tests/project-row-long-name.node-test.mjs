import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

// OCV5-364: a long project name ran under the hover「+」「⋯」buttons of its sidebar row.
// Real ProjectRow + real Tailwind CSS in Chromium. OC_PROJECT_ROW_RED_REF=<git ref> bundles
// ProjectRow.tsx from that ref instead (negative control, e.g. the commit before the fix).
// OC_PROJECT_ROW_SHOTS=<dir> also saves screenshots of each state.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const rowPath = resolve(here, "../src/components/sidebar/ProjectRow.tsx");
const redRef = process.env.OC_PROJECT_ROW_RED_REF || "";
const shotsDir = process.env.OC_PROJECT_ROW_SHOTS || "";

async function bundle(assetDir) {
  let swapped = 0;
  await build({
    entryPoints: [join(here, "project-row-long-name-harness.tsx")], bundle: true, format: "iife",
    outfile: join(assetDir, "app.js"), jsx: "automatic", loader: { ".css": "empty" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: redRef ? [{ name: "project-row-from-ref", setup(b) {
      b.onLoad({ filter: /[\\/]sidebar[\\/]ProjectRow\.tsx$/ }, ({ path }) => {
        assert.equal(resolve(path), rowPath);
        swapped += 1;
        const rel = "packages/web-react/src/components/sidebar/ProjectRow.tsx";
        const contents = execFileSync("git", ["show", `${redRef}:${rel}`], { cwd: here, encoding: "utf8" });
        return { contents, loader: "tsx", resolveDir: dirname(path) };
      });
    } }] : [],
    logLevel: "warning",
  });
  assert.equal(swapped, redRef ? 1 : 0);
  // Tailwind scans the bundle too, so a ProjectRow taken from another ref gets its own classes.
  const entry = join(assetDir, "entry.css");
  writeFileSync(entry, `@import ${JSON.stringify(resolve(here, "../src/styles.css"))};\n@source ${JSON.stringify(join(assetDir, "app.js"))};\n`);
  const entryJs = join(assetDir, "entry.ts");
  writeFileSync(entryJs, `import ${JSON.stringify(entry)};\n`);
  const cssDir = join(assetDir, "css-build"); mkdirSync(cssDir);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()], build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: entryJs, output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(assetDir, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
}

// Name text, chevron and visible action buttons of one row; overlaps are judged on these boxes.
function measure(page, id) {
  return page.getByTestId(`row-${id}`).evaluate((row) => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && getComputedStyle(el).visibility !== "hidden" ? { left: r.left, right: r.right } : null; };
    const name = row.querySelector("[data-project-open] span.truncate");
    const visibleButtons = [...row.querySelectorAll("button[aria-label^='在 '], button[aria-label$=' 更多']")]
      .filter((el) => el.getBoundingClientRect().width > 0 && Number(getComputedStyle(el.parentElement).opacity) > 0.5);
    return {
      name: box(name), toggle: box(row.querySelector("[data-project-toggle]")),
      actions: visibleButtons.map(box), row: box(row.querySelector("[data-project-row] > div")),
      truncated: name.scrollWidth > name.clientWidth,
    };
  });
}

// Past the 150ms opacity transition the pre-fix row used, so both versions are judged at rest.
const settle = (page) => page.waitForTimeout(300);

function assertNoOverlap(m, label) {
  assert.ok(m.actions.length > 0, `${label}: action buttons are visible`);
  const firstAction = Math.min(...m.actions.map((a) => a.left));
  assert.ok(m.name.right <= firstAction + 0.5, `${label}: name ends (${m.name.right}) before the first action (${firstAction})`);
  assert.ok(m.toggle.right <= firstAction + 0.5, `${label}: chevron ends (${m.toggle.right}) before the first action (${firstAction})`);
  for (const a of m.actions) assert.ok(a.right <= m.row.right + 0.5, `${label}: action stays inside the row`);
}

test("OCV5-364: long project names never run under the sidebar row actions", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-project-row-"));
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
  const shot = async (page, name) => { if (shotsDir) { mkdirSync(shotsDir, { recursive: true }); await page.getByTestId("sidebar").screenshot({ path: join(shotsDir, `${redRef ? "before" : "after"}-${name}.png`) }); } };

  await t.test("desktop: hover, keyboard focus and open menu", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 2 });
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(url);
      await page.getByTestId("row-p-long").waitFor();
      await shot(page, "rest");
      for (const id of ["p-short", "p-long", "p-longer"]) {
        await page.getByTestId(`row-${id}`).hover();
        await settle(page);
        if (id !== "p-short") await shot(page, `hover-${id}`);
        const m = await measure(page, id);
        assertNoOverlap(m, `hover ${id}`);
        if (id === "p-longer") assert.ok(m.truncated, "the longest name is cut with an ellipsis");
      }
      await page.mouse.move(900, 300);
      await settle(page);
      await page.getByTestId("row-p-long").locator("[data-project-open]").focus();
      await settle(page);
      assertNoOverlap(await measure(page, "p-long"), "keyboard focus p-long");
      await page.getByRole("button", { name: "项目 V5个人版和商业版项目开发 更多" }).click();
      await page.getByRole("menu").waitFor();
      await page.mouse.move(900, 300);
      await settle(page);
      assertNoOverlap(await measure(page, "p-long"), "menu open p-long");
      await shot(page, "menu-open");
      assert.deepEqual(errors, []);
      console.log("PROJECT_ROW_RECEIPT", JSON.stringify({ mode: redRef ? `red:${redRef}` : "worktree", desktop: "ok" }));
    } finally { await context.close(); }
  });

  await t.test("touch: the always-visible「⋯」does not cover the name", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 400 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const page = await context.newPage();
    try {
      await page.goto(url);
      await page.getByTestId("row-p-long").waitFor();
      assert.equal(await page.evaluate(() => matchMedia("(hover: none)").matches), true, "touch context really has no hover");
      for (const id of ["p-short", "p-long", "p-longer"]) assertNoOverlap(await measure(page, id), `touch ${id}`);
      await shot(page, "touch");
    } finally { await context.close(); }
  });
});
