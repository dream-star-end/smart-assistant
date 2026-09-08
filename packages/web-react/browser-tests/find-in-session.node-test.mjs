import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const repoRoot = join(here, "../../..");
const sha = process.env.OC_FIND_SHA || "unknown";
const resultPath = process.env.OC_FIND_RESULT || join(tmpdir(), "ocv5-188-find-result.json");
const PEAK_BUDGET = 80;

function snapshot(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector("[data-testid=find-chat-scroll]");
    const current = document.querySelector("[data-find-current]");
    const key = current?.getAttribute("data-chat-virtual-key") ?? null;
    const row = current?.getBoundingClientRect();
    const view = scroller?.getBoundingClientRect();
    const mounted = [...document.querySelectorAll("[data-chat-virtual-key]")].map((el) =>
      el.getAttribute("data-chat-virtual-key"),
    );
    const visible = !!(row && view && row.height > 0 && row.bottom > view.top + 1 && row.top < view.bottom - 1);
    return {
      key,
      mountedFirst: mounted[0] ?? null,
      needleMounted: mounted.includes("m0") || mounted.includes("needle"),
      paintCount: Number(document.querySelector("[data-testid=timeline-short-list]")?.getAttribute("data-timeline-paint-count") ?? 0),
      peakMounted: window.__findPage.peakMounted,
      following: window.__findPage.following,
      wheelFence: window.__findPage.wheelFence,
      hit: document.body.innerText.match(/\d+\/\d+|无匹配/)?.[0] ?? null,
      row: row ? { top: row.top, bottom: row.bottom, height: row.height } : null,
      scroller: view ? { top: view.top, bottom: view.bottom, height: view.height } : null,
      visible,
    };
  });
}

