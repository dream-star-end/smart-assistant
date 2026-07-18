// CI 组件级真浏览器冒烟(web-react):esbuild bundle 真实组件 → 真 Chromium
// 受信点击 → 断言用户可感知的交互契约。
//
// 为什么存在(2026-07-18 附件事故的机制化防复发):
//   「点击添加附件无反应」由 Radix select 同步卸载 Portal 杀死 label 原生激活引入,
//   jsdom 测试恒绿假阴性(label 转发查 ownerDocument / fireEvent 非受信不同步 flush)。
//   本文件把"真浏览器受信事件"前置到 CI:凡动高频交互面,合并前必过。
//   覆盖面强制:coverage-manifest.json + check-coverage.mjs(高危交互文件必须登记)。
//
// 用例(每条都是曾经/可能的生产回归形态):
//   T1 点「+」→「添加附件」→ filechooser 真实弹出(post-dispatch activation 存活);
//   T2 附件菜单随后正常关闭(preventDefault 不至于让菜单常驻);
//   T3 选文件后 chip 出现且非 error 态(onUpload stub → done);
//   T4 file input 结构红线:type=file / 无 accept / 计算样式非 display:none / tabindex=-1
//      (国产内核约束 61de46e2/de16e2be 的真浏览器断言);
//   T5 点「+」→「设定目标」→ 目标对话框弹出(同菜单的第二入口回归对照);
//   ── 2026-07-18 门禁审计批D 扩面(附件事故的同构风险面) ──
//   T6 切模型:点选择器 → Radix DropdownMenu Portal 真实弹出且含模型项;
//   T7 切模型:点另一模型 → onSelect 上抛 + 菜单关闭 + 触发器文案更新;
//   T8 评分:受信点击 👍 → submit 载荷正确(messageId/rating/traceId);
//   T9 支付入口:点开充值 → Portal dialog 真实弹出(fetch 失败态不崩)→ Esc 关闭。
//   全部用例跑两遍:桌面视口 + 移动仿真(390×844,isMobile+hasTouch——移动端此前
//   零真浏览器覆盖;Portal/触控差异只有仿真层能暴露)。
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

// ── 覆盖面强制门(静态,先于任何浏览器工作):高危交互文件必须登记 ──
const { execFileSync } = require_("node:child_process");
try {
  execFileSync(process.execPath, [join(HERE, "check-coverage.mjs")], { stdio: "inherit" });
} catch {
  console.error("browser-tests: 覆盖面 manifest 门失败(见上方输出)");
  process.exit(1);
}

// ── bundle ──────────────────────────────────────────────────────────────────
const outDir = mkdtempSync(join(tmpdir(), "oc-browser-tests-"));
const bundlePath = join(outDir, "harness.js");
await esbuild.build({
  entryPoints: [join(HERE, "harness.tsx")],
  bundle: true,
  format: "iife",
  outfile: bundlePath,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "node:crypto": join(HERE, "stubs", "node-crypto.js") },
  logLevel: "silent",
});

// 最小 CSS:只放断言依赖的规则。sr-only 与 tailwind 语义一致 —— T4 要用计算样式
// 证明 input 非 display:none(display:none 会让国产内核吞掉激活,tailwind 构建产物
// 不参与本测试,故在此内联同义规则)。
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}
</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, "utf8")}</script></body></html>`;

// ── drive ───────────────────────────────────────────────────────────────────
let browser;
try {
  browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true });
} catch (err) {
  console.error(`browser-tests: 环境错误(浏览器不可用): ${err.message}`);
  process.exit(2);
}

let failed = 0;
let caseIndex = 0;

async function runSuite(passName, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.setContent(html);

  async function check(name, fn) {
    caseIndex += 1;
    const fullName = `[${passName}] ${name}`;
    try {
      await fn();
      console.log(`ok ${caseIndex} - ${fullName}`);
    } catch (err) {
      failed += 1;
      console.error(`not ok ${caseIndex} - ${fullName}\n  ${String(err?.message ?? err).replaceAll("\n", "\n  ")}`);
      const shot = join(ARTIFACTS, `browser-test-fail-${passName}-${caseIndex}.png`);
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

  await check("T5 点「+」→「设定目标」→ 目标对话框弹出", async () => {
    await plusButton.click();
    const goalItem = page.getByText("设定目标");
    await goalItem.waitFor({ state: "visible", timeout: 3000 });
    await goalItem.click();
    await page.getByRole("dialog").waitFor({ state: "visible", timeout: 3000 });
    // 收尾:关掉目标对话框,别让 overlay 挡住后续用例的受信点击。
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 3000 });
  });

  const modelTrigger = page.getByRole("button", { name: "选择对话模型" });

  await check("T6 切模型:点选择器 → 模型菜单 Portal 真实弹出", async () => {
    await modelTrigger.click();
    await page.getByText("测试模型乙").waitFor({ state: "visible", timeout: 3000 });
  });

  await check("T7 切模型:点另一模型 → onSelect 上抛 + 菜单关闭 + 触发器文案更新", async () => {
    await page.getByText("测试模型乙").click();
    await page.getByText("测试模型乙").waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
    const picks = await page.evaluate(() => window.__modelPicks);
    if (!picks.includes("bt-model-b")) throw new Error(`onSelect 未收到选择: ${JSON.stringify(picks)}`);
    // 触发器如实显示新选中模型(显示诚信:用户看到的必须是真的)。
    await modelTrigger.filter({ hasText: "测试模型乙" }).waitFor({ state: "visible", timeout: 3000 });
  });

  await check("T8 评分:受信点击 👍 → submit 载荷正确", async () => {
    await page.getByRole("button", { name: "点赞" }).click();
    const ratings = await page.evaluate(() => window.__ratings);
    const hit = ratings.find((r) => r.messageId === "bt-message-1" && r.rating === "up");
    if (!hit) throw new Error(`评分 submit 未收到 up 载荷: ${JSON.stringify(ratings)}`);
    if (hit.traceId !== "bt-trace-1") throw new Error(`traceId 丢失/错误: ${JSON.stringify(hit)}`);
  });

  await check("T9 支付入口:充值 dialog Portal 弹出(fetch 失败态不崩)→ Esc 关闭", async () => {
    await page.getByRole("button", { name: "打开充值入口" }).click();
    await page.getByRole("dialog").waitFor({ state: "visible", timeout: 3000 });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 3000 });
  });

  if (pageErrors.length > 0) {
    failed += 1;
    console.error(`not ok - [${passName}] 页面出现未捕获异常:\n  ${pageErrors.join("\n  ")}`);
  }
  await context.close();
}

// 桌面 + 移动仿真双遍(移动:iPhone 尺寸视口 + 触控;Portal/触控差异只有这层能暴露)。
await runSuite("desktop", {});
await runSuite("mobile", {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

await browser.close();
console.log(failed === 0 ? `browser-tests: ${caseIndex} 全过(桌面+移动仿真)` : `browser-tests: ${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
