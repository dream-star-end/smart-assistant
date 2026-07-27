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
//   T21 320/390px 最拥挤聊天顶栏不横溢，全部真实控件可达可点；
//   T22 320/390px 落地页移动导航完整、可收起，CTA 与主标题布局正确。
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
const mobileHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${productionCss}</style><style>
  html,body{height:auto;min-height:100%;overflow:auto}
  #root{position:static;height:auto;min-height:100%;overflow:visible}
</style></head><body><div id="root"></div><script>${readFileSync(mobileBundlePath, "utf8")}</script></body></html>`;

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
</style></head><body><div id="root"></div><div id="timeline-user-root"></div><div id="timeline-agent-root"></div><div id="timeline-thinking-root"></div><div id="timeline-scroll-root"></div><div id="timeline-archive-root"></div><div id="single-agent-card-root"></div><div id="team-agent-card-root"></div><div id="tool-card-polish-root"></div><div id="feedback-root"></div><div id="message-quote-root"></div><div id="ask-question-root"></div><script>${readFileSync(bundlePath, "utf8")}</script></body></html>`;

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
const ASSET_MIME = { ".woff2": "font/woff2", ".woff": "font/woff", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
// 组件真实发出的遥测信标(succeeded 级 UX 事件也走这个出口)。harness 没有后端,
// 显式 204 挡掉;不 stub 就会 404 → console.error → 用例被自己的埋点判红。
const STUBBED_ENDPOINTS = new Set(["/api/client-errors"]);
const serveBuiltAsset = (route, request) => {
  const url = new URL(request.url());
  if (url.pathname === "/api/subscription/plans") {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plans: [] }),
    });
  }
  if (STUBBED_ENDPOINTS.has(url.pathname)) {
    return route.fulfill({ status: 204, contentType: "text/plain", body: "" });
  }
  const name = url.pathname.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const file = join(previewCssDir, name);
  if (name && ASSET_MIME[ext] && existsSync(file)) {
    return route.fulfill({ status: 200, contentType: ASSET_MIME[ext], body: readFileSync(file) });
  }
  const publicFile = join(HERE, "..", "public", url.pathname.replace(/^\/+/, ""));
  if (ASSET_MIME[ext] && existsSync(publicFile)) {
    return route.fulfill({ status: 200, contentType: ASSET_MIME[ext], body: readFileSync(publicFile) });
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

const mobileContext = await browser.newContext({
  viewport: { width: 320, height: 844 },
  hasTouch: true,
  isMobile: true,
});
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

async function assertNoHorizontalOverflow(target, label) {
  const width = await target.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  if (width.document > width.viewport || width.body > width.viewport) {
    throw new Error(`${label} 横向溢出:${JSON.stringify(width)}`);
  }
}

async function assertElementNoHorizontalOverflow(locator, label) {
  const width = await locator.evaluate((node) => ({
    client: node.clientWidth,
    scroll: node.scrollWidth,
  }));
  if (width.scroll > width.client) {
    throw new Error(`${label} 内部横向溢出:${JSON.stringify(width)}`);
  }
}

async function assertInsideViewport(locator, width, label) {
  const box = await locator.boundingBox();
  if (!box || box.x < -0.5 || box.x + box.width > width + 0.5) {
    throw new Error(`${label} 不在 ${width}px 可视区内:${JSON.stringify(box)}`);
  }
}

await check("T21 320/390px 最拥挤聊天顶栏不横溢且全部控件可达可点", async () => {
  screenshotPage = mobilePage;
  const controls = [
    { name: "打开菜单", action: "menu" },
    { name: /全能助手/, action: "agent" },
    { name: "打开使用教程", action: "tutorial" },
    { name: "站内信", action: "inbox" },
    { name: "账户与计费", action: "billing" },
    { name: /切换主题/, action: "theme" },
  ];

  for (const width of [320, 390]) {
    await mobilePage.setViewportSize({ width, height: 844 });
    await assertNoHorizontalOverflow(mobilePage, `${width}px 聊天顶栏`);
    const header = mobilePage.getByTestId("crowded-chat-header");
    for (const control of controls) {
      const locator = header.getByRole("button", { name: control.name });
      await locator.waitFor({ state: "visible", timeout: 3000 });
      await assertInsideViewport(locator, width, `${width}px ${String(control.name)}`);
      await locator.click();
      const action = await mobilePage.evaluate(() => document.documentElement.dataset.mobileAction);
      if (action !== control.action) {
        throw new Error(`${String(control.name)} 未触发原回调:${String(action)}`);
      }
    }

    const team = header.getByRole("button", { name: "团队模式已开启" });
    const model = header.getByRole("button", { name: "选择对话模型" });
    await assertInsideViewport(team, width, `${width}px 团队模式`);
    await assertInsideViewport(model, width, `${width}px 模型选择器`);
    await team.click();
    await mobilePage.getByText(/队长引擎为 GPT-5\.6-Sol/).waitFor({ state: "visible", timeout: 3000 });
    await mobilePage.keyboard.press("Escape");
    await model.click();
    await mobilePage.getByRole("menuitem", { name: /GLM-5\.2/ }).waitFor({ state: "visible", timeout: 3000 });
    await mobilePage.keyboard.press("Escape");
    await assertNoHorizontalOverflow(mobilePage, `${width}px 顶栏弹层关闭后`);
  }
});

await check("T22 320/390px 落地页移动导航完整可收起且 CTA 与主标题布局正确", async () => {
  screenshotPage = mobilePage;
  const landing = mobilePage.locator("main > div");
  for (const width of [320, 390]) {
    await mobilePage.setViewportSize({ width, height: 844 });
    await assertNoHorizontalOverflow(mobilePage, `${width}px 落地页`);
    await assertElementNoHorizontalOverflow(landing, `${width}px 落地页根容器`);
    const open = landing.getByRole("button", { name: "打开导航菜单" });
    await open.click();
    const mobileNav = landing.locator("#landing-mobile-nav");
    await mobileNav.waitFor({ state: "visible", timeout: 3000 });
    for (const label of ["演示", "智能体", "快速上手", "企业版", "常见问题"]) {
      await mobileNav.getByRole("link", { name: label, exact: true }).waitFor({ state: "visible", timeout: 3000 });
    }
    await assertNoHorizontalOverflow(mobilePage, `${width}px 展开导航`);
    await assertElementNoHorizontalOverflow(landing, `${width}px 展开导航根容器`);

    await mobileNav.getByRole("link", { name: "智能体", exact: true }).click();
    await mobileNav.waitFor({ state: "detached", timeout: 3000 });

    await landing.getByRole("button", { name: "打开导航菜单" }).click();
    await landing.locator("#landing-mobile-nav").getByRole("button", { name: "登录" }).click();
    const loginAction = await mobilePage.evaluate(() => document.documentElement.dataset.mobileAction);
    if (loginAction !== "login") throw new Error(`移动登录 CTA 未触发:${String(loginAction)}`);
    await mobileNav.waitFor({ state: "detached", timeout: 3000 });

    await landing.getByRole("button", { name: "打开导航菜单" }).click();
    await landing.locator("#landing-mobile-nav").getByRole("button", { name: "免费开始" }).click();
    const startAction = await mobilePage.evaluate(() => document.documentElement.dataset.mobileAction);
    if (startAction !== "start") throw new Error(`移动免费开始 CTA 未触发:${String(startAction)}`);
    await mobileNav.waitFor({ state: "detached", timeout: 3000 });

    const heading = landing.getByRole("heading", { level: 1 });
    const gradient = heading.getByText("拿回能直接用的成果");
    const headingLayout = await heading.evaluate((node) => ({
      fontSize: getComputedStyle(node).fontSize,
      breaks: node.querySelectorAll("br").length,
    }));
    const gradientDisplay = await gradient.evaluate((node) => getComputedStyle(node).display);
    if (headingLayout.breaks !== 0 || gradientDisplay !== "block") {
      throw new Error(`移动主标题仍依赖隐藏换行或渐变句未独占一行:${JSON.stringify({ headingLayout, gradientDisplay })}`);
    }
    if (width === 320 && headingLayout.fontSize !== "36px") {
      throw new Error(`320px 主标题字号不是 36px:${headingLayout.fontSize}`);
    }
    await assertNoHorizontalOverflow(mobilePage, `${width}px CTA 操作后`);
    await assertElementNoHorizontalOverflow(landing, `${width}px CTA 操作后根容器`);
  }
});
screenshotPage = page;

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
