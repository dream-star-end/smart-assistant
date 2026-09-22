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
import { BOARD_SESSION, CSV_BODY, CSV_NAME, WAIT_SESSION } from "./process-disclosure-story.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.env.OC_PROCESS_SHOT_DIR || "/home/agent/.openclaude/generated";
const assetDir = process.env.OC_PROCESS_APP_DIR || "/tmp/ocv5-265-app-preview";

function contrastRatio(fg, bg) {
  const parse = (value) => {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const linear = (channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  const a = parse(fg);
  const b = parse(bg);
  if (!a || !b) return 0;
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test("OCV5-265 App-level inventory board: real App, fixture API, not the component harness", { timeout: 240000 }, async () => {
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

  const preview = await startPreviewServer(assetDir);
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    async function open(width, touch, theme) {
      const context = await browser.newContext({
        viewport: { width, height: touch ? 844 : 1000 },
        isMobile: touch,
        hasTouch: touch,
        deviceScaleFactor: 1,
        timezoneId: "Asia/Shanghai",
        acceptDownloads: true,
      });
      if (theme) {
        await context.addInitScript((value) => localStorage.setItem("oc_theme", value), theme);
      }
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20_000);
      await page.goto(preview.url, { waitUntil: "domcontentloaded" });
      return { context, page, errors };
    }

    async function metaMetrics(page) {
      return page.getByTestId("assistant-meta").filter({ hasText: "2023-11-15" }).evaluate((el) => {
        const time = el.querySelector("time.tabular-nums");
        let bg = "rgba(0, 0, 0, 0)";
        let node = time;
        while (node) {
          const color = getComputedStyle(node).backgroundColor;
          if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
            bg = color;
            break;
          }
          node = node.parentElement;
        }
        const credits = [...el.children].find((child) => child.textContent?.includes("积分"));
        return {
          fontSize: time ? getComputedStyle(time).fontSize : "",
          color: time ? getComputedStyle(time).color : "",
          bg,
          rowHeight: el.getBoundingClientRect().height,
          timeTop: time?.getBoundingClientRect().top ?? 0,
          creditTop: credits?.getBoundingClientRect().top ?? 0,
          text: el.textContent ?? "",
        };
      });
    }

    const desktop = await open(1280, false);
    try {
      await desktop.page.getByText("看板已经做好").waitFor();
      await desktop.page.getByTitle("HTML 沙盒预览").waitFor();
      assert.equal(await desktop.page.getByText("summarize-stock.mjs").count(), 0, "tool log stays folded in the App");
      assert.equal(await desktop.page.getByText("paper.pdf").count(), 0);
      assert.equal(await desktop.page.getByText("还在，可售合计 128。").count(), 1);
      assert.equal(await desktop.page.getByTestId("process-disclosure").count(), 1, "plain follow-up has no process shell");
      const meta = await metaMetrics(desktop.page);
      assert.equal(meta.fontSize, "11px");
      assert.ok(meta.rowHeight < 36, `meta row too tall: ${meta.rowHeight}`);
      assert.ok(Math.abs(meta.timeTop - meta.creditTop) < 8, "old date and credits are not one compact row");
      assert.match(meta.text, /12\s*积分/);
      assert.match(meta.text, /token/);
      assert.ok(contrastRatio(meta.color, meta.bg) >= 4.5, `light contrast ${contrastRatio(meta.color, meta.bg)}`);
      await desktop.page.getByText("刚刚").waitFor();
      const iframeSrc = await desktop.page.getByTitle("HTML 沙盒预览").getAttribute("srcdoc");
      assert.match(iframeSrc ?? "", /库存看板/);
      assert.match(iframeSrc ?? "", /可售合计 128/);
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-app-desktop-collapsed.png") });

      const file = desktop.page.getByRole("link", { name: new RegExp(CSV_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
      await file.waitFor();
      const clip = await file.evaluate((el) => {
        const name = el.querySelector(".truncate") ?? el;
        return {
          full: name.textContent ?? "",
          clipped: name.scrollWidth > name.clientWidth + 1,
        };
      });
      assert.match(clip.full, /acceptance-fixture\.csv/);
      const [download] = await Promise.all([
        desktop.page.waitForEvent("download"),
        file.click(),
      ]);
      assert.equal(download.suggestedFilename(), CSV_NAME);
      const saved = await download.path();
      assert.equal(readFileSync(saved, "utf8"), CSV_BODY);
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-app-artifact.png") });

      await desktop.page.getByTestId("process-toggle").click();
      await desktop.page.getByText("先按北仓和南仓核对可售口径").waitFor();
      assert.equal(await desktop.page.getByText("summarize-stock.mjs").count(), 0);
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-app-desktop-expanded.png") });
      await desktop.page.getByTestId("process-detail-toggle").click();
      await desktop.page.getByText("summarize-stock.mjs").waitFor();
      await desktop.page.getByTestId("process-toggle").focus();
      await desktop.page.keyboard.press("Enter");
      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-toggle]")?.getAttribute("aria-expanded") === "false");
      await desktop.page.getByTestId("process-toggle").focus();
      await desktop.page.keyboard.press("Space");
      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-toggle]")?.getAttribute("aria-expanded") === "true");

      await desktop.page.getByRole("button", { name: "会话内查找" }).click();
      await desktop.page.getByLabel("在会话中查找").fill("可售口径");
      await desktop.page.keyboard.press("Enter");
      await desktop.page.waitForFunction(() => {
        const stage = document.querySelector("[data-testid=process-stage]");
        const scroller = stage?.closest(".chat-scroll-area");
        if (!(stage instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return false;
        const view = scroller.getBoundingClientRect();
        const row = stage.getBoundingClientRect();
        return row.height > 8 && row.top >= view.top - 2 && row.top < view.bottom - 8;
      });
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-app-find-stage.png") });

      await desktop.page.getByText("待你确认").click();
      await desktop.page.getByText("还差你的确认").waitFor();
      await desktop.page.getByText("未成功").waitFor();
      await desktop.page.getByText("任务待你确认").waitFor();
      assert.equal(await desktop.page.getByText("先按北仓和南仓核对可售口径").count(), 0, "expansion does not leak across sessions");
      assert.equal(await desktop.page.getByText("hidden-probe-cmd").count(), 0);
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-app-attention.png") });
      await desktop.page.getByRole("button", { name: "拒绝" }).click();
      await desktop.page.waitForTimeout(300);
      assert.equal(desktop.errors.length, 0, desktop.errors.join("\n"));

      await desktop.page.goto(preview.url, { waitUntil: "domcontentloaded" });
      await desktop.page.getByText("看板已经做好").waitFor();
      await desktop.page.getByTitle("HTML 沙盒预览").waitFor();
      assert.equal(await desktop.page.getByTestId("process-toggle").getAttribute("aria-expanded"), "false");
      assert.equal(desktop.errors.length, 0, desktop.errors.join("\n"));
    } catch (error) {
      console.error("APP_UNKNOWN", preview.unknown);
      console.error("APP_BODY", (await desktop.page.locator("body").innerText()).slice(0, 2000));
      console.error("APP_ERRORS", desktop.errors);
      throw error;
    } finally {
      await desktop.context.close();
    }

    const mobile = await open(390, true);
    try {
      await mobile.page.getByText("看板已经做好").waitFor();
      const box = await mobile.page.getByTestId("process-toggle").boundingBox();
      assert.ok(box && box.height >= 44, `touch target too small: ${JSON.stringify(box)}`);
      assert.ok(box.x >= -1 && box.x + box.width <= 391, `toggle overflows: ${JSON.stringify(box)}`);
      const docOverflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(docOverflow <= 1, `mobile document overflows by ${docOverflow}px`);
      const name = mobile.page.locator(".truncate", { hasText: "acceptance-fixture.csv" });
      await name.waitFor();
      const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1 && (el.textContent ?? "").includes("acceptance-fixture.csv"));
      assert.equal(clipped, true, "long filename truncates but stays in the accessible name");
      await mobile.page.screenshot({ path: join(shots, "ocv5-265-app-mobile-collapsed.png") });
      await mobile.page.getByTestId("process-toggle").tap();
      await mobile.page.getByText("先按北仓和南仓核对可售口径").waitFor();
      const order = await mobile.page.evaluate(() => {
        const user = document.querySelector("[data-testid=user-row]");
        const stage = document.querySelector("[data-testid=process-stage]");
        if (!(user instanceof HTMLElement) || !(stage instanceof HTMLElement)) return "missing";
        const follows = (user.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        return follows ? "stage-after-user" : "stage-before-user";
      });
      assert.equal(order, "stage-after-user", "mobile expand left this turn");
      assert.equal(await mobile.page.getByText("数字还在吗？").count(), 1);
      await mobile.page.screenshot({ path: join(shots, "ocv5-265-app-mobile-expanded.png") });
      assert.equal(mobile.errors.length, 0, mobile.errors.join("\n"));
    } catch (error) {
      console.error("APP_MOBILE_UNKNOWN", preview.unknown);
      console.error("APP_MOBILE_BODY", (await mobile.page.locator("body").innerText()).slice(0, 2000));
      console.error("APP_MOBILE_ERRORS", mobile.errors);
      throw error;
    } finally {
      await mobile.context.close();
    }

    const narrow = await open(360, true);
    try {
      await narrow.page.getByText("看板已经做好").waitFor();
      const overflow = await narrow.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `360px document overflows by ${overflow}px`);
      const box = await narrow.page.getByTestId("process-toggle").boundingBox();
      assert.ok(box && box.x + box.width <= 361, `360 toggle overflows: ${JSON.stringify(box)}`);
      await narrow.page.screenshot({ path: join(shots, "ocv5-265-app-mobile360-collapsed.png") });
    } finally {
      await narrow.context.close();
    }

    const dark = await open(1280, false, "dark");
    try {
      await dark.page.getByText("2023-11-15").waitFor();
      const meta = await metaMetrics(dark.page);
      assert.equal(meta.fontSize, "11px");
      assert.ok(contrastRatio(meta.color, meta.bg) >= 4.5, `dark contrast ${contrastRatio(meta.color, meta.bg)} color=${meta.color} bg=${meta.bg}`);
      await dark.page.screenshot({ path: join(shots, "ocv5-265-app-dark-meta.png") });
    } finally {
      await dark.context.close();
    }

    assert.equal(preview.url.includes(`/s/${BOARD_SESSION}`), true);
    assert.equal(WAIT_SESSION, "ocv5wait01");
  } finally {
    await browser.close();
    await new Promise((done) => preview.server.close(done));
  }
});
