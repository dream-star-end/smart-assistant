/**
 * v3 Phase 3A — openclaude-runtime container entrypoint (PID 3 under tini → entrypoint.sh)
 *
 * 由 entrypoint.sh 调起 (`npx tsx entrypoint.ts`)。本文件做两件事:
 *
 *   1. **Env scrubbing**(防 settings.json 残留 / 镜像残留 env / 容器 inherit 漂移):
 *      - 调 personal-version `claude-code-best/src/utils/managedEnvConstants.ts`
 *        暴露的 `isProviderManagedEnvVar(key)`,遍历 `process.env` 把所有匹配项删除
 *      - 例外:supervisor 注入的 3 个 env 必须保留:
 *          ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
 *      - 强制 CLAUDE_CONFIG_DIR=/run/oc/claude-config (tmpfs)
 *
 *   2. **Spawn `npm run gateway`** (个人版 cli 的 gateway 子命令):
 *      - 透传 stdio,转发 SIGTERM/SIGINT 给子进程
 *      - 子进程退出时把退出码透传出去(tini → docker → supervisor)
 *
 * **为什么用 tsx 而不是 mirror 一份 const set 进 .mjs?**
 *   personal-version 加 / 改 / 删 provider 路由 env 时,这里自动跟进,不会漂移。
 *   tsx 已经是 personal-version 的 devDep(`npm run gateway` 自己就用 tsx 跑 cli),
 *   零额外依赖。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isProviderManagedEnvVar } from "/opt/openclaude/claude-code-best/src/utils/managedEnvConstants.ts";

// ───────────────────────────────────────────────
// 1. 环境变量清洗
// ───────────────────────────────────────────────

/** supervisor 注入的 3 个变量必须保留(本脚本之上的 fail-closed 校验已确认它们存在) */
const RETAIN_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
]);

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
const removed: string[] = [];

for (const key of Object.keys(cleanEnv)) {
  if (RETAIN_ENV_KEYS.has(key)) continue;
  if (isProviderManagedEnvVar(key)) {
    delete cleanEnv[key];
    removed.push(key);
  }
}

if (removed.length > 0) {
  // 不打印 value(可能含 token);只打印 key 名 + 数量,审计够用
  console.error(`[entrypoint] scrubbed ${removed.length} provider-routing env keys: ${removed.sort().join(",")}`);
}

// 强制 CLAUDE_CONFIG_DIR 指 tmpfs(就算 supervisor 没传也兜底)
cleanEnv.CLAUDE_CONFIG_DIR = "/run/oc/claude-config";

// ───────────────────────────────────────────────
// 2. 个人版 openclaude.json 首次启动 bootstrap
// ───────────────────────────────────────────────
//
// 个人版 gateway 启动需要 ~/.openclaude/openclaude.json (gateway.bind/port/accessToken)。
// 容器内 HOME=/home/agent, supervisor 已把 oc-v3-data-u<uid> volume 挂到 /home/agent/.openclaude
// 首次启动时 volume 为空 → 写一个最小可用 config(之后 boot 走 volume 里的旧 config 不动)。
//
// accessToken 这里随机生成只用于本容器内 gateway HTTP API 自校验,
// 商用 v3 gateway 通过 docker bridge 直连容器 18789 走 WS,不依赖此 token。
const ocConfigDir = "/home/agent/.openclaude";
const ocConfigPath = join(ocConfigDir, "openclaude.json");

try {
  mkdirSync(ocConfigDir, { recursive: true });
  if (!existsSync(ocConfigPath)) {
    const accessToken = randomBytes(24).toString("base64url");
    const minimalConfig = {
      version: 1,
      gateway: {
        bind: "0.0.0.0", // 容器内监听全部接口,docker bridge 上 commercial gateway 通过 bound_ip:18789 直连
        port: 18789,
        accessToken,
      },
      auth: {
        // 容器内不做真 OAuth,所有 anthropic 调用走 ANTHROPIC_AUTH_TOKEN 注入到 ccb subprocess
        mode: "subscription",
        claudeCodePath: "/opt/openclaude/claude-code-best",
        claudeCodeRuntime: "node",
      },
      // 必填占位:个人版 gateway.ts 在启动时直接读 config.channels.wechat / .telegram
      // 不存在会 TypeError。容器场景下我们不开任何外部 channel —— webchat 由商用版
      // userChatBridge 走 docker bridge 直连容器 18789(WS upgrade),无需 channel adapter。
      channels: {
        wechat: { enabled: false },
        telegram: { enabled: false },
      },
    };
    writeFileSync(ocConfigPath, JSON.stringify(minimalConfig, null, 2), { mode: 0o600 });
    console.error(`[entrypoint] bootstrapped minimal openclaude.json at ${ocConfigPath}`);
  }
} catch (err) {
  // 不致命: 如果 volume 没挂(本地 build smoke)或 perm 异常,gateway 自己会 onboard 流程报错
  console.error(`[entrypoint] WARN: 写 openclaude.json 失败: ${(err as Error).message}`);
}

// ───────────────────────────────────────────────
// 3. spawn npm run gateway + 信号转发 + 退出码透传
// ───────────────────────────────────────────────

const child = spawn("npm", ["run", "gateway"], {
  cwd: "/opt/openclaude",
  env: cleanEnv,
  stdio: "inherit",
});

const forward = (sig: NodeJS.Signals) => () => {
  // 子进程已死的话 kill 会抛 EPERM/ESRCH,catch 掉
  try {
    child.kill(sig);
  } catch {
    /* noop */
  }
};
process.on("SIGTERM", forward("SIGTERM"));
process.on("SIGINT", forward("SIGINT"));
process.on("SIGHUP", forward("SIGHUP"));

child.on("exit", (code, signal) => {
  if (signal) {
    // 子进程被信号杀:exit code = 128 + signo,与 bash 约定一致
    const signo = signal === "SIGTERM" ? 15 : signal === "SIGINT" ? 2 : signal === "SIGKILL" ? 9 : 1;
    process.exit(128 + signo);
  }
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  console.error(`[entrypoint] spawn npm failed: ${err.message}`);
  process.exit(1);
});
