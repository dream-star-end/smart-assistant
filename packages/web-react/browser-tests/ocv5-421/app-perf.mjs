// OCV5-422 App-level streaming perf: the real App (sidebar, composer, timeline) against the OCV5-265 WebSocket
// fixture, a session with PERF_TURNS finished turns, then one answer streamed as 40-char deltas every 16 ms
// (same answer as lab.mjs perf-stream, size=medium). Mobile runs with 4x CPU throttling.
// Reports long tasks, frame gaps, input delay while typing in the composer during the stream, and React
// renders of the timeline. Env: OUT, PERF_TURNS (60), PERF_RUNS (1), PERF_VP (desktop|mobile), PERF_PROFILE=1,
// PERF_TRACE=1 (main-thread time per trace event name).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../../scripts/lib/resolve-browser.mjs";
import { startPreviewServer } from "../process-disclosure-app-server.mjs";
import { BOARD_SESSION } from "../process-disclosure-story.mjs";

const require_ = createRequire(import.meta.url);
const { build } = require_("esbuild");
const { chromium } = require_("playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const BT = dirname(HERE);
const OUT = process.env.OUT ?? join(tmpdir(), "ocv5-422-app-perf");
const TURNS = Number(process.env.PERF_TURNS ?? 60);
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "ocv5-422-app-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

await build({
  entryPoints: [join(BT, "process-disclosure-app-harness.tsx")], bundle: true, splitting: true, format: "esm",
  outdir: work, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
  alias: { "node:crypto": join(BT, "stubs/node-crypto.js") },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
  logLevel: "warning",
});
const cssDir = join(work, "css-build");
await viteBuild({ root: dirname(BT), configFile: false, logLevel: "silent", plugins: [tailwindcss()],
  build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false,
    rollupOptions: { input: join(BT, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } } });
// With a CPU profile, keep the bundle next to it so profile lines can be mapped back to modules.
if (process.env.PERF_PROFILE === "1") cpSync(work, join(OUT, "bundle"), { recursive: true, filter: (src) => !src.includes("css-build") });
writeFileSync(join(work, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));

const para = "这是一段较长的说明文字，用来模拟模型的正常输出，包含 **加粗**、`行内代码` 和 [链接](https://example.com)。".repeat(4);
const code = (n) => `\`\`\`\n${Array.from({ length: n }, (_, i) => `function f${i}(a, b) { return a.map((x) => x * ${i} + b).filter(Boolean) }`).join("\n")}\n\`\`\``;
const table = (n) => `| 列1 | 列2 | 列3 |\n|---|---|---|\n${Array.from({ length: n }, (_, i) => `| ${i} | 值 ${i} | 说明 ${i} |`).join("\n")}`;
const ANSWER = [para, code(60), para, table(20), para].join("\n\n");

function history(turns) {
  const out = [];
  const t0 = Date.now() - turns * 60_000;
  for (let i = 0; i < turns; i++) {
    const u = `perf-u${i}`;
    const ts = t0 + i * 60_000;
    out.push({ id: u, role: "user", text: `历史问题 ${i}`, status: "replied", ts });
    if (i % 3 === 0) {
      out.push({ id: `perf-bash${i}`, role: "tool", text: "终端", toolName: "Bash", inputJson: { command: `echo ${i}` },
        _completed: true, output: `${i}`, _clientMessageId: u, ts: ts + 5_000 });
    }
    out.push({ id: `perf-a${i}`, role: "assistant", _clientMessageId: u, ts: ts + 20_000,
      text: `${para}\n\n${i % 5 === 0 ? code(20) : "- 列表项一\n- 列表项二"}\n\n| a | b |\n|---|---|\n| ${i} | x |`,
      usage: { costCredits: "3", totalTokens: 420, inputTokens: 280, outputTokens: 140 } });
  }
  return out.map((m, k) => ({ ...m, _source: "server", _orderSeq: 100 + k, _seq: 100 + k, _timelineRecord: true,
    _timelineUnitKey: `unit:${100 + k}:${m.id}`, ...(m._clientMessageId ? { _turnOwnerId: m._clientMessageId } : {}) }));
}

let streamDone = null;
let lastSendMs = 0;
async function perfTurn(send, store, sessId, clientMessageId, text, nextSeq) {
  const base = { type: "outbound.message", sessionKey: `agent:main:webchat:dm:${sessId}`, channel: "webchat",
    peer: { id: sessId, kind: "dm" }, clientMessageId, isFinal: false };
  const mid = `perf-answer-${clientMessageId}`;
  const sendStarted = Date.now();
  for (let i = 0; i < ANSWER.length; i += 40) {
    send({ ...base, frameSeq: nextSeq(sessId), ts: Date.now(), blocks: [{ kind: "text", blockId: mid, messageId: mid, text: ANSWER.slice(i, i + 40) }] });
    await new Promise((r) => setTimeout(r, 16));
  }
  lastSendMs = Date.now() - sendStarted;
  const seq = store.board.length + 100;
  store.board.push(
    { id: clientMessageId, role: "user", text, status: "replied", ts: Date.now(), _source: "server", _orderSeq: seq, _seq: seq, _timelineRecord: true, _timelineUnitKey: `unit:${seq}:${clientMessageId}` },
    { id: mid, role: "assistant", text: ANSWER, ts: Date.now(), _clientMessageId: clientMessageId, _turnOwnerId: clientMessageId, _source: "server", _orderSeq: seq + 1, _seq: seq + 1, _timelineRecord: true, _timelineUnitKey: `unit:${seq + 1}:${mid}` },
  );
  store.revision += 1;
  send({ ...base, frameSeq: nextSeq(sessId), ts: Date.now(), blocks: [], isFinal: true });
  streamDone?.();
}

const preview = await startPreviewServer(work, { playTurn: perfTurn });
const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
const results = [];
for (const [vp, viewport, mobile] of [["desktop", { width: 1280, height: 900 }, false], ["mobile", { width: 390, height: 844 }, true]]) {
  if (process.env.PERF_VP && process.env.PERF_VP !== vp) continue;
  const runs = [];
  for (let k = 0; k < Number(process.env.PERF_RUNS ?? 1); k++) {
    preview.store.board = history(TURNS);
    preview.store.older = [];
    preview.store.revision += 1;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    await ctx.addInitScript(() => { localStorage.setItem("oc_auth_hint", "1"); localStorage.setItem("oc_theme", "light"); });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
    page.setDefaultTimeout(60_000);
    await page.goto(preview.url, { waitUntil: "domcontentloaded" });
    await page.getByText(`历史问题 ${TURNS - 1}`).waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes("未连接"));
    await page.waitForTimeout(2500);
    if (mobile) { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); }
    let prof = null;
    if (process.env.PERF_PROFILE === "1") {
      prof = await ctx.newCDPSession(page);
      await prof.send("Profiler.enable");
      await prof.send("Profiler.setSamplingInterval", { interval: 1000 });
      await prof.send("Profiler.start");
    }
    if (process.env.PERF_TRACE === "1") await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
    await page.evaluate(() => {
      const w = window;
      w.__perf = { lt: [], gaps: [], events: [], on: true };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.lt.push(e.duration); }).observe({ type: "longtask" });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.events.push({ name: e.name, d: e.duration, delay: e.processingStart - e.startTime }); })
        .observe({ type: "event", durationThreshold: 16 });
      let last = performance.now();
      const raf = (t) => { w.__perf.gaps.push(t - last); last = t; if (w.__perf.on) requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
    });
    // Resolve every target before measuring: Playwright locators run accessibility queries inside the page,
    // which under 4x throttling would show up as the app's own main-thread time.
    const box = page.getByPlaceholder(/对话/);
    await box.click();
    await box.fill("perf 长回答");
    const center = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const sendAt = await center(page.getByRole("button", { name: "发送" }));
    const boxAt = await center(box);
    const tap = (at) => (mobile ? page.touchscreen.tap(at.x, at.y) : page.mouse.click(at.x, at.y));
    // Instrumented builds (window.__md / __ml pushed by a patched MarkdownImpl / MessageList) report what rendered.
    await page.evaluate(() => { window.__perfT0 = performance.now(); });
    const done = new Promise((r) => { streamDone = r; });
    const t0 = Date.now();
    await tap(sendAt);
    // Type while the answer streams: what a user feels (keystroke → next paint) when the list is busy.
    await page.waitForTimeout(1500);
    await tap(boxAt);
    const typed = Date.now();
    await page.keyboard.type("继续追问一下细节", { delay: 120 });
    const typeMs = Date.now() - typed;
    await done;
    const streamMs = Date.now() - t0;
    await page.waitForTimeout(3000);
    const m = await page.evaluate(() => {
      const p = window.__perf; p.on = false;
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const keys = p.events.filter((e) => /key|input|beforeinput/.test(e.name));
      return { longTasks: p.lt.length, longTaskTotalMs: Math.round(sum(p.lt)), longTaskMaxMs: Math.round(Math.max(0, ...p.lt)),
        jank50: p.gaps.filter((g) => g > 50).length, jank100: p.gaps.filter((g) => g > 100).length, maxGapMs: Math.round(Math.max(0, ...p.gaps)),
        inputEvents: keys.length, inputMaxMs: Math.round(Math.max(0, ...keys.map((e) => e.d))), inputDelayMaxMs: Math.round(Math.max(0, ...keys.map((e) => e.delay))),
        answerShown: document.body.innerText.includes("说明 19"), domNodes: document.getElementsByTagName("*").length };
    });
    m.instr = await page.evaluate(() => {
      const t0 = window.__perfT0 ?? 0; const md = (window.__md ?? []).filter((x) => x.t >= t0);
      if (!window.__md) return undefined;
      const by = {}; for (const x of md) { const k = `${x.live ? "L" : "-"} ${x.head.replace(/\n/g, " ")}`; (by[k] ??= { n: 0, chars: 0, first: Math.round(x.t - t0) }); by[k].n++; by[k].chars += x.len; }
      return { mdRenders: md.length, listRenders: (window.__ml ?? []).filter((t) => t >= t0).length, top: Object.entries(by).sort((a, b) => b[1].n - a[1].n).slice(0, 15) };
    });
    m.streamMs = streamMs; m.serverSendMs = lastSendMs; m.typeMs = typeMs; m.composerValue = await box.inputValue(); m.errors = errors.length;
    if (process.env.PERF_TRACE === "1") {
      const trace = JSON.parse(String(await browser.stopTracing()));
      const events = trace.traceEvents ?? trace;
      const main = new Set(events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
      const byName = new Map();
      for (const e of events) if (e.ph === "X" && main.has(`${e.pid}:${e.tid}`)) byName.set(e.name, (byName.get(e.name) ?? 0) + (e.dur ?? 0) / 1000);
      m.traceMs = Object.fromEntries([...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k2, v]) => [k2, Math.round(v)]));
    }
    if (prof) {
      const { profile } = await prof.send("Profiler.stop");
      writeFileSync(join(OUT, `app-profile-${vp}-${k}.cpuprofile`), JSON.stringify(profile));
    }
    await page.screenshot({ path: join(OUT, `app-after-stream-${vp}-${k}.png`) });
    runs.push(m);
    console.log(JSON.stringify({ vp, run: k, ...m }));
    await ctx.close();
  }
  results.push({ vp, runs });
}
writeFileSync(join(OUT, "app-perf-results.json"), JSON.stringify(results, null, 1));
await browser.close();
preview.server.close();
console.log(`APP_PERF_DONE out=${OUT}`);
process.exit(0);
