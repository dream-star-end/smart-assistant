// OCV5-694 / OCV5-695: trusted clicks on the composer's paperclip and send button (real Chromium).
//   OC_COMPOSER_BASELINE=<file>  loads that file in place of src/components/Composer.tsx (RED run
//   against the pre-fix Composer; see rf-composer-20261031 evidence).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
const baseline = process.env.OC_COMPOSER_BASELINE;
const STOP_ARM_MS = 1000; // STOP_ARM_MS in src/components/Composer.tsx
const swaps = { count: 0 };
const plugins = baseline ? [{ name: "pre-fix-composer", setup(b) {
  b.onLoad({ filter: /\/src\/components\/Composer\.tsx$/ }, () => {
    swaps.count += 1;
    return { contents: readFileSync(baseline, "utf8"), loader: "tsx", resolveDir: join(here, "../src/components") };
  });
} }] : [];
const esbuildBase = {
  bundle: true, jsx: "automatic", plugins, logLevel: "warning",
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
  alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
};

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
test.after(() => browser?.close());

test("OCV5-694 real App: the first trusted click on the paperclip opens the file chooser", { timeout: 180_000 }, async (t) => {
  const assets = mkdtempSync(join(tmpdir(), "oc-composer-attach-"));
  t.after(() => rmSync(assets, { recursive: true, force: true }));
  await build({ ...esbuildBase, entryPoints: [join(here, "process-disclosure-app-harness.tsx")], splitting: true, format: "esm",
    outdir: assets, entryNames: "app", chunkNames: "chunks/[name]-[hash]" });
  const cssDir = join(assets, "css-build"); mkdirSync(cssDir);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()],
    build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false,
      rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(assets, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
  const preview = await startPreviewServer(assets);
  t.after(async () => {
    for (const ws of preview.wss.clients) ws.terminate();
    await new Promise((done) => preview.wss.close(done));
    await new Promise((done) => preview.server.close(done));
  });
  for (const width of [1280, 390]) {
    await t.test(`${width}px new session`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
        isMobile: width === 390, hasTouch: width === 390 });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        // Subscribe before navigation so file-chooser interception is armed before the first click.
        const choosers = [];
        page.on("filechooser", (chooser) => choosers.push(chooser));
        await page.goto(preview.url);
        await page.getByRole("textbox", { name: "消息输入框" }).waitFor();
        // Repro: a new session (sidebar on desktop, the drawer behind 打开菜单 on phones).
        if (width === 390) await page.getByRole("button", { name: /^打开菜单/ }).click();
        await page.getByRole("button", { name: /新建会话/ }).filter({ visible: true }).first().click();
        const clip = page.getByRole("button", { name: "添加附件" });
        await clip.waitFor();
        const box = await clip.boundingBox();
        assert.ok(box, "the paperclip is laid out");
        const hit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[aria-label="添加附件"]'),
          { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        assert.equal(hit, true, "nothing covers the paperclip");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        const until = Date.now() + 3000;
        while (choosers.length === 0 && Date.now() < until) await page.waitForTimeout(50);
        assert.equal(choosers.length, 1, "one trusted click opens exactly one file chooser");
        assert.equal(choosers[0].isMultiple(), true);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
});

test("OCV5-695 Composer: immediate sending feedback, and a click landing on a fresh Stop is not a Stop", { timeout: 90_000 }, async (t) => {
  const bundle = await build({ ...esbuildBase, entryPoints: [join(here, "composer-send-attach-harness.tsx")], write: false, format: "iife" });
  const server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const open = async (query = "") => {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(url + query);
    await page.getByRole("textbox", { name: "消息输入框" }).waitFor();
    return page;
  };
  const sendButton = (page) => page.getByRole("button", { name: /^(发送|正在发送|停止)$/ });
  const center = async (locator) => { const b = await locator.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const log = (page) => page.evaluate(() => window.__log.slice());

  await t.test("the send button reacts at once while onSend is pending", async () => {
    const page = await open();
    await page.getByRole("textbox", { name: "消息输入框" }).fill("做一个表格");
    const [x, y] = await center(sendButton(page));
    await page.mouse.click(x, y);
    // The next frame, long before the 1.5 s pipeline resolves.
    await page.waitForTimeout(150);
    assert.deepEqual(await log(page), ["send:做一个表格"]);
    assert.equal(await sendButton(page).getAttribute("aria-label"), "正在发送", "visible sending state right after the click");
    assert.equal(await sendButton(page).isDisabled(), true, "a repeat click cannot submit twice");
  });

  await t.test("a second click that lands just after Send turned into Stop does not stop the turn", async () => {
    const page = await open();
    await page.getByRole("textbox", { name: "消息输入框" }).fill("做一个表格");
    const [x, y] = await center(sendButton(page));
    await page.mouse.click(x, y);
    // The user sees nothing happen and clicks the same spot again just as the turn starts.
    await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    await page.mouse.click(x, y);
    await page.waitForTimeout(100);
    assert.deepEqual(await log(page), ["send:做一个表格"], "the transition click is not a Stop");
    // A deliberate Stop once the button has been on screen keeps working.
    await page.waitForTimeout(STOP_ARM_MS);
    await page.mouse.click(x, y);
    assert.deepEqual(await log(page), ["send:做一个表格", "stop"]);
  });

  await t.test("opening an already running conversation keeps Stop immediate", async () => {
    const page = await open("?busy");
    await page.getByRole("button", { name: "停止", exact: true }).click();
    assert.deepEqual(await log(page), ["stop"]);
  });
  assert.equal(swaps.count > 0, !!baseline, "a RED run must actually load the baseline Composer");
});
