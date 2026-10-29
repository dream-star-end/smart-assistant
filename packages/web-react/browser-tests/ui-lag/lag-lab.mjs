// #1240 page-wide lag during long runs: the real App against the OCV5-265 WebSocket fixture, a sidebar with
// `sessions` sessions and a session with `turns` finished turns, then one long team-style run (`steps` steps of
// streamed thinking, streamed tool input, tool result, stage text, one quiet gap) and a streamed final answer.
// A stub React DevTools hook counts commits and which components rendered, and attributes each render to its
// update root (the state/context owner that started it) and to a page section.
//
// CLI (profiling tool, not a test): node browser-tests/ui-lag/lag-lab.mjs
//   Env: OUT, PERF_VP (desktop|mobile), PERF_STEPS (15), PERF_TURNS (30), PERF_SESSIONS (120), PERF_PROFILE=1
//   (CPU self time per function), PERF_JSON=<file>. Mobile runs with 4x CPU throttling.
// Reports commits/renders (total, per frame, by component, by root, by section), renders of each process
// disclosure instance, renders during the quiet gap, long tasks, and event timing while typing during the run.
// The regression budget lives in ../ui-lag.node-test.mjs.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../../scripts/lib/resolve-browser.mjs";
import { startPreviewServer } from "../process-disclosure-app-server.mjs";

