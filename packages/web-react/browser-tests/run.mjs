// CI 组件级真浏览器冒烟(web-react):esbuild bundle 真实 Composer → 真 Chromium
// 受信点击 → 断言用户可感知的交互契约。
//
// 为什么存在(2026-07-18 附件事故的机制化防复发):
//   「点击添加附件无反应」由 Radix select 同步卸载 Portal 杀死 label 原生激活引入,
//   jsdom 测试恒绿假阴性(label 转发查 ownerDocument / fireEvent 非受信不同步 flush)。
//   本文件把"真浏览器受信事件"前置到 CI:凡动 Composer 等高频交互面,合并前必过。
//
// 用例(每条都是曾经/可能的生产回归形态):
//   T1 点「+」→「添加附件」→ filechooser 真实弹出(post-dispatch activation 存活);
//   T2 附件菜单随后正常关闭(preventDefault 不至于让菜单常驻);
//   T3 选文件后 chip 出现且非 error 态(onUpload stub → done);
//   T4 file input 结构红线:type=file / 无 accept / 计算样式非 display:none / tabindex=-1
//      (国产内核约束 61de46e2/de16e2be 的真浏览器断言);
//   T5 惰性 user sidecar 在真 viewport 水合为原文，重试收到同一份精确 payload;
//   T6 惰性 Agent tape record 水合为真实 ToolCard，不显示 locator 替身;
//   T7 点「+」→「设定目标」→ 目标对话框弹出(同菜单的第二入口回归对照)。
//   T8 统一时间线上滑零请求，显式点击只取一页，虚拟 remount 不重取;
//   T9 第二次明确点击继续下一不透明 cursor，已加载真实记录仍常驻;
//   T10 真 Virtuoso 归档前插足够多行后仍锁定点击前的真实可见消息;
//   T11 direct-timeline 思考实时展开、完成自动折叠，受信点击后完整正文恢复。
//   T12 单 Agent 卡/团队队员卡/通用 ToolCard 的可见按钮名单恰好等于白名单(冗余原始
//      记录入口回归即红),实际过程仍可见;
//   T13 工具卡头部满足 44px、键盘可展开/折叠，市场长列表可继续加载且移动宽度不溢出。
//   T14 消息反馈弹窗真浏览器焦点陷阱与关闭后焦点归还；
//   T15 活动 turn 中 AskUserQuestion 专用 UI 在移动视口仍可点选并提交;
//   T16/T17 容器网页预览按访问端自动选择移动/桌面、铺满真实可视区，空闲后收起
//      chrome，且独立“…”入口不会吞掉 iframe 页面交互。
//   T18 消息“引用”动作把精确目标送入 Composer，可取消；再次引用后随当前正文发送。
//   T19 真 IndexedDB 多标签陈旧快照不能抹除或复活 exact pending-dispatch journal;
//   T20 预览用例跑完后主 harness 页面仍完好(防 setContent 摧毁共享页面把后续缺席断言变恒真)。
//   T21 及以后的用例不在此重复罗列 —— 一条用例证明什么,以 cases.json 的 proves 为准
//      (两处各写一份必然漂移;下面那条"单一权威"的规则同样约束本注释)。
//
// 用例清单的单一权威是同目录 cases.json:实际执行的 T 编号集合必须 ⊇ 清单,
// 删/漏一条即红(过去删掉任意一段 check() 照样 exit 0)。新增用例必须同步登记。
//
// 跑法:npm run test:browser(web-react 包内);失败截图落 $OC_BROWSER_TEST_ARTIFACTS
// (默认 /tmp)。退出码:0 全过 / 1 断言失败 / 2 环境错误(浏览器缺失等,同样视为门失败)。
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");
const { chromium } = require_("playwright-core");

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = process.env.OC_BROWSER_TEST_ARTIFACTS ?? tmpdir();

/**
 * 触控靶下限。设计目标是 44px,但**不能拿 44 去严格比较** `boundingBox()` 的返回值:
 * 它是浏览器布局算出的浮点数,2026-07-26 实测同一个 CSS `height: 44px` 的按钮在连续
 * 三次运行中出现过一次 `43.999996185302734`(其余两次是精确 44),严格 `< 44` 因此会偶发
 * 误报,把真浏览器门变成 flaky 门 —— 而 flaky 门最终会被人忽略,等于没有门。
 * 取 43.5 留半像素容差:任何真实不达标的档位(40 / 36 / 32 / 28px)依然拦得住。
 */
const TOUCH_MIN = 43.5;

// ── bundle ──────────────────────────────────────────────────────────────────
const outDir = mkdtempSync(join(tmpdir(), "oc-browser-tests-"));
const bundlePath = join(outDir, "harness.js");
await esbuild.build({
  entryPoints: [join(HERE, "harness.tsx")],
  bundle: true,
  format: "iife",
  outfile: bundlePath,
  jsx: "automatic",
  // MessageRenderer pulls the production Markdown/KaTeX stylesheet graph.
  // This component smoke asserts behavior rather than visual CSS, so keep the
  // real React code while excluding stylesheet/font assets from the IIFE.
  loader: { ".css": "empty" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.MODE": '"production"',
  },
  alias: { "node:crypto": join(HERE, "stubs", "node-crypto.js") },
  logLevel: "silent",
});

const previewBundlePath = join(outDir, "preview-harness.js");
await esbuild.build({
  entryPoints: [join(HERE, "preview-harness.tsx")],
  bundle: true,
  format: "iife",
  outfile: previewBundlePath,
  jsx: "automatic",
  loader: { ".css": "empty" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.MODE": '"production"',
  },
  plugins: [
    {
      name: "container-preview-ready-stub",
      setup(build) {
        build.onResolve({ filter: /useContainerPreview$/ }, () => ({
          path: join(HERE, "stubs", "useContainerPreview.ts"),
        }));
      },
    },
  ],
  alias: { "node:crypto": join(HERE, "stubs", "node-crypto.js") },
  logLevel: "silent",
});

// 移动整页(T25)也要独立页面:主 harness 的脚手架 CSS 盖掉了 #root 的全屏定位与
// body 的 overflow:hidden,在那上面问"整页横向溢出"只会量到别人的挂载根。
const mobileBundlePath = join(outDir, "mobile-harness.js");
await esbuild.build({
  entryPoints: [join(HERE, "mobile-harness.tsx")],
  bundle: true,
  format: "iife",
  outfile: mobileBundlePath,
  jsx: "automatic",
  loader: { ".css": "empty" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.MODE": '"production"',
  },
  alias: { "node:crypto": join(HERE, "stubs", "node-crypto.js") },
  logLevel: "silent",
});
const previewCssDir = join(outDir, "preview-css");
await viteBuild({
  root: join(HERE, ".."),
  configFile: false,
  logLevel: "silent",
  plugins: [tailwindcss()],
  build: {
    outDir: previewCssDir,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: join(HERE, "preview-styles.ts"),
      output: {
        entryFileNames: "preview-styles.js",
        assetFileNames: "preview-styles[extname]",
      },
    },
  },
});
const previewCssFile = readdirSync(previewCssDir).find((name) => name.endsWith(".css"));
if (!previewCssFile) throw new Error("browser-tests: 预览 production CSS 构建失败");
// 单一 CSS 权威:两个 harness 都注入同一份 tailwind + src/styles.css 的 production 产物。
// 手写同义副本已删除 —— 副本让真实规则(.sr-only / .chat-scroll-area{overflow-anchor:none}
// / .min-h-11)被删掉后门依然全绿(2026-07-26 审计实锤:删 styles.css 的
// .chat-scroll-area 规则,T8 照过)。现在 T4/T8/T13 断言的就是线上那份 CSS。
const productionCss = readFileSync(join(previewCssDir, previewCssFile), "utf8");
const previewHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${productionCss}</style></head><body><div id="root"></div><script>${readFileSync(previewBundlePath, "utf8")}</script></body></html>`;
// 移动整页(T25):与线上 index.html 同构 —— 同一份 production CSS、同一条 viewport meta、
// 单一 #root 挂载点,**零测试脚手架样式**(加一条覆盖就等于把被测的布局改掉了)。
const mobileHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${productionCss}</style></head><body><div id="root"></div><script>${readFileSync(mobileBundlePath, "utf8")}</script></body></html>`;

