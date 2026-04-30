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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import * as YAML from "yaml";
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

// 强制 OPENCLAUDE_HOME 指容器内 per-user named volume 挂载点。
// 注意:personal 版 `@openclaude/storage/paths.ts` 里 `HOME` 是 module-level const,
// 解析时机 = 模块首次 import,**在 gateway/cli 进程启动时就冻结**。如果此时 env 没设,
// 就永远兜底回 `~/.openclaude`(容器内 = /home/agent/.openclaude —— 刚好也指向 volume),
// **但**下游 subprocessRunner 在 spawn MCP 时又会把 `process.env.OPENCLAUDE_HOME ?? ''`
// 原样传给 mcp-memory。当 env 里是空串(不是 undefined)时 `??` 不回退,MCP 侧 paths.ts
// 就会看到 `HOME=''`,然后所有 `join('', 'agents', 'main', 'MEMORY.md')` 变相对路径,
// 落到 MCP 进程的 cwd 里(/opt/openclaude),完全错位。因此 **这里必须显式 set**,确保
// 父 gateway 和子 MCP 看到的是同一个绝对路径 `/home/agent/.openclaude`。
//
// 修复配对:packages/gateway/src/subprocessRunner.ts 里 `OPENCLAUDE_HOME ?? ''` 改成
// 存在才传,空串视作 undefined。
cleanEnv.OPENCLAUDE_HOME = "/home/agent/.openclaude";

