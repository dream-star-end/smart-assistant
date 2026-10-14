// OCV5-422 first paint of a production build on a slow link, before deploy: serves DIST (a `vite build` output)
// with SPA fallback (no /api — the app ends on its signed-out or error screen, which is fine for first paint),
// then opens it in Chromium with 1.5 s latency + 40 KB/s, and once on an unthrottled link.
// Records first-paint / FCP, screenshots at fixed times, and a FOUC probe: when React first replaces the
// static placeholder in #root, is the main stylesheet already applied?
// Env: DIST (default ./dist), OUT, LABEL, SLOW_AT (ms list, default 3000,8000,15000,30000).
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { resolveBrowserExecutable } from "../../../../scripts/lib/resolve-browser.mjs";

const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright-core");
const DIST = resolve(process.env.DIST ?? "dist");
const OUT = process.env.OUT ?? "/tmp/ocv5-422-boot";
const LABEL = process.env.LABEL ?? "after";
const AT = (process.env.SLOW_AT ?? "3000,8000,15000,30000").split(",").map(Number);
mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".json": "application/json" };

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (path.startsWith("/api/") || path.startsWith("/ws")) { res.writeHead(503); res.end(); return; }
  if (path === "/sw.js") { res.writeHead(404); res.end(); return; } // no service worker in the probe
  const file = join(DIST, path);
  const ok = file.startsWith(DIST + sep) && existsSync(file) && statSync(file).isFile();
  const target = ok ? file : join(DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(target).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });

const probe = () => {
  const w = window;
  w.__boot = { paints: {}, swap: null };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__boot.paints[e.name] = Math.round(e.startTime); })
      .observe({ type: "paint", buffered: true });
  } catch {}
  const mainSheetApplied = () => [...document.styleSheets].some((s) => {
    try { return /\/assets\/styles-[^/]+\.css$/.test(s.href ?? "") && s.cssRules.length > 0; } catch { return false; }
  });
  const watch = () => {
    const root = document.getElementById("root");
    if (!root) return void requestAnimationFrame(watch);
    new MutationObserver(() => {
      if (w.__boot.swap || root.querySelector(":scope > .oc-boot")) return;
      w.__boot.swap = { at: Math.round(performance.now()), mainSheetApplied: mainSheetApplied(),
        bodyBg: getComputedStyle(document.body).backgroundColor };
    }).observe(root, { childList: true });
  };
  document.addEventListener("DOMContentLoaded", watch);
};

const state = (page) => page.evaluate(() => ({
  readyState: document.readyState,
  placeholder: !!document.querySelector("#root > .oc-boot"),
  hintVisible: (() => { const h = document.querySelector(".oc-boot-hint"); return !!h && Number(getComputedStyle(h).opacity) > 0.5; })(),
  sheets: [...document.styleSheets].map((s) => (s.href ? s.href.split("/").pop() : "inline")),
  rootText: (document.getElementById("root")?.innerText ?? "").replace(/\s+/g, " ").slice(0, 80),
  boot: window.__boot,
}));

const log = { label: LABEL, dist: DIST, cases: {} };
for (const [vp, viewport, mobile] of [["mobile", { width: 390, height: 844 }, true], ["desktop", { width: 1280, height: 900 }, false]]) {
  for (const net of ["slow", "fast"]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: "zh-CN", colorScheme: "light" });
    await ctx.addInitScript(probe);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (net === "slow") await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 1500, downloadThroughput: 40 * 1024, uploadThroughput: 20 * 1024 });
    // Filmstrip: Chrome records a frame only when one is actually presented. A forced CDP screenshot
    // (below) makes the renderer produce a frame even while the page is render-blocked, so for "what
    // the user saw at N s" the filmstrip is the evidence; the CDP shots are kept for the layout.
    if (net === "slow") await browser.startTracing(page, { categories: ["devtools.timeline", "blink.user_timing", "disabled-by-default-devtools.screenshot"] });
    const t0 = Date.now();
    page.goto(`${BASE}/`, { waitUntil: "load", timeout: 240000 }).catch(() => {});
    const samples = [];
    // CDP screenshot: Playwright's page.screenshot waits for web fonts, which on this link delays a "3 s" shot by tens of seconds.
    const shot = async (name) => {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, `boot-${LABEL}-${net}-${name}-${vp}.png`), Buffer.from(data, "base64"));
    };
    for (const at of net === "slow" ? AT : [1500]) {
      await page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
      const st = await state(page).catch((e) => ({ error: String(e).slice(0, 120) }));
      const tookAt = Date.now() - t0;
      await shot(`${at / 1000}s`).catch(() => {});
      samples.push({ at, tookAt, ...st });
    }
    if (net === "slow") {
      // Wait for React to take over, then record whether it did so with styles in place.
      await page.waitForFunction(() => !!window.__boot?.swap, null, { timeout: 240000 }).catch(() => {});
      samples.push({ at: Date.now() - t0, final: true, ...(await state(page).catch(() => ({}))) });
      await shot("mounted").catch(() => {});
      const trace = JSON.parse(String(await browser.stopTracing()));
      const events = trace.traceEvents ?? trace;
      const nav = events.find((e) => e.name === "navigationStart" || e.name === "NavigationStartToFirstPaint" || e.name === "markAsMainFrame")?.ts
        ?? Math.min(...events.filter((e) => e.ts > 0).map((e) => e.ts));
      const frames = events.filter((e) => e.name === "Screenshot" && e.args?.snapshot).map((e) => ({ ms: Math.round((e.ts - nav) / 1000), data: e.args.snapshot }));
      const film = [];
      for (const at of [...AT, samples.at(-1).at]) {
        const shown = frames.filter((f) => f.ms <= at).at(-1);
        film.push({ at, frameAtMs: shown?.ms ?? null });
        if (shown) writeFileSync(join(OUT, `film-${LABEL}-${at / 1000 | 0}s-${vp}.jpg`), Buffer.from(shown.data, "base64"));
      }
      samples.push({ film, firstFrameMs: frames[0]?.ms ?? null, frames: frames.length });
    } else {
      await page.waitForFunction(() => !!window.__boot?.swap, null, { timeout: 30000 }).catch(() => {});
      samples.push({ final: true, ...(await state(page)) });
    }
    log.cases[`${net}-${vp}`] = samples;
    console.log(JSON.stringify({ case: `${net}-${vp}`, film: samples.at(-1).film, firstFrameMs: samples.at(-1).firstFrameMs, samples: samples.map((s) => ({ at: s.at, tookAt: s.tookAt, placeholder: s.placeholder, hint: s.hintVisible, sheets: s.sheets?.length, paints: s.boot?.paints, swap: s.boot?.swap, text: s.rootText?.slice(0, 30) })) }));
    await ctx.close();
  }
}
writeFileSync(join(OUT, `boot-${LABEL}.json`), JSON.stringify(log, null, 1));
await browser.close();
server.close();
console.log(`BOOT_DONE out=${OUT}`);