// 主 harness = production CSS + 测试脚手架。脚手架放在 production CSS 之后。
// 唯一被脚手架遮蔽的生产规则是 #root 的全屏 fixed 定位与 body 的 overflow:hidden ——
// 本 harness 把 12 个挂载根平铺在 body 上,而线上 #root{position:fixed;inset:0} 是
// 单挂载点应用壳,会盖住其余全部根节点(点击一律被 #root 拦截)。这两条与被断言的
// 三条真实规则(.sr-only / .chat-scroll-area{overflow-anchor:none} / .min-h-11)
// 无交集,遮蔽范围必须保持最小,新增覆盖前先确认不碰任何被断言的选择器。
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${productionCss}</style><style>
  html,body{margin:0;overflow:auto;height:auto}
  #root{position:static;height:auto;overflow:visible}
  .timeline-scroll-probe{height:360px;width:640px;overflow-y:auto;position:relative;border:1px solid #ccc;scrollbar-gutter:stable}
  #timeline-archive-root .chat-virtual-item{min-height:40px}
</style></head><body><div id="root"></div><div id="timeline-user-root"></div><div id="timeline-agent-root"></div><div id="timeline-thinking-root"></div><div id="timeline-replay-root"></div><div id="timeline-scroll-root"></div><div id="timeline-archive-root"></div><div id="single-agent-card-root"></div><div id="team-agent-card-root"></div><div id="tool-card-polish-root"></div><div id="feedback-root"></div><div id="message-quote-root"></div><div id="ask-question-root"></div><div id="model-selector-root"></div><div id="markdown-rich-root"></div><script>${readFileSync(bundlePath, "utf8")}</script></body></html>`;

// ── drive ───────────────────────────────────────────────────────────────────
let browser;
try {
  browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true });
} catch (err) {
  console.error(`browser-tests: 环境错误(浏览器不可用): ${err.message}`);
  process.exit(2);
}

const page = await browser.newPage();
const DEFAULT_VIEWPORT = page.viewportSize();

// 运行时异常收口:pageerror(未捕获异常/unhandledrejection)与 console.error 同等 fail。
// 只监听 pageerror 会漏掉 React key 警告、Radix a11y 报错、受控/非受控切换、被
// ErrorBoundary 吞掉的渲染异常 —— 那些全部只走 console.error。按用例归属(check()
// 记起止),否则末尾一次性报错定位不到是谁引入的。
const runtimeErrors = [];
let currentCase = "(harness boot)";
function watchRuntimeErrors(target, label) {
  target.on("pageerror", (err) => {
    runtimeErrors.push({ case: currentCase, surface: label, kind: "pageerror", message: String(err) });
  });
  target.on("console", (msg) => {
    if (msg.type() !== "error") return;
    runtimeErrors.push({ case: currentCase, surface: label, kind: "console.error", message: msg.text() });
  });
}
function formatRuntimeErrors(entries) {
  return entries
    .map((e) => `[${e.surface}/${e.kind}] ${e.message}`.replaceAll("\n", "\n    "))
    .join("\n  ");
}
watchRuntimeErrors(page, "main");

const harnessUrl = "http://127.0.0.1/__openclaude_browser_tests__";
// 静态资源自服务:注入的 production CSS 里 @font-face 指向 vite 产物(Inter 变量字体)。
// 不服务它们就会打到 127.0.0.1:80 → ERR_CONNECTION_REFUSED → 被上面的 console.error
// 门判红,而那是 harness 缺资源不是产品缺陷。按 basename 回源到构建目录;**未登记的
// 外部请求一律 404**(不 abort、不放行),让真正的意外外联仍然以 console.error 变红。
const ASSET_MIME = { ".woff2": "font/woff2", ".woff": "font/woff", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
// 组件真实发出的遥测信标(succeeded 级 UX 事件也走这个出口)。harness 没有后端,
// 显式 204 挡掉;不 stub 就会 404 → console.error → 用例被自己的埋点判红。
const STUBBED_ENDPOINTS = new Set(["/api/client-errors"]);
const serveBuiltAsset = (route, request) => {
  const url = new URL(request.url());
  if (STUBBED_ENDPOINTS.has(url.pathname)) {
    return route.fulfill({ status: 204, contentType: "text/plain", body: "" });
  }
  const name = url.pathname.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const file = join(previewCssDir, name);
  if (name && ASSET_MIME[ext] && existsSync(file)) {
    return route.fulfill({ status: 200, contentType: ASSET_MIME[ext], body: readFileSync(file) });
  }
  console.error(`[browser-tests] 未登记的外部请求(已 404): ${request.url()}`);
  return route.fulfill({ status: 404, contentType: "text/plain", body: "not a browser-tests asset" });
};
// 先注册 catch-all,再注册 harness 页:playwright 后注册者优先,harness URL 命中专用处理。
await page.route("**/*", serveBuiltAsset);
await page.route(harnessUrl, (route) => route.fulfill({
  status: 200,
  contentType: "text/html",
  body: html,
}));
await page.goto(harnessUrl);

// 像素锚定用例(T8/T10)用 boundingBox() 取视口坐标做 before/after 比较。点击"加载更早
// 历史"时 playwright 可能顺带滚动**整页**(harness 把 12 个挂载根平铺在 body 上),
// 那 500px 的页面位移会被算进"锚点跳动",与被测的容器内锚定不变量无关 → 假红。
// 这里把文档滚动位置钉回点击前的值再测量,断言语义(≤2px)一字不改。
async function pinPageScroll(target) {
  const before = await target.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
  return async () => {
    await target.evaluate((y) => {
      if (document.scrollingElement) document.scrollingElement.scrollTop = y;
    }, before);
  };
}

// 用例清单门:实际执行的 T 编号集合必须 ⊇ cases.json。删掉任意一段 check() 就变红。
const CASE_MANIFEST = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
if (CASE_MANIFEST.schema !== 1) throw new Error("browser-tests: cases.json schema 必须为 1");
const expectedCaseIds = CASE_MANIFEST.cases.map((c) => c.id);
if (expectedCaseIds.length === 0) throw new Error("browser-tests: cases.json 不得为空");
const executedCaseIds = new Set();

let failed = 0;
let caseIndex = 0;
let reportedErrorCount = 0;
let screenshotPage = page;
async function check(name, fn) {
  caseIndex += 1;
  const id = /^(T\d+)\s/.exec(name)?.[1];
  const problems = [];
  if (!id) problems.push(`用例标题缺少 T 编号前缀(清单门无法归属): ${name}`);
  else if (executedCaseIds.has(id)) problems.push(`用例编号重复: ${id}`);
  else if (!expectedCaseIds.includes(id)) problems.push(`用例 ${id} 不在 cases.json 清单内(新增用例必须同步登记)`);
  if (id) executedCaseIds.add(id);

  currentCase = name;
  const errorsBefore = runtimeErrors.length;
  try {
    await fn();
  } catch (err) {
    problems.push(String(err?.message ?? err));
  }
  const introduced = runtimeErrors.slice(errorsBefore);
  reportedErrorCount = runtimeErrors.length;
  if (introduced.length > 0) {
    problems.push(`本用例期间出现 ${introduced.length} 条运行时错误:\n  ${formatRuntimeErrors(introduced)}`);
  }
  if (problems.length === 0) {
    console.log(`ok ${caseIndex} - ${name}`);
    return;
  }
  failed += 1;
  console.error(`not ok ${caseIndex} - ${name}\n  ${problems.join("\n  ").replaceAll("\n", "\n  ")}`);
  const shot = join(ARTIFACTS, `browser-test-fail-${caseIndex}.png`);
  try {
    await screenshotPage.screenshot({ path: shot, fullPage: true });
    console.error(`  screenshot: ${shot}`);
  } catch {}
}

const primaryComposer = page.locator("#root");
const plusButton = primaryComposer.getByRole("button", { name: "更多选项" });
// DropdownMenuContent renders in a body-level portal. Scope only the trigger
// to the primary composer; the menu item itself must be located from the page.
const attachItem = page.getByText("添加附件");

await check("T1 点「+」→「添加附件」→ filechooser 真实弹出", async () => {
  await plusButton.click();
  await attachItem.waitFor({ state: "visible", timeout: 3000 });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 3000 }),
    attachItem.click(),
  ]);
  const probe = join(outDir, "attach-probe.txt");
  writeFileSync(probe, "browser-tests attach probe\n");
  await chooser.setFiles(probe);
});

await check("T2 附件菜单随后正常关闭(不常驻)", async () => {
  await attachItem.waitFor({ state: "hidden", timeout: 3000 });
});

await check("T3 选文件后 chip 出现且非 error 态(stub 上传 → done)", async () => {
  await page.getByRole("button", { name: "移除 attach-probe.txt" }).waitFor({ state: "visible", timeout: 3000 });
  const retry = await page.getByRole("button", { name: "重试上传 attach-probe.txt" }).count();
  if (retry !== 0) throw new Error("chip 进入了 error 态(出现重试按钮),stub 上传本应 done");
  const uploads = await page.evaluate(() => window.__uploads);
  if (!uploads.includes("attach-probe.txt")) throw new Error(`onUpload 未收到文件: ${JSON.stringify(uploads)}`);
});

await check("T4 file input 结构红线:type=file/无 accept/非 display:none/tabindex=-1", async () => {
  const info = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("label[for]"));
    for (const label of labels) {
      const input = document.getElementById(label.htmlFor);
      if (input instanceof HTMLInputElement && input.type === "file") {
        return {
          hasAccept: input.hasAttribute("accept"),
          display: getComputedStyle(input).display,
          tabIndex: input.tabIndex,
        };
      }
    }
    // 菜单闭合时 label 不在 DOM;input 常驻,退化为直接找 input。
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) return null;
    return {
      hasAccept: input.hasAttribute("accept"),
      display: getComputedStyle(input).display,
      tabIndex: input.tabIndex,
    };
  });
  if (!info) throw new Error("找不到 file input");
  if (info.hasAccept) throw new Error("file input 挂了 accept 白名单(会灰掉国产内核选择器)");
  if (info.display === "none") throw new Error("file input 是 display:none(国产内核会吞掉激活)");
  if (info.tabIndex !== -1) throw new Error(`file input tabindex=${info.tabIndex},应为 -1`);
});

await check("T5 惰性 user sidecar 水合为原文且重试收到精确 payload", async () => {
  const root = page.locator("#timeline-user-root");
  await root.getByText("EXACT_DEFERRED_USER_MARKER").waitFor({ state: "visible", timeout: 3000 });
  await root.getByRole("button", { name: "重试" }).click();
  const state = await page.evaluate(() => window.__lazyTimeline);
  if (state.userFetches !== 1) throw new Error(`user payload fetch 次数=${state.userFetches},应为 1`);
  const expected = JSON.stringify({
    id: "deferred-user-probe",
    text: "EXACT_DEFERRED_USER_MARKER",
    modelText: "EXACT_MODEL_VISIBLE_PROMPT",
    retryFilename: "exact-retry.txt",
  });
  if (JSON.stringify(state.userRetry) !== expected) {
    throw new Error(`重试未收到精确 user payload:${JSON.stringify(state.userRetry)}`);
  }
});

await check("T6 惰性 Agent tape record 水合为真实 ToolCard", async () => {
  const root = page.locator("#timeline-agent-root");
  await root.getByText("终端").waitFor({ state: "visible", timeout: 3000 });
  await root.locator("button").first().click();
  await root.getByText("EXACT_AGENT_PROCESS_MARKER").waitFor({ state: "visible", timeout: 3000 });
  const state = await page.evaluate(() => window.__lazyTimeline);
  if (state.tapeFetches !== 1) throw new Error(`tape payload fetch 次数=${state.tapeFetches},应为 1`);
  const expected = JSON.stringify({
    tapeId: "tape-browser-probe",
    ordinal: 7,
    recordId: "deferred-tool-probe",
    role: "tool",
  });
  if (JSON.stringify(state.tapeFetch) !== expected) {
    throw new Error(`tape payload 定位键漂移:${JSON.stringify(state.tapeFetch)}`);
  }
});

await check("T7 点「+」→「设定目标」→ 目标对话框弹出", async () => {
  await plusButton.click();
  const goalItem = page.getByText("设定目标");
  await goalItem.waitFor({ state: "visible", timeout: 3000 });
  await goalItem.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 3000 });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 3000 });
});

let firstAnchorTop = 0;
async function scrollTimelineDiagnostic(stage) {
  return page.evaluate((currentStage) => {
    const state = window.__scrollTimeline;
    const scroller = document.querySelector("#timeline-scroll-root .timeline-scroll-probe");
    const row = state.anchor
      ? Array.from(document.querySelectorAll("#timeline-scroll-root [data-chat-virtual-key]"))
        .find((candidate) => candidate.getAttribute("data-chat-virtual-key") === state.anchor.key)
      : null;
    const wrapper = row?.closest("[data-index]");
    const button = document.querySelector(
      "#timeline-scroll-root [data-testid='history-page-loader'] button",
    );
    return {
      stage: currentStage,
      calls: [...state.calls],
      mergedPages: state.mergedPages,
      messageCount: state.messageCount,
      loading: state.loading,
      anchor: state.anchor,
      rowMissing: row === null,
      currentDataIndex: wrapper?.getAttribute("data-index") ?? null,
      currentTop: row instanceof HTMLElement && scroller instanceof HTMLElement
        ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        : null,
      scrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : null,
      scrollHeight: scroller instanceof HTMLElement ? scroller.scrollHeight : null,
      buttonAriaBusy: button?.getAttribute("aria-busy") ?? null,
      buttonText: button?.textContent ?? null,
    };
  }, stage);
}
await check("T8 上滑零请求，点击只取一页、像素锚定且 remount 不重取", async () => {
  const root = page.locator("#timeline-scroll-root .timeline-scroll-probe");
  await root.waitFor({ state: "visible", timeout: 3000 });
  const overflowAnchor = await root.evaluate((node) => getComputedStyle(node).overflowAnchor);
  if (overflowAnchor !== "none") {
    throw new Error(`history scroller overflow-anchor=${overflowAnchor},应为 none`);
  }
  await page.evaluate(() => {
    const node = document.querySelector("#timeline-scroll-root .timeline-scroll-probe");
    if (!(node instanceof HTMLElement)) throw new Error("missing scroll probe");
    node.scrollTop = 80;
  });
  await page.waitForTimeout(50);
  const rootBox = await root.boundingBox();
  if (!rootBox) throw new Error("scroll probe has no layout box");
  await root.dispatchEvent("pointerdown", {
    pointerType: "mouse",
    pointerId: 77,
    button: 0,
    buttons: 1,
    clientX: rootBox.x + rootBox.width - 1,
    clientY: rootBox.y + 30,
  });
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerType: "mouse", pointerId: 77 }));
    const node = document.querySelector("#timeline-scroll-root .timeline-scroll-probe");
    if (!(node instanceof HTMLElement)) throw new Error("missing scroll probe");
    node.scrollTop = 0;
  });
  await page.waitForTimeout(180);
  const afterCancel = await page.evaluate(() => window.__scrollTimeline.calls);
  if (afterCancel.length !== 0) {
    throw new Error(`pointercancel 后程序滚动被误判为手势:${JSON.stringify(afterCancel)}`);
  }
  const anchor = root.locator('[data-chat-virtual-key="outer:200:scroll-tail-0"]');
  await anchor.waitFor({ state: "attached", timeout: 3000 });
  const beforeBox = await anchor.boundingBox();
  if (!beforeBox) throw new Error("tail anchor has no layout box before paging");
  firstAnchorTop = beforeBox.y;

  // A complete wheel/inertia burst is navigation only. It must reveal the
  // explicit boundary without admitting any history request.
  await root.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
  });
  await page.waitForTimeout(200);
  const afterInertia = await page.evaluate(() => window.__scrollTimeline.calls);
  if (afterInertia.length !== 0) {
    throw new Error(`上滑错误触发了历史请求:${JSON.stringify(afterInertia)}`);
  }
  const loadButton = root.getByRole("button", { name: "查看更早历史记录" });
  await loadButton.waitFor({ state: "visible", timeout: 3000 });
  const restorePageScrollT8 = await pinPageScroll(page);
  await loadButton.click();
  try {
    await page.waitForFunction(() => window.__scrollTimeline.mergedPages === 1, null, { timeout: 3000 });
  } catch (err) {
    const diagnostic = await scrollTimelineDiagnostic("merged-pages");
    throw new Error(`${err.message}; diagnostic=${JSON.stringify(diagnostic)}`);
  }
  try {
    await page.waitForFunction(() => {
      const button = document.querySelector("#timeline-scroll-root [data-testid='history-page-loader'] button");
      return button instanceof HTMLButtonElement && button.getAttribute("aria-busy") === "false";
    }, null, { timeout: 3000 });
  } catch (err) {
    const diagnostic = await scrollTimelineDiagnostic("loader-idle");
    throw new Error(`${err.message}; diagnostic=${JSON.stringify(diagnostic)}`);
  }
  const afterClick = await page.evaluate(() => window.__scrollTimeline.calls);
  if (JSON.stringify(afterClick) !== JSON.stringify(["cursor-200"])) {
    throw new Error(`单次点击未严格加载一页:${JSON.stringify(afterClick)}`);
  }
  await restorePageScrollT8();
  const afterBox = await anchor.boundingBox();
  if (!afterBox) throw new Error("tail anchor disappeared after older page merge");
  const delta = Math.abs(afterBox.y - firstAnchorTop);
  if (delta > 2) throw new Error(`插页后可见锚点跳动 ${delta.toFixed(2)}px，应 ≤2px`);

  // Force the first latest record out of Virtuoso overscan and back using
  // programmatic scroll only. A remount must never refetch a resident page.
  await page.evaluate(() => {
    const node = document.querySelector("#timeline-scroll-root .timeline-scroll-probe");
    if (!(node instanceof HTMLElement)) throw new Error("missing scroll probe");
    node.scrollTop = node.scrollHeight;
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const node = document.querySelector("#timeline-scroll-root .timeline-scroll-probe");
    if (!(node instanceof HTMLElement)) throw new Error("missing scroll probe");
    node.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => window.__scrollTimeline);
  if (JSON.stringify(state.calls) !== JSON.stringify(["cursor-200"])) {
    throw new Error(`虚拟 remount 重复请求了 cursor:${JSON.stringify(state.calls)}`);
  }
  if (state.messageCount !== 163) {
    throw new Error(`首批记录未常驻:messageCount=${state.messageCount},应为163`);
  }
});

await check("T9 再次上滑仍零请求，第二次点击才继续下一 cursor", async () => {
  const root = page.locator("#timeline-scroll-root .timeline-scroll-probe");
  await root.hover();
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(200);
  const afterWheel = await page.evaluate(() => window.__scrollTimeline.calls);
  if (JSON.stringify(afterWheel) !== JSON.stringify(["cursor-200"])) {
    throw new Error(`第二次上滑错误触发请求:${JSON.stringify(afterWheel)}`);
  }
  await root.getByRole("button", { name: "查看更早历史记录" }).click();
  await page.waitForFunction(() => window.__scrollTimeline.mergedPages === 2, null, { timeout: 3000 });
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => window.__scrollTimeline);
  if (JSON.stringify(state.calls) !== JSON.stringify(["cursor-200", "cursor-100"])) {
    throw new Error(`cursor 顺序/次数错误:${JSON.stringify(state.calls)}`);
  }
  if (state.messageCount !== 227) {
    throw new Error(`第二批合并后真实记录有丢失/替换:messageCount=${state.messageCount},应为227`);
  }
});

await check("T10 归档前插跨出虚拟挂载区仍保持原消息像素位置", async () => {
  const root = page.locator("#timeline-archive-root .timeline-scroll-probe");
  await root.waitFor({ state: "visible", timeout: 3000 });
  await root.evaluate((node) => { node.scrollTop = 0; });
  await page.waitForTimeout(200);
  if ((await page.evaluate(() => window.__archiveTimeline.calls)) !== 0) {
    throw new Error("归档会话滚到顶部时错误自动请求");
  }
  const anchor = root.locator('[data-chat-virtual-key="outer:300:archive-tail-0"]');
  await anchor.waitFor({ state: "attached", timeout: 3000 });
  const beforeBox = await anchor.boundingBox();
  if (!beforeBox) throw new Error("归档前插前缺少可见锚点");
  const button = root.getByTestId("history-page-loader").getByRole("button");
  const restorePageScrollT10 = await pinPageScroll(page);
  await button.click();
  await page.waitForFunction(() => window.__archiveTimeline.mergedPages === 1, null, { timeout: 3000 });
  await page.waitForFunction(() => {
    const button = document.querySelector("#timeline-archive-root [data-testid='history-page-loader'] button");
    return button instanceof HTMLButtonElement && button.getAttribute("aria-busy") === "false";
  }, null, { timeout: 3000 });
  await restorePageScrollT10();
  const afterBox = await anchor.boundingBox();
  if (!afterBox) throw new Error("归档前插 80 行后原锚点被虚拟列表丢失");
  const delta = Math.abs(afterBox.y - beforeBox.y);
  if (delta > 2) throw new Error(`归档前插后可见锚点跳动 ${delta.toFixed(2)}px，应 ≤2px`);
  const state = await page.evaluate(() => window.__archiveTimeline);
  if (state.calls !== 1 || state.messageCount !== 200) {
    throw new Error(`归档单击加载契约错误:${JSON.stringify(state)}`);
  }
});

await check("T11 direct-timeline 思考完成后自动折叠且可完整展开", async () => {
  const root = page.locator("#timeline-thinking-root");
  const body = root.getByText("EXACT_LIVE_TIMELINE_THINKING");
  await body.waitFor({ state: "visible", timeout: 3000 });
  await root.getByRole("button", { name: "思考过程" }).waitFor({ state: "visible", timeout: 3000 });

  await page.evaluate(() => window.__completeTimelineThinking());

  await body.waitFor({ state: "hidden", timeout: 3000 });
  const completed = root.getByRole("button", { name: /已思考/ });
  await completed.waitFor({ state: "visible", timeout: 3000 });
  await completed.click();
  await body.waitFor({ state: "visible", timeout: 3000 });
});

// 卡片可见按钮的**正向**结构不变量。
// 过去这里是 `getByRole('button', { name: '查看原始完整记录' }).count() === 0` 的缺席断言:
// 那条文案早已从产品里删干净(2026-07-26 核实 packages/web-react/src 只剩测试文件提到它),
// 断言恒真;文案一改名就更是四条同时静默失效。改成"卡内可见按钮名单恰好等于白名单":
// 冗余入口回归 → 名单多出一项 → 红;入口改名重现 → 同样多出一项 → 红。
async function visibleButtonNames(scopeSelector) {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) throw new Error(`缺少挂载根 ${selector}`);
    return Array.from(scope.querySelectorAll("button"))
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").replace(/\s+/g, " ").trim());
  }, scopeSelector);
}
async function assertVisibleButtonSet(scopeSelector, expected, label) {
  const actual = await visibleButtonNames(scopeSelector);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} 可见按钮名单漂移:实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
  }
}

await check("T12 Agent 卡按钮名单恰好为白名单(无冗余原始记录入口)且真实过程可见", async () => {
  const single = page.locator("#single-agent-card-root");
  await single.getByText("SINGLE_AGENT_CARD").click();
  await single.getByText("SINGLE_AGENT_PROCESS_MARKER").waitFor({ state: "visible", timeout: 3000 });
  await assertVisibleButtonSet("#single-agent-card-root", ["SINGLE_AGENT_CARD完成"], "单 Agent 卡");

  const team = page.locator("#team-agent-card-root");
  await team.getByText("团队协作 · 1 个智能体").click();
  await team.getByText("TEAM_AGENT_CARD").click();
  await team.getByText("TEAM_AGENT_PROCESS_MARKER").waitFor({ state: "visible", timeout: 3000 });
  await assertVisibleButtonSet(
    "#team-agent-card-root",
    ["团队协作 · 1 个智能体✓ 1 完成", "TEAM_AGENT_CARDTEAM_AGENT_GOAL完成"],
    "团队队员卡",
  );

  await assertVisibleButtonSet("#timeline-agent-root", ["终端printf exact完成"], "通用 ToolCard");
});

await check("T13 工具卡触控尺寸、键盘交互、渐进列表与移动宽度", async () => {
  const root = page.locator("#tool-card-polish-root");
  const header = root.getByRole("button", { name: /搜索 AI 市场.*browser.*完成/ });
  await header.waitFor({ state: "visible", timeout: 3000 });
  const box = await header.boundingBox();
  if (!box || box.height < TOUCH_MIN) throw new Error(`工具卡头部高度=${box?.height ?? 0}px，应至少 44px`);

  // exact:true 是必需的:子串匹配下"浏览器能力 1"在展开到 10 条后会同时命中
  // "浏览器能力 10",触发 strict mode violation = 假红。
  await header.focus();
  await header.press("Enter");
  await root.getByText("浏览器能力 1", { exact: true }).waitFor({ state: "visible", timeout: 3000 });
  if (await root.getByText("浏览器能力 9", { exact: true }).count() !== 0) {
    throw new Error("市场列表未按需渐进展示");
  }
  await root.getByRole("button", { name: /查看更多/ }).click();
  await root.getByText("浏览器能力 10", { exact: true }).waitFor({ state: "visible", timeout: 3000 });

  await header.focus();
  await header.press("Space");
  await root.getByText("浏览器能力 1", { exact: true }).waitFor({ state: "hidden", timeout: 3000 });
  const width = await root.evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth }));
  if (width.scroll > width.client) throw new Error(`375px 级工具卡横向溢出:${JSON.stringify(width)}`);
  // 折叠态按钮名单恰好只剩卡头(同 T12:正向名单代替恒真的文案缺席断言)。
  await assertVisibleButtonSet("#tool-card-polish-root", ["搜索 AI 市场browser完成"], "美化后的工具卡");
});

await check("T14 消息反馈弹窗关闭后把焦点还给原消息动作", async () => {
  const trigger = page.getByRole("button", { name: "打开消息反馈" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "反馈这条回复" });
  await dialog.waitFor({ state: "visible", timeout: 3000 });
  if (!(await page.getByLabel("附上以上回复摘录，帮助定位问题").isChecked())) {
    throw new Error("当前回复摘录未以用户可见勾选态呈现");
  }
  await dialog.getByRole("button", { name: "关闭" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 3000 });
  const focused = await trigger.evaluate((node) => document.activeElement === node);
  if (!focused) throw new Error("关闭反馈弹窗后焦点没有归还原消息动作");
});

await check("T15 活动 turn 中专用 Ask UI 在移动端可点选并提交", async () => {
  // 移动视口是本用例的局部条件,必须还原:主 harness 页面被后续用例复用,
  // 遗留 390×844 会静默改变别人的布局/像素断言语义。
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await runAskQuestionMobileCase();
  } finally {
    if (DEFAULT_VIEWPORT) await page.setViewportSize(DEFAULT_VIEWPORT).catch(() => {});
  }
});

async function runAskQuestionMobileCase() {
  await page.evaluate(() => window.__mountAskQuestion());
  const dialog = page.getByRole("dialog", { name: "用户问答" });
  await dialog.waitFor({ state: "visible", timeout: 3000 });
  await dialog.getByRole("button", { name: /仿古画卷2\.5D/ }).click();
  await dialog.getByRole("button", { name: "提交" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 3000 });
  const responses = await page.evaluate(() => window.__askQuestion.responses);
  if (responses.length !== 1) {
    throw new Error(`Ask UI 回调次数=${responses.length},应为 1`);
  }
  const response = responses[0];
  const expected = {
    requestId: "ask-active-r1",
    behavior: "allow",
    updatedInput: {
      questions: [
        {
          header: "画面风格",
          question: "画面风格选哪种?",
          multiSelect: false,
          options: [
            { label: "仿古画卷2.5D", description: "推荐，接近原画美感" },
            { label: "全3D低多边形", description: "偏现代游戏风格" },
          ],
        },
      ],
      answers: { "画面风格选哪种?": "仿古画卷2.5D" },
    },
  };
  if (JSON.stringify(response) !== JSON.stringify(expected)) {
    throw new Error(`Ask UI 回传漂移:${JSON.stringify(response)}`);
  }
}

await check("T18 点助手“引用”→预览可取消→再次引用后随正文发送", async () => {
  const root = page.locator("#message-quote-root");
  const quote = root.getByRole("button", { name: "引用" });
  await quote.click();
  await root.getByText("正在引用 OpenClaude").waitFor({ state: "visible", timeout: 3000 });
  await root.getByText("这是需要被引用的完整回答").last().waitFor({ state: "visible", timeout: 3000 });
  await root.getByRole("button", { name: "取消引用" }).click();
  if (await root.getByText("正在引用 OpenClaude").count()) {
    throw new Error("取消后引用预览仍存在");
  }
  await quote.click();
  const composer = root.getByPlaceholder("给 OpenClaude 发消息…");
  await composer.fill("请重点解释这一段");
  await root.getByRole("button", { name: "发送" }).click();
  const sends = await page.evaluate(() => window.__messageQuote.sends);
  const expected = [{
    text: "请重点解释这一段",
    replyTo: {
      messageId: "assistant-quote-probe",
      role: "assistant",
      text: "这是需要被引用的完整回答",
    },
  }];
  if (JSON.stringify(sends) !== JSON.stringify(expected)) {
    throw new Error(`引用发送参数不完整:${JSON.stringify(sends)}`);
  }
});

await check("T19 真 IndexedDB 多标签陈旧快照不抹除/复活发送日志", async () => {
  const result = await page.evaluate(() => window.__runPendingDispatchJournalProbe());
  if (!result.survivedStaleWrite) {
    throw new Error("陈旧 whole-session 写入抹除了 exact pending-dispatch journal");
  }
  if (!result.resistedResurrection) {
    throw new Error("已 ACK 删除的 exact pending-dispatch 被陈旧快照复活");
  }
});

// ── T21 真 WS 帧 replay ────────────────────────────────────────────────────────
// 断言的是**用户可见事实**:一轮真实帧进来,时间线上该出现几条、什么顺序、工具卡里
// 是不是那条真命令与真输出、思考卡是不是实时展开而终态自动折叠、终态有没有清掉发送态。
// 中间任何一层(帧解析 / reducer 归并键 / 虚拟条目键 / 卡片分派)漂了都会红。
const replayRoot = page.locator("#timeline-replay-root");
// 断言常量的单一权威是 fixtures/turnReplay.ts(TS,进 harness bundle);run.mjs 从页面
// 读回,避免同一批标记在 .mjs 里再写一份副本(副本一旦漂移,门就变成自说自话)。
const replayFixture = await page.evaluate(() => window.__replayFixture);
const replayMarkers = replayFixture.markers;
const EXPECTED_TIMELINE_ROLES = replayFixture.expectedRoles;

/** 轮询而非 sleep:只放宽"什么时候读",不放宽"读到什么"。 */
async function waitForReplay(predicate, describe, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await page.evaluate(() => ({
      sending: window.__replay.sending,
      rows: window.__replay.rows,
      keys: Array.from(
        document.querySelectorAll("#timeline-replay-root [data-chat-virtual-key]"),
      ).map((node) => node.getAttribute("data-chat-virtual-key")),
    }));
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`${describe};最后一次观测=${JSON.stringify(last)}`);
    }
    await page.waitForTimeout(25);
  }
}

await check("T21 真 WS 帧驱动真时间线:条目顺序、工具卡内容、思考折叠、终态清发送", async () => {
  const cmid = await page.evaluate(() => window.__replayDrive.openTurn());
  if (typeof cmid !== "string" || !cmid.startsWith("m-")) {
    throw new Error(`真实发送未铸出 clientMessageId: ${JSON.stringify(cmid)}`);
  }
  // 乐观 user 行先落地,且 socket 认为该会话正在等响应。
  await waitForReplay(
    (s) => s.rows.length === 1 && s.rows[0].role === "user" && s.sending,
    "真实发送后没有出现唯一一条 user 行 + 发送态",
  );
  await replayRoot.getByText(replayMarkers.userText).waitFor({ state: "visible", timeout: 3000 });

  // ① thinking 帧:实时思考正文可见(live 展开),这是 #158 折叠回归的正向对照。
  await page.evaluate(() => window.__replayDrive.pushNextFrame());
  await replayRoot.getByText(replayMarkers.thinking).waitFor({ state: "visible", timeout: 3000 });

  // ② 其余帧(tool_use → tool_output_tail → tool_result → 正文两段 delta → isFinal)。
  const pushed = await page.evaluate(() => window.__replayDrive.pushRemainingFrames());
  const total = await page.evaluate(() => window.__replayDrive.frameCount());
  if (pushed !== total) throw new Error(`帧未全部推入: ${pushed}/${total}`);

  // 终态:发送态清掉(isFinal 被消化),时间线恰好四条真实记录且顺序正确。
  const settled = await waitForReplay(
    (s) => !s.sending && s.rows.length === 4,
    "终帧到达后没有收敛为 4 条时间线记录 + 非发送态",
  );
  const roles = settled.rows.map((r) => r.role);
  if (JSON.stringify(roles) !== JSON.stringify(EXPECTED_TIMELINE_ROLES)) {
    throw new Error(`时间线条目顺序漂移: ${JSON.stringify(roles)}`);
  }
  // 虚拟列表实际挂载的条目键必须与逻辑行一一对应(条目键漂移=虚拟列表重复/丢行)。
  if (settled.keys.length !== settled.rows.length) {
    throw new Error(
      `虚拟条目数(${settled.keys.length})与逻辑行数(${settled.rows.length})不一致: ${JSON.stringify(settled.keys)}`,
    );
  }

  // 工具卡:头部直出 wire 携带的真命令;展开后是 wire 携带的真输出(不是 stub 替身)。
  await replayRoot.getByText(replayMarkers.toolCommand).first().waitFor({ state: "visible", timeout: 3000 });
  const toolRowKey = settled.rows.find((r) => r.role === "tool")?.id;
  if (!toolRowKey) throw new Error("时间线里没有 tool 行");
  const toolCard = replayRoot
    .locator("[data-chat-virtual-key]")
    .filter({ hasText: replayMarkers.toolCommand })
    .first();
  await toolCard.locator("button").first().click();
  await toolCard.getByText(replayMarkers.toolOutput).waitFor({ state: "visible", timeout: 3000 });

  // assistant 终态正文:两段 delta 必须拼成同一条回答(而不是裂成两行)。
  await replayRoot.getByText(replayMarkers.answerHead).waitFor({ state: "visible", timeout: 3000 });
  await replayRoot.getByText(replayMarkers.answerTail).waitFor({ state: "visible", timeout: 3000 });
  const assistantRows = settled.rows.filter((r) => r.role === "assistant");
  if (assistantRows.length !== 1) {
    throw new Error(`两段 text delta 没有合并成单条 assistant 行: ${assistantRows.length} 条`);
  }

  // 思考卡:终态自动折叠(正文隐藏),受信点击后完整正文恢复。
  const thinkingBody = replayRoot.getByText(replayMarkers.thinking);
  await thinkingBody.waitFor({ state: "hidden", timeout: 3000 });
  const thinkingHeader = replayRoot.getByRole("button", { name: /思考|已思考/ }).first();
  await thinkingHeader.waitFor({ state: "visible", timeout: 3000 });
  await thinkingHeader.click();
  await thinkingBody.waitFor({ state: "visible", timeout: 3000 });
});

// ── T22 Enter / Shift+Enter / 中文 IME ────────────────────────────────────────
// jsdom 里合成 KeyboardEvent 不带组合态(isComposing 物理恒 false),所以
// `!e.nativeEvent.isComposing` 这道守卫在单测里等于不存在:删掉它单测照绿,而线上
// 中文用户选词按回车就会误发半截草稿。这里用 CDP Input.imeSetComposition 造真实组合态。
await check("T22 Enter 发送 / Shift+Enter 换行 / IME 组合中回车不误发", async () => {
  const composer = primaryComposer.getByPlaceholder("给 OpenClaude 发消息…");
  await composer.waitFor({ state: "visible", timeout: 3000 });
  const sendCount = async () => (await page.evaluate(() => window.__sends)).length;
  const value = () => composer.inputValue();
  const before = await sendCount();

  // ① Shift+Enter = 换行,绝不发送。
  await composer.click();
  await composer.fill("");
  await page.keyboard.type("第一段");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("第二段");
  if (await sendCount() !== before) throw new Error("Shift+Enter 误发了消息");
  if (await value() !== "第一段\n第二段") {
    throw new Error(`Shift+Enter 没有插入换行: ${JSON.stringify(await value())}`);
  }

  // ② 中文 IME 组合中:回车是"确认候选词",绝不能发送。
  const cdp = await page.context().newCDPSession(page);
  try {
    await composer.fill("");
    await cdp.send("Input.imeSetComposition", {
      text: "zhongwen",
      selectionStart: 8,
      selectionEnd: 8,
    });
    const composingValue = await value();
    if (!composingValue.includes("zhongwen")) {
      throw new Error(`未进入真实 IME 组合态: ${JSON.stringify(composingValue)}`);
    }
    await page.keyboard.press("Enter");
    if (await sendCount() !== before) {
      throw new Error("IME 组合过程中按回车把半截草稿发出去了(isComposing 守卫失效)");
    }
    // 组合结束(选词落定)→ 提交组合文本,退出组合态。
    await cdp.send("Input.insertText", { text: "中文候选" });
    await cdp.send("Input.imeSetComposition", { text: "", selectionStart: -1, selectionEnd: -1 });
  } finally {
    await cdp.detach().catch(() => {});
  }

  // ③ 组合结束后 Enter 正常发送,且载荷文本精确。
  await composer.fill("组合已结束可以发送");
  await page.keyboard.press("Enter");
  const sends = await page.evaluate(() => window.__sends);
  if (sends.length !== before + 1) {
    throw new Error(`组合结束后的 Enter 未发送(或多发): ${sends.length - before} 次`);
  }
  if (sends[sends.length - 1].text !== "组合已结束可以发送") {
    throw new Error(`发送载荷文本不精确: ${JSON.stringify(sends[sends.length - 1])}`);
  }
  if (await value() !== "") throw new Error("发送后草稿未清空");
});

// ── T23 会话内切模型 ─────────────────────────────────────────────────────────
// 用户可见事实:点顶栏模型名 → 菜单弹出 → 点另一个模型 → 真的切过去(菜单关闭、
// 顶栏显示新模型、上层收到精确 model id);标了「暂不可用」的模型点不动、也不会被
// 静默切过去。前半段守的是 2026-07-18 附件事故那一类(Radix 菜单项受信点击的
// post-dispatch 副作用被同步卸载杀死),jsdom 的 fireEvent 走不出这条真实序列。
await check("T23 顶栏切模型:受信点选生效并回显,降级模型点不动", async () => {
  const fixture = await page.evaluate(() => window.__modelFixture);
  const { markers, ids } = fixture;
  const modelRoot = page.locator("#model-selector-root");
  const trigger = modelRoot.getByRole("button", { name: "选择对话模型" });
  await trigger.waitFor({ state: "visible", timeout: 3000 });
  if (!(await trigger.textContent())?.includes(markers.current)) {
    throw new Error(`触发器未显示当前模型: ${JSON.stringify(await trigger.textContent())}`);
  }

  // ① 受信点击展开:三个候选都在,降级项带「暂不可用」徽记(用户看得见为什么不能选)。
  await trigger.click();
  const targetItem = page.getByRole("menuitem", { name: new RegExp(markers.target) });
  const degradedItem = page.getByRole("menuitem", { name: new RegExp(markers.degraded) });
  await targetItem.waitFor({ state: "visible", timeout: 3000 });
  await degradedItem.waitFor({ state: "visible", timeout: 3000 });
  if (!(await degradedItem.textContent())?.includes("暂不可用")) {
    throw new Error("降级模型没有「暂不可用」徽记(用户无从判断为何选不了)");
  }

  // ② 点另一个模型:上层收到精确 id、菜单关闭、触发器回显新模型。
  //    这三件事都是 select 之后才发生的副作用 —— 菜单项在派发中被卸载就会全丢。
  await targetItem.click();
  await targetItem.waitFor({ state: "hidden", timeout: 3000 });
  const picks = await page.evaluate(() => window.__modelPicks);
  if (JSON.stringify(picks) !== JSON.stringify([ids.target])) {
    throw new Error(`onSelect 收到的 model id 不精确: ${JSON.stringify(picks)}`);
  }
  const afterLabel = await trigger.textContent();
  if (!afterLabel?.includes(markers.target)) {
    throw new Error(`切换后触发器仍未回显新模型: ${JSON.stringify(afterLabel)}`);
  }

  // ③ 降级模型:真浏览器里点不动(生产 CSS data-[disabled]:pointer-events-none),
  //    受信点击落在菜单容器上 → 不切模型、也不误关菜单。
  await trigger.click();
  await degradedItem.waitFor({ state: "visible", timeout: 3000 });
  const degradedState = await degradedItem.evaluate((el) => ({
    ariaDisabled: el.getAttribute("aria-disabled"),
    pointerEvents: getComputedStyle(el).pointerEvents,
  }));
  if (degradedState.ariaDisabled !== "true") {
    throw new Error("降级模型未对读屏/键盘用户暴露 aria-disabled");
  }
  if (degradedState.pointerEvents !== "none") {
    throw new Error(`降级模型仍可接收指针事件: pointer-events=${degradedState.pointerEvents}`);
  }
  const box = await degradedItem.boundingBox();
  if (!box) throw new Error("降级模型不可见");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const picksAfter = await page.evaluate(() => window.__modelPicks);
  if (picksAfter.length !== picks.length) {
    throw new Error(`点降级模型把会话切过去了: ${JSON.stringify(picksAfter)}`);
  }
  await degradedItem.waitFor({ state: "visible", timeout: 1000 });
  await page.keyboard.press("Escape");
  await degradedItem.waitFor({ state: "hidden", timeout: 3000 });
  if (!(await trigger.textContent())?.includes(markers.target)) {
    throw new Error("降级项交互后触发器显示的模型被改掉了");
  }
});

// ── T24 markdown 富块:mermaid ────────────────────────────────────────────────
// 助手回复几乎全部经 markdown,而 ```mermaid 是 MarkdownImpl 里一条完全独立的分支
// (dynamic import → parse → render → dangerouslySetInnerHTML),此前零测试。
// jsdom 没有 SVG 布局,画不出也量不了 —— 只有真浏览器能证明"图真的出来了"。
await check("T24 mermaid 有效语法真出 SVG、半截语法回退可读源码不白屏", async () => {
  const ok = page.getByTestId("mermaid-ok");
  const broken = page.getByTestId("mermaid-broken");

  // ① 有效图:等到真 <svg> 落地(动态 import mermaid + render 是异步的,轮询等落定)。
  const svg = ok.locator("svg");
  await svg.waitFor({ state: "attached", timeout: 20000 });
  const okState = await ok.evaluate((el) => {
    const node = el.querySelector("svg");
    const rect = node?.getBoundingClientRect();
    return {
      text: (el.textContent ?? "").trim(),
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      svgText: node?.textContent ?? "",
    };
  });
  if (okState.text.includes("图表渲染中")) throw new Error("有效 mermaid 仍卡在渲染中占位");
  if (okState.width < 10 || okState.height < 10) {
    throw new Error(`mermaid SVG 没有真实尺寸: ${okState.width}×${okState.height}(用户看到的是空白框)`);
  }
  // 出的是这张图,不是随便一个 <svg>(节点文案来自源码)。
  if (!okState.svgText.includes("MERMAIDOKSTART") || !okState.svgText.includes("MERMAIDOKEND")) {
    throw new Error(`mermaid 出的图不含源码里的节点: ${JSON.stringify(okState.svgText.slice(0, 120))}`);
  }

  // ② 半截/无效语法:回退成可读源码,不留占位、不白屏。
  await broken.locator("pre").waitFor({ state: "visible", timeout: 20000 });
  const brokenState = await broken.evaluate((el) => ({
    text: (el.textContent ?? "").trim(),
    pre: el.querySelector("pre")?.textContent ?? "",
    svgs: el.querySelectorAll("svg").length,
  }));
  if (brokenState.text.includes("图表渲染中")) throw new Error("无效 mermaid 永远停在渲染中占位");
  if (!brokenState.pre.includes("MERMAIDBROKENSOURCE")) {
    throw new Error(`无效 mermaid 未回退出原始源码: ${JSON.stringify(brokenState.pre.slice(0, 120))}`);
  }
  if (brokenState.svgs !== 0) throw new Error("无效 mermaid 仍渲染了图(应只回退源码)");

  // ③ 富块不许往 <body> 顶层塞节点。mermaid 对坏输入调 render 会把 "Syntax error"
  //    图挂到 body 上并残留(用户看到一个飘在页面上的红叉图),生产代码靠先 parse 挡住。
  //    这里不认 mermaid 的内部命名(实现细节,换版本就漂),只认"body 顶层多出了不属于
  //    harness 挂载点的东西"—— 实测:摘掉 parse 守卫,这里就多出一个 div#dmmdrj。
  const strays = await page.evaluate(() =>
    Array.from(document.body.children)
      .filter((el) => el.tagName !== "SCRIPT" && el.id !== "root" && !el.id.endsWith("-root"))
      .map((el) => `${el.tagName.toLowerCase()}#${el.id || "(no-id)"}`),
  );
  if (strays.length > 0) {
    throw new Error(`markdown 富块把节点注入了 <body> 顶层: ${JSON.stringify(strays)}`);
  }
});

async function assertContainerPreviewFillsViewport(page, expectedDevice, width, height, top = 0) {
  const dialog = page.getByRole("dialog", { name: "容器网页预览与元素评论" });
  await dialog.waitFor({ state: "visible", timeout: 3000 });
  const active = dialog.getByRole("button", { name: `${expectedDevice}预览` });
  if ((await active.getAttribute("aria-pressed")) !== "true") {
    throw new Error(`访问端未自动选择${expectedDevice}预览`);
  }
  const viewport = dialog.getByTestId("container-preview-viewport");
  const box = await viewport.boundingBox();
  if (!box) throw new Error("容器预览没有可测量画布");
  if (
    Math.abs(box.x) > 1 ||
    Math.abs(box.y - top) > 1 ||
    Math.abs(box.width - width) > 1 ||
    Math.abs(box.height - height) > 1
  ) {
    throw new Error(`容器预览未铺满:${JSON.stringify(box)}，期望 0,${top} ${width}×${height}`);
  }
  if ((await viewport.getAttribute("data-fullscreen")) !== "true") {
    throw new Error("匹配访问端的预览未进入 fullscreen 布局");
  }
  const overflow = await dialog.evaluate((node) => {
    const shell = node.querySelector(".preview-shell");
    return {
      dialog: node.scrollWidth > node.clientWidth,
      shell: shell instanceof HTMLElement && shell.scrollWidth > shell.clientWidth,
    };
  });
  if (overflow.dialog || overflow.shell) {
    throw new Error(`全屏预览自身产生横向溢出:${JSON.stringify(overflow)}`);
  }

  const reveal = dialog.getByRole("button", { name: "显示预览控制" });
  await reveal.waitFor({ state: "visible", timeout: 4500 });
  if (await dialog.getByRole("button", { name: "关闭网页预览" }).count()) {
    throw new Error("空闲后顶部控制栏仍在遮挡预览");
  }
  if (await dialog.getByRole("button", { name: "评论" }).count()) {
    throw new Error("空闲后底部工具栏仍在遮挡预览");
  }

  const revealBox = await reveal.boundingBox();
  if (
    !revealBox ||
    revealBox.width < TOUCH_MIN ||
    revealBox.height < TOUCH_MIN ||
    revealBox.x < 0 ||
    revealBox.y < top ||
    revealBox.x + revealBox.width > width + 1 ||
    revealBox.y + revealBox.height > top + height + 1
  ) {
    throw new Error(`控制唤醒按钮尺寸或安全区位置不合格:${JSON.stringify(revealBox)}`);
  }

  const previewFrame = dialog.frameLocator("iframe");
  await previewFrame.getByRole("button", { name: "预览页面测试按钮" }).click();
  if ((await previewFrame.locator("body").getAttribute("data-clicked")) !== "true") {
    throw new Error("收起控件后 iframe 页面没有收到真实点击");
  }
  if (await dialog.getByRole("button", { name: "关闭网页预览" }).count()) {
    throw new Error("点击预览页面意外展开了控制栏");
  }

  await reveal.click();
  const closeBox = await dialog.getByRole("button", { name: "关闭网页预览" }).boundingBox();
  if (!closeBox || closeBox.width < TOUCH_MIN || closeBox.height < TOUCH_MIN) {
    throw new Error(`恢复后的关闭控件触控尺寸不足:${JSON.stringify(closeBox)}`);
  }
  await dialog.getByRole("button", { name: `${expectedDevice}预览` }).waitFor({
    state: "visible",
    timeout: 1000,
  });
  await dialog.getByRole("button", { name: "评论" }).waitFor({
    state: "visible",
    timeout: 1000,
  });
}

// 预览用例过去用 page.setContent() 就地摧毁主 harness 页面(#root 与全部
// timeline 根节点随之消失),之后任何依赖主 harness 的新用例都会静默失效 ——
// 在空页面上做"缺席断言"更是恒真。改成独立 context/page,主 harness 保持完好。
const previewContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const previewPage = await previewContext.newPage();
watchRuntimeErrors(previewPage, "preview");
// 走同一个 http 源(而不是 setContent + about:blank),字体/遥测才能命中与主 harness
// 相同的 stub 路由;否则相对 URL 在 about:blank 下直接抛错,又变成 console.error 噪声。
const previewUrl = "http://127.0.0.1/__openclaude_browser_preview__";
await previewPage.route("**/*", serveBuiltAsset);
await previewPage.route(previewUrl, (route) => route.fulfill({
  status: 200,
  contentType: "text/html",
  body: previewHtml,
}));
await previewPage.goto(previewUrl);

await check("T16 移动全屏预览空闲收起控件且不吞页面触控", async () => {
  screenshotPage = previewPage;
  await previewPage.setViewportSize({ width: 390, height: 844 });
  await previewPage.evaluate(() => {
    document.documentElement.style.setProperty("--oc-visual-offset-top", "24px");
    document.documentElement.style.setProperty("--oc-visual-height", "780px");
    window.__mountContainerPreview();
  });
  await assertContainerPreviewFillsViewport(previewPage, "移动", 390, 780, 24);
  await previewPage.evaluate(() => window.__unmountContainerPreview());
});

await check("T17 PC 全屏预览空闲收起控件且可按需恢复", async () => {
  screenshotPage = previewPage;
  await previewPage.setViewportSize({ width: 1440, height: 900 });
  await previewPage.evaluate(() => {
    document.documentElement.style.removeProperty("--oc-visual-offset-top");
    document.documentElement.style.removeProperty("--oc-visual-height");
    window.__mountContainerPreview();
  });
  await assertContainerPreviewFillsViewport(previewPage, "桌面", 1440, 900);
  await previewPage.evaluate(() => window.__unmountContainerPreview());
});

// ── T25 移动整页布局 ─────────────────────────────────────────────────────────
// 已有的移动覆盖(T13 工具卡 375px / T15 Ask UI / T16 预览)都是单组件,整页的
// 顶栏拥挤与正文横向溢出**没人看**。而聊天滚动区是 overflow-x-hidden:超出视口的
// 内容不是"可以滑过去看",是**直接被裁掉、用户永远看不到**。
const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mobilePage = await mobileContext.newPage();
watchRuntimeErrors(mobilePage, "mobile");
const mobileUrl = "http://127.0.0.1/__openclaude_browser_mobile__";
await mobilePage.route("**/*", serveBuiltAsset);
await mobilePage.route(mobileUrl, (route) => route.fulfill({
  status: 200,
  contentType: "text/html",
  body: mobileHtml,
}));
await mobilePage.goto(mobileUrl);

await check("T25 390×844 整页:顶栏入口不被挤出、宽正文不被裁、发送区可用", async () => {
  screenshotPage = mobilePage;
  const scroll = mobilePage.getByTestId("mobile-chat-scroll");
  await scroll.waitFor({ state: "visible", timeout: 5000 });
  // 正文渲染完(markdown 懒块 + 工具卡)再量几何:轮询只改"什么时候读",不放宽"读到什么"。
  await mobilePage.getByText("MOBILE_ASSISTANT_TAIL_MARKER").waitFor({ state: "visible", timeout: 10000 });

  // ① 整页不产生横向滚动(线上 body/#root 都是 overflow:hidden,这里量的是布局本身)。
  const pageWidth = await mobilePage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (pageWidth.scrollWidth > pageWidth.clientWidth + 1) {
    throw new Error(`整页横向溢出: scrollWidth=${pageWidth.scrollWidth} > clientWidth=${pageWidth.clientWidth}`);
  }

  // ② 聊天区里超出视口的内容必须落在自己的横向滚动区内(那是"能滑着看完"),
  //    否则就是被 overflow-x-hidden 裁掉的不可达内容。
  const clipped = await mobilePage.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scroller = document.querySelector('[data-testid="mobile-chat-scroll"]');
    if (!scroller) return { error: "找不到聊天滚动区" };
    const scrollable = (el) => {
      const ox = getComputedStyle(el).overflowX;
      return ox === "auto" || ox === "scroll";
    };
    const offenders = [];
    for (const el of scroller.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.left >= -1 && r.right <= vw + 1) continue;
      // 自己或某层祖先是显式横向滚动区,且该滚动区本身在视口内 → 用户滑得到,放行。
      let host = el;
      let reachable = false;
      while (host && host !== scroller) {
        if (scrollable(host)) {
          const hr = host.getBoundingClientRect();
          if (hr.left >= -1 && hr.right <= vw + 1) {
            reachable = true;
            break;
          }
        }
        host = host.parentElement;
      }
      if (reachable) continue;
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 80),
        left: Math.round(r.left),
        right: Math.round(r.right),
        text: (el.textContent ?? "").trim().slice(0, 60),
      });
    }
    return { vw, count: offenders.length, sample: offenders.slice(0, 4) };
  });
  if (clipped.error) throw new Error(clipped.error);
  if (clipped.count > 0) {
    throw new Error(
      `聊天区有 ${clipped.count} 处内容溢出视口且不在横向滚动区内(移动端被裁掉看不见): ` +
        JSON.stringify(clipped.sample),
    );
  }

  // ③ 顶栏四个入口全在视口内(挤爆时最先被推出去的就是右侧主题/铃铛)。
  const headerEntries = [
    ["打开菜单", "汉堡(唯一的移动侧栏入口)"],
    ["站内信", "站内信"],
    ["账户与计费", "余额"],
    ["选择对话模型", "模型选择器"],
  ];
  for (const [label, human] of headerEntries) {
    const box = await mobilePage.getByRole("button", { name: label }).boundingBox();
    if (!box) throw new Error(`顶栏「${human}」不可见`);
    if (box.x < 0 || box.x + box.width > 390 + 1) {
      throw new Error(`顶栏「${human}」被挤出视口: x=${Math.round(box.x)} w=${Math.round(box.width)}`);
    }
  }

  // ④ 三个关键入口真的按得动(受信点击 + 可观测结果),不是"渲染出来就算"。
  await mobilePage.getByRole("button", { name: "打开菜单" }).click();
  if ((await mobilePage.evaluate(() => window.__mobilePage.navOpens)) !== 1) {
    throw new Error("移动端汉堡点了没反应(侧栏抽屉打不开)");
  }
  await mobilePage.getByRole("button", { name: "更多选项" }).click();
  const attach = mobilePage.getByRole("menuitem", { name: "添加附件" });
  await attach.waitFor({ state: "visible", timeout: 3000 });
  await mobilePage.keyboard.press("Escape");
  await attach.waitFor({ state: "hidden", timeout: 3000 });

  const box = await mobilePage.getByRole("textbox").boundingBox();
  if (!box) throw new Error("输入框不可见");
  await mobilePage.getByRole("textbox").fill("MOBILE_SEND_MARKER");
  const send = mobilePage.getByRole("button", { name: "发送" });
  const sendBox = await send.boundingBox();
  if (!sendBox) throw new Error("发送按钮不可见");
  if (sendBox.x + sendBox.width > 390 + 1) {
    throw new Error(`发送按钮被挤出视口: right=${Math.round(sendBox.x + sendBox.width)}`);
  }
  await send.click();
  const sends = await mobilePage.evaluate(() => window.__mobilePage.sends);
  if (JSON.stringify(sends) !== JSON.stringify([{ text: "MOBILE_SEND_MARKER", mediaCount: 0 }])) {
    throw new Error(`移动端发送结果漂移: ${JSON.stringify(sends)}`);
  }
});
screenshotPage = page;

