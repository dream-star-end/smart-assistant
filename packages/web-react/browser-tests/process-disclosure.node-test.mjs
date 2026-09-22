import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.env.OC_PROCESS_SHOT_DIR || "/home/agent/.openclaude/generated";

test("OCV5-265 process disclosure: real MessageList, production CSS, red/green entry", { timeout: 180000 }, async () => {
  mkdirSync(shots, { recursive: true });
  const out = join(tmpdir(), `oc-process-disclosure-${process.pid}`);
  mkdirSync(out, { recursive: true });
  const bundle = await build({
    entryPoints: [join(here, "process-disclosure-harness.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.MODE": '"production"',
    },
    logLevel: "silent",
  });
  await viteBuild({
    root: join(here, ".."),
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    build: {
      outDir: out,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: join(here, "preview-styles.ts"),
        output: { assetFileNames: "styles[extname]" },
      },
    },
  });
  const css = readFileSync(join(out, readdirSync(out).find((name) => name.endsWith(".css"))), "utf8");
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    async function open(width, touch) {
      const context = await browser.newContext({
        viewport: { width, height: touch ? 844 : 900 },
        isMobile: touch,
        hasTouch: touch,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div>`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.getByTestId("process-harness").waitFor();
      return { context, page, errors };
    }

    const desktop = await open(1280, false);
    try {
      await desktop.page.evaluate(() => window.__processPage.setMode("legacy"));
      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-harness]")?.getAttribute("data-mode") === "legacy");
      assert.equal(await desktop.page.getByTestId("process-disclosure").count(), 0, "legacy entry has no disclosure");
      await desktop.page.getByText("summarize-stock.mjs").waitFor();
      await desktop.page.getByText("看板已经做好").waitFor();
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-legacy-desktop.png") });

      await desktop.page.evaluate(() => window.__processPage.setMode("manus"));
      await desktop.page.getByTestId("process-toggle").waitFor();
      assert.equal(await desktop.page.getByText("summarize-stock.mjs").count(), 0, "tool stays folded");
      assert.equal(await desktop.page.getByText("paper.pdf").count(), 0, "pdf execution log is not a deliverable");
      await desktop.page.getByText("看板已经做好").waitFor();
      await desktop.page.getByTitle("HTML 沙盒预览").waitFor();
      await desktop.page.getByText(/inventory-board-north-south/).waitFor();
      const meta = desktop.page.getByTestId("assistant-meta").filter({ hasText: "2023-11-15" });
      await meta.waitFor();
      const metaBox = await meta.evaluate((el) => {
        const time = el.querySelector("time.tabular-nums");
        const credits = [...el.querySelectorAll("span")].find((node) => node.textContent?.includes("积分"));
        const timeRect = time?.getBoundingClientRect();
        const creditRect = credits?.getBoundingClientRect();
        return {
          fontSize: time ? getComputedStyle(time).fontSize : "",
          rowHeight: el.getBoundingClientRect().height,
          sameLine: !!timeRect && !!creditRect && Math.abs(timeRect.top - creditRect.top) < 8,
          credits: el.textContent ?? "",
        };
      });
      assert.equal(metaBox.fontSize, "11px", "old absolute date must use caption size");
      assert.ok(metaBox.rowHeight < 36, `meta row too tall: ${metaBox.rowHeight}`);
      assert.equal(metaBox.sameLine, true, "date and credits share one compact row");
      assert.match(metaBox.credits, /12\s*积分/);
      assert.match(metaBox.credits, /token/);
      await desktop.page.getByText("刚刚").waitFor();
      const collapsedShot = join(shots, "ocv5-265-manus-desktop-collapsed.png");
      await desktop.page.screenshot({ path: collapsedShot });

      await desktop.page.getByTestId("process-toggle").click();
      await desktop.page.getByText("先按北仓和南仓核对可售口径").waitFor();
      assert.equal(await desktop.page.getByText("summarize-stock.mjs").count(), 0, "level 2 is narrative and counts only");
      await desktop.page.getByTestId("process-detail-toggle").click();
      await desktop.page.getByText("summarize-stock.mjs").waitFor();
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-manus-desktop-expanded.png") });

      await desktop.page.getByTestId("process-toggle").focus();
      await desktop.page.keyboard.press("Enter");
      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-toggle]")?.getAttribute("aria-expanded") === "false");
      assert.equal(desktop.errors.length, 0, desktop.errors.join("\n"));
    } finally {
      await desktop.context.close();
    }

    const mobile = await open(390, true);
    try {
      await mobile.page.getByTestId("process-toggle").waitFor();
      const box = await mobile.page.getByTestId("process-toggle").boundingBox();
      assert.ok(box && box.height >= 44, `touch target too small: ${JSON.stringify(box)}`);
      assert.ok(box.x >= -1 && box.x + box.width <= 391, `toggle overflows viewport: ${JSON.stringify(box)}`);
      await mobile.page.getByText("看板已经做好").waitFor();
      assert.equal(await mobile.page.getByText("summarize-stock.mjs").count(), 0);
      await mobile.page.getByText(/acceptance-fixture\.csv/).waitFor();
      const overflow = await mobile.page.getByTestId("process-harness").evaluate((el) => el.scrollWidth - el.clientWidth);
      assert.ok(overflow <= 1, `mobile harness overflows by ${overflow}px`);
      await mobile.page.screenshot({ path: join(shots, "ocv5-265-manus-mobile-collapsed.png") });
      const userBefore = await mobile.page.getByText("做一版库存看板").boundingBox();
      await mobile.page.getByTestId("process-toggle").tap();
      await mobile.page.getByTestId("process-detail-toggle").tap();
      await mobile.page.getByText("summarize-stock.mjs").waitFor();
      const userAfter = await mobile.page.getByText("做一版库存看板").boundingBox();
      assert.ok(userBefore && userAfter && Math.abs(userBefore.y - userAfter.y) < 80, "mobile expand stays on this turn");
      const detail = await mobile.page.getByTestId("process-details").boundingBox();
      assert.ok(detail && detail.x >= -1 && detail.x + detail.width <= 391, `details overflow: ${JSON.stringify(detail)}`);
      await mobile.page.screenshot({ path: join(shots, "ocv5-265-manus-mobile-expanded.png") });
      assert.equal(mobile.errors.length, 0, mobile.errors.join("\n"));
    } finally {
      await mobile.context.close();
    }

    const stream = await open(1280, false);
    try {
      await stream.page.evaluate(() => window.__processPage.setScene("stream"));
      await stream.page.getByTestId("process-chat-scroll").waitFor();
      await stream.page.getByText("STREAM_TAIL_MARKER").waitFor();
      const clipped = await stream.page.getByText("STREAM_TAIL_MARKER").evaluate((node) => {
        if (node.closest("[data-testid=process-live-summary]")) return true;
        let el = node.parentElement;
        while (el) {
          const clamp = getComputedStyle(el).webkitLineClamp;
          if (clamp && clamp !== "none") return true;
          el = el.parentElement;
        }
        return false;
      });
      assert.equal(clipped, false, "streaming answer must not be line-clamped");
      await stream.page.evaluate(() => {
        const el = document.querySelector("[data-testid=process-chat-scroll]");
        if (!(el instanceof HTMLElement)) throw new Error("missing scroller");
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
      try {
        await stream.page.waitForFunction(() => document.querySelector("[data-testid=scroll-to-bottom-dock]")?.getAttribute("data-visible") === "true", { timeout: 4000 });
      } catch (error) {
        const info = await stream.page.evaluate(() => {
          const el = document.querySelector("[data-testid=process-chat-scroll]");
          return {
            scrollTop: el instanceof HTMLElement ? el.scrollTop : null,
            scrollHeight: el instanceof HTMLElement ? el.scrollHeight : null,
            clientHeight: el instanceof HTMLElement ? el.clientHeight : null,
            visible: document.querySelector("[data-testid=scroll-to-bottom-dock]")?.getAttribute("data-visible") ?? null,
          };
        });
        throw new Error(`${error instanceof Error ? error.message : error} ${JSON.stringify(info)}`);
      }
      const parked = await stream.page.getByTestId("process-chat-scroll").evaluate((el) => el.scrollTop);
      await stream.page.evaluate(() => window.__processPage.appendAnswer("\n尾部仍在增长"));
      await stream.page.getByText("尾部仍在增长").waitFor();
      const stayed = await stream.page.getByTestId("process-chat-scroll").evaluate((el) => el.scrollTop);
      assert.ok(stayed < parked + 40, `new tokens yanked the reader: ${parked} -> ${stayed}`);
      await stream.page.getByTestId("scroll-to-bottom").click({ force: true });
      await stream.page.waitForFunction(() => {
        const el = document.querySelector("[data-testid=process-chat-scroll]");
        if (!(el instanceof HTMLElement)) return false;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      });
      await stream.page.getByTestId("process-toggle").click();
      await stream.page.waitForFunction(() => document.querySelector("[data-testid=process-toggle]")?.getAttribute("aria-expanded") === "true");
      await stream.page.evaluate(() => window.__processPage.appendAnswer("\n尾部仍在增长"));
      await stream.page.getByText("尾部仍在增长").waitFor();
      await stream.page.evaluate(() => window.__processPage.setSending(false));
      await stream.page.getByText("尾部仍在增长").waitFor();
      assert.equal(await stream.page.getByTestId("process-toggle").getAttribute("aria-expanded"), "true");
      await stream.page.screenshot({ path: join(shots, "ocv5-265-manus-stream-answer.png") });
      assert.equal(stream.errors.length, 0, stream.errors.join("\n"));
    } finally {
      await stream.context.close();
    }

    const find = await open(1280, false);
    try {
      await find.page.evaluate(() => window.__processPage.setScene("find"));
      await find.page.getByTestId("process-chat-scroll").waitFor();
      await find.page.waitForFunction(() => {
        const el = document.querySelector("[data-testid=process-chat-scroll]");
        return !!el && el.scrollHeight > el.clientHeight + 80;
      });
      assert.equal(await find.page.getByText("阶段锚点ALPHATOKEN").count(), 0, "folded stage is not mounted yet");
      await find.page.getByLabel("在会话中查找").fill("阶段锚点ALPHATOKEN");
      await find.page.keyboard.press("Enter");
      await find.page.waitForFunction(() => {
        const scroller = document.querySelector("[data-testid=process-chat-scroll]");
        const stage = document.querySelector("[data-find-member]");
        if (!(scroller instanceof HTMLElement) || !(stage instanceof HTMLElement)) return false;
        const view = scroller.getBoundingClientRect();
        const row = stage.getBoundingClientRect();
        const input = document.querySelector("[aria-label='在会话中查找']");
        const bar = input instanceof HTMLElement ? input.getBoundingClientRect() : null;
        const top = bar && bar.height > 0 ? bar.bottom : view.top;
        return row.height > 8 && row.top >= top - 2 && row.bottom > top + 8 && row.top < view.bottom - 8;
      });
      await find.page.screenshot({ path: join(shots, "ocv5-265-manus-find-stage.png") });
      assert.equal(find.errors.length, 0, find.errors.join("\n"));
    } finally {
      await find.context.close();
    }

    const attention = await open(1280, false);
    try {
      await attention.page.evaluate(() => window.__processPage.setScene("attention"));
      await attention.page.getByText("未成功").waitFor();
      await attention.page.getByTestId("permission-card").waitFor();
      await attention.page.getByText("任务待你确认").waitFor();
      assert.equal(await attention.page.getByText("hidden-probe-cmd").count(), 0);
      await attention.page.getByRole("button", { name: "拒绝" }).click();
      await attention.page.waitForFunction(() => document.querySelector("[data-testid=process-harness]")?.getAttribute("data-respond-count") === "1");
      await attention.page.waitForTimeout(200);
      assert.equal(await attention.page.getByTestId("process-harness").getAttribute("data-respond-count"), "1");
      await attention.page.screenshot({ path: join(shots, "ocv5-265-manus-attention.png") });
      assert.equal(attention.errors.length, 0, attention.errors.join("\n"));
    } finally {
      await attention.context.close();
    }
  } finally {
    await browser.close();
  }
});
