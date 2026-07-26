// v5 部署 smoke:真浏览器用户旅程 canary(E2E journey gate)。
//
// 背景(2026-07-18 附件事故):「点击添加附件无反应」的回归上线约 20 小时才被用户
// 报障 —— turn canary 只覆盖 WS 契约,健康端点不点 UI,前端交互层是自动化盲区,
// 用户成了人肉 canary。本脚本用真 Chromium(受信事件)走一遍核心用户旅程,作为
// 部署后的 UI 层验收门:
//   J1 登录表单形态断言(widget 必须在 + turnstile_bypass 必须 false)+ API 登录种 cookie
//      (2026-07-26 安全整改:全局旁路改账号级白名单,widget 对 headless 出交互挑战解不了,
//       故登录本体走 API;表单形态仍被断言,反而多了一条'旁路被偷偷打开'的活体探针)
//   J2 附件全链:「+」菜单 → 添加附件 → filechooser 真实弹出 → 真实上传 → chip done
//   J3 目标全链:「+」菜单 → 创建目标 → active 可见 → 清除并恢复未设置
//   J4 带附件发送:消息上屏 + 附件区清空
//   J5 送达硬断言:失败签名零容忍 + 助手回复完成且最终正文含附件秘密探针
//      (2026-07-18 受理竞态事故裁定:乐观上屏≠送达 —— 旧 J4 只断言上屏,新会话首发
//      必挂的回归穿门而过;WS smoke turn 走的不是 UI 发送路径,盖不住这一层。J5 等一轮
//      真回复,与 smoke turn 的等待窗有意冗余 —— 两者路径不同,冗余即覆盖)
//
// 运行形态:在**部署发起机**(本机)执行,自建 ssh 隧道访问 kl-mirror 的 master 端口
// (kl-mirror 无浏览器;隧道由本进程 spawn/回收,libuv 不继承部署锁 fd,不会占住
// /var/lock/oc-v5-deploy.lock)。浏览器解析见 scripts/lib/resolve-browser.mjs。
//
// 失败语义(第一期,2026-07-18 裁定):fail-loud 非零退出 = 部署判定失败,但**不进
// 自动回滚链** —— UI 断言存在文案/选择器漂移的假阳性面,自动整 release 回滚代价
// 不对称;跑稳(连续两周零假阳性)后再升级进 validation_failure 链。V5_SMOKE_E2E=0
// 显式豁免(紧急场景;默认必跑)。
//
// 环境变量:
//   V5_E2E_SSH_HOST(默认 kl-mirror)  V5_E2E_REMOTE_PORT(默认 18790)
//   V5_CANARY_EMAIL(默认 v5-canary@claudeai.chat)
//   V5_CANARY_PASSWORD_FILE(默认 /root/.secrets/v5-canary.password,经 ssh 读远端 —— 单一权威在 kl-mirror)
//   OC_E2E_BROWSER(浏览器路径覆盖)  OC_E2E_ARTIFACTS(失败截图目录,默认 /tmp)
// 退出码:0=旅程全过;1=断言失败;2=环境错误(浏览器/隧道/凭据)。两者都算门失败,
// 错误信息区分排查方向。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(join(HERE, "..", "package.json"));
const { chromium } = require_("playwright-core");

const SSH_HOST = process.env.V5_E2E_SSH_HOST ?? "kl-mirror";
const REMOTE_PORT = Number(process.env.V5_E2E_REMOTE_PORT ?? 18790);
const EMAIL = process.env.V5_CANARY_EMAIL ?? "v5-canary@claudeai.chat";
const PASSWORD_FILE = process.env.V5_CANARY_PASSWORD_FILE ?? "/root/.secrets/v5-canary.password";
const ARTIFACTS = process.env.OC_E2E_ARTIFACTS ?? tmpdir();
const STEP_TIMEOUT = 20_000;
/** J5 等一轮真回复的上限(journey 在 smoke-turn 之后跑,模型链路已证健康;宽限防偶发慢轮误杀)。 */
const TURN_WAIT_TIMEOUT = 120_000;

