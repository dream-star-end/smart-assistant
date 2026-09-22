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
import { BOARD_SESSION, CSV_BODY, CSV_NAME, OLD_SESSION, WAIT_SESSION } from "./process-disclosure-story.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.env.OC_PROCESS_SHOT_DIR || "/home/agent/.openclaude/generated";
const assetDir = process.env.OC_PROCESS_APP_DIR || "/tmp/ocv5-265-e2e-app";

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

async function waitUntil(label, pred, ms = 20_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out`);
}

test("OCV5-265 App E2E: real WebSocket fixture, not a disconnected preview", { timeout: 420000 }, async () => {
  process.env.OC_E2E_STREAM_GAP_MS = process.env.OC_E2E_STREAM_GAP_MS || "420";
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
  const evidence = { scroll: null, clamp: null, permission: null, frames: [] };
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
      const traffic = { sent: [], recv: [] };
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("websocket", (ws) => {
        ws.on("framesent", (frame) => {
          try { traffic.sent.push(JSON.parse(frame.payload)); } catch { /* ignore */ }
        });
        ws.on("framereceived", (frame) => {
          try { traffic.recv.push(JSON.parse(frame.payload)); } catch { /* ignore */ }
        });
      });
      page.setDefaultTimeout(20_000);
      await page.goto(preview.url, { waitUntil: "domcontentloaded" });
      return { context, page, errors, traffic };
    }

    async function metaMetrics(page, needle) {
      return page.getByTestId("assistant-meta").filter({ hasText: needle }).evaluate((el) => {
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

    async function frameInView(page, locator, name) {
      await locator.waitFor();
      const visible = await locator.evaluate((el) => {
        const scroller = el.closest(".chat-scroll-area");
        if (!(scroller instanceof HTMLElement) || !(el instanceof HTMLElement)) return { ok: false, reason: "missing" };
        const view = scroller.getBoundingClientRect();
        const row = el.getBoundingClientRect();
        scroller.scrollTop += row.top - view.top - 28;
        const next = el.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        return {
          ok: next.height > 8 && next.top >= box.top - 2 && next.top <= box.bottom - 24,
          top: Math.round(next.top),
          bottom: Math.round(next.bottom),
          height: Math.round(next.height),
          viewTop: Math.round(box.top),
          viewBottom: Math.round(box.bottom),
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90),
        };
      });
      assert.ok(visible.ok, `${name} not in view: ${JSON.stringify(visible)}`);
      evidence.frames.push({ name, ...visible });
      return visible;
    }

    async function shotFramed(page, locator, name) {
      const visible = await frameInView(page, locator, name);
      await page.screenshot({ path: join(shots, `${name}.png`) });
      return visible;
    }

    async function shotActiveGoalStage(page, kind, fileName) {
      const shell = page.locator("[data-process-active=true]").last();
      const toggle = shell.getByTestId("process-toggle");
      const proof = kind === "tool"
        ? shell.getByTestId("process-step-live")
        : shell.getByTestId("process-stage").filter({ hasText: "FINAL_LONG" });
      await toggle.waitFor();
      await proof.waitFor();
      const placed = await shell.evaluate((el, expected) => {
        const scroller = el.closest(".chat-scroll-area");
        if (!(scroller instanceof HTMLElement) || !(el instanceof HTMLElement)) return { ok: false, reason: "missing" };
        const toggleEl = el.querySelector("[data-testid=process-toggle]");
        const proofEl = expected === "tool"
          ? el.querySelector("[data-testid=process-step-live]")
          : [...el.querySelectorAll("[data-testid=process-stage]")].find((node) => node.textContent?.includes("FINAL_LONG"));
        if (!(toggleEl instanceof HTMLElement) || !(proofEl instanceof HTMLElement)) return { ok: false, reason: "target" };
        const view = scroller.getBoundingClientRect();
        scroller.scrollTop += toggleEl.getBoundingClientRect().top - view.top - 12;
        const box = scroller.getBoundingClientRect();
        const toggleBox = toggleEl.getBoundingClientRect();
        const proofBox = proofEl.getBoundingClientRect();
        const goal = el.querySelector("[data-testid=process-goal]");
        let lineClamp = "none";
        let node = proofEl;
        while (node) {
          const value = getComputedStyle(node).webkitLineClamp;
          if (value && value !== "none") lineClamp = value;
          node = node.parentElement;
        }
        const inside = (rect) => rect.height > 8 && rect.top >= box.top - 2 && rect.bottom <= box.bottom + 2 && rect.top < box.bottom - 8;
        return {
          ok: inside(toggleBox) && proofBox.top >= box.top - 2 && proofBox.top < box.bottom - 24 && proofBox.height > 8,
          title: (toggleEl.textContent || "").replace(/\s+/g, " ").trim(),
          expanded: toggleEl.getAttribute("aria-expanded"),
          active: el.getAttribute("data-process-active"),
          avatar: !!el.querySelector(".bg-grad-cta"),
          lineClamp,
          proofHeight: Math.round(proofBox.height),
          proofText: (proofEl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
          goalText: (goal?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
          toggle: { top: Math.round(toggleBox.top), bottom: Math.round(toggleBox.bottom), left: Math.round(toggleBox.left), width: Math.round(toggleBox.width) },
          proof: { top: Math.round(proofBox.top), bottom: Math.round(proofBox.bottom), height: Math.round(proofBox.height) },
          view: { top: Math.round(box.top), bottom: Math.round(box.bottom), width: window.innerWidth },
        };
      }, kind);
      assert.equal(placed.active, "true", `${kind} shell is not the active process`);
      assert.match(placed.title, /处理过程/, `${kind} title: ${placed.title}`);
      assert.equal(placed.expanded, "true", `${kind} shell is collapsed`);
      assert.equal(placed.avatar, false, `${kind} still paints an avatar`);
      assert.equal(placed.lineClamp, "none", `${kind} proof is line-clamped`);
      assert.ok(placed.proofHeight > (kind === "tool" ? 16 : 72), `${kind} proof looks truncated: ${JSON.stringify(placed)}`);
      assert.ok(placed.ok, `${kind} target rect is outside the viewport: ${JSON.stringify(placed)}`);
      if (kind === "tool") assert.match(placed.proofText, /进行中/);
      if (kind === "body") assert.match(placed.proofText, /FINAL_LONG/);
      assert.ok(placed.goalText.length > 0, `${kind} diagnostic goal is missing: ${JSON.stringify(placed)}`);
      evidence.frames.push({ name: fileName, ...placed });
      await page.screenshot({ path: join(shots, `${fileName}.png`) });
      return placed;
    }

    async function align(page, locator) {
      const scroller = page.locator(".chat-scroll-area");
      await scroller.hover();
      for (let i = 0; i < 16; i += 1) {
        const placed = await locator.evaluate((el) => {
          const box = el.closest(".chat-scroll-area");
          if (!box) return false;
          const view = box.getBoundingClientRect();
          const row = el.getBoundingClientRect();
          return row.height > 8 && row.top >= view.top + 4 && row.top <= view.top + 200;
        });
        if (placed) return;
        const dir = await locator.evaluate((el) => {
          const box = el.closest(".chat-scroll-area");
          return el.getBoundingClientRect().top < box.getBoundingClientRect().top + 4 ? -1 : 1;
        });
        await page.mouse.wheel(0, dir * 360);
        await page.waitForTimeout(70);
      }
    }

    async function sendText(page, text) {
      const box = page.getByPlaceholder(/对话/);
      await box.click();
      await box.fill(text);
      await page.getByRole("button", { name: "发送" }).click();
    }

    const desktop = await open(1280, false);
    try {
      await desktop.page.getByText("看板已经做好").waitFor();
      await waitUntil("hello", () => preview.stats.hellos > 0);
      await desktop.page.waitForFunction(() => !document.body.innerText.includes("未连接"));
      await desktop.page.getByTitle("HTML 沙盒预览").waitFor();
      assert.equal(await desktop.page.getByText("summarize-stock.mjs").count(), 0, "tool log stays folded in the App");
      assert.equal(await desktop.page.getByText("paper.pdf").count(), 0);
      assert.equal(await desktop.page.getByText("还在，可售合计 128。").count(), 1);
      assert.equal(await desktop.page.getByTestId("process-disclosure").count(), 1, "plain follow-up has no process shell");
      const chronology = await desktop.page.evaluate(async (id) => {
        const detail = await (await fetch(`/api/sessions/${id}`)).json();
        const listed = (await (await fetch("/api/sessions/list")).json()).sessions;
        return { detail, listed };
      }, BOARD_SESSION);
      const times = chronology.detail.messages.map((message) => message.ts);
      assert.ok(chronology.detail.createdAt <= times[0], "session created after its first message");
      assert.ok(times.every((ts, index) => index === 0 || ts >= times[index - 1]), "message timestamps go backwards");
      assert.ok(chronology.detail.updatedAt >= times.at(-1) && chronology.detail.lastAt >= times.at(-1));
      assert.ok(Date.now() - chronology.detail.createdAt < 3 * 60 * 60_000, "default board is not a recent session");
      assert.equal(chronology.detail.messages.some((message) => message.ts < 1_600_000_000_000), false, "default board still has a 2023 timestamp");
      const waitListed = chronology.listed.find((session) => session.id === WAIT_SESSION);
      assert.ok(waitListed.createdAt > 1_600_000_000_000 && waitListed.createdAt <= waitListed.lastAt);
      const chatText = await desktop.page.locator(".chat-scroll-area").innerText();
      assert.doesNotMatch(chatText, /2023-11-15|1970/);
      const boardLabel = await desktop.page.getByRole("button", { name: "库存看板" }).innerText();
      const waitLabel = await desktop.page.getByRole("button", { name: "待你确认" }).innerText();
      assert.doesNotMatch(boardLabel, /1970|\d{4,}天/);
      assert.doesNotMatch(waitLabel, /1970|\d{4,}天/);
      const meta = await metaMetrics(desktop.page, "12 积分");
      assert.equal(meta.fontSize, "11px");
      assert.ok(meta.rowHeight < 36, `meta row too tall: ${meta.rowHeight}`);
      assert.ok(Math.abs(meta.timeTop - meta.creditTop) < 8, "time and credits are not one compact row");
      assert.match(meta.text, /12\s*积分/);
      assert.match(meta.text, /token/);
      assert.match(meta.text, /刚刚|分钟前/);
      assert.doesNotMatch(meta.text, /2023-11-15|1970/);
      assert.ok(contrastRatio(meta.color, meta.bg) >= 4.5, `light contrast ${contrastRatio(meta.color, meta.bg)}`);
      await desktop.page.getByText("刚刚").first().waitFor();
      const iframeSrc = await desktop.page.getByTitle("HTML 沙盒预览").getAttribute("srcdoc");
      assert.match(iframeSrc ?? "", /库存看板/);
      assert.match(iframeSrc ?? "", /可售合计 128/);

      await align(desktop.page, desktop.page.getByText("做一版库存看板").first());
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-e2e-desktop-turn.png") });
      await align(desktop.page, desktop.page.getByText("看板已经做好").first());
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-e2e-desktop-answer.png") });

      const file = desktop.page.getByRole("link", { name: new RegExp(CSV_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
      await file.waitFor();
      const clip = await file.evaluate((el) => {
        const name = el.querySelector(".truncate") ?? el;
        return { full: name.textContent ?? "", clipped: name.scrollWidth > name.clientWidth + 1 };
      });
      assert.match(clip.full, /acceptance-fixture\.csv/);
      const [download] = await Promise.all([
        desktop.page.waitForEvent("download"),
        file.click(),
      ]);
      assert.equal(download.suggestedFilename(), CSV_NAME);
      const saved = await download.path();
      assert.equal(readFileSync(saved, "utf8"), CSV_BODY);
      await align(desktop.page, file);
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-e2e-artifact.png") });

      assert.equal(await desktop.page.getByText("已清除的库存目标").count(), 0, "cleared goal is its own top card while the process is closed");
      await desktop.page.getByTestId("process-toggle").first().click();
      await desktop.page.getByText("先按北仓和南仓核对可售口径").waitFor();
      const clearedGoal = desktop.page.getByText("已清除的库存目标");
      await clearedGoal.waitFor();
      const goalChrome = await clearedGoal.evaluate((el) => {
        const line = el.closest("[data-testid=process-goal-line]");
        const card = el.closest(".rounded-lg.border");
        return {
          inGoal: !!el.closest("[data-testid=process-goal]"),
          line: line instanceof HTMLElement,
          card: !!card,
          text: (line?.textContent || "").replace(/\s+/g, " ").trim(),
        };
      });
      assert.equal(goalChrome.inGoal, true);
      assert.equal(goalChrome.line, true, "cleared goal is still a tombstone card");
      assert.equal(goalChrome.card, false, "cleared goal still paints a bordered card");
      assert.match(goalChrome.text, /^目标已清除/);
      assert.doesNotMatch(goalChrome.text, /会话目标/);
      assert.equal(await desktop.page.getByText("tape-cleared-goal").count(), 0, "raw goal record is visible before the third level");
      await shotFramed(desktop.page, clearedGoal, "ocv5-265-avatar-polish-cleared-goal");
      await desktop.page.getByRole("button", { name: "查看原始目标记录" }).click();
      await desktop.page.getByText("tape-cleared-goal").waitFor();
      await shotFramed(desktop.page, desktop.page.getByTestId("process-goal-record"), "ocv5-265-avatar-polish-goal-record");
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-live-flow-cleared-goal.png") });
      assert.equal(await desktop.page.getByText("summarize-stock.mjs").count(), 0);
      await align(desktop.page, desktop.page.getByTestId("process-stage").first());
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-e2e-desktop-expanded.png") });
      await desktop.page.getByTestId("process-detail-toggle").first().click();
      await desktop.page.getByText("summarize-stock.mjs").waitFor();
      await desktop.page.getByTestId("process-toggle").first().focus();
      await desktop.page.keyboard.press("Enter");
      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-toggle]")?.getAttribute("aria-expanded") === "false");
      await desktop.page.getByTestId("process-toggle").first().focus();
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
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-e2e-find.png") });
      await desktop.page.keyboard.press("Escape");

      await desktop.page.getByRole("button", { name: /查看更早历史记录/ }).click();
      await desktop.page.getByText("先把北仓和南仓的可售范围说清楚").waitFor();
      await desktop.page.getByText("冻结库存这次要不要单独列出？").waitFor();
      await desktop.page.getByText("看板已经做好").waitFor();
      const olderInside = await desktop.page.getByText("先把北仓和南仓的可售范围说清楚").evaluate((el) => !!el.closest("[data-testid=process-disclosure]"));
      assert.equal(olderInside, false, "older turn must not join the board process group");
      const recentInside = await desktop.page.getByText("数字还在吗？").evaluate((el) => !!el.closest("[data-testid=process-disclosure]"));
      assert.equal(recentInside, false, "plain follow-up must not join the board process group");
      const order = await desktop.page.evaluate(() => {
        const textOf = (needle) => [...document.querySelectorAll("body *")].find((el) =>
          [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes(needle)));
        const older = textOf("先把北仓和南仓的可售范围说清楚");
        const board = textOf("做一版库存看板");
        const recent = textOf("数字还在吗？");
        if (!older || !board || !recent) return "missing";
        const after = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        return after(older, board) && after(board, recent) ? "older-board-recent" : "crossed";
      });
      assert.equal(order, "older-board-recent");

      const beforeSend = preview.stats.inboundMessages.length;
      await sendText(desktop.page, "把南仓预警补进同一张看板");
      await waitUntil("composer inbound", () => preview.stats.inboundMessages.length > beforeSend);
      await desktop.page.getByText("南仓预警已补进看板").waitFor();
      await desktop.page.getByText("预警段落-02").waitFor();
      assert.equal(await desktop.page.getByText("预警段落-08").count(), 0, "later token arrived before the scroll sample");
      const clamp = await desktop.page.getByText("南仓预警已补进看板").evaluate((el) => {
        let lineClamp = "none";
        let node = el;
        while (node) {
          const value = getComputedStyle(node).webkitLineClamp;
          if (value && value !== "none") lineClamp = value;
          node = node.parentElement;
        }
        return { lineClamp, inProcess: !!el.closest("[data-testid=process-disclosure]") };
      });
      evidence.clamp = clamp;
      assert.equal(clamp.lineClamp, "none", "streaming answer is line-clamped");
      assert.equal(clamp.inProcess, true, "streaming answer left the single work area");
      const scroller = desktop.page.locator(".chat-scroll-area");
      await scroller.hover();
      for (let i = 0; i < 14; i += 1) {
        const gap = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
        if (gap > 500) break;
        await desktop.page.mouse.wheel(0, -480);
        await desktop.page.waitForTimeout(60);
      }
      await align(desktop.page, desktop.page.getByText("做一版库存看板").first());
      await desktop.page.waitForTimeout(350);
      const scrolled = await scroller.evaluate((el) => ({
        top: el.scrollTop,
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      }));
      assert.ok(scrolled.gap > 400, `did not leave the bottom before later tokens: ${JSON.stringify(scrolled)}`);
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-e2e-stream-scrolled.png") });
      await desktop.page.getByText("预警段落-08").waitFor({ timeout: 20_000 });
      const afterTokens = await scroller.evaluate((el) => ({
        top: el.scrollTop,
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      }));
      evidence.scroll = { before: scrolled, after: afterTokens };
      assert.ok(afterTokens.gap > 300, `new tokens pulled back to the bottom: ${JSON.stringify(afterTokens)}`);
      assert.ok(afterTokens.top < scrolled.top + 80, `viewport moved toward the bottom ${scrolled.top} -> ${afterTokens.top}`);
      const liveToggle = desktop.page.getByTestId("process-toggle").last();
      assert.equal(await liveToggle.getAttribute("aria-expanded"), "true", "active process hid the current step");
      await desktop.page.getByText("南仓预警已补进看板").waitFor();
      const liveStagePlacement = await desktop.page.evaluate(() => {
        const textIn = (selector, needle) => [...document.querySelectorAll(selector)].some((el) => el.textContent?.includes(needle));
        return {
          answerInProcess: textIn("[data-testid=process-stage]", "预警段落"),
          answerOutside: textIn("[data-testid=assistant-row]", "南仓预警已补进看板"),
          previousOpen: textIn("[data-testid=process-stage]", "冻结库存仍然不进看板"),
          previousFolded: textIn("[data-testid=process-stage-toggle]", "冻结库存仍然不进看板"),
          active: document.querySelector("[data-process-active=true]") ? "true" : "false",
        };
      });
      if (liveStagePlacement.answerInProcess) {
        assert.equal(liveStagePlacement.previousFolded, true, `previous stage stayed open after the answer started: ${JSON.stringify(liveStagePlacement)}`);
        assert.equal(liveStagePlacement.previousOpen, false, `previous stage stayed fully open: ${JSON.stringify(liveStagePlacement)}`);
        assert.equal(await liveToggle.getAttribute("aria-expanded"), "true", "process collapsed while tokens arrived");
      } else {
        assert.equal(liveStagePlacement.answerOutside, true, `streaming answer left both the work area and the answer card: ${JSON.stringify(liveStagePlacement)}`);
        if (liveStagePlacement.active === "true") {
          assert.equal(liveStagePlacement.previousOpen, true, `stage collapsed after the answer left the shell: ${JSON.stringify(liveStagePlacement)}`);
          assert.equal(await liveToggle.getAttribute("aria-expanded"), "true", "process collapsed while tokens arrived");
        }
      }
      await desktop.page.getByTestId("scroll-to-bottom").click();
      await desktop.page.waitForFunction(() => {
        const el = document.querySelector(".chat-scroll-area");
        return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      });
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-e2e-stream-answer.png") });
      await desktop.page.getByRole("button", { name: "发送" }).waitFor({ timeout: 20_000 });
      assert.equal(await liveToggle.getAttribute("aria-expanded"), "false", "finished turn stayed expanded without an explicit open");
      const finishedAnswer = await desktop.page.getByText("南仓预警已补进看板").evaluate((el) => ({
        inProcess: !!el.closest("[data-testid=process-disclosure]"),
        inAnswer: !!el.closest("[data-testid=assistant-row]"),
      }));
      assert.equal(finishedAnswer.inProcess, false, "finished answer stayed inside the process");
      assert.equal(finishedAnswer.inAnswer, true, "finished answer has no top-level card");
      const shells = await desktop.page.getByTestId("process-disclosure").count();
      await sendText(desktop.page, "合计还在就行");
      await desktop.page.getByText("还在。可售合计 128，南仓预警已经分开标出。").waitFor({ timeout: 20_000 });
      assert.equal(await desktop.page.getByTestId("process-disclosure").count(), shells, "plain chat grew a process shell");
      const pureAnswer = desktop.page.getByText("还在。可售合计 128，南仓预警已经分开标出。");
      const pureChrome = await pureAnswer.evaluate((el) => ({
        inProcess: !!el.closest("[data-testid=process-disclosure]"),
        avatar: !!el.closest("[data-testid=assistant-row]")?.querySelector(".bg-grad-cta"),
      }));
      assert.equal(pureChrome.inProcess, false, "plain chat grew a process shell");
      assert.equal(pureChrome.avatar, false, "plain chat answer still has an avatar");
      await shotFramed(desktop.page, pureAnswer, "ocv5-265-avatar-polish-pure");
      await desktop.page.getByRole("button", { name: "发送" }).waitFor();

      async function fixtureStep() {
        const endpoint = new URL("/api/fixture/step", preview.url);
        const response = await fetch(endpoint, { method: "POST" });
        assert.equal(response.ok, true);
      }
      async function activeShells() {
        return desktop.page.locator("[data-process-active=true]").count();
      }
      await sendText(desktop.page, "分段过程请按步走");
      await desktop.page.getByText("正在思考").waitFor();
      assert.equal(await activeShells(), 1, "thinking split the turn");
      assert.equal(await desktop.page.getByText("THINK_HIDDEN_TAIL").count(), 0, "thinking trace opened by default");
      await shotFramed(desktop.page, desktop.page.getByText("正在思考"), "ocv5-265-avatar-polish-thinking");
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-live-flow-thinking.png") });
      await fixtureStep();

      await desktop.page.getByText("我先对一下这班发布落在哪").waitFor();
      const stagePlacement = await desktop.page.getByText("我先对一下这班发布落在哪").evaluate((el) => ({
        inProcess: !!el.closest("[data-testid=process-stage]"),
        inAnswer: !!el.closest("[data-testid=assistant-row]"),
        meta: !!el.closest("[data-testid=process-disclosure]")?.querySelector("[data-testid=assistant-meta]"),
      }));
      assert.equal(stagePlacement.inProcess, true, "stage assistant is not in the work area");
      assert.equal(stagePlacement.inAnswer, false, "stage assistant was promoted to the final card");
      assert.equal(stagePlacement.meta, false, "stage assistant shows its own token row");
      const phasedGoal = desktop.page.getByText("已清除的分段目标");
      await phasedGoal.waitFor();
      assert.equal(await phasedGoal.evaluate((el) => !!el.closest("[data-testid=process-disclosure]")), true);
      assert.equal(await activeShells(), 1, "cleared goal split the turn");
      const phasedGoalLine = await phasedGoal.evaluate((el) => (el.closest("[data-testid=process-goal-line]")?.textContent || "").replace(/\s+/g, " ").trim());
      assert.match(phasedGoalLine, /^目标已清除/);
      assert.equal(await phasedGoal.evaluate((el) => !!el.closest(".rounded-lg.border")), false);
      assert.equal(
        await desktop.page.getByText("我先对一下这班发布落在哪").evaluate((el) => !!el.closest("[data-testid=process-stage]")),
        true,
        "goal clear collapsed the current stage",
      );
      await shotFramed(desktop.page, desktop.page.getByText("我先对一下这班发布落在哪"), "ocv5-265-avatar-polish-stage");
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-live-flow-stage.png") });
      await fixtureStep();

      await desktop.page.getByTestId("process-step-live").waitFor();
      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-step-live]")?.textContent?.includes("进行中"));
      assert.equal(await desktop.page.getByText("CMD_DONE_SECRET").count(), 0);
      assert.equal(await activeShells(), 1, "running tool split the turn");
      await desktop.page.getByText("工具仍在执行时的目标诊断").waitFor();
      const runningLive = desktop.page.getByTestId("process-step-live").filter({ hasText: "进行中" });
      assert.match(await runningLive.innerText(), /进行中/);
      await shotFramed(desktop.page, runningLive, "ocv5-265-avatar-polish-tool-running");
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-live-flow-tool-running.png") });
      await shotActiveGoalStage(desktop.page, "tool", "ocv5-265-final-goal-stage-desktop-tool");
      await desktop.page.setViewportSize({ width: 390, height: 844 });
      await shotActiveGoalStage(desktop.page, "tool", "ocv5-265-final-goal-stage-mobile390-tool");
      await desktop.page.setViewportSize({ width: 1280, height: 1000 });
      await fixtureStep();

      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-step-live]")?.textContent?.includes("已完成"));
      assert.equal(await desktop.page.getByText("CMD_DONE_SECRET").count(), 0, "finished tool log opened itself");
      assert.equal(await activeShells(), 1);
      await shotFramed(desktop.page, desktop.page.getByTestId("process-step-live").filter({ hasText: "已完成" }), "ocv5-265-avatar-polish-tool-done");
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-live-flow-tool-done.png") });
      await fixtureStep();

      await desktop.page.getByText("STAGE_TWO 继续核对切流窗口").waitFor();
      const previousStage = await desktop.page.locator("[data-testid=process-stage]", { hasText: "我先对一下这班发布落在哪" }).count();
      const previousLabel = await desktop.page.getByTestId("process-stage-toggle").first().innerText();
      assert.equal(previousStage, 0, "previous stage stayed open");
      assert.ok(previousLabel.replace(/\s/g, "").length > 6, `stage label hard-cut: ${previousLabel}`);
      assert.match(previousLabel, /我先对一下这班发布/);
      assert.equal(await activeShells(), 1);
      await shotFramed(desktop.page, desktop.page.getByText("STAGE_TWO 继续核对切流窗口"), "ocv5-265-avatar-polish-next-stage");
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-live-flow-next-stage.png") });
      await fixtureStep();

      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-step-live]")?.textContent?.includes("VERSION"));
      assert.equal(await desktop.page.getByText("READ_SECRET").count(), 0, "read log opened itself");
      assert.equal(await desktop.page.locator("[data-testid=process-stage]", { hasText: "STAGE_TWO 继续核对切流窗口" }).count(), 0, "previous stage stayed open after the next tool");
      const stageLabels = await desktop.page.getByTestId("process-stage-toggle").allInnerTexts();
      assert.ok(stageLabels.some((label) => label.includes("STAGE_TWO") && label.replace(/\s/g, "").length > 6), `stage labels hard-cut: ${stageLabels.join(" | ")}`);
      assert.equal(await activeShells(), 1, "next tool split the turn");
      await shotFramed(desktop.page, desktop.page.getByTestId("process-step-live").filter({ hasText: "VERSION" }), "ocv5-265-avatar-polish-next-tool");
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-live-flow-next-tool.png") });
      await fixtureStep();

      await desktop.page.getByText("FINAL_LONG").waitFor();
      await desktop.page.getByText("正文仍在进行时的目标诊断").waitFor();
      const longPlacement = await desktop.page.getByTestId("process-stage").filter({ hasText: "FINAL_LONG" }).evaluate((el) => {
        let lineClamp = "none";
        let node = el;
        while (node) {
          const value = getComputedStyle(node).webkitLineClamp;
          if (value && value !== "none") lineClamp = value;
          node = node.parentElement;
        }
        return { lineClamp, inProcess: !!el.closest("[data-testid=process-disclosure]") };
      });
      assert.equal(longPlacement.lineClamp, "none");
      assert.equal(longPlacement.inProcess, true);
      assert.equal(await activeShells(), 1, "final tokens split the turn");
      await shotActiveGoalStage(desktop.page, "body", "ocv5-265-final-goal-stage-desktop-body");
      await desktop.page.setViewportSize({ width: 390, height: 844 });
      await shotActiveGoalStage(desktop.page, "body", "ocv5-265-final-goal-stage-mobile390-body");
      await desktop.page.setViewportSize({ width: 1280, height: 1000 });
      const phasedToggle = desktop.page.getByTestId("process-toggle").filter({ hasText: "思考" }).last();
      await phasedToggle.click();
      await desktop.page.waitForFunction(() => document.querySelector("[data-process-active=true] [data-testid=process-toggle]")?.getAttribute("aria-expanded") === "false");
      await phasedToggle.click();
      await desktop.page.waitForFunction(() => document.querySelector("[data-process-active=true] [data-testid=process-toggle]")?.getAttribute("aria-expanded") === "true");
      await shotFramed(desktop.page, desktop.page.getByText("FINAL_LONG"), "ocv5-265-avatar-polish-final-streaming");
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-live-flow-final-streaming.png") });
      await fixtureStep();
      await desktop.page.getByTestId("assistant-row").filter({ hasText: "FINAL_LONG" }).waitFor({ timeout: 20_000 });
      assert.equal(await phasedToggle.getAttribute("aria-expanded"), "true", "manual open collapsed after isFinal");
      const finalPlacement = await desktop.page.getByText("FINAL_LONG").evaluate((el) => ({
        inProcess: !!el.closest("[data-testid=process-disclosure]"),
        inAnswer: !!el.closest("[data-testid=assistant-row]"),
      }));
      assert.equal(finalPlacement.inAnswer, true);
      assert.equal(finalPlacement.inProcess, false);
      assert.equal(await activeShells(), 0);
      const aligned = await desktop.page.evaluate(() => {
        const answer = [...document.querySelectorAll("[data-testid=assistant-row]")].find((el) => el.textContent?.includes("FINAL_LONG"));
        const processes = [...document.querySelectorAll("[data-testid=process-disclosure]")];
        const process = processes.at(-1);
        if (!(answer instanceof HTMLElement) || !(process instanceof HTMLElement)) return null;
        return {
          answerLeft: Math.round(answer.getBoundingClientRect().left),
          processLeft: Math.round(process.getBoundingClientRect().left),
          marginLeft: getComputedStyle(process).marginLeft,
          avatar: !!answer.querySelector(".bg-grad-cta"),
        };
      });
      assert.ok(aligned, "final answer or process missing");
      assert.equal(aligned.avatar, false, "final answer still has an avatar");
      assert.equal(aligned.marginLeft, "0px");
      assert.ok(Math.abs(aligned.answerLeft - aligned.processLeft) < 2, `body and process left edges differ: ${JSON.stringify(aligned)}`);
      evidence.align = aligned;
      await shotFramed(desktop.page, desktop.page.getByText("FINAL_LONG"), "ocv5-265-avatar-polish-final");
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-live-flow-final.png") });

      await desktop.page.getByText("待你确认").click();
      await desktop.page.getByText("发布前确认目标").waitFor();
      assert.equal(await desktop.page.getByText("发布前确认目标").evaluate((el) => el.closest("[data-testid=process-disclosure]")), null);
      await desktop.page.getByRole("button", { name: "查看原始目标记录" }).waitFor();
      await desktop.page.getByText("还差你的确认").waitFor();
      await desktop.page.getByText("未成功").waitFor();
      await desktop.page.getByText("任务待你确认").waitFor();
      await desktop.page.getByText("冻结库存要不要单独列在看板上？").waitFor();
      await desktop.page.getByRole("button", { name: "打开提问" }).waitFor();
      assert.equal(await desktop.page.getByText("先按北仓和南仓核对可售口径").count(), 0, "expansion does not leak across sessions");
      assert.equal(await desktop.page.getByText("node scripts/check-available.mjs").count(), 0);
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-e2e-attention.png") });
      const deniesBefore = preview.stats.permissionResponses.length;
      await desktop.page.getByRole("button", { name: "拒绝" }).click();
      await desktop.page.getByText("已拒绝").waitFor({ timeout: 15_000 });
      await waitUntil("one deny frame", () => preview.stats.permissionResponses.length >= deniesBefore + 1);
      const denies = preview.stats.permissionResponses.filter((frame) => frame.requestId === "req-browser-deny");
      evidence.permission = {
        count: denies.length,
        behaviors: denies.map((frame) => frame.behavior),
        acks: preview.stats.permissionAcks.length,
      };
      assert.equal(denies.length, 1, `deny frame count ${denies.length}`);
      assert.equal(denies[0].behavior, "deny");
      assert.equal(preview.stats.permissionAcks.length, 1);
      assert.equal(await desktop.page.getByRole("button", { name: "拒绝" }).count(), 0, "deny did not settle the card");
      assert.equal(desktop.errors.filter((error) => !/ResizeObserver/.test(error)).length, 0, desktop.errors.join("\n"));

      await desktop.page.getByRole("button", { name: "库存看板" }).click();
      await desktop.page.getByText("看板已经做好").waitFor();
      await desktop.page.getByText("南仓预警已补进看板").waitFor();
      await desktop.page.getByTitle("HTML 沙盒预览").first().waitFor();

      await desktop.page.goto(preview.url, { waitUntil: "domcontentloaded" });
      await desktop.page.getByText("看板已经做好").waitFor();
      await desktop.page.getByText("南仓预警已补进看板").waitFor();
      await desktop.page.getByTitle("HTML 沙盒预览").first().waitFor();
      await desktop.page.getByRole("link", { name: new RegExp(CSV_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().waitFor();
      await waitUntil("reload hello", () => preview.stats.hellos > 1);
      await desktop.page.waitForFunction(() => !document.body.innerText.includes("未连接"));
      assert.equal(await desktop.page.getByTestId("process-toggle").first().getAttribute("aria-expanded"), "false");
    } catch (error) {
      console.error("APP_UNKNOWN", preview.unknown);
      console.error("APP_STATS", JSON.stringify({
        hellos: preview.stats.hellos,
        inbound: preview.stats.inboundMessages.map((frame) => frame.content?.text),
        permission: preview.stats.permissionResponses.length,
        outbound: preview.stats.outboundByType,
      }));
      console.error("APP_BODY", (await desktop.page.locator("body").innerText()).slice(0, 2500));
      console.error("APP_ERRORS", desktop.errors);
      throw error;
    } finally {
      writeFileSync(join(shots, "ocv5-265-e2e-stats.json"), JSON.stringify({
        hellos: preview.stats.hellos,
        inbound: preview.stats.inboundMessages.map((frame) => ({
          sessionId: frame.peer?.id,
          text: frame.content?.text,
          clientMessageId: frame.clientMessageId,
        })),
        permission: preview.stats.permissionResponses.map((frame) => ({
          requestId: frame.requestId,
          behavior: frame.behavior,
          controlId: frame.controlId,
        })),
        permissionAcks: preview.stats.permissionAcks,
        outboundByType: preview.stats.outboundByType,
        browserSent: desktop.traffic.sent.map((frame) => frame.type),
        browserRecv: desktop.traffic.recv.map((frame) => frame.type),
        evidence,
        unknown: preview.unknown,
      }, null, 2));
      await desktop.context.close();
    }

    const mobile = await open(390, true);
    try {
      await mobile.page.getByText("看板已经做好").waitFor();
      await align(mobile.page, mobile.page.getByText("做一版库存看板").first());
      const box = await mobile.page.getByTestId("process-toggle").first().boundingBox();
      assert.ok(box && box.height >= 44, `touch target too small: ${JSON.stringify(box)}`);
      assert.ok(box.x >= -1 && box.x + box.width <= 391, `toggle overflows: ${JSON.stringify(box)}`);
      const docOverflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(docOverflow <= 1, `mobile document overflows by ${docOverflow}px`);
      const name = mobile.page.locator(".truncate", { hasText: "acceptance-fixture.csv" }).first();
      await name.waitFor();
      const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1 && (el.textContent ?? "").includes("acceptance-fixture.csv"));
      assert.equal(clipped, true, "long filename truncates but stays in the accessible name");
      await mobile.page.screenshot({ path: join(shots, "ocv5-265-e2e-mobile390-turn.png") });
      await align(mobile.page, mobile.page.getByText("看板已经做好").first());
      await mobile.page.screenshot({ path: join(shots, "ocv5-265-e2e-mobile390-answer.png") });
      await mobile.page.getByTestId("process-toggle").first().tap();
      await mobile.page.getByText("先按北仓和南仓核对可售口径").waitFor();
      const order = await mobile.page.evaluate(() => {
        const user = [...document.querySelectorAll("[data-testid=user-row]")].find((el) => el.textContent?.includes("做一版库存看板"));
        const stage = document.querySelector("[data-testid=process-stage]");
        if (!(user instanceof HTMLElement) || !(stage instanceof HTMLElement)) return "missing";
        const follows = (user.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        return follows ? "stage-after-user" : "stage-before-user";
      });
      assert.equal(order, "stage-after-user", "mobile expand left this turn");
      assert.equal(await mobile.page.getByText("数字还在吗？").count(), 1);
      await mobile.page.getByText("FINAL_LONG").waitFor();
      const mobileAlign = await mobile.page.evaluate(() => {
        const answer = [...document.querySelectorAll("[data-testid=assistant-row]")].find((el) => el.textContent?.includes("FINAL_LONG"));
        const process = answer?.previousElementSibling?.getAttribute("data-testid") === "process-disclosure"
          ? answer.previousElementSibling
          : [...document.querySelectorAll("[data-testid=process-disclosure]")].at(-1);
        if (!(answer instanceof HTMLElement) || !(process instanceof HTMLElement)) return null;
        return {
          answerLeft: Math.round(answer.getBoundingClientRect().left),
          processLeft: Math.round(process.getBoundingClientRect().left),
          marginLeft: getComputedStyle(process).marginLeft,
          avatar: !!answer.querySelector(".bg-grad-cta"),
          width: window.innerWidth,
        };
      });
      assert.ok(mobileAlign, "390 final answer missing");
      assert.equal(mobileAlign.avatar, false);
      assert.equal(mobileAlign.marginLeft, "0px");
      assert.ok(Math.abs(mobileAlign.answerLeft - mobileAlign.processLeft) < 2, JSON.stringify(mobileAlign));
      evidence.mobileAlign = mobileAlign;
      await shotFramed(mobile.page, mobile.page.getByText("FINAL_LONG"), "ocv5-265-avatar-polish-mobile390-answer");
      const stepToggle = mobile.page.getByTestId("process-toggle").filter({ hasText: "思考" }).last();
      if (await stepToggle.getAttribute("aria-expanded") !== "true") await stepToggle.tap();
      await mobile.page.getByText("STAGE_TWO 继续核对切流窗口").waitFor();
      await shotFramed(mobile.page, mobile.page.getByText("STAGE_TWO 继续核对切流窗口"), "ocv5-265-avatar-polish-mobile390-step");
      assert.equal(mobile.errors.filter((error) => !/ResizeObserver/.test(error)).length, 0, mobile.errors.join("\n"));
    } catch (error) {
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
      await align(narrow.page, narrow.page.getByText("做一版库存看板").first());
      const box = await narrow.page.getByTestId("process-toggle").first().boundingBox();
      assert.ok(box && box.height >= 44 && box.x + box.width <= 361, `360 toggle overflows: ${JSON.stringify(box)}`);
      await narrow.page.screenshot({ path: join(shots, "ocv5-265-e2e-mobile360-turn.png") });
    } finally {
      await narrow.context.close();
    }

    async function assertOldDateVisible(page) {
      const time = page.locator("time.tabular-nums").filter({ hasText: "2023-11-15" }).first();
      await time.waitFor();
      await align(page, time);
      const info = await time.evaluate((el) => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll(".sr-only").forEach((node) => node.remove());
        const rect = el.getBoundingClientRect();
        return {
          text: (clone.textContent || "").replace(/\s+/g, " ").trim(),
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          view: window.innerHeight,
        };
      });
      assert.match(info.text, /^2023-11-15/);
      assert.ok(info.height > 8, `old date is not a visible line: ${JSON.stringify(info)}`);
      assert.ok(info.top >= 24 && info.bottom <= info.view - 8, `old date outside the viewport: ${JSON.stringify(info)}`);
      return info;
    }

    const oldUrl = preview.url.replace(`/s/${BOARD_SESSION}`, `/s/${OLD_SESSION}`);
    const oldLight = await open(1280, false);
    try {
      await oldLight.page.goto(oldUrl, { waitUntil: "domcontentloaded" });
      await oldLight.page.getByText("看板已经做好").waitFor();
      const meta = await metaMetrics(oldLight.page, "2023-11-15");
      assert.equal(meta.fontSize, "11px");
      assert.ok(meta.rowHeight < 36, `old-date meta row too tall: ${meta.rowHeight}`);
      assert.ok(Math.abs(meta.timeTop - meta.creditTop) < 8, "old date and credits are not one compact row");
      assert.match(meta.text, /12\s*积分/);
      assert.ok(contrastRatio(meta.color, meta.bg) >= 4.5, `old-date light contrast ${contrastRatio(meta.color, meta.bg)}`);
      await assertOldDateVisible(oldLight.page);
      await oldLight.page.screenshot({ path: join(shots, "ocv5-265-e2e-olddate-light.png") });
    } finally {
      await oldLight.context.close();
    }

    const dark = await open(1280, false, "dark");
    try {
      await dark.page.goto(oldUrl, { waitUntil: "domcontentloaded" });
      await dark.page.getByText("看板已经做好").waitFor();
      const meta = await metaMetrics(dark.page, "2023-11-15");
      assert.equal(meta.fontSize, "11px");
      assert.ok(contrastRatio(meta.color, meta.bg) >= 4.5, `dark contrast ${contrastRatio(meta.color, meta.bg)} color=${meta.color} bg=${meta.bg}`);
      await assertOldDateVisible(dark.page);
      await dark.page.screenshot({ path: join(shots, "ocv5-265-e2e-dark-meta.png") });
      await dark.page.screenshot({ path: join(shots, "ocv5-265-e2e-olddate-dark.png") });
    } finally {
      await dark.context.close();
    }

    assert.equal(preview.url.includes(`/s/${BOARD_SESSION}`), true);
    assert.equal(WAIT_SESSION, "ocv5wait01");
    const sentTypes = desktop.traffic.sent.map((frame) => frame.type);
    assert.ok(sentTypes.includes("inbound.hello"));
    assert.ok(sentTypes.includes("inbound.message"));
    assert.ok(sentTypes.includes("inbound.permission_response"));
    assert.ok(desktop.traffic.recv.some((frame) => frame.type === "sys.relay_ready"));
    assert.ok(desktop.traffic.recv.some((frame) => frame.type === "outbound.message" && frame.isFinal === true));
    writeFileSync(join(shots, "ocv5-265-e2e-stats.json"), JSON.stringify({
      hellos: preview.stats.hellos,
      inbound: preview.stats.inboundMessages.map((frame) => ({
        sessionId: frame.peer?.id,
        text: frame.content?.text,
        clientMessageId: frame.clientMessageId,
      })),
      permission: preview.stats.permissionResponses.map((frame) => ({
        requestId: frame.requestId,
        behavior: frame.behavior,
        controlId: frame.controlId,
      })),
      permissionAcks: preview.stats.permissionAcks,
      outboundByType: preview.stats.outboundByType,
      browserSent: desktop.traffic.sent.map((frame) => frame.type),
      browserRecv: desktop.traffic.recv.map((frame) => frame.type),
      evidence,
    }, null, 2));
  } finally {
    await browser.close();
    await new Promise((done) => preview.server.close(done));
  }
});
