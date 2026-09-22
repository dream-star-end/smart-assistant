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
const assetDir = process.env.OC_PROCESS_MOTION_DIR || "/tmp/ocv5-265-motion-review-app";

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
  return { flips, span: min === Infinity ? 0 : Math.round((max - min) * 10) / 10 };
}

function summarize(samples) {
  const remounts = samples.filter((sample, index) => index > 0 && sample.anchorId && samples[index - 1].anchorId && sample.anchorId !== samples[index - 1].anchorId).length;
  const texts = samples.map((sample) => sample.text).filter(Boolean);
  return {
    count: samples.length,
    updates: texts.filter((text, index) => index === 0 || text !== texts[index - 1]).length - (texts.length ? 1 : 0),
    sawAnchor: texts.some((text) => text.includes("REVIEW_ANCHOR")),
    sawTail: texts.some((text) => text.includes("尾段")),
    sawLive: [...new Set(samples.map((sample) => sample.live).filter(Boolean))],
    remounts,
    anchorTop: oscillation(samples, "anchorTop"),
    anchorHeight: oscillation(samples, "anchorHeight"),
    scrollTop: oscillation(samples, "scrollTop", 2),
    scrollHeight: oscillation(samples, "scrollHeight", 2),
    transform: [...new Set(samples.flatMap((sample) => sample.transforms || []))],
    opacity: [...new Set(samples.flatMap((sample) => sample.opacities || []))],
    animation: [...new Set(samples.flatMap((sample) => sample.animations || []))],
  };
}