const require_ = createRequire(import.meta.url);
const { build } = require_("esbuild");
const { chromium } = require_("playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const BT = dirname(HERE);
const QUIET_MS = 2500;

/** Production bundle of the real App + Tailwind CSS into `work`. */
export async function buildLagApp(work) {
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
  writeFileSync(join(work, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
  rmSync(cssDir, { recursive: true, force: true });
}

const para = "这是一段较长的说明文字，用来模拟模型的正常输出，包含 **加粗**、`行内代码` 和 [链接](https://example.com)。".repeat(3);
const ANSWER = [para, `| 列1 | 列2 |\n|---|---|\n${Array.from({ length: 12 }, (_, i) => `| ${i} | 值 ${i} |`).join("\n")}`, para].join("\n\n");
const THINK = "先看看需求里的约束，再决定下一步要调用哪个工具，注意不要重复读取同一个文件。".repeat(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function history(turns) {
  const out = [];
  const t0 = Date.now() - turns * 60_000;
  for (let i = 0; i < turns; i++) {
    const u = `perf-u${i}`;
    const ts = t0 + i * 60_000;
    out.push({ id: u, role: "user", text: `历史问题 ${i}`, status: "replied", ts });
    out.push({ id: `perf-bash${i}`, role: "tool", text: "终端", toolName: "Bash", inputJson: { command: `echo ${i}` },
      _completed: true, output: `${i}`, _clientMessageId: u, ts: ts + 5_000 });
    out.push({ id: `perf-a${i}`, role: "assistant", _clientMessageId: u, ts: ts + 20_000,
      text: `${para}\n\n- 列表项一\n- 列表项二`, usage: { costCredits: "3", totalTokens: 420, inputTokens: 280, outputTokens: 140 } });
  }
  return out.map((m, k) => ({ ...m, _source: "server", _orderSeq: 100 + k, _seq: 100 + k, _timelineRecord: true,
    _timelineUnitKey: `unit:${100 + k}:${m.id}`, ...(m._clientMessageId ? { _turnOwnerId: m._clientMessageId } : {}) }));
}

/** Fixture server whose turns are one long team-style run. `run` carries per-measurement hooks. */
export async function startLagServer(work, sessions) {
  const run = { steps: 15, marks: null, done: null };
  async function longRun(send, store, sessId, clientMessageId, text, nextSeq) {
    const base = { type: "outbound.message", sessionKey: `agent:main:webchat:dm:${sessId}`, channel: "webchat",
      peer: { id: sessId, kind: "dm" }, clientMessageId, isFinal: false };
    const emit = (blocks) => send({ ...base, frameSeq: nextSeq(sessId), ts: Date.now(), blocks });
    let frames = 0;
    const frame = async (blocks, gap) => { emit(blocks); frames++; await sleep(gap); };
    for (let s = 0; s < run.steps; s++) {
      const think = `think-${clientMessageId}-${s}`;
      for (let i = 0; i < THINK.length; i += 12) await frame([{ kind: "thinking", text: THINK.slice(i, i + 12), messageId: think }], 40);
      const tool = `tool-${clientMessageId}-${s}`;
      const name = s % 4 === 3 ? "Task" : s % 2 ? "Read" : "Bash";
      const input = name === "Task" ? { description: `子任务 ${s}`, prompt: "查一下京都的交通和住宿安排，给出三套方案".repeat(2) }
        : name === "Read" ? { file_path: `/workspace/notes/day-${s}.md` } : { command: `python3 plan.py --day ${s} --verbose && ls -la out/` };
      const json = JSON.stringify(input);
      for (let i = 0; i < json.length; i += 16) {
        await frame([{ kind: "tool_use", blockId: tool, toolName: name, messageId: tool, partial: true,
          partialJsonDelta: json.slice(i, i + 16), partialJsonOffset: i }], 30);
      }
      await frame([{ kind: "tool_use", blockId: tool, toolName: name, messageId: tool, partial: false, inputJson: input }], 60);
      await frame([{ kind: "tool_result", blockId: `${tool}:result`, toolUseBlockId: tool, toolName: name, isError: false,
        output: `step ${s} ok\n${"输出行\n".repeat(20)}` }], 60);
      await frame([{ kind: "text", text: `第 ${s + 1} 步完成，继续。`, messageId: `stage-${clientMessageId}-${s}` }], 40);
      if (s === 2) {
        // Quiet window: the run is open but nothing arrives (the tester's "正在思考下一步").
        await run.marks?.quietStart();
        await sleep(QUIET_MS);
        await run.marks?.quietEnd();
      } else {
        await sleep(250);
      }
    }
    const mid = `answer-${clientMessageId}`;
    for (let i = 0; i < ANSWER.length; i += 40) await frame([{ kind: "text", text: ANSWER.slice(i, i + 40), messageId: mid }], 16);
    const seq = store.board.length + 100;
    store.board.push(
      { id: clientMessageId, role: "user", text, status: "replied", ts: Date.now(), _source: "server", _orderSeq: seq, _seq: seq, _timelineRecord: true, _timelineUnitKey: `unit:${seq}:${clientMessageId}` },
      { id: mid, role: "assistant", text: ANSWER, ts: Date.now(), _clientMessageId: clientMessageId, _turnOwnerId: clientMessageId, _source: "server", _orderSeq: seq + 1, _seq: seq + 1, _timelineRecord: true, _timelineUnitKey: `unit:${seq + 1}:${mid}` },
    );
    store.revision += 1;
    send({ ...base, frameSeq: nextSeq(sessId), ts: Date.now(), blocks: [], isFinal: true });
    run.done?.(frames + 1);
  }
  const preview = await startPreviewServer(work, { playTurn: longRun });
  const now = Date.now();
  preview.store.extraSessions = Array.from({ length: sessions }, (_, i) => ({
    id: `webperf${String(i).padStart(4, "0")}`, agentId: "main", title: `历史会话 ${i} · 京都行程与预算`, pinned: false,
    createdAt: now - (i + 2) * 3_600_000, lastAt: now - (i + 1) * 3_600_000, updatedAt: now - (i + 1) * 3_600_000,
    messageCount: 12, modelId: "glm-5.2" }));
  return { preview, run };
}

// Stub DevTools hook: React calls onCommitFiberRoot after every commit. A fiber rendered in this commit when it was
// cloned for this render (its parent's subtree was entered: parent.child !== parent.alternate.child) and has
// PerformedWork. An update root is a rendered component whose nearest component ancestor did not render.
function installHook() {
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const SECTIONS = new Set(["Sidebar", "SessionRow", "MessageList", "Composer", "ChatHeader", "ProcessDisclosure", "MessageRenderer", "TurnActivity"]);
  const nameOf = (f) => {
    const t = f.type;
    if (!t) return "?";
    return t.displayName || t.name || t.type?.displayName || t.type?.name || t.render?.displayName || t.render?.name || "anon";
  };
  const stats = { on: false, commits: 0, renders: 0, by: {}, roots: {}, sections: {}, pd: {}, quiet: null, quietDone: null };
  window.__lag = stats;
  let section = "App-other";
  const visit = (fiber, mounting, parentRendered, path) => {
    let total = 0;
    for (let f = fiber; f; f = f.sibling) {
      const fresh = mounting || !f.alternate;
      const isComp = COMPONENT_TAGS.has(f.tag);
      const rendered = isComp && (fresh || (f.flags & 1) === 1);
      const name = isComp ? nameOf(f) : null;
      const childPath = isComp && name !== "anon" ? `${path.split(">").slice(-2).join(">")}>${name}` : path;
      const prevSection = section;
      if (isComp && SECTIONS.has(name)) section = name;
      let sub = 0;
      if (fresh) sub = visit(f.child, true, rendered || (parentRendered && !isComp), childPath);
      else if (f.child !== f.alternate.child) sub = visit(f.child, false, isComp ? rendered : parentRendered, childPath);
      if (rendered) {
        const sec = (stats.sections[section] ??= { n: 0, top: {} });
        sec.n++; sec.top[name] = (sec.top[name] ?? 0) + 1;
        if (name === "ProcessDisclosure") {
          const k = `active=${f.memoizedProps?.active} first=${f.memoizedProps?.sections?.[0]?.key ?? "?"}`;
          stats.pd[k] = (stats.pd[k] ?? 0) + 1;
        }
      }
      section = prevSection;
      if (rendered) {
        stats.renders++;
        stats.by[name] = (stats.by[name] ?? 0) + 1;
        if (stats.quiet) stats.quiet.renders++;
        if (!parentRendered) {
          const r = (stats.roots[childPath] ??= { n: 0, sub: 0 });
          r.n++; r.sub += sub + 1;
        }
      }
      total += sub + (rendered ? 1 : 0);
    }
    return total;
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject() { return 1; }, checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      if (!stats.on) return;
      stats.commits++;
      if (stats.quiet) stats.quiet.commits++;
      const cur = root.current;
      if (cur.alternate && cur.child === cur.alternate.child) return;
      visit(cur.child, !cur.alternate, false, "root");
    },
  };
}

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, mobile: false },
  mobile: { viewport: { width: 390, height: 844 }, mobile: true },
};

/** One long run in a fresh context. Returns the measurement summary. */
export async function measureRun(browser, { preview, run }, { vp = "desktop", steps = 15, turns = 30, throttle, profile = false, shot } = {}) {
  const { viewport, mobile } = VIEWPORTS[vp];
  run.steps = steps;
  preview.store.board = history(turns);
  preview.store.older = [];
  preview.store.revision += 1;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  try {
    await ctx.addInitScript(() => { localStorage.setItem("oc_auth_hint", "1"); localStorage.setItem("oc_theme", "light"); });
    await ctx.addInitScript(installHook);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
    page.setDefaultTimeout(60_000);
    await page.goto(preview.url, { waitUntil: "domcontentloaded" });
    await page.getByText(`历史问题 ${turns - 1}`).waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes("未连接"));
    await page.waitForTimeout(2500);
    const m = { vp, steps, turns };
    const box = page.getByPlaceholder(/对话/);
    const center = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const tap = (at) => (mobile ? page.touchscreen.tap(at.x, at.y) : page.mouse.click(at.x, at.y));
    if (throttle ?? mobile) { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); }
    await page.evaluate(() => {
      const w = window;
      w.__perf = { lt: [], events: [] };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.lt.push(e.duration); }).observe({ type: "longtask" });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.events.push({ name: e.name, d: e.duration, delay: e.processingStart - e.startTime }); })
        .observe({ type: "event", durationThreshold: 16 });
    });
    await box.click();
    await box.fill("帮我规划京都五日行程（团队模式）");
    const sendAt = await center(page.getByRole("button", { name: "发送" }));
    const boxAt = await center(box);
    let quietResolve;
    const quietDone = new Promise((r) => { quietResolve = r; });
    run.marks = {
      quietStart: () => page.evaluate(() => { window.__lag.quiet = { commits: 0, renders: 0 }; }),
      quietEnd: () => page.evaluate(() => { window.__lag.quietDone = window.__lag.quiet; window.__lag.quiet = null; }).then(quietResolve),
    };
    const done = new Promise((r) => { run.done = r; });
    let prof = null;
    if (profile) {
      prof = await ctx.newCDPSession(page);
      await prof.send("Profiler.enable");
      await prof.send("Profiler.setSamplingInterval", { interval: 500 });
      await prof.send("Profiler.start");
    }
    await page.evaluate(() => { window.__lag.on = true; });
    const t0 = Date.now();
    await tap(sendAt);
    await quietDone;
    // Type while the run streams: keystroke cost when the page is busy.
    await tap(boxAt);
    await page.keyboard.type("继续追问一下细节", { delay: 120 });
    m.frames = await done;
    m.runMs = Date.now() - t0;
    await page.waitForTimeout(1500);
    Object.assign(m, await page.evaluate(() => {
      const s = window.__lag; s.on = false;
      const p = window.__perf;
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const keys = p.events.filter((e) => /key|input|beforeinput|pointer|click|touch/.test(e.name));
      return {
        commits: s.commits, renders: s.renders, quiet: s.quietDone, by: s.by, pd: s.pd,
        roots: Object.entries(s.roots).sort((a, b) => b[1].sub - a[1].sub).slice(0, 20),
        sections: Object.fromEntries(Object.entries(s.sections).map(([k, v]) => [k, { n: v.n, top: Object.entries(v.top).sort((a, b) => b[1] - a[1]).slice(0, 8) }])),
        longTasks: p.lt.length, longTaskTotalMs: Math.round(sum(p.lt)), longTaskMaxMs: Math.round(Math.max(0, ...p.lt)),
        slowEvents: keys.length, eventMaxMs: Math.round(Math.max(0, ...keys.map((e) => e.d))),
        eventDelayMaxMs: Math.round(Math.max(0, ...keys.map((e) => e.delay))),
      };
    }));
    if (prof) {
      const { profile: cpu } = await prof.send("Profiler.stop");
      const dt = new Map();
      for (let i = 0; i < cpu.samples.length; i++) dt.set(cpu.samples[i], (dt.get(cpu.samples[i]) ?? 0) + (cpu.timeDeltas[i] ?? 0));
      const self = {};
      for (const n of cpu.nodes) {
        const us = dt.get(n.id) ?? 0;
        if (!us) continue;
        const cf = n.callFrame;
        const k = `${cf.functionName || "(anon)"} ${(cf.url || "").split("/").pop() || "(native)"}:${cf.lineNumber + 1}`;
        self[k] = (self[k] ?? 0) + us / 1000;
      }
      m.cpuSelfTop = Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Math.round(v)]);
    }
    m.rendersPerFrame = Math.round((m.renders / m.frames) * 10) / 10;
    m.composerValue = await box.inputValue();
    m.errors = errors;
    if (shot) await page.screenshot({ path: shot });
    return m;
  } finally {
    run.marks = null;
    run.done = null;
    await ctx.close();
  }
}

export function launchBrowser() {
  return chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const OUT = process.env.OUT ?? join(tmpdir(), "ui-lag-1240");
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "ui-lag-1240-"));
  process.on("exit", () => rmSync(work, { recursive: true, force: true }));
  await buildLagApp(work);
  const lab = await startLagServer(work, Number(process.env.PERF_SESSIONS ?? 120));
  const browser = await launchBrowser();
  const results = [];
  for (const vp of Object.keys(VIEWPORTS)) {
    if (process.env.PERF_VP && process.env.PERF_VP !== vp) continue;
    const m = await measureRun(browser, lab, {
      vp, steps: Number(process.env.PERF_STEPS ?? 15), turns: Number(process.env.PERF_TURNS ?? 30),
      profile: process.env.PERF_PROFILE === "1", shot: join(OUT, `run-lag-${vp}.png`),
    });
    const { by, ...summary } = m;
    console.log(JSON.stringify({ ...summary, top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12) }));
    results.push(m);
  }
  writeFileSync(process.env.PERF_JSON ?? join(OUT, "run-lag.json"), JSON.stringify(results, null, 1));
  await browser.close();
  lab.preview.server.close();
  console.log(`RUN_LAG_DONE out=${OUT}`);
  process.exit(0);
}
