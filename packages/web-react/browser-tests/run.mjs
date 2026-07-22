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
//   T12 单 Agent 卡和团队队员卡不显示冗余原始记录入口，实际过程仍可见。
//   T13 工具卡头部满足 44px、键盘可展开/折叠，市场长列表可继续加载且移动宽度不溢出。
//   T14 消息反馈弹窗真浏览器焦点陷阱与关闭后焦点归还；
//   T15 活动 turn 中 AskUserQuestion 专用 UI 在移动视口仍可点选并提交。
//
// 跑法:npm run test:browser(web-react 包内);失败截图落 $OC_BROWSER_TEST_ARTIFACTS
// (默认 /tmp)。退出码:0 全过 / 1 断言失败 / 2 环境错误(浏览器缺失等,同样视为门失败)。
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");
const { chromium } = require_("playwright-core");

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = process.env.OC_BROWSER_TEST_ARTIFACTS ?? tmpdir();

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

// 最小 CSS:只放断言依赖的规则。sr-only 与 tailwind 语义一致 —— T4 要用计算样式
// 证明 input 非 display:none(display:none 会让国产内核吞掉激活,tailwind 构建产物
// 不参与本测试,故在此内联同义规则)。
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}
  .chat-scroll-area{overflow-anchor:none}
  .timeline-scroll-probe{height:360px;width:640px;overflow-y:auto;position:relative;border:1px solid #ccc;scrollbar-gutter:stable}
  #timeline-archive-root .chat-virtual-item{min-height:40px}
  #tool-card-polish-root .min-h-11{min-height:2.75rem}
</style></head><body><div id="root"></div><div id="timeline-user-root"></div><div id="timeline-agent-root"></div><div id="timeline-thinking-root"></div><div id="timeline-scroll-root"></div><div id="timeline-archive-root"></div><div id="single-agent-card-root"></div><div id="team-agent-card-root"></div><div id="tool-card-polish-root"></div><div id="feedback-root"></div><div id="ask-question-root"></div><script>${readFileSync(bundlePath, "utf8")}</script></body></html>`;

// ── drive ───────────────────────────────────────────────────────────────────
let browser;
try {
  browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true });
} catch (err) {
  console.error(`browser-tests: 环境错误(浏览器不可用): ${err.message}`);
  process.exit(2);
}

const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));
await page.setContent(html);

let failed = 0;
let caseIndex = 0;
async function check(name, fn) {
  caseIndex += 1;
  try {
    await fn();
    console.log(`ok ${caseIndex} - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok ${caseIndex} - ${name}\n  ${String(err?.message ?? err).replaceAll("\n", "\n  ")}`);
    const shot = join(ARTIFACTS, `browser-test-fail-${caseIndex}.png`);
    try {
      await page.screenshot({ path: shot, fullPage: true });
      console.error(`  screenshot: ${shot}`);
    } catch {}
  }
}

const plusButton = page.getByRole("button", { name: "更多选项" });
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
  await button.click();
  await page.waitForFunction(() => window.__archiveTimeline.mergedPages === 1, null, { timeout: 3000 });
  await page.waitForFunction(() => {
    const button = document.querySelector("#timeline-archive-root [data-testid='history-page-loader'] button");
    return button instanceof HTMLButtonElement && button.getAttribute("aria-busy") === "false";
  }, null, { timeout: 3000 });
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

await check("T12 Agent 卡不显示冗余原始记录入口且真实过程可见", async () => {
  const single = page.locator("#single-agent-card-root");
  await single.getByText("SINGLE_AGENT_CARD").click();
  await single.getByText("SINGLE_AGENT_PROCESS_MARKER").waitFor({ state: "visible", timeout: 3000 });
  if (await single.getByRole("button", { name: "查看原始完整记录" }).count() !== 0) {
    throw new Error("单 Agent 卡仍显示查看原始完整记录");
  }

  const team = page.locator("#team-agent-card-root");
  await team.getByText("团队协作 · 1 个智能体").click();
  await team.getByText("TEAM_AGENT_CARD").click();
  await team.getByText("TEAM_AGENT_PROCESS_MARKER").waitFor({ state: "visible", timeout: 3000 });
  if (await team.getByRole("button", { name: "查看原始完整记录" }).count() !== 0) {
    throw new Error("团队队员卡仍显示查看原始完整记录");
  }

  const tool = page.locator("#timeline-agent-root");
  if (await tool.getByRole("button", { name: "查看原始完整记录" }).count() !== 0) {
    throw new Error("通用 ToolCard 仍显示查看原始完整记录");
  }
});

await check("T13 工具卡触控尺寸、键盘交互、渐进列表与移动宽度", async () => {
  const root = page.locator("#tool-card-polish-root");
  const header = root.getByRole("button", { name: /搜索 AI 市场.*browser.*完成/ });
  await header.waitFor({ state: "visible", timeout: 3000 });
  const box = await header.boundingBox();
  if (!box || box.height < 44) throw new Error(`工具卡头部高度=${box?.height ?? 0}px，应至少 44px`);

  await header.focus();
  await header.press("Enter");
  await root.getByText("浏览器能力 1").waitFor({ state: "visible", timeout: 3000 });
  if (await root.getByText("浏览器能力 9").count() !== 0) throw new Error("市场列表未按需渐进展示");
  await root.getByRole("button", { name: /查看更多/ }).click();
  await root.getByText("浏览器能力 10").waitFor({ state: "visible", timeout: 3000 });

  await header.focus();
  await header.press("Space");
  await root.getByText("浏览器能力 1").waitFor({ state: "hidden", timeout: 3000 });
  const width = await root.evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth }));
  if (width.scroll > width.client) throw new Error(`375px 级工具卡横向溢出:${JSON.stringify(width)}`);
  if (await root.getByText("查看原始完整记录").count() !== 0) {
    throw new Error("美化后的工具卡仍出现原始完整记录文案");
  }
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
  await page.setViewportSize({ width: 390, height: 844 });
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
});

if (pageErrors.length > 0) {
  failed += 1;
  console.error(`not ok - 页面出现未捕获异常:\n  ${pageErrors.join("\n  ")}`);
}

await browser.close();
console.log(failed === 0 ? `browser-tests: ${caseIndex} 全过` : `browser-tests: ${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
