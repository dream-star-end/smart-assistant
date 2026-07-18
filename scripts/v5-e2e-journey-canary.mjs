// v5 部署 smoke:真浏览器用户旅程 canary(E2E journey gate)。
//
// 背景(2026-07-18 附件事故):「点击添加附件无反应」的回归上线约 20 小时才被用户
// 报障 —— turn canary 只覆盖 WS 契约,健康端点不点 UI,前端交互层是自动化盲区,
// 用户成了人肉 canary。本脚本用真 Chromium(受信事件)走一遍核心用户旅程,作为
// 部署后的 UI 层验收门:
//   J1 UI 登录(真实表单;依赖线上 turnstile_bypass=true,同 turn canary 的 bypass 前提)
//   J2 附件全链:「+」菜单 → 添加附件 → filechooser 真实弹出 → 真实上传 → chip done
//   J3 目标入口:「+」菜单 → 设定目标 → 对话框弹出
//   J4 带附件发送:消息上屏 + 附件区清空(turn 结果不在此等待 —— WS 三信号由
//      v5-smoke-turn-canary 硬门覆盖,此处只验 UI 发送旅程,避免双倍等待窗)
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

const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
let stepName = "init";
async function step(name, fn) {
  stepName = name;
  await fn();
  console.log(`e2e-journey: ✓ ${name}`);
}

try {
  await step("J1 打开站点并 UI 登录(canary 账号)", async () => {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT });
    // 根路径 = 营销首页(未登录形态),导航「登录」进 AuthGate。.first():首页存在多个
    // 登录入口(导航+CTA)时取导航首个。
    await page.getByText("登录", { exact: true }).first().click({ timeout: STEP_TIMEOUT });
    await page.getByPlaceholder("邮箱").fill(EMAIL, { timeout: STEP_TIMEOUT });
    await page.getByPlaceholder("密码").fill(password);
    await page.getByRole("button", { name: /^登录/ }).click();
    // 登录成功的判据 = 侧栏「新建会话」出现(composer placeholder 随 agent 名动态变化,
    // 不可作判据 —— 实测 canary 落在已有会话时 placeholder 是「和「全能助手」对话...」)。
    await page.getByText("新建会话", { exact: true }).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    // 旅程在全新会话里跑,不污染既有会话的历史。
    await page.getByText("新建会话", { exact: true }).first().click();
    await page.locator("textarea").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  });

  const probeName = `e2e-journey-${Date.now().toString(36)}.txt`;
  await step("J2 附件全链:菜单→filechooser→真实上传→chip done", async () => {
    await page.getByRole("button", { name: "更多选项" }).click();
    const attachItem = page.getByText("添加附件");
    await attachItem.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: STEP_TIMEOUT }),
      attachItem.click(),
    ]);
    const probePath = join(mkdtempSync(join(tmpdir(), "oc-e2e-")), probeName);
    writeFileSync(probePath, `v5 e2e journey attach probe ${new Date().toISOString()}\n`);
    await chooser.setFiles(probePath);
    // chip 出现 + 真实上传完成(done 态没有重试按钮;上传中发送按钮禁用,enabled=done 活体信号)。
    await page.getByRole("button", { name: `移除 ${probeName}` }).waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    if ((await page.getByRole("button", { name: `重试上传 ${probeName}` }).count()) > 0) {
      throw new Error("附件 chip 进入 error 态(真实上传失败)");
    }
  });

  await step("J3 目标入口:菜单→设定目标→对话框弹出", async () => {
    await page.getByRole("button", { name: "更多选项" }).click();
    const goalItem = page.getByText("设定目标");
    await goalItem.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await goalItem.click();
    await page.getByRole("dialog").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT });
  });

  const marker = `e2e journey canary ${Date.now().toString(36)}`;
  await step("J4 带附件发送:消息上屏+附件区清空", async () => {
    const input = page.locator("textarea").first();
    await input.fill(`${marker}(自动冒烟,只需简短回复)`);
    const send = page.getByRole("button", { name: "发送" });
    // 上传若未完成发送键保持禁用;等它可用(附件 done 的第二重信号)。
    const deadline = Date.now() + STEP_TIMEOUT;
    while (await send.isDisabled()) {
      if (Date.now() > deadline) throw new Error("发送按钮在超时窗内未变为可用(上传未完成?)");
      await new Promise((r) => setTimeout(r, 200));
    }
    await send.click();
    // .first():模型回复若复读 marker 会出现第二个匹配,strict 单元素断言会误报。
    await page.getByText(marker, { exact: false }).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    if ((await page.getByRole("button", { name: `移除 ${probeName}` }).count()) > 0) {
      throw new Error("发送后附件区未清空");
    }
  });

  console.log("e2e-journey: 旅程全过(登录/附件/目标/发送)");
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