// 主 harness 仍在:预览用例没有把它换成空页面(否则后续缺席断言全部恒真)。
await check("T20 预览用例结束后主 harness 页面未被摧毁", async () => {
  const alive = await page.evaluate(() => ({
    root: Boolean(document.querySelector("#root")),
    roots: document.querySelectorAll("[id$='-root']").length,
  }));
  if (!alive.root) throw new Error("主 harness #root 已消失(预览用例摧毁了共享页面)");
  if (alive.roots < 10) throw new Error(`主 harness 挂载根节点只剩 ${alive.roots} 个,应 ≥10`);
});

const missingCases = expectedCaseIds.filter((id) => !executedCaseIds.has(id));
if (missingCases.length > 0) {
  failed += 1;
  console.error(
    `not ok - 用例清单门:cases.json 声明的用例未执行 → ${missingCases.join(", ")}` +
      "\n  (删用例必须同步改 packages/web-react/browser-tests/cases.json)",
  );
}

// 用例区间之外(harness 启动、用例间隙)出现的运行时错误同样 fail,不许漏网。
const tailErrors = runtimeErrors.slice(reportedErrorCount);
if (tailErrors.length > 0) {
  failed += 1;
  console.error(`not ok - 用例区间之外出现运行时错误:\n  ${formatRuntimeErrors(tailErrors)}`);
}

await previewContext.close();
await mobileContext.close();
await browser.close();
console.log(
  failed === 0
    ? `browser-tests: ${caseIndex} 全过(清单 ${expectedCaseIds.length} 条全部执行)`
    : `browser-tests: ${failed} 个失败`,
);
process.exit(failed === 0 ? 0 : 1);
