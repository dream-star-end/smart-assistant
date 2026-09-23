import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.env.OC_PROCESS_SHOT_DIR || "/home/agent/.openclaude/generated";
const assetDir = process.env.OC_PROCESS_APP_DIR || "/tmp/ocv5-265-text-polish-app";

function styleSnapshot(root) {
  const keys = ["fontSize", "lineHeight", "fontFamily", "fontWeight", "color"];
  const pick = (selector) => {
    const el = root.querySelector(selector);
    if (!(el instanceof HTMLElement)) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const key of keys) out[key] = cs[key];
    return out;
  };
  return {
    p: pick("p"),
    strong: pick("strong"),
    li: pick("li"),
    code: pick(":not(pre) > code"),
    blockquote: pick("blockquote"),
    td: pick("td"),
  };
}

test("OCV5-265 text polish: same markdown active to final, cleared goal gone, no footer token", { timeout: 240000 }, async () => {
  process.env.OC_E2E_STREAM_GAP_MS = "40";
  mkdirSync(shots, { recursive: true });
  mkdirSync(assetDir, { recursive: true });
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")],
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: assetDir,
    entryNames: "app",
    chunkNames: "chunks/[name]-[hash]",
    jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}',
    },
    logLevel: "warning",
  });
  const cssDir = join(assetDir, "css-build");
  mkdirSync(cssDir, { recursive: true });
  await viteBuild({
    root: join(here, ".."),
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    build: {
      outDir: cssDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: join(here, "preview-styles.ts"),
        output: { assetFileNames: "styles[extname]" },
      },
    },
  });
  const cssName = readdirSync(cssDir).find((name) => name.endsWith(".css"));
  writeFileSync(join(assetDir, "styles.css"), readFileSync(join(cssDir, cssName)));

  const preview = await startPreviewServer(assetDir, { port: 0 });
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox"],
  });
  const evidence = {};
  try {
    async function open(width, touch) {
      const context = await browser.newContext({
        viewport: { width, height: touch ? 844 : 1000 },
        isMobile: touch,
        hasTouch: touch,
        deviceScaleFactor: 1,
        timezoneId: "Asia/Shanghai",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20_000);
      await page.goto(preview.url, { waitUntil: "domcontentloaded" });
      await page.getByText("看板已经做好").waitFor();
      await page.waitForFunction(() => !document.body.innerText.includes("未连接"));
      return { context, page, errors };
    }

    async function sendText(page, text) {
      const box = page.getByPlaceholder(/对话/);
      await box.click();
      await box.fill(text);
      await page.getByRole("button", { name: "发送" }).click();
    }

    function target(page, selector) {
      return page.locator(selector).filter({ hasText: "对照重点" }).last();
    }

    async function frameTarget(page, selector) {
      const locator = target(page, selector);
      await locator.waitFor();
      await locator.evaluate((el) => {
        const scroller = el.closest(".chat-scroll-area");
        if (!(scroller instanceof HTMLElement)) {
          el.scrollIntoView({ block: "start" });
          return;
        }
        const view = scroller.getBoundingClientRect();
        const row = el.getBoundingClientRect();
        scroller.scrollTop += row.top - view.top - 16;
      });
      return locator;
    }

    async function readStyles(page, selector) {
      const locator = await frameTarget(page, selector);
      return locator.evaluate(styleSnapshot);
    }

    const desktop = await open(1280, false);
    const historyMeta = desktop.page.getByTestId("assistant-meta").filter({ hasText: "12" }).first();
    await historyMeta.waitFor();
    const historyText = await historyMeta.innerText();
    assert.match(historyText, /积分/);
    assert.doesNotMatch(historyText, /token/i);
    assert.equal(await desktop.page.getByText("已清除的库存目标").count(), 0);

    await sendText(desktop.page, "排版对照。目标已清除");
    await desktop.page.getByText("第一段说明口径").first().waitFor();
    await desktop.page.getByText("对照重点").first().waitFor();
    assert.equal(await desktop.page.getByText("排版对照已清除目标").count(), 0, "cleared goal rendered");
    assert.equal(await desktop.page.getByTestId("process-goal-line").filter({ hasText: "目标已清除" }).count(), 0);
    await desktop.page.getByText("排版对照已完成目标").waitFor();
    assert.equal(await desktop.page.getByText("目标已清除").count() > 0, true, "user sentence was deleted");
    const activeStyles = await readStyles(desktop.page, "[data-testid=process-stage]");
    assert.ok(activeStyles.p && activeStyles.strong && activeStyles.li && activeStyles.code && activeStyles.blockquote && activeStyles.td, JSON.stringify(activeStyles));
    evidence.active = activeStyles;
    await frameTarget(desktop.page, "[data-testid=process-stage]");
    await desktop.page.screenshot({ path: join(shots, "ocv5-265-text-polish-desktop-active.png") });
    await desktop.page.setViewportSize({ width: 390, height: 844 });
    await frameTarget(desktop.page, "[data-testid=process-stage]");
    await desktop.page.screenshot({ path: join(shots, "ocv5-265-text-polish-mobile390-active.png") });
    await desktop.page.setViewportSize({ width: 1280, height: 1000 });

    const stepped = await fetch(new URL("/api/fixture/step", preview.url), { method: "POST" });
    assert.equal(stepped.ok, true);
    const finalRow = desktop.page.getByTestId("assistant-row").filter({ hasText: "对照重点" });
    await finalRow.waitFor({ timeout: 20_000 });
    const finalStyles = await readStyles(desktop.page, "[data-testid=assistant-row]");
    evidence.final = finalStyles;
    assert.deepEqual(finalStyles, activeStyles, `style drift ${JSON.stringify({ active: activeStyles, final: finalStyles })}`);
    const finalMeta = finalRow.getByTestId("assistant-meta");
    await finalMeta.waitFor();
    const finalMetaText = await finalMeta.innerText();
    assert.match(finalMetaText, /积分/);
    assert.match(finalMetaText, /刚刚|分钟前|\d{4}-\d{2}-\d{2}/);
    assert.doesNotMatch(finalMetaText, /token/i);
    assert.equal(await desktop.page.getByText("排版对照已清除目标").count(), 0);
    await frameTarget(desktop.page, "[data-testid=assistant-row]");
    await desktop.page.screenshot({ path: join(shots, "ocv5-265-text-polish-desktop-final.png") });
    await desktop.page.setViewportSize({ width: 390, height: 844 });
    await frameTarget(desktop.page, "[data-testid=assistant-row]");
    await desktop.page.screenshot({ path: join(shots, "ocv5-265-text-polish-mobile390-final.png") });
    assert.deepEqual(desktop.errors, []);
    writeFileSync(join(shots, "ocv5-265-text-polish-styles.json"), JSON.stringify(evidence, null, 2));
    await desktop.context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => preview.server.close(resolve));
  }
});
