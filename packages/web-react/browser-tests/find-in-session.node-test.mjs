import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
import { EXPECTED_SCENES, PEAK_BUDGET, catalogIsInvalid, finalizeRows, record as recordScene } from "./find-in-session-collector.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const NEGATIVE_SHA = "87d4554efd27289844cfb3ce0146fb713ce24954";
const NEGATIVE_HASHES = {
  "components/MessageRenderer.tsx": "f92af0793d94540045f4d3f9f4fea2406ac0f2084574cda6aa5f6b6564a4ab95",
};
const PINNED_RENDERER = join(here, "baselines/87d4554-MessageRenderer.tsx");
const resultPath = process.env.OC_FIND_RESULT || join(tmpdir(), "ocv5-188-find-result.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const negative = process.env.OC_FIND_NEGATIVE === "1";

function sourceEvidence() {
  const currentRenderer = readFileSync(new URL("../src/components/MessageRenderer.tsx", import.meta.url));
  const pinned = readFileSync(PINNED_RENDERER);
  const pinnedHash = sha256(pinned);
  if (negative) {
    assert.equal(pinnedHash, NEGATIVE_HASHES["components/MessageRenderer.tsx"], "negative-control source drift");
  }
  return {
    mode: negative ? "pinned-negative-MessageRenderer-overlay" : "current-worktree",
    pinnedModulesCommit: negative ? NEGATIVE_SHA : null,
    overlay: negative ? "components/MessageRenderer.tsx" : null,
    sourceHashes: {
      "components/MessageRenderer.tsx": negative ? pinnedHash : sha256(currentRenderer),
      "components/MessageRenderer.tsx.worktree": sha256(currentRenderer),
      "baselines/87d4554-MessageRenderer.tsx": pinnedHash,
    },
    harnessSha256: sha256(readFileSync(new URL("./find-in-session-harness.tsx", import.meta.url))),
    collectorSha256: sha256(readFileSync(new URL("./find-in-session-collector.mjs", import.meta.url))),
    testSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  };
}

function snapshot(page) {
  return page.evaluate(() => {
    const scrollerEl = document.querySelector("[data-testid=find-chat-scroll]");
    const list = document.querySelector("[data-testid=timeline-short-list]");
    const toolbar = document.querySelector("[aria-label='在会话中查找']")?.closest("div");
    const current = document.querySelector("[data-find-current]");
    const key = current?.getAttribute("data-chat-virtual-key") ?? null;
    const row = current?.getBoundingClientRect();
    const view = scrollerEl?.getBoundingClientRect();
    const bar = toolbar?.getBoundingClientRect();
    const mounted = [...document.querySelectorAll("[data-chat-virtual-key]")].map((el) =>
      el.getAttribute("data-chat-virtual-key"),
    );
    const lastRow = mounted.length ? document.querySelectorAll("[data-chat-virtual-key]")[mounted.length - 1] : null;
    let toolbarEl = toolbar instanceof HTMLElement ? toolbar : null;
    if (scrollerEl && toolbarEl) {
      let node = toolbarEl;
      while (node && node !== scrollerEl) {
        const pos = getComputedStyle(node).position;
        if (pos === "sticky" || pos === "fixed") {
          toolbarEl = node;
          break;
        }
        node = node.parentElement;
      }
    }
    const stickyBar = toolbarEl?.getBoundingClientRect();
    const viewTop = stickyBar && stickyBar.height > 0 ? stickyBar.bottom : (view?.top ?? 0);
    const visible = !!(row && view && row.height > 0 && row.bottom > viewTop + 1 && row.top >= viewTop - 1 && row.top < view.bottom - 1);
    return {
      key,
      text: current?.textContent ?? "",
      findPin: list?.getAttribute("data-find-pin") || "",
      mountedFirst: mounted[0] ?? null,
      mountedLast: lastRow?.getAttribute("data-chat-virtual-key") ?? null,
      mountedCount: mounted.length,
      needleMounted: mounted.includes("m0") || mounted.includes("needle") || mounted.includes("m250"),
      paintCount: Number(list?.getAttribute("data-timeline-paint-count") ?? 0),
      peakMounted: window.__findPage.peakMounted,
      following: window.__findPage.following,
      wheelFence: window.__findPage.wheelFence,
      hit: document.body.innerText.match(/\d+\/\d+|无匹配/)?.[0] ?? null,
      sessionId: document.querySelector("[data-testid=session]")?.textContent ?? "",
      needle: document.querySelector("[data-testid=needle]")?.textContent ?? "",
      findOpen: !!document.querySelector("[aria-label='在会话中查找']"),
      listMounted: !!list,
      scrollTop: scrollerEl?.scrollTop ?? -1,
      distBottom: scrollerEl
        ? scrollerEl.scrollHeight - scrollerEl.clientHeight - scrollerEl.scrollTop
        : -1,
      dockVisible: document.querySelector("[data-testid=scroll-to-bottom-dock]")?.getAttribute("data-visible") ?? null,
      row: row ? { top: row.top, bottom: row.bottom, height: row.height } : null,
      scroller: view ? { top: view.top, bottom: view.bottom, height: view.height } : null,
      toolbar: stickyBar ? { top: stickyBar.top, bottom: stickyBar.bottom, height: stickyBar.height } : (bar ? { top: bar.top, bottom: bar.bottom, height: bar.height } : null),
      visible,
    };
  });
}

function record(rows, scene, expected, actual, events, pass, failReason, phase) {
  return recordScene(rows, scene, expected, actual, events, pass, failReason, {
    mode: negative ? "negative-overlay" : "candidate",
    phase,
    error: pass ? "" : failReason,
  });
}

async function waitLocated(page, key, timeout = 4000) {
  await page.waitForFunction((k) => {
    const current = document.querySelector("[data-find-current]");
    const scroller = document.querySelector("[data-testid=find-chat-scroll]");
    const input = document.querySelector("[aria-label='在会话中查找']");
    if (!current || !scroller) return false;
    if (current.getAttribute("data-chat-virtual-key") !== k) return false;
    let node = input instanceof HTMLElement ? input : null;
    while (node && node !== scroller) {
      const pos = getComputedStyle(node).position;
      if (pos === "sticky" || pos === "fixed") break;
      node = node.parentElement;
    }
    const row = current.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const bar = node && node !== scroller ? node.getBoundingClientRect() : null;
    const top = bar && bar.height > 0 ? bar.bottom : view.top;
    const pin = document.querySelector("[data-testid=timeline-short-list]")?.getAttribute("data-find-pin") || "";
    return row.height > 0 && row.bottom > top + 1 && row.top >= top - 1 && row.top < view.bottom - 1 && pin === "";
  }, key, { timeout });
}

async function waitFindReady(page, hit) {
  await page.waitForFunction((expected) => {
    const btn = document.querySelector('[aria-label="下一处"]');
    const found = document.body.innerText.match(/\d+\/\d+|无匹配/)?.[0] ?? "";
    return btn instanceof HTMLButtonElement && !btn.disabled && (!expected || found === expected);
  }, hit ?? null, { timeout: 4000 });
}

async function framesStable(page, key, count = 4) {
  const first = await snapshot(page);
  for (let i = 0; i < count; i += 1) {
    await page.waitForTimeout(32);
    const frame = await snapshot(page);
    if (frame.key !== key || frame.visible !== true) return { stable: false, first, last: frame };
    if (Math.abs((frame.row?.top ?? 0) - (first.row?.top ?? 0)) > 8) return { stable: false, first, last: frame };
  }
  return { stable: true, first, last: await snapshot(page) };
}

async function typeNeedle(page, text) {
  const box = page.getByRole("textbox", { name: "在会话中查找" });
  await box.click();
  await page.keyboard.type(text, { delay: 8 });
}

async function holdFence(page) {
  await page.evaluate(() => window.__findPage.holdFence());
  await page.waitForFunction(() => window.__findPage.wheelFence === true, null, { timeout: 2000 });
}

async function waitPin(page, key) {
  await page.waitForFunction((k) =>
    document.querySelector("[data-testid=timeline-short-list]")?.getAttribute("data-find-pin") === k,
  key, { timeout: 4000 });
}

/** Capture pending pin atomically (pin set, target not yet visible) and re-hold the fence. */
async function waitPending(page, key, timeout = 4000) {
  const handle = await page.waitForFunction((k) => {
    const scrollerEl = document.querySelector("[data-testid=find-chat-scroll]");
    const list = document.querySelector("[data-testid=timeline-short-list]");
    const toolbar = document.querySelector("[aria-label='在会话中查找']")?.closest("div");
    const current = document.querySelector("[data-find-current]");
    const pin = list?.getAttribute("data-find-pin") || "";
    if (pin !== k) return false;
    const row = current?.getBoundingClientRect();
    const view = scrollerEl?.getBoundingClientRect();
    let toolbarEl = toolbar instanceof HTMLElement ? toolbar : null;
    if (scrollerEl && toolbarEl) {
      let node = toolbarEl;
      while (node && node !== scrollerEl) {
        const pos = getComputedStyle(node).position;
        if (pos === "sticky" || pos === "fixed") {
          toolbarEl = node;
          break;
        }
        node = node.parentElement;
      }
    }
    const stickyBar = toolbarEl?.getBoundingClientRect();
    const viewTop = stickyBar && stickyBar.height > 0 ? stickyBar.bottom : (view?.top ?? 0);
    const visible = !!(row && view && row.height > 0 && row.bottom > viewTop + 1 && row.top >= viewTop - 1 && row.top < view.bottom - 1);
    if (visible) return false;
    window.__findPage.holdFence();
    const mounted = [...document.querySelectorAll("[data-chat-virtual-key]")].map((el) =>
      el.getAttribute("data-chat-virtual-key"),
    );
    const lastRow = mounted.length ? document.querySelectorAll("[data-chat-virtual-key]")[mounted.length - 1] : null;
    const bar = toolbar?.getBoundingClientRect();
    return {
      key: current?.getAttribute("data-chat-virtual-key") ?? null,
      text: current?.textContent ?? "",
      findPin: pin,
      visible,
      hit: document.body.innerText.match(/\d+\/\d+|无匹配/)?.[0] ?? null,
      following: window.__findPage.following,
      wheelFence: window.__findPage.wheelFence,
      scrollTop: scrollerEl?.scrollTop ?? -1,
      distBottom: scrollerEl
        ? scrollerEl.scrollHeight - scrollerEl.clientHeight - scrollerEl.scrollTop
        : -1,
      needleMounted: mounted.includes("m0") || mounted.includes("needle") || mounted.includes("m250"),
      mountedCount: mounted.length,
      peakMounted: window.__findPage.peakMounted,
      paintCount: Number(list?.getAttribute("data-timeline-paint-count") ?? 0),
      dockVisible: document.querySelector("[data-testid=scroll-to-bottom-dock]")?.getAttribute("data-visible") ?? null,
      mountedLast: lastRow?.getAttribute("data-chat-virtual-key") ?? null,
      sessionId: document.querySelector("[data-testid=session]")?.textContent ?? "",
      findOpen: !!document.querySelector("[aria-label='在会话中查找']"),
      listMounted: !!list,
      row: row ? { top: row.top, bottom: row.bottom, height: row.height } : null,
      scroller: view ? { top: view.top, bottom: view.bottom, height: view.height } : null,
      toolbar: stickyBar ? { top: stickyBar.top, bottom: stickyBar.bottom, height: stickyBar.height } : (bar ? { top: bar.top, bottom: bar.bottom, height: bar.height } : null),
    };
  }, key, { timeout });
  return handle.jsonValue();
}

async function hoverFindChrome(page, where) {
  const point = await findChromePoint(page, where);
  await page.mouse.move(point.x, point.y);
}

async function findChromePoint(page, where) {
  const point = await page.evaluate((w) => {
    const input = document.querySelector("[aria-label='在会话中查找']");
    const scroller = document.querySelector("[data-testid=find-chat-scroll]");
    if (w === "input" && input instanceof HTMLElement) {
      const r = input.getBoundingClientRect();
      return { x: r.x + Math.min(40, Math.max(8, r.width / 2)), y: r.y + r.height / 2 };
    }
    let node = input instanceof HTMLElement ? input : null;
    while (node && node !== scroller) {
      const pos = getComputedStyle(node).position;
      if (pos === "sticky" || pos === "fixed") break;
      node = node.parentElement;
    }
    const r = node?.getBoundingClientRect();
    if (!r) return null;
    return { x: r.x + 8, y: r.y + Math.max(4, r.height / 2) };
  }, where);
  if (!point) throw new Error(`find chrome point missing for ${where}`);
  return point;
}

async function installGestureObserver(page) {
  await page.evaluate(() => {
    const s = document.querySelector("[data-testid=find-chat-scroll]");
    if (!s || window.__findGestureObserverInstalled) return;
    window.__findGestureEvents = [];
    window.__findGestureObserverInstalled = true;
    const describeTarget = (t) => {
      if (!(t instanceof Element)) return "";
      return t.getAttribute("aria-label") || t.getAttribute("data-testid") || t.tagName;
    };
    const inToolbar = (t) => {
      const input = document.querySelector("[aria-label='在会话中查找']");
      let node = input instanceof HTMLElement ? input : null;
      while (node && node !== s) {
        const pos = getComputedStyle(node).position;
        if (pos === "sticky" || pos === "fixed") break;
        node = node.parentElement;
      }
      return !!(node && t instanceof Node && node.contains(t));
    };
    const onEvt = (e) => {
      window.__findGestureEvents.push({
        type: e.type,
        trusted: e.isTrusted,
        deltaY: e.type === "wheel" ? e.deltaY : undefined,
        target: describeTarget(e.target),
        inToolbar: inToolbar(e.target),
        pin: document.querySelector("[data-testid=timeline-short-list]")?.getAttribute("data-find-pin") || "",
        top: s.scrollTop,
        fence: window.__findPage.wheelFence,
      });
    };
    s.addEventListener("wheel", onEvt, { passive: true });
    s.addEventListener("touchmove", onEvt, { passive: true });
  });
}

async function takeGestureEvents(page) {
  return page.evaluate(() => {
    const rows = window.__findGestureEvents || [];
    window.__findGestureEvents = [];
    return rows;
  });
}

/** Pending pin without re-holding the synthetic fence. */
async function waitPendingNatural(page, key, timeout = 4000) {
  const handle = await page.waitForFunction((k) => {
    const scrollerEl = document.querySelector("[data-testid=find-chat-scroll]");
    const list = document.querySelector("[data-testid=timeline-short-list]");
    const toolbar = document.querySelector("[aria-label='在会话中查找']")?.closest("div");
    const current = document.querySelector("[data-find-current]");
    const pin = list?.getAttribute("data-find-pin") || "";
    if (pin !== k) return false;
    const row = current?.getBoundingClientRect();
    const view = scrollerEl?.getBoundingClientRect();
    let toolbarEl = toolbar instanceof HTMLElement ? toolbar : null;
    if (scrollerEl && toolbarEl) {
      let node = toolbarEl;
      while (node && node !== scrollerEl) {
        const pos = getComputedStyle(node).position;
        if (pos === "sticky" || pos === "fixed") {
          toolbarEl = node;
          break;
        }
        node = node.parentElement;
      }
    }
    const stickyBar = toolbarEl?.getBoundingClientRect();
    const viewTop = stickyBar && stickyBar.height > 0 ? stickyBar.bottom : (view?.top ?? 0);
    const visible = !!(row && view && row.height > 0 && row.bottom > viewTop + 1 && row.top >= viewTop - 1 && row.top < view.bottom - 1);
    if (visible) return false;
    return {
      key: current?.getAttribute("data-chat-virtual-key") ?? null,
      text: current?.textContent ?? "",
      findPin: pin,
      visible,
      following: window.__findPage.following,
      wheelFence: window.__findPage.wheelFence,
      scrollTop: scrollerEl?.scrollTop ?? -1,
      hit: document.body.innerText.match(/\d+\/\d+|无匹配/)?.[0] ?? null,
    };
  }, key, { timeout });
  return handle.jsonValue();
}

async function dispatchTouchMove(page, point) {
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: point.x, y: point.y - 120, id: 1 }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

test("OCV5-188 F4 find navigation (real MessageList, controller, production CSS)", { timeout: 420_000 }, async (t) => {
  if (process.env.OC_FIND_ONLY) {
    const rows = [];
    const catalog = finalizeRows(rows, { mode: "official-reject" });
    writeFileSync(resultPath, JSON.stringify({
      sources: {
        rejected: "OC_FIND_ONLY",
        reason: "official suite always runs the fixed 20-scene catalog",
        filter: process.env.OC_FIND_ONLY,
      },
      negative,
      peakBudget: PEAK_BUDGET,
      expectedSceneCount: EXPECTED_SCENES.length,
      ...catalog,
      rows,
    }, null, 2));
    process.exitCode = 1;
    assert.fail(
      `OC_FIND_ONLY=${JSON.stringify(process.env.OC_FIND_ONLY)} is rejected by the official find suite; run the fixed ${EXPECTED_SCENES.length}-scene catalog without a filter`,
    );
  }
  const sources = sourceEvidence();
  t.diagnostic(`find-sources ${JSON.stringify(sources)}`);
  let out;
  const bundle = await build({
    entryPoints: [join(here, "find-in-session-harness.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.MODE": '"production"' },
    logLevel: "silent",
    plugins: negative
      ? [{
        name: "pinned-find-negative-control",
        setup(b) {
          b.onLoad({ filter: /src\/components\/MessageRenderer\.tsx$/ }, () => ({
            contents: readFileSync(PINNED_RENDERER, "utf8"),
            loader: "tsx",
          }));
        },
      }]
      : [],
  });
  try {
    out = mkdtempSync(join(tmpdir(), "oc-find-css-"));
    await viteBuild({
      root: join(here, ".."),
      configFile: false,
      logLevel: "silent",
      plugins: [tailwindcss()],
      build: {
        outDir: out,
        emptyOutDir: true,
        cssCodeSplit: false,
        rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } },
      },
    });
    const cssFile = readdirSync(out).find((n) => n.endsWith(".css"));
    const css = readFileSync(join(out, cssFile));
    sources.styleSha256 = sha256(css);
    const browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-overlay-scrollbar"],
    });
    const rows = [];
    try {
      async function openPage(scene, touch = false) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          isMobile: touch,
          hasTouch: touch,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(
          `<!doctype html><meta charset="utf-8"><style>${css.toString()}
[data-testid=find-chat-scroll]{overflow-y:scroll!important;}
[data-testid=find-chat-scroll]::-webkit-scrollbar{width:12px;height:12px;}
[data-testid=find-chat-scroll]::-webkit-scrollbar-thumb{background:#666;}
</style><div id="root"></div>`,
        );
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.evaluate((s) => window.__findPage.setScene(s), scene);
        await page.getByTestId("scene").waitFor();
        await page.getByRole("textbox", { name: "在会话中查找" }).waitFor();
        await page.waitForTimeout(200);
        await page.evaluate(() => { window.__findPage.peakMounted = 0; });
        return { context, page, errors };
      }

      async function runToolbarCancel(page, errors, rows, events, where, gesture) {
        const pendingId = `toolbar-${where}-${gesture}-pending`;
        const cancelId = `toolbar-${where}-${gesture}-cancel`;
        const typed = await page.getByRole("textbox", { name: "在会话中查找" }).inputValue();
        if (typed !== "FIND_NEEDLE_MID") {
          const box = page.getByRole("textbox", { name: "在会话中查找" });
          await box.fill("");
          await typeNeedle(page, "FIND_NEEDLE_MID");
          events.keys += 15;
        }
        await waitFindReady(page, "1/1");
        await installGestureObserver(page);
        const wantType = gesture === "wheel" ? "wheel" : "touchmove";
        let pending = null;
        let ev = null;
        let gest = [];
        for (let attempt = 0; attempt < 4 && !ev; attempt += 1) {
          await page.evaluate(() => {
            const el = document.querySelector("[data-testid=find-chat-scroll]");
            if (el) el.scrollTop = el.scrollHeight;
          });
          await page.waitForTimeout(40);
          await takeGestureEvents(page);
          const point = await findChromePoint(page, where);
          await page.mouse.move(point.x, point.y);
          await page.mouse.wheel(0, -120);
          events.wheels = (events.wheels || 0) + 1;
          await page.keyboard.press("Enter");
          events.enters = (events.enters || 0) + 1;
          pending = await snapshot(page);
          if (!(pending.findPin === "m250" && pending.visible !== true && pending.following === false && pending.wheelFence === true)) continue;
          if (gesture === "wheel") {
            await page.mouse.wheel(0, -240);
            events.wheels += 1;
          } else {
            await dispatchTouchMove(page, point);
            events.touchmoves = (events.touchmoves || 0) + 1;
          }
          // Playwright wheel dispatch can resolve before the DOM event reaches our observer.
          // Wait for delivery, not for the pin/trust assertions below to become true.
          await page.waitForFunction((type) =>
            (window.__findGestureEvents || []).some((e) =>
              e.type === type && (type !== "wheel" || e.deltaY === -240)),
          wantType, { timeout: 4000 });
          gest = await takeGestureEvents(page);
          ev = [...gest].reverse().find((e) =>
            e.type === wantType
            && e.trusted === true
            && e.inToolbar === true
            && e.pin === "m250"
            && Math.abs((e.top ?? 0) - pending.scrollTop) < 400) || null;
        }
        pending = pending || await snapshot(page);
        pending.pageErrors = errors.length;
        const pendingOk = pending.findPin === "m250" && pending.visible !== true && pending.following === false;
        record(rows, pendingId, { findPin: "m250", visible: false, following: false }, pending, events, pendingOk,
          pendingOk ? "" : `pending pin=${pending.findPin} visible=${pending.visible} fence=${pending.wheelFence}`,
          "pending-positive");
        assert.equal(pending.findPin, "m250");
        assert.equal(pending.visible, false);
        const evOk = !!(ev && ev.trusted === true && ev.inToolbar === true && ev.pin === "m250");
        if (evOk) {
          await page.waitForFunction(() =>
            document.querySelector("[data-testid=timeline-short-list]")?.getAttribute("data-find-pin") === "",
          null, { timeout: 4000 });
        }
        const topAtEvent = typeof ev?.top === "number" ? ev.top : pending.scrollTop;
        await page.waitForFunction(() => window.__findPage.wheelFence === false, null, { timeout: 4000 }).catch(() => {});
        let jumped = false;
        let last = await snapshot(page);
        for (let i = 0; i < 8; i += 1) {
          await page.waitForTimeout(32);
          last = await snapshot(page);
          if (last.key === "m250" && last.visible === true) jumped = true;
        }
        last.pageErrors = errors.length;
        last.stable = !jumped;
        const cancelOk = last.findPin === "" && !jumped && !(last.key === "m250" && last.visible) && evOk;
        record(rows, cancelId, {
          findPin: "", visible: false, trusted: true, inToolbar: true, pinAtEvent: "m250",
        }, last, {
          ...events,
          trusted: ev?.trusted ?? null,
          target: ev?.target ?? null,
          pinAtEvent: ev?.pin ?? null,
          inToolbar: ev?.inToolbar ?? null,
          fenceAtEvent: ev?.fence ?? null,
          topAtEvent,
          topAfterFence: last.scrollTop,
          rejumpPx: (last.scrollTop ?? 0) - topAtEvent,
        }, cancelOk,
          cancelOk ? "" : `rejump pin=${last.findPin} visible=${last.visible} key=${last.key} trusted=${ev?.trusted} target=${ev?.target} pinAt=${ev?.pin} inToolbar=${ev?.inToolbar} jump=${(last.scrollTop ?? 0) - topAtEvent}`,
          "after-toolbar-gesture");
        assert.equal(last.findPin, "");
        assert.equal(jumped, false, `old find rejumps after toolbar ${where} ${gesture}`);
        assert.equal(evOk, true, `toolbar ${where} ${gesture} missing trusted in-toolbar event at pin`);
        assert.deepEqual(errors, []);
      }

      await t.test("tail-320-m0 keyboard.type then one click", async () => {
        const { context, page, errors } = await openPage("tail");
        const events = { clicks: 0, keys: 0, wheels: 0 };
        try {
          const before = await snapshot(page);
          assert.equal(before.needleMounted, false, "precondition: m0 must start unmounted");
          await typeNeedle(page, "FIND_NEEDLE_A");
          events.keys += 13;
          await page.getByRole("button", { name: "下一处" }).click();
          events.clicks += 1;
          let located = false;
          try {
            await waitLocated(page, "m0");
            located = true;
          } catch (error) {
            const failed = await snapshot(page);
            failed.pageErrors = errors.length;
            record(rows, "tail-320-m0", { key: "m0", visible: true, hit: "1/1" }, failed, events, false, error.message);
            throw error;
          }
          const after = await snapshot(page);
          after.pageErrors = errors.length;
          const pass = located && after.key === "m0" && after.visible === true && after.hit === "1/1";
          record(rows, "tail-320-m0", { key: "m0", visible: true, hit: "1/1" }, after, events, pass,
            pass ? "" : `key=${after.key} visible=${after.visible} hit=${after.hit} mounted=${after.needleMounted}`);
          assert.equal(after.key, "m0");
          assert.equal(after.visible, true);
          assert.equal(after.hit, "1/1");
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("enter / shift+enter / button key", async () => {
        const { context, page, errors } = await openPage("multi");
        const events = { clicks: 0, keys: 0, enters: 0 };
        try {
          await typeNeedle(page, "MULTI_NEEDLE");
          events.keys += 12;
          const findBox = page.getByRole("textbox", { name: "在会话中查找" });
          await findBox.press("Enter");
          events.enters += 1;
          await page.waitForFunction((k) =>
            document.querySelector("[data-find-current]")?.getAttribute("data-chat-virtual-key") === k,
          "m160", { timeout: 4000 });
          await waitLocated(page, "m160");
          let after = await snapshot(page);
          after.pageErrors = errors.length;
          record(rows, "enter-second-hit", { key: "m160", visible: true, hit: "2/3" }, after, { ...events },
            after.key === "m160" && after.visible, `Enter expected m160 got ${after.key}`);
          assert.equal(after.key, "m160");
          assert.equal(after.visible, true);
          await findBox.press("Shift+Enter");
          events.enters += 1;
          await waitLocated(page, "m0");
          after = await snapshot(page);
          after.pageErrors = errors.length;
          record(rows, "shift-enter-first-hit", { key: "m0", visible: true, hit: "1/3" }, after, { ...events },
            after.key === "m0" && after.visible, `Shift+Enter expected m0 got ${after.key}`);
          assert.equal(after.key, "m0");
          await findBox.focus();
          let active = "";
          for (let i = 0; i < 6; i += 1) {
            await page.keyboard.press("Tab");
            active = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
            if (active === "下一处") break;
          }
          assert.equal(active, "下一处", `expected 下一处 focused, got ${active}`);
          await page.keyboard.press("Enter");
          events.enters += 1;
          await waitLocated(page, "m160");
          const stability = await framesStable(page, "m160");
          after = stability.last;
          after.stable = stability.stable;
          after.pageErrors = errors.length;
          record(rows, "button-key-activate", { key: "m160", visible: true, hit: "2/3" }, after, events,
            after.key === "m160" && after.visible && after.hit === "2/3" && stability.stable,
            `button Enter expected m160 got ${after.key} visible=${after.visible} hit=${after.hit} stable=${stability.stable}`);
          assert.equal(after.key, "m160");
          assert.equal(after.visible, true);
          assert.equal(stability.stable, true);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("mobile tap completes despite own touchend fence", async () => {
        const { context, page, errors } = await openPage("tail", true);
        const events = { taps: 0, keys: 0 };
        try {
          await page.getByRole("textbox", { name: "在会话中查找" }).tap();
          events.taps += 1;
          await page.keyboard.type("FIND_NEEDLE_A", { delay: 8 });
          events.keys += 13;
          await page.getByRole("button", { name: "下一处" }).tap();
          events.taps += 1;
          await waitLocated(page, "m0");
          const after = await snapshot(page);
          after.pageErrors = errors.length;
          record(rows, "mobile-tap", { key: "m0", visible: true }, after, events,
            after.key === "m0" && after.visible, `tap key=${after.key} visible=${after.visible} fence=${after.wheelFence}`);
          assert.equal(after.key, "m0");
          assert.equal(after.visible, true);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("coalesced team then ordinary assistant uses render key", async () => {
        const { context, page, errors } = await openPage("coalesce");
        const events = { clicks: 0, keys: 0 };
        try {
          await typeNeedle(page, "FIND_NEEDLE_A");
          events.keys += 13;
          await page.getByRole("button", { name: "下一处" }).click();
          events.clicks += 1;
          await waitLocated(page, "needle");
          const after = await snapshot(page);
          after.pageErrors = errors.length;
          const pass = after.key === "needle" && after.visible === true && after.hit === "1/1";
          record(rows, "coalesced-after-team", { key: "needle", visible: true, hit: "1/1" }, after, events, pass,
            pass ? "" : `expected needle got ${after.key}`);
          assert.equal(after.key, "needle");
          assert.equal(after.visible, true);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("pending then real mouse.wheel / scrollbar drag cancel", async () => {
        const { context, page, errors } = await openPage("midtail");
        const events = { clicks: 0, wheels: 0, keys: 0, drags: 0 };
        try {
          await typeNeedle(page, "FIND_NEEDLE_MID");
          events.keys += 15;
          await holdFence(page);
          events.wheels += 1;
          const sessionBefore = await page.getByTestId("session").textContent();
          await page.getByRole("button", { name: "下一处" }).click();
          events.clicks += 1;
          await waitPin(page, "m250");
          const pending = await snapshot(page);
          pending.pageErrors = errors.length;
          const pendingOk = pending.findPin === "m250" && pending.visible !== true && pending.following === false;
          record(rows, "pending-positive-m250", {
            findPin: "m250", visible: false, following: false,
          }, pending, events, pendingOk,
            pendingOk ? "" : `pending pin=${pending.findPin} visible=${pending.visible} following=${pending.following}`);
          assert.equal(pending.findPin, "m250");
          assert.equal(pending.visible, false);
          assert.equal(pending.following, false);
          const topBefore = pending.scrollTop;
          await page.getByTestId("find-chat-scroll").hover();
          await page.mouse.wheel(0, -240);
          events.wheels += 1;
          await page.waitForTimeout(280);
          const afterWheel = await snapshot(page);
          afterWheel.pageErrors = errors.length;
          const cancelled = afterWheel.findPin === "" && afterWheel.visible !== true;
          record(rows, "wheel-cancel-no-rejump", {
            findPin: "", visible: false, following: false,
          }, afterWheel, events, cancelled && afterWheel.scrollTop !== topBefore,
            cancelled ? "" : `rejump pin=${afterWheel.findPin} visible=${afterWheel.visible} key=${afterWheel.key}`);
          assert.equal(afterWheel.findPin, "");
          assert.notEqual(afterWheel.key === "m250" && afterWheel.visible, true);
          assert.equal(await page.getByTestId("session").textContent(), sessionBefore);

          await page.evaluate(() => { window.__findPage.peakMounted = 0; });
          await holdFence(page);
          await page.getByRole("button", { name: "下一处" }).click();
          events.clicks += 1;
          await waitPin(page, "m250");
          const pending2 = await snapshot(page);
          assert.equal(pending2.findPin, "m250");
          const box = await page.getByTestId("find-chat-scroll").boundingBox();
          const metrics = await page.getByTestId("find-chat-scroll").evaluate((el) => ({
            clientWidth: el.clientWidth, offsetWidth: el.offsetWidth, height: el.clientHeight,
          }));
          const gutter = Math.max(metrics.offsetWidth - metrics.clientWidth, 12);
          const x = box.x + box.width - Math.min(6, gutter / 2);
          const y = box.y + metrics.height * 0.7;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x, y - 50, { steps: 6 });
          await page.mouse.up();
          events.drags += 1;
          await page.waitForTimeout(280);
          const afterDrag = await snapshot(page);
          afterDrag.pageErrors = errors.length;
          record(rows, "scrollbar-drag-cancel", { findPin: "", visible: false }, afterDrag, events,
            afterDrag.findPin === "" && !(afterDrag.key === "m250" && afterDrag.visible),
            `drag pin=${afterDrag.findPin} key=${afterDrag.key} visible=${afterDrag.visible}`);
          assert.equal(afterDrag.findPin, "");
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("touchmove cancels pending jump", async () => {
        const { context, page, errors } = await openPage("midtail", true);
        const events = { clicks: 0, taps: 0, touchmoves: 0, keys: 0 };
        try {
          await typeNeedle(page, "FIND_NEEDLE_MID");
          events.keys += 15;
          await waitFindReady(page, "1/1");
          await holdFence(page);
          await page.getByRole("button", { name: "下一处" }).tap();
          events.taps += 1;
          let pending;
          try {
            pending = await waitPending(page, "m250");
          } catch (error) {
            pending = await snapshot(page);
            pending.pageErrors = errors.length;
            pending.error = error.message;
            record(rows, "touchmove-pending-positive", {
              findPin: "m250", visible: false, following: false,
            }, pending, events, false, error.message, "wait-pending");
            throw error;
          }
          pending.pageErrors = errors.length;
          const pendingOk = pending.findPin === "m250" && pending.visible !== true && pending.following === false;
          record(rows, "touchmove-pending-positive", {
            findPin: "m250", visible: false, following: false,
          }, pending, events, pendingOk,
            pendingOk ? "" : `pending pin=${pending.findPin} visible=${pending.visible} key=${pending.key} fence=${pending.wheelFence}`,
            "pending-positive");
          assert.equal(pending.findPin, "m250");
          assert.equal(pending.visible, false);
          const box = await page.getByTestId("find-chat-scroll").boundingBox();
          const client = await page.context().newCDPSession(page);
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: box.x + 80, y: box.y + 200, id: 1 }],
          });
          await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: box.x + 80, y: box.y + 80, id: 1 }],
          });
          await client.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
          events.touchmoves += 1;
          await page.waitForFunction(() =>
            document.querySelector("[data-testid=timeline-short-list]")?.getAttribute("data-find-pin") === "",
          null, { timeout: 4000 });
          const after = await snapshot(page);
          after.pageErrors = errors.length;
          record(rows, "touchmove-cancel", { findPin: "" }, after, events,
            after.findPin === "",
            `touch pin=${after.findPin} key=${after.key} visible=${after.visible}`,
            "after-touchmove");
          assert.equal(after.findPin, "");
          assert.deepEqual(errors, []);
        } catch (error) {
          if (!rows.some((row) => row.contractId === "touchmove-cancel")) {
            const failed = await snapshot(page).catch(() => ({ error: error.message }));
            failed.pageErrors = errors.length;
            failed.error = error.message;
            record(rows, "touchmove-cancel", { findPin: "" }, failed, events, false, error.message, "uncaught");
          }
          throw error;
        } finally {
          await context.close();
        }
      });

      await t.test("toolbar input/blank real wheel cancels pending", async () => {
        let firstError = null;
        for (const where of ["input", "blank"]) {
          const { context, page, errors } = await openPage("midtail");
          const events = { clicks: 0, keys: 0, wheels: 0, enters: 0 };
          try {
            await runToolbarCancel(page, errors, rows, events, where, "wheel");
          } catch (error) {
            firstError = firstError || error;
            for (const scene of [`toolbar-${where}-wheel-pending`, `toolbar-${where}-wheel-cancel`]) {
              if (!rows.some((row) => row.contractId === scene)) {
                const failed = await snapshot(page).catch(() => ({ error: error.message }));
                failed.pageErrors = errors.length;
                failed.error = error.message;
                record(rows, scene, { findPin: "" }, failed, events, false, error.message, "uncaught");
              }
            }
          } finally {
            await context.close();
          }
        }
        if (firstError) throw firstError;
      });

      await t.test("toolbar input/blank real touchmove cancels pending", async () => {
        let firstError = null;
        for (const where of ["input", "blank"]) {
          const { context, page, errors } = await openPage("midtail", true);
          const events = { clicks: 0, keys: 0, wheels: 0, touchmoves: 0, enters: 0 };
          try {
            await runToolbarCancel(page, errors, rows, events, where, "touchmove");
          } catch (error) {
            firstError = firstError || error;
            for (const scene of [`toolbar-${where}-touchmove-pending`, `toolbar-${where}-touchmove-cancel`]) {
              if (!rows.some((row) => row.contractId === scene)) {
                const failed = await snapshot(page).catch(() => ({ error: error.message }));
                failed.pageErrors = errors.length;
                failed.error = error.message;
                record(rows, scene, { findPin: "" }, failed, events, false, error.message, "uncaught");
              }
            }
          } finally {
            await context.close();
          }
        }
        if (firstError) throw firstError;
      });

      await t.test("same-session same-id same-length replace does not keep old pin", async () => {
        const { context, page, errors } = await openPage("tail");
        const events = { clicks: 0, keys: 0, replaces: 0 };
        try {
          const session = await page.getByTestId("session").textContent();
          await typeNeedle(page, "FIND_NEEDLE_A");
          events.keys += 13;
          await holdFence(page);
          await page.getByRole("button", { name: "下一处" }).click();
          events.clicks += 1;
          let pending;
          try {
            pending = await waitPending(page, "m0");
          } catch (error) {
            pending = await snapshot(page);
            pending.pageErrors = errors.length;
            pending.error = error.message;
            record(rows, "same-session-replace-drops-pin", {
              sessionId: session, findPin: "m0", visible: false, needle: "FIND_NEEDLE_B",
            }, pending, events, false, error.message, "wait-pending");
            throw error;
          }
          pending.pageErrors = errors.length;
          assert.equal(pending.findPin, "m0");
          assert.equal(pending.visible, false);
          const scrollBefore = pending.scrollTop;
          await page.evaluate(() => window.__findPage.replaceNeedle("FIND_NEEDLE_B"));
          events.replaces += 1;
          await page.waitForFunction(() => document.querySelector("[data-testid=needle]")?.textContent === "FIND_NEEDLE_B");
          await page.waitForFunction(() =>
            document.querySelector("[data-testid=timeline-short-list]")?.getAttribute("data-find-pin") === "",
          null, { timeout: 4000 });
          assert.equal(await page.getByTestId("session").textContent(), session);
          let afterReplace = await snapshot(page);
          for (let i = 0; i < 6; i += 1) {
            await page.waitForTimeout(32);
            afterReplace = await snapshot(page);
          }
          afterReplace.pageErrors = errors.length;
          const noRejump = afterReplace.findPin === "" && !(afterReplace.key === "m0" && afterReplace.visible);
          record(rows, "same-session-replace-drops-pin", {
            sessionId: session, findPin: "", visible: false, needle: "FIND_NEEDLE_B",
          }, afterReplace, { ...events, pendingPin: pending.findPin, pendingVisible: pending.visible },
            afterReplace.sessionId === session && afterReplace.needle === "FIND_NEEDLE_B" && noRejump,
            `session ${afterReplace.sessionId} pin=${afterReplace.findPin} needle=${afterReplace.needle} visible=${afterReplace.visible} key=${afterReplace.key}`);
          assert.equal(afterReplace.sessionId, session);
          assert.equal(afterReplace.findPin, "");
          assert.equal(afterReplace.key === "m0" && afterReplace.visible, false);
          assert.equal(Math.abs(afterReplace.scrollTop - scrollBefore) < 80 || afterReplace.following === false, true);
          await page.getByTestId("find-chat-scroll").hover();
          await page.mouse.wheel(0, 1);
          await page.waitForFunction(() => window.__findPage.wheelFence === false, null, { timeout: 4000 });
          const box = page.getByRole("textbox", { name: "在会话中查找" });
          await box.fill("");
          await box.click();
          await page.keyboard.type("FIND_NEEDLE_B", { delay: 8 });
          events.keys += 13;
          await page.getByRole("button", { name: "下一处" }).click();
          events.clicks += 1;
          await waitLocated(page, "m0");
          const after = await snapshot(page);
          after.pageErrors = errors.length;
          record(rows, "same-session-replace-new-needle", { key: "m0", text: "FIND_NEEDLE_B" }, after, events,
            after.key === "m0" && after.visible && after.text.includes("FIND_NEEDLE_B"),
            `key=${after.key} text=${after.text}`);
          assert.equal(after.key, "m0");
          assert.ok(after.text.includes("FIND_NEEDLE_B"));
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      async function pendingMidtail(page, events) {
        await typeNeedle(page, "FIND_NEEDLE_MID");
        events.keys += 15;
        await waitFindReady(page, "1/1");
        await holdFence(page);
        await page.getByRole("button", { name: "下一处" }).click();
        events.clicks += 1;
        await waitPin(page, "m250");
        const pending = await snapshot(page);
        assert.equal(pending.findPin, "m250");
        assert.equal(pending.visible, false);
        return pending;
      }

      await t.test("session switch cancels pending pin", async () => {
        const { context, page, errors } = await openPage("midtail");
        const events = { clicks: 0, keys: 0 };
        try {
          await pendingMidtail(page, events);
          const sessionBefore = await page.getByTestId("session").textContent();
          assert.equal(sessionBefore, "sess-1");
          await page.evaluate(() => window.__findPage.setSessionId("sess-2"));
          await page.waitForFunction(() => document.querySelector("[data-testid=session]")?.textContent === "sess-2");
          const afterSession = await snapshot(page);
          afterSession.pageErrors = errors.length;
          record(rows, "session-switch-cancels-pin", { findPin: "", sessionId: "sess-2" }, afterSession, events,
            afterSession.sessionId === "sess-2" && afterSession.findPin === "",
            `pin=${afterSession.findPin} session=${afterSession.sessionId}`);
          assert.equal(afterSession.findPin, "");
          assert.notEqual(afterSession.key === "m250" && afterSession.visible, true);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("close cancels pending and does not rejump", async () => {
        const { context, page, errors } = await openPage("midtail");
        const events = { clicks: 0, keys: 0 };
        try {
          await pendingMidtail(page, events);
          await page.evaluate(() => window.__findPage.closeFind());
          await page.waitForFunction(() => !document.querySelector("[aria-label='在会话中查找']"));
          const afterClose = await snapshot(page);
          afterClose.pageErrors = errors.length;
          record(rows, "close-cancels-pin", { findOpen: false, findPin: "" }, afterClose, events,
            afterClose.findOpen === false && afterClose.findPin === "" && !(afterClose.key === "m250" && afterClose.visible),
            `open=${afterClose.findOpen} pin=${afterClose.findPin} key=${afterClose.key}`);
          assert.equal(afterClose.findOpen, false);
          assert.equal(afterClose.findPin, "");
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("sending cancels pending and does not rejump", async () => {
        const { context, page, errors } = await openPage("midtail");
        const events = { clicks: 0, keys: 0 };
        try {
          await pendingMidtail(page, events);
          await page.evaluate(() => window.__findPage.setSending(true));
          await page.waitForFunction(() =>
            document.querySelector("[data-testid=timeline-short-list]")?.getAttribute("data-find-pin") === "",
          );
          const afterSending = await snapshot(page);
          afterSending.pageErrors = errors.length;
          record(rows, "sending-cancels-pin", { findPin: "" }, afterSending, events,
            afterSending.findPin === "" && !(afterSending.key === "m250" && afterSending.visible),
            `sending pin=${afterSending.findPin} key=${afterSending.key} visible=${afterSending.visible}`);
          assert.equal(afterSending.findPin, "");
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("unmount does not replay old generation", async () => {
        const { context, page, errors } = await openPage("midtail");
        const events = { clicks: 0, keys: 0 };
        try {
          await pendingMidtail(page, events);
          await page.evaluate(() => window.__findPage.setMounted(false));
          await page.getByTestId("list-unmounted").waitFor();
          await page.evaluate(() => window.__findPage.setMounted(true));
          await page.getByRole("textbox", { name: "在会话中查找" }).waitFor();
          await page.waitForFunction(() => document.querySelector("[data-testid=timeline-short-list]"));
          const afterUnmount = await snapshot(page);
          afterUnmount.pageErrors = errors.length;
          record(rows, "unmount-no-rejump", { listMounted: true, visible: false }, afterUnmount, events,
            afterUnmount.listMounted === true && !(afterUnmount.key === "m250" && afterUnmount.visible),
            `unmount key=${afterUnmount.key} visible=${afterUnmount.visible} pin=${afterUnmount.findPin}`);
          assert.equal(afterUnmount.key === "m250" && afterUnmount.visible, false);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("rapid next-prev lands on second hit", async () => {
        const { context, page, errors } = await openPage("multi");
        const events = { clicks: 0, keys: 0 };
        try {
          await typeNeedle(page, "MULTI_NEEDLE");
          events.keys += 12;
          await waitFindReady(page, "1/3");
          const nextBtn = page.getByRole("button", { name: "下一处" });
          await nextBtn.click();
          await nextBtn.click();
          await page.getByRole("button", { name: "上一处" }).click();
          events.clicks += 3;
          await waitLocated(page, "m160");
          const rapid = await snapshot(page);
          rapid.pageErrors = errors.length;
          record(rows, "rapid-next-prev", { key: "m160", hit: "2/3" }, rapid, events,
            rapid.key === "m160" && rapid.visible && rapid.hit === "2/3",
            `rapid key=${rapid.key} hit=${rapid.hit} visible=${rapid.visible}`);
          assert.equal(rapid.key, "m160");
          assert.equal(rapid.visible, true);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t.test("2000-row peak budget, pin release, jumpToBottom", async () => {
        const { context, page, errors } = await openPage("budget");
        const events = { clicks: 0, keys: 0 };
        try {
          await typeNeedle(page, "FIND_NEEDLE_A");
          events.keys += 13;
          await page.evaluate(() => { window.__findPage.peakMounted = 0; });
          await page.getByRole("button", { name: "下一处" }).click();
          events.clicks += 1;
          await waitLocated(page, "m0");
          const after = await snapshot(page);
          const underBudget = after.peakMounted <= PEAK_BUDGET;
          const located = after.key === "m0" && after.visible === true;
          const stability = await framesStable(page, "m0");
          after.stable = stability.stable;
          after.pageErrors = errors.length;
          record(rows, "budget-2000-peak", {
            key: "m0", visible: true, peakLte: PEAK_BUDGET, stable: true, findPin: "",
          }, after, events, located && underBudget && stability.stable && after.findPin === "",
            `key=${after.key} visible=${after.visible} peak=${after.peakMounted} stable=${stability.stable} pin=${after.findPin}`);
          assert.equal(located, true, "m0 visible");
          assert.equal(underBudget, true, `peak ${after.peakMounted} > ${PEAK_BUDGET}`);
          assert.equal(stability.stable, true, "pin release must stay put");
          assert.equal(after.findPin, "");
          await page.waitForFunction(() =>
            document.querySelector("[data-testid=scroll-to-bottom-dock]")?.getAttribute("data-visible") === "true",
          );
          const btn = page.getByTestId("scroll-to-bottom");
          assert.equal(await btn.count(), 1);
          await btn.click();
          events.clicks += 1;
          await page.waitForFunction(() => {
            const el = document.querySelector("[data-testid=find-chat-scroll]");
            return el && el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
          });
          let bottomOk = true;
          let bottom = await snapshot(page);
          for (let i = 0; i < 4; i += 1) {
            await page.waitForTimeout(32);
            bottom = await snapshot(page);
            if (bottom.distBottom > 2 || bottom.following !== true) bottomOk = false;
          }
          bottom.stable = bottomOk;
          bottom.pageErrors = errors.length;
          record(rows, "jump-to-bottom-after-find", {
            distBottomLte: 2, following: true, findPin: "", last: "m1999", stable: true,
          }, bottom, events,
            bottom.distBottom <= 2 && bottom.following === true && bottom.findPin === "" && bottom.mountedLast === "m1999" && bottomOk,
            `dist=${bottom.distBottom} following=${bottom.following} last=${bottom.mountedLast} pin=${bottom.findPin} stable=${bottomOk}`);
          assert.ok(bottom.distBottom <= 2, `distBottom ${bottom.distBottom}`);
          assert.equal(bottom.following, true);
          assert.equal(bottom.findPin, "");
          assert.equal(bottom.mountedLast, "m1999");
          assert.equal(bottomOk, true);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    } finally {
      try {
        await browser.close();
      } catch {
        /* still write catalog */
      }
      const catalog = finalizeRows(rows, { mode: negative ? "negative-overlay" : "candidate" });
      writeFileSync(resultPath, JSON.stringify({
        sources,
        negative,
        peakBudget: PEAK_BUDGET,
        expectedSceneCount: EXPECTED_SCENES.length,
        ...catalog,
        rows,
      }, null, 2));
      console.log(`FIND_RESULT ${resultPath} scenes=${catalog.scenes} expected=${EXPECTED_SCENES.length} missing=${catalog.missingScenes.length} failed=${catalog.failed}`);
      if (catalogIsInvalid(catalog)) {
        process.exitCode = 1;
        const recordedFails = rows.filter((r) => !r.pass && r.phase !== "never-recorded");
        if (recordedFails.length === 0) {
          assert.fail(
            `find catalog incomplete after JSON write: failed=${catalog.failed} missing=${catalog.missingScenes.join(",") || "[]"} duplicates=${(catalog.duplicates || []).join(",") || "[]"}`,
          );
        }
      }
    }
  } finally {
    if (out) rmSync(out, { recursive: true, force: true });
  }
});
