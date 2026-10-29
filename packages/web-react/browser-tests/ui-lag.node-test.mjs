// #1240 page-wide lag / first click not responding. Real App against the OCV5-265 WebSocket fixture
// (ui-lag/lag-lab.mjs): render budget while a long team-style run streams, the first click after the mobile
// drawer was left open when the window widened, and a rename racing an in-flight session-list refresh. Render counts come from a stub React DevTools hook, so
// they do not depend on runner speed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BOARD_SESSION } from "./process-disclosure-story.mjs";
import { buildLagApp, launchBrowser, measureRun, startLagServer } from "./ui-lag/lag-lab.mjs";

// Calibrated on the fixture (6 steps, 12 settled turns, 60 sessions); see the PR for measured values.
const SESSION_ROW_BUDGET = 60;
const SETTLED_SHELL_BUDGET = 6;
const RENDERS_PER_FRAME_BUDGET = 350;

let work;
let lab;
let browser;

before(async () => {
  work = mkdtempSync(join(tmpdir(), "ui-lag-test-"));
  await buildLagApp(work);
  lab = await startLagServer(work, 60);
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  lab?.preview.server.close();
  rmSync(work, { recursive: true, force: true });
});

test("#1240 long run: sidebar rows and settled process shells do not re-render per stream frame", { timeout: 240_000 }, async () => {
  const m = await measureRun(browser, lab, { vp: "desktop", steps: 6, turns: 12, throttle: false });
  assert.deepEqual(m.errors, []);
  assert.equal(m.composerValue, "继续追问一下细节", "typing during the run reaches the composer");
  assert.ok(m.frames > 80, `run streamed ${m.frames} frames`);
  const rows = m.by.SessionRow ?? 0;
  assert.ok(rows <= SESSION_ROW_BUDGET, `SessionRow rendered ${rows} times during the run (budget ${SESSION_ROW_BUDGET})`);
  const settled = Object.entries(m.pd).filter(([key]) => key.startsWith("active=false"));
  assert.ok(settled.length > 0, "settled turns are on screen");
  for (const [key, n] of settled) {
    assert.ok(n <= SETTLED_SHELL_BUDGET, `settled process shell ${key} rendered ${n} times (budget ${SETTLED_SHELL_BUDGET})`);
  }
  assert.ok(m.rendersPerFrame <= RENDERS_PER_FRAME_BUDGET,
    `${m.rendersPerFrame} component renders per stream frame (budget ${RENDERS_PER_FRAME_BUDGET})`);
});

test("#1240 drawer left open below md, window widened: the first click on the composer focuses it", { timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  try {
    await ctx.addInitScript(() => { localStorage.setItem("oc_auth_hint", "1"); localStorage.setItem("oc_theme", "light"); });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(lab.preview.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.innerText.includes("未连接"));
    await page.getByRole("button", { name: "打开菜单" }).click();
    await page.getByRole("dialog", { name: "会话导航" }).waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    const composer = page.getByPlaceholder(/对话/);
    const b = await composer.boundingBox();
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.mouse.click(b.x + b.width / 2, b.y + 10);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "first click focuses the composer");
    assert.equal(await page.getByRole("dialog", { name: "会话导航" }).count(), 0, "no hidden modal drawer remains");
  } finally {
    await ctx.close();
  }
});

test("#1240 rename while a session-list refresh is in flight: the first rename sticks", { timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  try {
    await ctx.addInitScript(() => { localStorage.setItem("oc_auth_hint", "1"); localStorage.setItem("oc_theme", "light"); });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(lab.preview.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.innerText.includes("未连接"));
    const sidebar = page.locator("aside").first();
    const row = sidebar.locator("[data-session-row]").filter({ has: page.getByRole("button", { name: "库存看板", exact: true }) });
    await row.hover();
    await row.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "重命名" }).click();
    const input = page.getByRole("dialog").getByRole("textbox");
    await input.fill("office-1029pm");
    // The PATCH is held; meanwhile a window-focus refresh brings back the list as it was before the rename.
    let releasePatch;
    const patchSeen = new Promise((seen) => {
      page.route(`**/api/sessions/${BOARD_SESSION}`, async (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        seen();
        await new Promise((release) => { releasePatch = release; });
        await route.fulfill({ json: { ok: true, updatedAt: Date.now() } });
      });
    });
    await input.press("Enter");
    await patchSeen;
    const refresh = async () => {
      const listed = page.waitForResponse((r) => r.url().includes("/api/sessions/list"));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await listed;
      await page.waitForTimeout(300);
    };
    await refresh();
    assert.equal(await sidebar.getByRole("button", { name: "office-1029pm", exact: true }).count(), 1,
      "a list response that predates the rename does not put the old title back while the PATCH is in flight");
    releasePatch();
    await page.waitForTimeout(300);
    await refresh();
    assert.equal(await sidebar.getByRole("button", { name: "office-1029pm", exact: true }).count(), 1,
      "an older list snapshot after the PATCH landed does not put the old title back");
    assert.equal(await sidebar.getByRole("button", { name: "库存看板", exact: true }).count(), 0);
  } finally {
    await ctx.close();
  }
});
