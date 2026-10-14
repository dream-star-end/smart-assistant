// OCV5-421 render lab driver: real MessageList + production CSS in real Chromium.
// Shots: every scene × {desktop 1280x900, mobile 390x844} × {light, dark}; probes: DOM facts per scene;
// perf: stream a long answer on top of a large session and record long tasks / frame gaps.
// Env: OUT (dir), SCENES (comma filter), PERF=0 to skip perf, PERF_TURNS (default 150).
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../../scripts/lib/resolve-browser.mjs";
import { SCENES, TEXT, longCode } from "./scenes.mjs";

const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");
const { chromium } = require_("playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const BT = dirname(HERE);
const OUT = process.env.OUT ?? join(tmpdir(), "ocv5-421-lab");
const FILTER = (process.env.SCENES ?? "").split(",").filter(Boolean);
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "ocv5-421-lab-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

await esbuild.build({
  entryPoints: [join(HERE, "lab-harness.tsx")], bundle: true, format: "iife", outfile: join(work, "lab.js"),
  jsx: "automatic", loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.MODE": '"production"' },
  alias: { "node:crypto": join(BT, "stubs", "node-crypto.js") }, logLevel: "silent",
});
const cssDir = join(work, "css");
await viteBuild({ root: dirname(BT), configFile: false, logLevel: "silent", plugins: [tailwindcss()],
  build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false,
    rollupOptions: { input: join(HERE, "lab-styles.ts"), output: { entryFileNames: "p.js", assetFileNames: "p[extname]" } } } });
const css = readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css"))), "utf8");
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div><script>${readFileSync(join(work, "lab.js"), "utf8")}</script></body></html>`;
const MIME = { ".woff2": "font/woff2", ".woff": "font/woff", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".js": "text/javascript", ".ttf": "font/ttf" };
const URL0 = "http://127.0.0.1/__ocv5_421_lab__";

const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
const results = [];
async function open(viewport, mobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console ${m.text().slice(0, 300)}`); });
  await page.route("**/*", (route, req) => {
    const u = new URL(req.url());
    if (req.url().startsWith(URL0)) return route.fulfill({ status: 200, contentType: "text/html", body: html });
    const name = u.pathname.split("/").pop() ?? "";
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
    const f = join(cssDir, name);
    if (name && MIME[ext] && existsSync(f)) return route.fulfill({ status: 200, contentType: MIME[ext], body: readFileSync(f) });
    if (MIME[ext] === "image/png" || /\.(jpe?g|gif|webp)$/.test(name)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.addInitScript(([md, lc]) => { window.__TEXT_MD = md; window.__LONG_CODE = lc; }, [TEXT.md, longCode(400, "")]);
  await page.goto(URL0);
  await page.waitForFunction(() => !!window.__lab);
  return { ctx, page, errors };
}

for (const scene of SCENES) {
  if (scene.perf) continue;
  if (FILTER.length && !FILTER.some((f) => scene.id.includes(f))) continue;
  for (const [vp, viewport, mobile] of [["desktop", { width: 1280, height: 900 }, false], ["mobile", { width: 390, height: 844 }, true]]) {
    const { ctx, page, errors } = await open(viewport, mobile);
    const r = { scene: scene.id, vp, probes: {}, errors };
    try {
      await page.evaluate(scene.setup);
      await page.waitForTimeout(scene.settleMs ?? 1500);
      if (scene.expand) {
        for (let k = 0; k < 3; k++) {
          const closed = page.locator('[data-testid=process-disclosure] button[aria-expanded="false"]');
          const n = await closed.count();
          for (let i = n - 1; i >= 0; i--) await closed.nth(i).click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
      }
      if (scene.during) r.probes.during = await page.evaluate(scene.during);
      if (scene.probe) r.probes.after = await page.evaluate(scene.probe);
      r.probes.hscroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      for (const dark of [false, true]) {
        await page.evaluate((d) => window.__lab.dark(d), dark);
        await page.waitForTimeout(400);
        const shots = scene.shots ?? [{ name: "top", scroll: "top" }];
        for (const s of shots) {
          await page.evaluate(({ scroll, sel }) => {
            const el = document.querySelector("[data-lab-scroll]");
            if (sel) { const t = [...document.querySelectorAll(sel)].pop(); t?.scrollIntoView({ block: "start" }); el.scrollTop -= 12; }
            else if (scroll === "top") el.scrollTop = 0;
            else if (scroll === "bottom") el.scrollTop = el.scrollHeight;
            else if (typeof scroll === "number") el.scrollTop = scroll;
          }, s);
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(OUT, `${scene.id}-${s.name}-${vp}-${dark ? "dark" : "light"}.png`) });
        }
      }
    } catch (e) { r.error = String(e).slice(0, 500); }
    results.push(r);
    console.log(JSON.stringify(r));
    await ctx.close();
  }
}

if (process.env.PERF !== "0") {
  for (const scene of SCENES.filter((s) => s.perf && (!FILTER.length || FILTER.some((f) => s.id.includes(f))))) {
    for (const [vp, viewport, mobile] of [["desktop", { width: 1280, height: 900 }, false], ["mobile", { width: 390, height: 844 }, true]]) {
      const runs = [];
      for (let k = 0; k < Number(process.env.PERF_RUNS ?? 3); k++) {
        const { ctx, page, errors } = await open(viewport, mobile);
        if (mobile) { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); }
        const m = await page.evaluate(scene.perf, Number(process.env.PERF_TURNS ?? 150));
        m.errors = errors.length;
        runs.push(m);
        await ctx.close();
      }
      const r = { scene: scene.id, vp, runs };
      results.push(r);
      console.log(JSON.stringify(r));
    }
  }
}
writeFileSync(join(OUT, "lab-results.json"), JSON.stringify(results, null, 1));
await browser.close();
const bad = results.filter((r) => r.error);
console.log(`LAB_DONE scenes=${results.length} failed=${bad.length} out=${OUT}`);
process.exit(bad.length ? 1 : 0);
