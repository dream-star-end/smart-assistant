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
const assetDir = process.env.OC_PROCESS_MOTION_DIR || "/tmp/ocv5-265-motion-app";

function oscillation(samples, key, epsilon = 1) {
  let flips = 0;
  let lastSign = 0;
  let min = Infinity;
  let max = -Infinity;
  let prev = null;
  for (const sample of samples) {
    const value = sample[key];
    if (typeof value !== "number") continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    if (prev === null) {
      prev = value;
      continue;
    }
    const delta = value - prev;
    prev = value;
    if (Math.abs(delta) < epsilon) continue;
    const sign = Math.sign(delta);
    if (lastSign && sign !== lastSign) flips += 1;
    lastSign = sign;
  }
  return {
    flips,
    span: min === Infinity ? 0 : Math.round((max - min) * 10) / 10,
  };
}

function summarize(samples) {
  const remounts = samples.filter((sample, index) => index > 0 && sample.anchorId && sample.anchorId !== samples[index - 1].anchorId).length;
  return {
    count: samples.length,
    remounts,
    anchorTop: oscillation(samples, "anchorTop"),
    anchorHeight: oscillation(samples, "anchorHeight"),
    scrollTop: oscillation(samples, "scrollTop", 2),
    scrollHeight: oscillation(samples, "scrollHeight", 2),
    transform: [...new Set(samples.map((sample) => sample.transform).filter(Boolean))],
    opacity: [...new Set(samples.map((sample) => sample.opacity).filter(Boolean))],
    fontSize: [...new Set(samples.map((sample) => sample.fontSize).filter(Boolean))],
    animation: [...new Set(samples.map((sample) => sample.animation).filter(Boolean))],
    live: [...new Set(samples.map((sample) => sample.live).filter(Boolean))],
  };
}