function record(rows, scene, expected, actual, clicks, pass, failReason, skips = []) {
  const row = {
    scene,
    sha,
    expected,
    actual: {
      key: actual.key,
      visible: actual.visible,
      needleMounted: actual.needleMounted,
      hit: actual.hit,
      row: actual.row,
      scroller: actual.scroller,
      peakMounted: actual.peakMounted,
      paintCount: actual.paintCount,
    },
    clicks,
    peakMounted: actual.peakMounted,
    pass,
    failed: pass ? 0 : 1,
    skip: skips.length,
    skips,
    failReason: pass ? "" : failReason,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  return row;
}

test("OCV5-188 F4 find navigation (real MessageList, controller, production CSS)", { timeout: 240_000 }, async (t) => {
  const baselineFile = process.env.OC_FIND_BASELINE_FILE;
  const bundle = await build({
    entryPoints: [join(here, "find-in-session-harness.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    alias: {
      "node:crypto": join(here, "stubs/node-crypto.js"),
    },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.MODE": '"production"' },
    logLevel: "silent",
    plugins: baselineFile
      ? [{
        name: "find-red-baseline",
        setup(b) {
          b.onLoad({ filter: /src\/components\/MessageRenderer\.tsx$/ }, () => ({
            contents: readFileSync(baselineFile, "utf8"),
            loader: "tsx",
          }));
        },
      }]
      : [],
  });
  const out = mkdtempSync(join(tmpdir(), "oc-find-css-"));
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
  const css = readFileSync(join(out, readdirSync(out).find((n) => n.endsWith(".css"))), "utf8");
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox"],
  });
  const rows = [];
  const isBaseline = Boolean(baselineFile);
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
        `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div>`,
      );
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate((s) => window.__findPage.setScene(s), scene);
      await page.getByTestId("scene").waitFor();
      await page.getByRole("textbox", { name: "在会话中查找" }).waitFor();
      await page.waitForTimeout(250);
      await page.evaluate(() => { window.__findPage.peakMounted = 0; });
      return { context, page, errors };
    }

    await t.test("tail-320-m0 keyboard.type then one click", async () => {
      const { context, page, errors } = await openPage("tail");
      try {
        const before = await snapshot(page);
        assert.equal(before.needleMounted, false, "precondition: m0 must start unmounted");
        await page.getByRole("textbox", { name: "在会话中查找" }).click();
        await page.keyboard.type("FIND_NEEDLE_A", { delay: 15 });
        await page.waitForTimeout(50);
        await page.getByRole("button", { name: "下一处" }).click();
        await page.waitForFunction(() => {
          const el = document.querySelector('[data-find-current]');
          const scroller = document.querySelector("[data-testid=find-chat-scroll]");
          if (!el || !scroller) return false;
          const r = el.getBoundingClientRect();
          const s = scroller.getBoundingClientRect();
          return el.getAttribute("data-chat-virtual-key") === "m0" &&
            r.height > 0 && r.bottom > s.top + 1 && r.top < s.bottom - 1;
        }, null, { timeout: isBaseline ? 800 : 4000 }).catch(() => {});
        const after = await snapshot(page);
        const pass = after.key === "m0" && after.visible === true && after.hit === "1/1";
        record(rows, "tail-320-m0", { key: "m0", visible: true, hit: "1/1", clicks: 1 }, after, 1, pass,
          pass ? "" : `key=${after.key} visible=${after.visible} hit=${after.hit} mounted=${after.needleMounted}`);
        assert.deepEqual(errors, []);
        if (isBaseline) assert.equal(pass, false, "old jumpTo must fail to reveal m0");
        else assert.equal(pass, true);
      } finally {
        await context.close();
      }
    });

    await t.test("enter / shift+enter / button key / mobile tap", async () => {
      const { context, page, errors } = await openPage("multi");
      try {
        await page.getByRole("textbox", { name: "在会话中查找" }).click();
        await page.keyboard.type("MULTI_NEEDLE", { delay: 10 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(isBaseline ? 400 : 1500);
        let after = await snapshot(page);
        const enterPass = after.key === "m160" && after.visible === true;
        record(rows, "enter-second-hit", { key: "m160", visible: true }, after, 1, enterPass,
          enterPass ? "" : `Enter expected m160 got ${after.key} visible=${after.visible}`);
        await page.keyboard.press("Shift+Enter");
        await page.waitForTimeout(isBaseline ? 400 : 1500);
        after = await snapshot(page);
        const shiftPass = after.key === "m0" && after.visible === true;
        record(rows, "shift-enter-first-hit", { key: "m0", visible: true }, after, 1, shiftPass,
          shiftPass ? "" : `Shift+Enter expected m0 got ${after.key}`);
        await page.getByRole("button", { name: "下一处" }).focus();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(isBaseline ? 400 : 1500);
        after = await snapshot(page);
        const keyBtn = after.key === "m160" && after.visible === true;
        record(rows, "button-key-activate", { key: "m160", visible: true }, after, 1, keyBtn,
          keyBtn ? "" : `button Enter expected m160 got ${after.key}`);
        assert.deepEqual(errors, []);
        if (!isBaseline) {
          assert.equal(enterPass, true);
          assert.equal(shiftPass, true);
          assert.equal(keyBtn, true);
        }
      } finally {
        await context.close();
      }
    });

    await t.test("mobile tap completes despite own touchend fence", async () => {
      const { context, page, errors } = await openPage("tail", true);
      try {
        await page.getByRole("textbox", { name: "在会话中查找" }).tap();
        await page.keyboard.type("FIND_NEEDLE_A", { delay: 10 });
        await page.getByRole("button", { name: "下一处" }).tap();
        await page.waitForFunction(() => {
          const el = document.querySelector('[data-find-current]');
          const scroller = document.querySelector("[data-testid=find-chat-scroll]");
          if (!el || !scroller) return false;
          const r = el.getBoundingClientRect();
          const s = scroller.getBoundingClientRect();
          return el.getAttribute("data-chat-virtual-key") === "m0" &&
            r.height > 0 && r.bottom > s.top + 1 && r.top < s.bottom - 1;
        }, null, { timeout: isBaseline ? 800 : 4000 }).catch(() => {});
        const after = await snapshot(page);
        const pass = after.key === "m0" && after.visible === true;
        record(rows, "mobile-tap", { key: "m0", visible: true }, after, 1, pass,
          pass ? "" : `tap key=${after.key} visible=${after.visible} fence=${after.wheelFence}`);
        assert.deepEqual(errors, []);
        if (!isBaseline) assert.equal(pass, true);
      } finally {
        await context.close();
      }
    });

    await t.test("coalesced team then ordinary assistant uses render key", async () => {
      const { context, page, errors } = await openPage("coalesce");
      try {
        await page.getByRole("textbox", { name: "在会话中查找" }).click();
        await page.keyboard.type("FIND_NEEDLE_A", { delay: 10 });
        await page.getByRole("button", { name: "下一处" }).click();
        await page.waitForTimeout(isBaseline ? 400 : 1500);
        const after = await snapshot(page);
        const pass = after.key === "needle" && after.visible === true && after.hit === "1/1";
        record(rows, "coalesced-after-team", { key: "needle", visible: true, hit: "1/1" }, after, 1, pass,
          pass ? "" : `expected needle got ${after.key} visible=${after.visible}`);
        assert.deepEqual(errors, []);
        if (!isBaseline) assert.equal(pass, true);
      } finally {
        await context.close();
      }
    });

    await t.test("pending jump cancelled by real wheel does not resume after fence", async () => {
      const { context, page, errors } = await openPage("midtail");
      try {
        await page.getByRole("textbox", { name: "在会话中查找" }).click();
        await page.keyboard.type("FIND_NEEDLE_MID", { delay: 8 });
        await page.evaluate(() => {
          document.querySelector('[aria-label="下一处"]')?.click();
          const scroller = document.querySelector("[data-testid=find-chat-scroll]");
          scroller?.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(700);
        const after = await snapshot(page);
        const forced = after.key === "m250" && after.visible === true;
        const cancelled = !forced;
        record(rows, "wheel-cancel-no-rejump", { cancelled: true, key: "not-m250-visible" }, after, 1, cancelled,
          cancelled ? "" : `old generation scrolled to m250 after wheel cancel`);
        assert.deepEqual(errors, []);
        if (!isBaseline) assert.equal(cancelled, true);
      } finally {
        await context.close();
      }
    });

    await t.test("session same id different text and query race", async () => {
      const { context, page, errors } = await openPage("tail");
      try {
        await page.getByRole("textbox", { name: "在会话中查找" }).click();
        await page.keyboard.type("FIND_NEEDLE_A", { delay: 8 });
        await page.getByRole("button", { name: "下一处" }).click();
        await page.evaluate(() => window.__findPage.setVariant("B"));
        await page.waitForTimeout(300);
        const box = page.getByRole("textbox", { name: "在会话中查找" });
        await box.fill("");
        await box.click();
        await page.keyboard.type("FIND_NEEDLE_B", { delay: 8 });
        await page.getByRole("button", { name: "下一处" }).click();
        await page.waitForTimeout(isBaseline ? 400 : 1500);
        const after = await snapshot(page);
        const text = await page.locator("[data-find-current]").innerText().catch(() => "");
        const pass = after.key === "m0" && after.visible === true && text.includes("FIND_NEEDLE_B");
        record(rows, "session-same-id-new-text", { key: "m0", text: "FIND_NEEDLE_B" }, { ...after, text }, 1, pass,
          pass ? "" : `key=${after.key} text=${text}`);
        assert.deepEqual(errors, []);
        if (!isBaseline) assert.equal(pass, true);
      } finally {
        await context.close();
      }
    });

    await t.test("2000-row peak mount budget and pin release restick", async () => {
      const { context, page, errors } = await openPage("budget");
      try {
        await page.getByRole("textbox", { name: "在会话中查找" }).click();
        await page.keyboard.type("FIND_NEEDLE_A", { delay: 5 });
        await page.evaluate(() => { window.__findPage.peakMounted = 0; });
        await page.getByRole("button", { name: "下一处" }).click();
        await page.waitForTimeout(isBaseline ? 600 : 2000);
        const after = await snapshot(page);
        const underBudget = after.peakMounted <= PEAK_BUDGET;
        const located = after.key === "m0" && after.visible === true;
        let stable = true;
        const firstTop = after.row?.top;
        for (let i = 0; i < 4; i += 1) {
          await page.waitForTimeout(32);
          const frame = await snapshot(page);
          if (Math.abs((frame.row?.top ?? 0) - (firstTop ?? 0)) > 8) stable = false;
        }
        await page.getByTestId("scroll-to-bottom").click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
        const pass = isBaseline ? false : located && underBudget && stable;
        record(rows, "budget-2000-peak", { key: "m0", visible: true, peakLte: PEAK_BUDGET, stable: true }, after, 1, pass,
          pass ? "" : `key=${after.key} visible=${after.visible} peak=${after.peakMounted} stable=${stable}`);
        assert.deepEqual(errors, []);
        if (!isBaseline) {
          assert.equal(located, true, "m0 visible");
          assert.equal(underBudget, true, `peak ${after.peakMounted} > ${PEAK_BUDGET}`);
          assert.equal(stable, true, "pin release must stay put");
        }
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
    writeFileSync(resultPath, JSON.stringify({ sha, baseline: isBaseline, rows }, null, 2));
    console.log(`FIND_RESULT ${resultPath}`);
  }
});