function fatal(code, msg) {
  console.error(`e2e-journey: ${msg}`);
  process.exit(code);
}

// ── 凭据(单一权威在 kl-mirror,不落本机副本)──────────────────────────────
let password;
try {
  password = execFileSync("ssh", [SSH_HOST, `cat ${PASSWORD_FILE}`], { encoding: "utf8" }).trim();
} catch (err) {
  fatal(2, `无法读取 canary 密码(ssh ${SSH_HOST} cat ${PASSWORD_FILE}): ${err.message}`);
}
if (!password) fatal(2, "canary 密码为空");

// ── ssh 隧道(本进程管理,退出必回收)─────────────────────────────────────
async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const localPort = await freePort();
const tunnel = spawn(
  "ssh",
  ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-L", `${localPort}:127.0.0.1:${REMOTE_PORT}`, SSH_HOST],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let tunnelStderr = "";
tunnel.stderr.on("data", (d) => (tunnelStderr += d));
const cleanupTunnel = () => {
  try {
    tunnel.kill("SIGTERM");
  } catch {}
};
process.on("exit", cleanupTunnel);

async function waitPort(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (tunnel.exitCode !== null) {
      fatal(2, `ssh 隧道进程提前退出(code=${tunnel.exitCode}): ${tunnelStderr.slice(0, 300)}`);
    }
    const ok = await new Promise((resolve) => {
      const sock = connect({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  fatal(2, `ssh 隧道 ${localPort}→${SSH_HOST}:${REMOTE_PORT} 在 15s 内未就绪: ${tunnelStderr.slice(0, 300)}`);
}
await waitPort(localPort, 15_000);
const BASE = `http://127.0.0.1:${localPort}`;

// ── 浏览器旅程 ───────────────────────────────────────────────────────────
let browser;
try {
  browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true });
} catch (err) {
  fatal(2, `浏览器不可用: ${err.message}`);
}

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
let stepName = "init";
async function step(name, fn) {
  stepName = name;
  await fn();
  console.log(`e2e-journey: ✓ ${name}`);
}

try {
  await step("J1 登录表单形态断言 + API 登录种 cookie 进入应用", async () => {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT });
    // 根路径 = 营销首页(未登录形态),导航「登录」进 AuthGate。.first():首页存在多个
    // 登录入口(导航+CTA)时取导航首个。
    await page.getByText("登录", { exact: true }).first().click({ timeout: STEP_TIMEOUT });
    await page.getByPlaceholder("邮箱").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await page.getByPlaceholder("密码").waitFor({ state: "visible", timeout: STEP_TIMEOUT });

    // ── 2026-07-26 安全整改后的形态断言 ──────────────────────────────────
    // 生产已把全局 TURNSTILE_TEST_BYPASS 摘掉(改账号级白名单),真实用户必须看到
    // Cloudflare widget。这里正向断言 widget 存在 —— 它同时是"全局旁路是否被人偷偷
    // 打开"的活体探针:旁路一旦回来,前端会走占位 token 路径,widget 消失,本断言即红。
    const publicConfig = await page.evaluate(async () => {
      const r = await fetch("/api/public/config");
      return r.ok ? await r.json() : null;
    });
    if (!publicConfig) fatal(1, "J1 读 /api/public/config 失败");
    // 强制态下才断言 widget 存在。turnstile_bypass=true 有两种合法来源:dev/CI 的全局
    // 测试旁路,以及产品配置 TURNSTILE_ENFORCE=0(2026-07-26 起线上暂为此态,因为 CF
    // widget 仍是 Managed 交互模式,会让真实用户多一次勾选 —— 详见 config.ts 的债与
    // 偿还条件)。所以这里**不能**无条件断言 bypass 必须为 false,否则暂关期间门恒红。
    // 断言仍有价值:一旦线上翻回强制,widget 缺失就会被这道门抓住。
    if (publicConfig.turnstile_bypass === true) {
      console.log("e2e-journey: · turnstile 当前不强制(bypass=true),跳过 widget 形态断言");
    } else {
      await page
        .locator('iframe[src*="challenges.cloudflare.com"]')
        .first()
        .waitFor({ state: "attached", timeout: STEP_TIMEOUT })
        .catch(() => fatal(1, "J1 强制态下登录表单未挂载 Turnstile widget —— 真实用户的人机验证缺失"));
    }

    // ── 登录本体走 API,不走表单 ──────────────────────────────────────────
    // 为什么不填表单点登录:widget 会对 headless 浏览器出交互式挑战(这正是它该做的),
    // 自动化解不了。canary 邮箱在 TURNSTILE_BYPASS_ACCOUNTS 白名单里,服务端放行占位
    // token,所以 API 登录可用。拿到 refresh cookie 后种进 context,应用启动时用它换
    // access token —— 与真实用户的会话恢复路径完全一致,后续 J2-J5 的 UI 覆盖不打折。
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, turnstile_token: "x" }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      fatal(
        1,
        `J1 API 登录失败 HTTP ${res.status}:${body.slice(0, 200)}` +
          `(若是 TURNSTILE_FAILED,说明 ${EMAIL} 不在线上 TURNSTILE_BYPASS_ACCOUNTS 白名单里)`,
      );
    }
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const rt = setCookie.map((c) => /(?:^|;\s*)oc_rt=([^;]+)/.exec(c)?.[1]).find(Boolean);
    if (!rt) fatal(1, "J1 登录响应里没有 oc_rt refresh cookie");
    await context.addCookies([
      {
        name: "oc_rt",
        value: rt,
        domain: "127.0.0.1",
        path: "/api/auth",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT });

    // 登录成功的判据 = 侧栏「新建会话」出现(composer placeholder 随 agent 名动态变化,
    // 不可作判据 —— 实测 canary 落在已有会话时 placeholder 是「和「全能助手」对话...」)。
    await page.getByText("新建会话", { exact: true }).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    // 旅程在全新会话里跑,不污染既有会话的历史。
    await page.getByText("新建会话", { exact: true }).first().click();
    await page.locator("textarea").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  });

  const probeName = `e2e-journey-${Date.now().toString(36)}.txt`;
  const probeToken = `OC_ATTACH_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  await step("J2 附件全链:菜单→filechooser→真实上传→chip done", async () => {
    await page.getByRole("button", { name: "更多选项" }).click();
    const attachItem = page.getByText("添加附件");
    await attachItem.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: STEP_TIMEOUT }),
      attachItem.click(),
    ]);
    const probePath = join(mkdtempSync(join(tmpdir(), "oc-e2e-")), probeName);
    writeFileSync(probePath, `${probeToken}\n`);
    await chooser.setFiles(probePath);
    // chip 出现 + 真实上传完成(done 态没有重试按钮;上传中发送按钮禁用,enabled=done 活体信号)。
    await page.getByRole("button", { name: `移除 ${probeName}` }).waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    if ((await page.getByRole("button", { name: `重试上传 ${probeName}` }).count()) > 0) {
      throw new Error("附件 chip 进入 error 态(真实上传失败)");
    }
  });

  await step("J3 目标全链:菜单→创建→active 可见→清除", async () => {
    await page.getByRole("button", { name: "更多选项" }).click();
    const goalItem = page.getByText("设定目标");
    await goalItem.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await goalItem.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    const goalMarker = `e2e-goal-${Date.now().toString(36)}`;
    await dialog.getByPlaceholder("这次会话要达成什么？").fill(goalMarker);
    await dialog.getByRole("button", { name: "开始目标" }).click();
    await dialog.getByRole("button", { name: /清除/ }).waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await dialog.getByText("进行中", { exact: true }).waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await dialog.getByRole("button", { name: /清除/ }).click();
    await dialog.getByRole("button", { name: "开始目标" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: STEP_TIMEOUT });
  });

  const marker = `e2e journey canary ${Date.now().toString(36)}`;
  let assistantRowsBefore = 0;
  await step("J4 带附件发送:消息上屏+附件区清空", async () => {
    const input = page.locator("textarea").first();
    await input.fill(`${marker}(自动冒烟)。请读取附件第一行，并只把第一行原样回复；不要猜测、不要描述文件名。`);
    const send = page.getByRole("button", { name: "发送" });
    // 上传若未完成发送键保持禁用;等它可用(附件 done 的第二重信号)。
    const deadline = Date.now() + STEP_TIMEOUT;
    while (await send.isDisabled()) {
      if (Date.now() > deadline) throw new Error("发送按钮在超时窗内未变为可用(上传未完成?)");
      await new Promise((r) => setTimeout(r, 200));
    }
    assistantRowsBefore = await page.getByTestId("assistant-row").count();
    await send.click();
    // .first():模型回复若复读 marker 会出现第二个匹配,strict 单元素断言会误报。
    await page.getByText(marker, { exact: false }).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    if ((await page.getByRole("button", { name: `移除 ${probeName}` }).count()) > 0) {
      throw new Error("发送后附件区未清空");
    }
  });

  await step("J5 送达硬断言:失败卡零容忍+最终正文含附件探针", async () => {
    // 2026-07-18 受理竞态事故:发送失败时乐观气泡照样上屏,旧断言「上屏=成功」让新会话
    // 首发必挂的回归穿门(canary 账号当场撞到、被重试语义掩蔽后门照放绿)。送达升硬门:
    //   失败判据 = ErrorBanner 签名(发送失败 / 消息暂未安全送达),一出现立即 fail;
    //   成功判据 = 新 assistant 行出现 + 流式光标消失 + composer 从「停止」恢复「发送」；
    //   新行不得含 alert（终态错误/空轮/截断都必须 fail）。不依赖回复文案或可选操作按钮。
    const failSig = page.getByText(/发送失败|消息暂未安全送达/).first();
    const assistantRows = page.getByTestId("assistant-row");
    const send = page.getByRole("button", { name: "发送", exact: true });
    const deadline = Date.now() + TURN_WAIT_TIMEOUT;
    for (;;) {
      if ((await failSig.count()) > 0) {
        throw new Error("发送失败签名出现(消息未送达,见截图)");
      }
      if ((await assistantRows.count()) > assistantRowsBefore) {
        const newestAssistant = assistantRows.last();
        const responseFinished =
          (await newestAssistant.locator(".caret-blink").count()) === 0 &&
          (await send.count()) > 0;
        if (responseFinished) {
          if ((await newestAssistant.locator('[role="alert"]').count()) > 0) {
            throw new Error("assistant 以错误/空轮/截断提示结束(非正常回复)");
          }
          const finalBody = (await newestAssistant.locator(".prose").last().textContent())?.trim() ?? "";
          if (!finalBody.includes(probeToken)) {
            throw new Error("assistant 最终正文未包含附件秘密探针(附件未送达 Agent、未读取或回复不完整)");
          }
          break;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`assistant 回复在 ${TURN_WAIT_TIMEOUT / 1000}s 内未完成(无失败卡亦无完整回复 = turn 挂起)`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  console.log("e2e-journey: 旅程全过(登录/附件读取/目标创建清除/发送/送达)");
  await browser.close();
  cleanupTunnel();
  process.exit(0);
} catch (err) {
  const shot = join(ARTIFACTS, `e2e-journey-fail-${Date.now().toString(36)}.png`);
  try {
    await page.screenshot({ path: shot, fullPage: true });
    console.error(`e2e-journey: 失败截图 ${shot}`);
  } catch {}
  console.error(`e2e-journey: ✗ 步骤「${stepName}」失败: ${String(err?.message ?? err).slice(0, 500)}`);
  await browser.close().catch(() => {});
  cleanupTunnel();
  process.exit(1);
}