test("OCV5-265 motion: real App WebSocket trajectory, desktop and 390", { timeout: 240000 }, async () => {
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
  console.log("motion-bundle-ready");

  const preview = await startPreviewServer(assetDir);
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox"],
  });
  const report = { viewports: [] };
  try {
    async function open(width, height) {
      const context = await browser.newContext({
        viewport: { width, height },
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

    async function installRecorder(page) {
      await page.evaluate(() => {
        const state = { samples: [], stopped: false };
        window.__motionRec = state;
        const anchor = () => [...document.querySelectorAll("p, div, span")].find((node) => {
          const text = node.textContent || "";
          return text.includes("还在，可售合计 128") && text.length < 80;
        }) || null;
        const tick = () => {
          if (state.stopped) return;
          const node = anchor();
          if (node && !node.dataset.motionId) node.dataset.motionId = `a${state.samples.length}-${node.tagName}`;
          const scroller = document.querySelector(".chat-scroll-area");
          const rect = node?.getBoundingClientRect();
          const style = node ? getComputedStyle(node) : null;
          const live = document.querySelector("[data-testid=process-step-live]");
          state.samples.push({
            t: Math.round(performance.now()),
            anchorId: node?.dataset.motionId || "",
            anchorTop: rect ? Math.round(rect.top * 10) / 10 : null,
            anchorHeight: rect ? Math.round(rect.height * 10) / 10 : null,
            scrollTop: scroller instanceof HTMLElement ? Math.round(scroller.scrollTop * 10) / 10 : null,
            scrollHeight: scroller instanceof HTMLElement ? scroller.scrollHeight : null,
            transform: style?.transform || "",
            opacity: style?.opacity || "",
            fontSize: style?.fontSize || "",
            animation: style?.animationName || "",
            live: (live?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }

    async function sliceFrom(page, mark) {
      return page.evaluate((start) => window.__motionRec.samples.slice(start), mark);
    }

    async function mark(page) {
      return page.evaluate(() => window.__motionRec.samples.length);
    }

    async function release() {
      const response = await fetch(new URL("/api/fixture/step", preview.url), { method: "POST" });
      assert.equal(response.ok, true);
    }

    async function run(width, height, shotsFor) {
      const session = await open(width, height);
      try {
        await installRecorder(session.page);
        const box = session.page.getByPlaceholder(/对话/);
        await box.click();
        await box.fill("抖动探针");
        await session.page.getByRole("button", { name: "发送" }).click();
        await session.page.getByText("MOTION_ANCHOR").waitFor();
        const followMark = await mark(session.page);
        await session.page.waitForFunction(() => document.body.innerText.includes("尾段6"));
        await session.page.waitForTimeout(300);
        const follow = await sliceFrom(session.page, followMark);
        if (shotsFor.follow) await session.page.screenshot({ path: join(shots, shotsFor.follow) });

        const scroller = session.page.locator(".chat-scroll-area").first();
        const beforePause = await scroller.evaluate((el) => {
          el.scrollTop = Math.max(0, el.scrollTop - Math.min(280, el.scrollTop));
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
          return el.scrollTop;
        });
        await session.page.waitForTimeout(200);
        const pausedMark = await mark(session.page);
        await release();
        await session.page.waitForFunction(() => document.body.innerText.includes("尾段10") || document.body.innerText.includes("MOTION_THINK") || !!document.querySelector("[data-testid=process-step-live]"));
        await session.page.waitForTimeout(400);
        const paused = await sliceFrom(session.page, pausedMark);
        const pausedScroll = await scroller.evaluate((el) => el.scrollTop);
        if (shotsFor.paused) await session.page.screenshot({ path: join(shots, shotsFor.paused) });

        const toolMark = await mark(session.page);
        await release();
        await session.page.getByText("MOTION_NEXT").waitFor();
        await session.page.waitForTimeout(250);
        const switched = await sliceFrom(session.page, toolMark);
        if (shotsFor.switched) await session.page.screenshot({ path: join(shots, shotsFor.switched) });

        const toggle = session.page.getByTestId("process-detail-toggle").last();
        if (await toggle.count()) {
          await toggle.click();
          await session.page.waitForTimeout(200);
        }
        if (shotsFor.expanded) await session.page.screenshot({ path: join(shots, shotsFor.expanded) });
        const expandedCommand = await session.page.locator("body").innerText();

        const finalMark = await mark(session.page);
        await release();
        await session.page.getByText("MOTION_FINAL").waitFor();
        await session.page.waitForTimeout(300);
        const finished = await sliceFrom(session.page, finalMark);
        if (shotsFor.finished) await session.page.screenshot({ path: join(shots, shotsFor.finished) });
        assert.equal(session.errors.length, 0, session.errors.join("\n"));
        const pausedLive = paused.map((sample) => sample.live).join("\n");
        return {
          width,
          height,
          beforePause,
          pausedScroll,
          leakedJob: /dlgjob-motion-SECRET|delegate-wait/.test(pausedLive),
          expandedHasCommand: expandedCommand.includes("dlgjob-motion-SECRET"),
          follow: summarize(follow),
          paused: summarize(paused),
          switched: summarize(switched),
          finished: summarize(finished),
          samples: {
            follow: follow.filter((_, index) => index % 4 === 0).slice(0, 40),
            paused: paused.filter((_, index) => index % 4 === 0).slice(0, 40),
            switched: switched.filter((_, index) => index % 4 === 0).slice(0, 40),
          },
        };
      } finally {
        await session.context.close();
      }
    }

    report.viewports.push(await run(1280, 1000, {
      follow: "ocv5-265-motion-follow-desktop.png",
      paused: "ocv5-265-motion-paused-desktop.png",
      switched: "ocv5-265-motion-switch-desktop.png",
      expanded: "ocv5-265-motion-expand-desktop.png",
      finished: "ocv5-265-motion-final-desktop.png",
    }));
    report.viewports.push(await run(390, 844, {
      follow: "ocv5-265-motion-follow-390.png",
      paused: "ocv5-265-motion-paused-390.png",
      finished: "ocv5-265-motion-final-390.png",
    }));
    writeFileSync(join(shots, "ocv5-265-motion-trajectory.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.viewports.map((item) => ({
      width: item.width,
      leakedJob: item.leakedJob,
      expandedHasCommand: item.expandedHasCommand,
      follow: item.follow,
      paused: item.paused,
      switched: item.switched,
      finished: item.finished,
      scroll: [item.beforePause, item.pausedScroll],
    }))));
  } finally {
    await browser.close();
    await new Promise((done) => preview.server.close(done));
  }
});