test("OCV5-265 motion review: current-turn prefix, desktop and 390", { timeout: 240000 }, async () => {
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
  const report = { note: "Samples the current-turn REVIEW_ANCHOR, not the previous inventory sentence.", viewports: [] };
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
      await page.evaluate(() => {
        const state = { samples: [], stopped: false, seq: 1 };
        window.__reviewRec = state;
        window.__reviewAnchor = () => {
          const roots = [...document.querySelectorAll("[data-testid=process-stage]")].filter((node) => (node.textContent || "").includes("REVIEW_ANCHOR"));
          const root = roots.at(-1);
          if (!root) return null;
          const inner = [...root.querySelectorAll("p, li, div, span")].filter((node) => (node.textContent || "").includes("REVIEW_ANCHOR"));
          inner.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
          return inner[0] || root;
        };
        const tick = () => {
          if (state.stopped) return;
          const node = window.__reviewAnchor();
          const stage = node?.closest("[data-testid=process-stage]");
          if (node && !node.dataset.reviewId) node.dataset.reviewId = `r${state.seq++}`;
          const scroller = document.querySelector(".chat-scroll-area");
          const rect = node?.getBoundingClientRect();
          const box = scroller instanceof HTMLElement ? scroller.getBoundingClientRect() : null;
          const chain = [];
          let cursor = node;
          while (cursor && chain.length < 6) {
            const style = getComputedStyle(cursor);
            chain.push({ transform: style.transform, opacity: style.opacity, animation: style.animationName });
            if (cursor === scroller) break;
            cursor = cursor.parentElement;
          }
          const live = document.querySelector("[data-testid=process-step-live]");
          const text = (stage?.textContent || node?.textContent || "").replace(/\s+/g, " ").trim();
          state.samples.push({
            t: Math.round(performance.now()),
            anchorId: node?.dataset.reviewId || "",
            text: text.slice(0, 180),
            anchorTop: rect ? Math.round(rect.top * 10) / 10 : null,
            anchorHeight: rect ? Math.round(rect.height * 10) / 10 : null,
            inView: !!(rect && box && rect.height > 8 && rect.top >= box.top - 2 && rect.bottom <= box.bottom + 2 && rect.top < box.bottom - 8),
            scrollTop: scroller instanceof HTMLElement ? Math.round(scroller.scrollTop * 10) / 10 : null,
            scrollHeight: scroller instanceof HTMLElement ? scroller.scrollHeight : null,
            gap: scroller instanceof HTMLElement ? Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) : null,
            transforms: chain.map((item) => item.transform),
            opacities: chain.map((item) => item.opacity),
            animations: chain.map((item) => item.animation),
            live: (live?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { context, page, errors };
    }

    async function mark(page) {
      return page.evaluate(() => window.__reviewRec.samples.length);
    }

    async function sliceFrom(page, start) {
      return page.evaluate((from) => window.__reviewRec.samples.slice(from), start);
    }

    async function release() {
      const response = await fetch(new URL("/api/fixture/step", preview.url), { method: "POST" });
      assert.equal(response.ok, true);
    }

    async function proveVisible(page, file) {
      const proof = await page.evaluate(() => {
        const node = window.__reviewAnchor();
        const scroller = document.querySelector(".chat-scroll-area");
        if (!(node instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return { ok: false, reason: "missing" };
        const measure = () => {
          const rect = node.getBoundingClientRect();
          const box = scroller.getBoundingClientRect();
          return {
            ok: rect.height > 8 && rect.top >= box.top + 4 && rect.bottom <= box.bottom - 4 && rect.top < box.bottom - 8,
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            height: Math.round(rect.height),
            viewTop: Math.round(box.top),
            viewBottom: Math.round(box.bottom),
          };
        };
        const before = measure();
        if (!before.ok) {
          const rect = node.getBoundingClientRect();
          const box = scroller.getBoundingClientRect();
          scroller.scrollTop += rect.top - box.top - 80;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        const after = measure();
        return {
          ...after,
          before,
          nudged: !before.ok,
          text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
          id: node.dataset.reviewId || "",
        };
      });
      assert.ok(proof.ok, `${file} anchor not in view: ${JSON.stringify(proof)}`);
      assert.match(proof.text, /REVIEW_ANCHOR/);
      await page.screenshot({ path: join(shots, file) });
      return proof;
    }

    function assertActive(summary, label) {
      assert.ok(summary.count > 0, `${label} collected no samples`);
      assert.ok(summary.updates > 0, `${label} update count is 0: ${JSON.stringify(summary)}`);
      assert.equal(summary.sawAnchor, true, `${label} never saw the current prefix`);
    }

    async function run(width, height, names) {
      const session = await open(width, height);
      try {
        const box = session.page.getByPlaceholder(/对话/);
        await box.click();
        await box.fill("抖动复核");
        await session.page.getByRole("button", { name: "发送" }).click();
        await session.page.getByTestId("process-stage").filter({ hasText: "REVIEW_ANCHOR" }).waitFor();
        const dock = session.page.getByTestId("scroll-to-bottom-dock");
        if (await dock.getAttribute("data-visible") === "true") {
          await session.page.getByTestId("scroll-to-bottom").click({ force: true });
          await session.page.waitForTimeout(250);
        }
        const followMark = await mark(session.page);
        await release();
        await session.page.getByText("尾段6").waitFor();
        await session.page.waitForTimeout(250);
        const follow = await sliceFrom(session.page, followMark);
        const followSummary = summarize(follow);
        assertActive(followSummary, "follow");
        assert.equal(followSummary.sawTail, true, "follow did not see appended tail text");
        const followShot = await proveVisible(session.page, names.follow);

        const pausedAt = await session.page.evaluate(() => {
          const scroller = document.querySelector(".chat-scroll-area");
          if (!(scroller instanceof HTMLElement)) return { ok: false, reason: "scroller" };
          const place = () => {
            const node = window.__reviewAnchor();
            if (!(node instanceof HTMLElement)) return { ok: false, reason: "anchor" };
            const rect = node.getBoundingClientRect();
            const box = scroller.getBoundingClientRect();
            const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
            return {
              ok: rect.height > 8 && rect.height < box.height - 16 && rect.top >= box.top + 4 && rect.bottom <= box.bottom - 4,
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              height: Math.round(rect.height),
              viewTop: Math.round(box.top),
              viewBottom: Math.round(box.bottom),
              gap: Math.round(gap),
              scrollTop: Math.round(scroller.scrollTop),
              text: (node.textContent || "").slice(0, 40),
            };
          };
          let placed = place();
          if (!placed.ok && typeof placed.top === "number" && typeof placed.viewTop === "number") {
            scroller.scrollTop += placed.top - placed.viewTop - 88;
            placed = place();
          }
          if (placed.gap < 80 && placed.ok) {
            scroller.scrollTop = Math.max(0, scroller.scrollTop - 120);
            placed = place();
          }
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          return placed;
        });
        assert.ok(pausedAt.ok && pausedAt.gap > 40, `could not pause away from the bottom while keeping the prefix: ${JSON.stringify(pausedAt)}`);
        await session.page.waitForTimeout(200);
        const pausedMark = await mark(session.page);
        await release();
        await session.page.getByText("尾段10").waitFor();
        await session.page.waitForTimeout(250);
        const paused = await sliceFrom(session.page, pausedMark);
        const pausedSummary = summarize(paused);
        assertActive(pausedSummary, "paused");
        const pausedShot = await proveVisible(session.page, names.paused);
        const pausedScroll = await session.page.locator(".chat-scroll-area").first().evaluate((el) => el.scrollTop);

        const expandMark = await mark(session.page);
        await release();
        await session.page.getByText("REVIEW_THINK").waitFor({ timeout: 8_000 }).catch(() => {});
        const stageToggle = session.page.getByTestId("process-stage-toggle").filter({ hasText: "REVIEW_ANCHOR" });
        if (await stageToggle.count()) await stageToggle.click();
        await session.page.getByTestId("process-stage").filter({ hasText: "REVIEW_ANCHOR" }).waitFor();
        await session.page.waitForTimeout(200);
        const opened = await sliceFrom(session.page, expandMark);
        const openedShot = await proveVisible(session.page, names.expanded);
        const pinnedId = openedShot.id;

        const metaMark = await mark(session.page);
        await release();
        await session.page.waitForTimeout(700);
        const meta = await sliceFrom(session.page, metaMark);
        const metaSummary = summarize(meta);
        assert.ok(metaSummary.count > 0, "meta phase collected no samples");
        assert.ok(metaSummary.sawLive.length > 0 || metaSummary.updates > 0, `meta phase saw neither a live line nor a text update: ${JSON.stringify(metaSummary)}`);
        assert.equal(metaSummary.sawAnchor, true, "expanded prefix disappeared during tool metadata updates");
        const metaShot = await proveVisible(session.page, names.meta);
        assert.equal(metaShot.id, pinnedId, `prefix remounted while the stage stayed open: ${pinnedId} -> ${metaShot.id}`);

        const switchMark = await mark(session.page);
        await release();
        await session.page.getByText("REVIEW_NEXT").waitFor();
        await session.page.waitForTimeout(250);
        const switched = await sliceFrom(session.page, switchMark);
        const switchSummary = summarize(switched);
        assert.ok(switchSummary.count > 0, "switch phase collected no samples");
        const switchShot = names.switched ? await proveVisible(session.page, names.switched).catch((error) => ({ ok: false, error: String(error) })) : null;

        assert.equal(session.errors.length, 0, session.errors.join("\n"));
        return {
          width,
          height,
          pausedAt,
          pausedScroll,
          follow: followSummary,
          paused: pausedSummary,
          openedUpdates: summarize(opened).updates,
          meta: metaSummary,
          switched: switchSummary,
          shots: { follow: followShot, paused: pausedShot, expanded: openedShot, meta: metaShot, switched: switchShot },
          samples: {
            follow: follow.filter((_, index) => index % 3 === 0).slice(0, 24),
            paused: paused.filter((_, index) => index % 3 === 0).slice(0, 24),
            meta: meta.filter((_, index) => index % 3 === 0).slice(0, 24),
          },
        };
      } finally {
        await session.context.close();
      }
    }

    report.viewports.push(await run(1280, 1000, {
      follow: "ocv5-265-motion-review-follow-desktop.png",
      paused: "ocv5-265-motion-review-paused-desktop.png",
      expanded: "ocv5-265-motion-review-expanded-desktop.png",
      meta: "ocv5-265-motion-review-meta-desktop.png",
      switched: "ocv5-265-motion-review-switch-desktop.png",
    }));
    report.viewports.push(await run(390, 844, {
      follow: "ocv5-265-motion-review-follow-390.png",
      paused: "ocv5-265-motion-review-paused-390.png",
      expanded: "ocv5-265-motion-review-expanded-390.png",
      meta: "ocv5-265-motion-review-meta-390.png",
      switched: "ocv5-265-motion-review-switch-390.png",
    }));
    writeFileSync(join(shots, "ocv5-265-motion-review-trajectory.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.viewports.map((item) => ({
      width: item.width,
      pausedAt: item.pausedAt,
      follow: item.follow,
      paused: item.paused,
      meta: item.meta,
      switched: item.switched,
      shots: item.shots,
    }))));
  } finally {
    await browser.close();
    await new Promise((done) => preview.server.close(done));
  }
});