// Codex CLI 默认从 $CODEX_HOME/auth.json 读 OAuth token。host 把剥离 refresh_token
// 的 auth.json 通过 ro bind-mount 写到 /home/agent/.codex/(见 v3supervisor.ts 的
// codex-container-auth 目录挂载),codex 默认路径直接命中。**不要**把这个目录改到
// 别处,否则 `codex` 二进制找不到 auth → 启动即 fail。
//
// boss 未 OAuth 时,host 不写 auth.json,但 mount 始终在(空目录),codex 启动报
// "未授权"是预期行为(GPT 模型在 admin UI 也未发授权,前端 modelPicker 不会出选项)。
cleanEnv.CODEX_HOME = "/home/agent/.codex";

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
        // **指 prebuilt dist 而不是 src/entrypoints/cli.tsx** —— 容器镜像里
        // 只有 node 没有 bun,直接 fork .tsx 入口会因 MACRO undefined 立即 exit 1。
        // dist/cli.js 是 bun build 后的产物(post-process 过 import.meta.require → node 兼容,
        // MACRO 已 inline),node 直接跑通。镜像 build 阶段由 build-image.sh 预先 bun build。
        claudeCodePath: "/opt/openclaude/claude-code-best",
        claudeCodeEntry: "dist/cli.js",
        claudeCodeRuntime: "node",
      },
      // 必填:个人版 SessionManager.getOrCreate (sessionManager.ts:303) 在 spawn ccb 时
      // 会读 `this.config.defaults.model / .permissionMode / .toolsets`。defaults 缺失
      // 直接 NPE → ws-message unhandled error → 前端"thinking 0s 无新数据"卡死。
      // 历史 incident 2026-04-21:漏写本字段,boss 在 claudeai.chat 发消息容器接到
      // 但永远不回包。
      defaults: {
        model: "claude-opus-4-7",
        permissionMode: "acceptEdits",
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

  // 个人版 SessionManager 也需要 agents.yaml 才能解析 opts.agent。两件事:
  //
  //   (a) volume 空 → bootstrap "main" + "codex" 两个 agent
  //   (b) volume 已有 yaml(用户/旧版镜像写过)→ **强制 merge 固定 id `codex`**:
  //       - 不存在 codex agent → append
  //       - 存在但 provider/runnerKind/model 不匹配 → 覆盖并日志告警(原文件先 .bak)
  //       - 解析失败 → 备份原文件到 .bak.<rand>,重新写一份双 agent yaml
  //
  // **安全边界放在后端 canUseModel + inferAgentForModel(fail-closed),agents.yaml
  // 不当权限系统**。这里 merge 的目的只是确保 `id:codex` agent 一定存在 + 配置正确,
  // 让 SessionManager 路由 gpt-5.5 时能找到 runnerKind:'app-server' 的目标。
  // 用户哪怕手改 yaml 加了别的 codex agent,后端 canUseModel 不放行也无意义。
  const agentsPath = join(ocConfigDir, "agents.yaml");
  const personaDir = join(ocConfigDir, "agents", "main");
  const personaPath = join(personaDir, "CLAUDE.md");
  mkdirSync(personaDir, { recursive: true });
  if (!existsSync(personaPath)) {
    writeFileSync(personaPath, "你是 OpenClaude 上的助手,简洁中文回答。\n", { mode: 0o644 });
  }

  // 期望的 codex agent 配置 —— 任何字段不匹配都覆盖
  const desiredCodexAgent = {
    id: "codex",
    model: "gpt-5.5",
    permissionMode: "bypassPermissions",
    provider: "codex-native",
    runnerKind: "app-server",
    displayName: "GPT 5.5 (Codex)",
  };

  const desiredMainAgent = {
    id: "main",
    model: "claude-opus-4-7",
    persona: personaPath,
    permissionMode: "bypassPermissions",
    provider: "claude-subscription",
    displayName: "main",
  };

  if (!existsSync(agentsPath)) {
    const initialDoc = {
      agents: [desiredMainAgent, desiredCodexAgent],
      routes: [],
      default: "main",
    };
    writeFileSync(agentsPath, YAML.stringify(initialDoc), { mode: 0o644 });
    console.error(`[entrypoint] bootstrapped agents.yaml at ${agentsPath}`);
  } else {
    // merge 路径
    let parsed: unknown = null;
    let parseFailed = false;
    try {
      const raw = readFileSync(agentsPath, "utf8");
      parsed = YAML.parse(raw);
    } catch (parseErr) {
      parseFailed = true;
      const bakSuffix = randomBytes(4).toString("hex");
      const bakPath = `${agentsPath}.bak.${bakSuffix}`;
      try {
        copyFileSync(agentsPath, bakPath);
        console.error(
          `[entrypoint] WARN: agents.yaml 解析失败,原文件备份到 ${bakPath}: ${(parseErr as Error).message}`,
        );
      } catch (bakErr) {
        console.error(
          `[entrypoint] WARN: agents.yaml 解析失败且 .bak 备份也失败: ${(bakErr as Error).message}`,
        );
      }
    }

    if (parseFailed || parsed === null || typeof parsed !== "object") {
      // 重新写一份完整的双 agent yaml(保险)
      const initialDoc = {
        agents: [desiredMainAgent, desiredCodexAgent],
        routes: [],
        default: "main",
      };
      writeFileSync(agentsPath, YAML.stringify(initialDoc), { mode: 0o644 });
      console.error(`[entrypoint] rewrote agents.yaml at ${agentsPath} (parse failed or empty)`);
    } else {
      const doc = parsed as { agents?: unknown; routes?: unknown; default?: unknown };
      const agents = Array.isArray(doc.agents) ? [...(doc.agents as unknown[])] : [];
      const codexIndex = agents.findIndex(
        (a) => a !== null && typeof a === "object" && (a as { id?: unknown }).id === "codex",
      );
      let mutated = false;
      if (codexIndex < 0) {
        agents.push(desiredCodexAgent);
        mutated = true;
        console.error(`[entrypoint] agents.yaml: appended codex agent`);
      } else {
        const existing = agents[codexIndex] as Record<string, unknown>;
        const mismatch =
          existing.provider !== desiredCodexAgent.provider ||
          existing.runnerKind !== desiredCodexAgent.runnerKind ||
          existing.model !== desiredCodexAgent.model;
        if (mismatch) {
          // 备份后覆盖(用户 / 旧镜像污染了 codex 条目)
          const bakSuffix = randomBytes(4).toString("hex");
          const bakPath = `${agentsPath}.bak.${bakSuffix}`;
          try {
            copyFileSync(agentsPath, bakPath);
          } catch (bakErr) {
            console.error(
              `[entrypoint] WARN: agents.yaml 覆盖 codex 前 .bak 备份失败: ${(bakErr as Error).message}`,
            );
          }
          agents[codexIndex] = desiredCodexAgent;
          mutated = true;
          console.error(
            `[entrypoint] agents.yaml: codex agent 字段不匹配,已覆盖(原文件备份到 ${bakPath})`,
          );
        }
      }
      if (mutated) {
        const newDoc = {
          ...doc,
          agents,
          routes: Array.isArray(doc.routes) ? doc.routes : [],
          default: typeof doc.default === "string" ? doc.default : "main",
        };
        writeFileSync(agentsPath, YAML.stringify(newDoc), { mode: 0o644 });
      }
    }
  }
} catch (err) {
  // 不致命: 如果 volume 没挂(本地 build smoke)或 perm 异常,gateway 自己会 onboard 流程报错
  console.error(`[entrypoint] WARN: 写 openclaude.json/agents.yaml 失败: ${(err as Error).message}`);
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
