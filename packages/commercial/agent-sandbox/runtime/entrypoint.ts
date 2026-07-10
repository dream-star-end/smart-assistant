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
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isProviderManagedEnvVar } from "/opt/openclaude/claude-code-best/src/utils/managedEnvConstants.ts";
// 隐藏系统 agent id 的单一权威(与 gateway 编译期共享,不再手抄黑名单)。绝对路径
// import 与上面 managedEnvConstants 同构:容器内整棵 packages 树在 /opt/openclaude/,
// entrypoint 用 tsx 直接跑、被 Dockerfile COPY 到 /usr/local/lib/openclaude(父链无
// node_modules),故用工作区根的绝对源码路径。本文件不进 commercial tsconfig 编译图,
// 一致性由 runtimeEntrypointPolicy.test.ts 守护。
import { isHiddenSystemAgentId as isHiddenSystemAgentIdShared } from "/opt/openclaude/packages/protocol/src/agentVisibility.ts";
import {
  DEFAULT_CODEX_ENGINE_MODEL,
  DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME,
} from "/opt/openclaude/packages/protocol/src/engineModels.ts";

// entrypoint.ts 文件被 Dockerfile COPY 到 /usr/local/lib/openclaude/,而 yaml 模块装在
// 容器内 /opt/openclaude/node_modules/yaml(npm workspaces 装到根)。Node ESM/require
// 默认从文件位置沿父链找 node_modules,/usr/local/lib/openclaude/ 父链没 node_modules,
// 直接 import "yaml" 会 MODULE_NOT_FOUND。createRequire 锚到 /opt/openclaude/package.json
// 把 resolution 起点显式拉到工作区根。
const requireFromOC = createRequire("/opt/openclaude/package.json");
const YAML: typeof import("yaml") = requireFromOC("yaml");

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

// ScanSci PDF stores downloader config/cache/output under one explicit
// per-user persistent path.  Keep it out of ~/.config (blocked wholesale by
// the trusted file ACL) so downloaded PDFs can still be served, while gateway
// blocks the sensitive config/cookie/browser-state files by exact patterns.
const SCANSCI_PDF_DATA_DIR = "/home/agent/.local/share/scansci-pdf";
cleanEnv.SCANSCI_PDF_DATA_DIR = SCANSCI_PDF_DATA_DIR;

const CORE_TOOLSET_ID = "core";
const BROWSER_TOOLSET_ID = "browser";
// `research` (scansci-pdf + web-context) and `web_context` toolsets were retired
// when those capabilities moved from MCP tools to the `scansci-pdf` / `oc-web`
// CLIs (documented by baseline skills). Their ids + MCP servers are stripped
// from any stale user-volume config in upsertPlatformMcpIntegrations below.
const RESEARCH_TOOLSET_ID = "research";
const WEB_CONTEXT_TOOLSET_ID = "web_context";

// 平台全局默认模型。**2026-06-17 改为 glm-5.2(火山方舟 ark,boss 决定:替换掉 glm-5.1、队长全切 glm-5.2)。**
// ⚠️ 已知运营权衡:glm-5.x 走火山方舟【北京】端点,从 master(吉隆坡)跨境进中国大陆、链路间歇抖动,
// 长 turn 可能撞瞬时丢包 → "半天没反应"(2026-06-16 正因此把队长撤回 MiniMax-M3)。boss 2026-06-17
// 明确接受该风险、把队长/平台默认切回火山系 glm-5.2;部署 smoke 须重点验证队长长 turn 稳定性。
// 注意:本文件由 Dockerfile 单独 COPY 进 runtime 镜像,无法 import packages/commercial/src,故本地维护;
// master 权威常量在 src/platformDefaults.ts,两源一致性由 src/__tests__/runtimeEntrypointPolicy.test.ts
// 守护 —— 改这里必须同步改 platformDefaults.ts。
const COMMERCIAL_DEFAULT_MODEL = "glm-5.2";
const COMMERCIAL_DEFAULT_PROVIDER = "ark";
// v5 纯市场模型:容器只 seed「全能助手」(main)+GPT-5.6 默认队长(codex)+隐藏审查员
// (hidden-reviewer) → 其它用户可见 agent 一律走市场安装(见下方 desiredSeedAgents)。
// 历史内置子 agent(researcher/scientist/coder/reviewer/scholar)已退役,其各角色专用
// 的 model/provider 常量随之移除。
// M1b codex 复活:codex seed agent 回归 —— provider:'codex-native' + runnerKind:
// 'app-server' 是 gateway runner 路由依据,必须落 agents.yaml。
const COMMERCIAL_CODEX_MODEL = DEFAULT_CODEX_ENGINE_MODEL;
const COMMERCIAL_HIDDEN_REVIEWER_MODEL = "glm-5.2";
const COMMERCIAL_HIDDEN_REVIEWER_PROVIDER = "ark";

// Retired MCP server — id retained only so upsertPlatformMcpIntegrations can
// strip stale platform-owned entries from existing user volumes. Browser is now
// the stateful oc-browser daemon (keeps one Playwright session alive) +
// thin `oc-browser` CLI, documented by the `browser` baseline skill.
const BROWSER_MCP_ID = "browser";

// Retired MCP servers — ids retained only so upsertPlatformMcpIntegrations can
// strip stale platform-owned entries from existing user volumes. The `scansci-pdf`
// CLI (still installed in the image, reads SCANSCI_PDF_DATA_DIR) and the `oc-web`
// CLI now provide these capabilities, documented by baseline skills.
const SCANSCI_PDF_MCP_ID = "scansci-pdf";
const WEB_CONTEXT_MCP_ID = "web-context";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sameStringArray(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

function isLegacyClaudeModel(model: unknown): boolean {
  return typeof model === "string" && /^claude-/i.test(model.trim());
}

function sameStringSet(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a)) return false;
  const av = a.filter((v): v is string => typeof v === "string").sort();
  const bv = [...b].sort();
  return av.length === bv.length && av.every((v, i) => v === bv[i]);
}

function upsertPlatformMcpServer(
  servers: unknown[],
  id: string,
  desired: Record<string, unknown>,
  isDesired: (value: unknown) => boolean,
): boolean {
  const idx = servers.findIndex((srv) => isRecord(srv) && srv.id === id);
  if (idx < 0) {
    servers.push(desired);
    return true;
  }
  if (!isDesired(servers[idx])) {
    // Platform-owned server ids: keep runtime command/env/tool metadata
    // authoritative so image upgrades repair stale user-volume config.
    servers[idx] = desired;
    return true;
  }
  return false;
}

// Strip a retired platform-owned MCP server id from a user volume's config so an
// image upgrade actively removes deprecated tools (not just stops re-adding them).
// Removes ALL matching entries: a hand-edited/legacy volume may hold duplicates,
// and a single splice would leave the later copies for SubprocessRunner to mount.
function removePlatformMcpServer(servers: unknown[], id: string): boolean {
  let removed = false;
  for (let i = servers.length - 1; i >= 0; i--) {
    const srv = servers[i];
    if (isRecord(srv) && srv.id === id) {
      servers.splice(i, 1);
      removed = true;
    }
  }
  return removed;
}

function deleteToolset(toolsets: Record<string, unknown>, name: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(toolsets, name)) return false;
  delete toolsets[name];
  return true;
}

function setToolset(
  toolsets: Record<string, unknown>,
  name: string,
  ids: readonly string[],
): boolean {
  if (sameStringArray(toolsets[name], ids)) return false;
  toolsets[name] = [...ids];
  return true;
}

function ensureCoreDefaults(defaults: Record<string, unknown>): boolean {
  let mutated = false;
  const normalized = normalizeStringArray(defaults.toolsets);
  const next = normalized.length > 0 ? normalized : [CORE_TOOLSET_ID];
  if (!sameStringArray(defaults.toolsets, next)) {
    defaults.toolsets = next;
    mutated = true;
  }
  if (
    typeof defaults.model !== "string" ||
    defaults.model.trim() === "" ||
    isLegacyClaudeModel(defaults.model)
  ) {
    defaults.model = COMMERCIAL_DEFAULT_MODEL;
    mutated = true;
  }
  // 迁移旧平台默认 acceptEdits → bypassPermissions:已有用户卷里 config.defaults 在缺失分支
  // 不会被重建,需在此主动归一。沙箱即安全边界,消费级产品不逐条 bash 弹窗。只动旧平台默认值
  // (acceptEdits),不覆盖用户/其它显式设置(如 default/plan)。
  if (defaults.permissionMode === "acceptEdits") {
    defaults.permissionMode = "bypassPermissions";
    mutated = true;
  }
  return mutated;
}

function upsertPlatformMcpIntegrations(config: Record<string, unknown>): boolean {
  let mutated = false;

  const existingServers = Array.isArray(config.mcpServers) ? [...config.mcpServers] : [];
  // browser + scansci-pdf + web-context all retired from MCP → CLI: actively
  // strip any stale platform-owned entries from existing user volumes.
  mutated = removePlatformMcpServer(existingServers, BROWSER_MCP_ID) || mutated;
  mutated = removePlatformMcpServer(existingServers, SCANSCI_PDF_MCP_ID) || mutated;
  mutated = removePlatformMcpServer(existingServers, WEB_CONTEXT_MCP_ID) || mutated;
  if (!Array.isArray(config.mcpServers) || mutated) {
    config.mcpServers = existingServers;
  }

  // v3 runtime default is deliberately lightweight: `core` is the only toolset
  // and mounts no MCP servers — browser/scansci-pdf/web-context all moved to the
  // oc-browser / scansci-pdf / oc-web CLIs (documented by baseline skills).
  const toolsets = isRecord(config.toolsets) ? { ...config.toolsets } : {};
  let toolsetsMutated = !isRecord(config.toolsets);
  toolsetsMutated = setToolset(toolsets, CORE_TOOLSET_ID, []) || toolsetsMutated;
  toolsetsMutated = deleteToolset(toolsets, BROWSER_TOOLSET_ID) || toolsetsMutated;
  toolsetsMutated = deleteToolset(toolsets, RESEARCH_TOOLSET_ID) || toolsetsMutated;
  toolsetsMutated = deleteToolset(toolsets, WEB_CONTEXT_TOOLSET_ID) || toolsetsMutated;
  if (toolsetsMutated) {
    config.toolsets = toolsets;
    mutated = true;
  }

  if (!isRecord(config.defaults)) {
    // 默认 bypassPermissions:容器是每用户独立沙箱(沙箱即安全边界),消费级产品不应逐条
    // bash 弹窗。seed agent 早已 bypass;市场/用户自建 agent(manifest 禁止自带 permissionMode)
    // 此前落到 acceptEdits → bash/oc-* CLI 都弹确认。统一默认 bypass 消除该摩擦。
    config.defaults = { model: COMMERCIAL_DEFAULT_MODEL, permissionMode: "bypassPermissions", toolsets: [CORE_TOOLSET_ID] };
    mutated = true;
  } else if (ensureCoreDefaults(config.defaults)) {
    mutated = true;
  }

  return mutated;
}

// Codex CLI 默认从 $CODEX_HOME/auth.json 读 OAuth token。CODEX_HOME 还是 codex CLI 的
// 状态/日志目录(`.personality_migration` / `logs_*.sqlite` / `state_*.sqlite` /
// `memories/` / `skills/` / helper PATH binaries 都写在这里),**必须可写**。
//
// 早期实现把 host 的 ro auth 源直接挂到 CODEX_HOME → codex 启动写状态/PATH 时
// `Read-only file system (os error 30)` → exit 1。现拆成两路:
//
//   /home/agent/.codex/             ← agent owned 可写(image rootfs upper layer)
//     auth.json                     ← symlink → /run/oc/codex-auth/auth.json
//     logs_*.sqlite, state_*.sqlite, memories/, skills/  ← codex 自由写
//   /run/oc/codex-auth/             ← host bind ro,只放 auth.json
//     auth.json                     ← host master gateway 通过 atomic rename 写入
//
// 用 symlink 而不是 copy:
//   - host atomic rename 在 source dir 替换 entry,容器侧 /run/oc/codex-auth dirfd
//     立即可见新 entry,codex 下次读 auth.json 走 symlink → 新 dirent
//   - copy 路径需要监听刷新 + 重写,复杂且并发不安全
//
// 失败模式(全部预期):
//   - host 未 mount /run/oc/codex-auth(codex 池空 / OAuth 未配)→ symlink dangle
//     → codex 读 auth.json ENOENT → 报"未授权"(与未 OAuth 等价)
//
// 安全边界**保护 host auth 源不被容器改写**(/run/oc/codex-auth 是 RO bind mount);
// CODEX_HOME 下的 auth.json **symlink 不是安全控制** —— 容器内 agent 本来就能读
// auth token(mode 0400),改 symlink 最多让自己的 codex 找不到 auth(自伤)。
cleanEnv.CODEX_HOME = "/home/agent/.codex";

const CODEX_HOME_DIR = "/home/agent/.codex";
const CODEX_AUTH_SOURCE = "/run/oc/codex-auth/auth.json";
try {
  mkdirSync(CODEX_HOME_DIR, { recursive: true });
  const authLink = join(CODEX_HOME_DIR, "auth.json");
  // unlink 旧 symlink/file(idempotent — 容器重启会再跑)
  // 只吞 ENOENT;EACCES / EISDIR / EBUSY 等部署故障必须冒泡到外层 catch 报警
  try {
    unlinkSync(authLink);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  symlinkSync(CODEX_AUTH_SOURCE, authLink);
} catch (e) {
  console.error(
    `[entrypoint] WARN: codex auth symlink setup failed: ${(e as Error).message}`,
  );
}

// ── D2 持久化(2026-05-09): bootstrap 用户级 npm / pip 配置 ──
// 目标:让用户在容器内的 npm install -g / pip install --user / pipx 行为
// 跨容器重启保留(配 supervisor 5-volume 全套持久化)。
//
// 设计要点:
//   - 文件落 ~/.config/npm/npmrc + ~/.config/pip/pip.conf,~/.config 已是
//     持久化 volume → 跨容器保留。Dockerfile 已设 NPM_CONFIG_USERCONFIG 指
//     这个文件,所以 npm 会直接读它而不是 ~/.npmrc(/home/agent/.npmrc 在
//     overlay 不持久化)。
//   - "if !existsSync" 幂等模式:首次启动 bootstrap 默认值,用户后续手动改
//     prefix / registry / authToken / 任何 pip 配置都不被覆盖。
//   - npm prefix 默认 = /home/agent/.local → npm install -g foo 落到 ~/.local
//     (持久化)。配 Dockerfile PATH=~/.local/bin:... 后立即可用。
//   - pip 不强制 user=true(那会破坏 venv 内 pip install);只放
//     break-system-packages=true,绕开 Debian PEP-668 拦截。用户用
//     `pip install --user foo` 仍落 ~/.local 持久化。
//   - 失败 non-fatal:bootstrap 出错不该挂掉容器(用户自己装 pip/npm 仍能
//     自己解决,只是首次少了便利)。
const npmConfDir = "/home/agent/.config/npm";
const npmConfPath = join(npmConfDir, "npmrc");
try {
  mkdirSync(npmConfDir, { recursive: true });
  if (!existsSync(npmConfPath)) {
    // 0600 — npm 7+ 的 _authToken / userconfig 可能落进这个文件,缺省紧权限防护。
    writeFileSync(npmConfPath, "prefix=/home/agent/.local\n", { mode: 0o600 });
  }
} catch (e) {
  console.error(
    `[entrypoint] WARN: bootstrap ~/.config/npm/npmrc failed (non-fatal): ${(e as Error).message}`,
  );
}
const pipConfDir = "/home/agent/.config/pip";
const pipConfPath = join(pipConfDir, "pip.conf");
try {
  mkdirSync(pipConfDir, { recursive: true });
  if (!existsSync(pipConfPath)) {
    // 0600 — pip.conf 也可能放 index-url 含 token 的私有镜像配置,缺省紧权限。
    writeFileSync(
      pipConfPath,
      "[install]\nbreak-system-packages = true\n",
      { mode: 0o600 },
    );
  }
} catch (e) {
  console.error(
    `[entrypoint] WARN: bootstrap ~/.config/pip/pip.conf failed (non-fatal): ${(e as Error).message}`,
  );
}

try {
  mkdirSync(SCANSCI_PDF_DATA_DIR, { recursive: true });
  mkdirSync(join(SCANSCI_PDF_DATA_DIR, "papers"), { recursive: true });
  mkdirSync(join(SCANSCI_PDF_DATA_DIR, "cache"), { recursive: true });
} catch (e) {
  console.error(
    `[entrypoint] WARN: bootstrap ScanSci PDF data dir failed (non-fatal): ${(e as Error).message}`,
  );
}

// ── codex system skills seed(image_gen / document-writing 等内建 tool 必需)──
// codex 0.125 把 image_gen 等内建工具实现成 `~/.codex/skills/.system/imagegen/`
// system skill。codex CLI 启动时会 populate 这个目录,但实测耗时 1-2s,
// gateway lazy-spawn codex 接到首个 turn 时 populate 还没好,enumerate tools
// 看不到 imagegen → 用户问"画图"时 codex 自答 "没有 image_gen 工具"。
//
// build 阶段 Dockerfile 已把 populate 出来的 skills 放到 /opt/codex-system-skills,
// 并叠加 OpenClaude runtime 自带的 Codex native system skill(如 document-writing)。
// 这里逐 skill copy 到 CODEX_HOME/skills/.system/(idempotent — 已存在则跳过),
// 让首个 turn 就能看到系统 skill,且已有用户 volume 也能在镜像升级后补到新增 skill。
//
// 注意:这不是让 Codex 用 `~/.codex/skills` 管理 OpenClaude 平台记忆/用户 skill;
// 平台状态仍通过 openclaude_memory MCP。这里仅用于 Codex native system skill surface。
//
// 失败 non-fatal — 某个 Codex system skill 不可用不该挂掉容器。
const BAKED_SKILLS = "/opt/codex-system-skills";
const TARGET_SKILLS = join(CODEX_HOME_DIR, "skills");
try {
  const bakedSystemSkills = join(BAKED_SKILLS, ".system");
  const targetSystemSkills = join(TARGET_SKILLS, ".system");
  if (existsSync(bakedSystemSkills)) {
    mkdirSync(targetSystemSkills, { recursive: true });
    for (const entry of readdirSync(bakedSystemSkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDir = join(bakedSystemSkills, entry.name);
      const sourceSkillMd = join(sourceDir, "SKILL.md");
      const targetDir = join(targetSystemSkills, entry.name);
      const targetSkillMd = join(targetDir, "SKILL.md");
      if (!existsSync(sourceSkillMd) || existsSync(targetSkillMd)) continue;
      cpSync(sourceDir, targetDir, {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  }
} catch (e) {
  console.error(
    `[entrypoint] WARN: codex system skills seed failed (non-fatal): ${(e as Error).message}`,
  );
}

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
        model: COMMERCIAL_DEFAULT_MODEL,
        // bypassPermissions:沙箱即安全边界,消费级产品不逐条 bash 弹窗(详见上方 ensureCoreDefaults 注释)。
        permissionMode: "bypassPermissions",
        toolsets: [CORE_TOOLSET_ID],
      },
      toolsets: {
        // `core` is the only toolset; browser/scansci-pdf/web-context all moved
        // from MCP to the oc-browser / scansci-pdf / oc-web CLIs (baseline skills).
        [CORE_TOOLSET_ID]: [],
      },
      mcpServers: [],
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
  } else {
    try {
      const rawConfig = readFileSync(ocConfigPath, "utf8");
      const parsedConfig = JSON.parse(rawConfig) as unknown;
      if (isRecord(parsedConfig) && upsertPlatformMcpIntegrations(parsedConfig)) {
        writeFileSync(ocConfigPath, JSON.stringify(parsedConfig, null, 2), { mode: 0o600 });
        console.error("[entrypoint] openclaude.json: ensured core/browser toolsets, stripped retired scansci/web-context MCP");
      }
    } catch (configErr) {
      // Existing config parse failures should not be silently repaired here:
      // gateway startup will surface the real onboarding/config error.  Keep
      // this integration best-effort so a bad user config is not overwritten.
      console.error(
        `[entrypoint] WARN: openclaude.json MCP toolset merge skipped: ${(configErr as Error).message}`,
      );
    }
  }

  // 个人版 SessionManager 也需要 agents.yaml 才能解析 opts.agent。两件事:
  //
  //   (a) volume 空 → bootstrap 商业版 seed agents(v5 ccb-only:main/researcher/
  //       scientist/coder/reviewer + 两个团队,不再 seed codex agent)
  //   (b) volume 已有 yaml(用户/旧版镜像写过)→ merge 平台 seed:
  //       - 保留用户自建 agent,但规范化 main/researcher/scientist/coder/reviewer 这些平台保留 id
  //       - 缺少 science_research_team/programming_team → append;旧 codex 队长默认形态 → 迁移为 main 队长
  //       - 解析失败 → 备份原文件到 .bak.<rand>,重新写一份平台 seed yaml
  //
  // **安全边界放在后端 canUseModel + inferAgentForModel(fail-closed),agents.yaml
  // 不当权限系统**。这里 merge 的目的只是确保默认商业版 agent 不再落到不可用 Claude。
  // (v5 ccb-only:gpt-* 被 inferAgentForModel fail-closed 拒绝,不再有 codex runner。)
  const agentsPath = join(ocConfigDir, "agents.yaml");

  function ensureAgentPersona(
    agentId: string,
    content: string,
    legacyContents: readonly string[] = [],
    opts: { force?: boolean } = {},
  ): string {
    const personaDir = join(ocConfigDir, "agents", agentId);
    const personaPath = join(personaDir, "CLAUDE.md");
    mkdirSync(personaDir, { recursive: true });
    if (opts.force || !existsSync(personaPath)) {
      writeFileSync(personaPath, content, { mode: 0o644 });
    } else if (legacyContents.length > 0) {
      try {
        const current = readFileSync(personaPath, "utf8");
        if (legacyContents.some((legacy) => current === legacy)) {
          writeFileSync(personaPath, content, { mode: 0o644 });
          console.error(`[entrypoint] agents.yaml: refreshed legacy ${agentId} persona`);
        }
      } catch (personaErr) {
        console.error(
          `[entrypoint] WARN: ${agentId} persona refresh skipped: ${(personaErr as Error).message}`,
        );
      }
    }
    return personaPath;
  }

  const KDENSE_SCIENTIFIC_SOURCE_COMMIT = "dab7aa672944a77f20cda3f2a672a6f1582adab6";

  type ScientificSkillSeed = {
    name: string;
    description: string;
    tags: readonly string[];
    related?: readonly string[];
    license: string;
    title: string;
    useWhen: readonly string[];
    workflow: readonly string[];
    pitfalls: readonly string[];
  };

  function scientificSkillContent(seed: ScientificSkillSeed): string {
    const related = seed.related && seed.related.length > 0
      ? [`related_skills: [${seed.related.join(", ")}]`]
      : [];
    return [
      "---",
      `name: ${seed.name}`,
      `description: ${JSON.stringify(seed.description)}`,
      "version: 1.0.0",
      `tags: [${seed.tags.join(", ")}]`,
      ...related,
      `license: ${seed.license}`,
      "source: K-Dense-AI/scientific-agent-skills adapted static subset",
      `source_commit: ${KDENSE_SCIENTIFIC_SOURCE_COMMIT}`,
      "---",
      "",
      `# ${seed.title}`,
      "",
      "## OpenClaude 商业版安全边界",
      "",
      "本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:",
      "",
      "- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。",
      "- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。",
      "- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。",
      "- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。",
      "- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。",
      "",
      "## 什么时候用",
      "",
      ...seed.useWhen.map((line) => `- ${line}`),
      "",
      "## 推荐流程",
      "",
      ...seed.workflow.map((line, i) => `${i + 1}. ${line}`),
      "",
      "## 防错要点",
      "",
      ...seed.pitfalls.map((line) => `- ${line}`),
      "",
      "## 来源与许可",
      "",
      `- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit \`${KDENSE_SCIENTIFIC_SOURCE_COMMIT}\`.`,
      "- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.",
      `- Package/library license noted in frontmatter: ${seed.license}.`,
      "",
    ].join("\n");
  }

  const SCIENTIST_SKILL_SEEDS: readonly ScientificSkillSeed[] = [
    {
      name: "matplotlib",
      description:
        "Publication-quality Python plotting with matplotlib when fine-grained control over axes, typography, layout, annotations, and export format is needed.",
      tags: ["science", "plotting", "visualization", "python", "figures"],
      related: ["statistical-analysis"],
      license: "Matplotlib license",
      title: "matplotlib scientific plotting",
      useWhen: [
        "用户要论文图、报告图、复杂坐标轴、多 panel figure、误差条、注释或出版级 PDF/SVG/PNG。",
        "需要精确控制字体、线宽、颜色、legend、ticks、子图布局或导出尺寸。",
        "seaborn/plotly 默认图不够可控时,回到 matplotlib。",
      ],
      workflow: [
        "先明确图要证明什么结论,再选择 line/scatter/bar/box/violin/heatmap/contour/image 等图型。",
        "整理 tidy data 或明确 x/y/error/group columns;图前先检查缺失值、单位和样本量。",
        "写可复现脚本,把数据读取、统计汇总、绘图和导出放在同一文件或 notebook 中。",
        "导出至少一个矢量格式(PDF/SVG)和一个预览 PNG;按目标媒介设置尺寸、DPI 和字体大小。",
        "交付前检查文件存在、尺寸合理、无截断、legend 不遮挡数据。",
      ],
      pitfalls: [
        "默认使用色盲友好 palette,不要只靠颜色区分类别;必要时配合线型/marker。",
        "坐标轴必须有 label 和单位;科学图优先展示 CI、IQR、error bar、raw points 或样本量。",
        "避免 3D、渐变、双 y 轴等容易误导的视觉效果,除非用户明确需要且解释清楚。",
      ],
    },
    {
      name: "statistical-analysis",
      description:
        "Choose and report appropriate statistical tests: assumptions, effect sizes, confidence intervals, multiple testing, power, and reproducible analysis decisions.",
      tags: ["science", "statistics", "hypothesis-testing", "analysis"],
      related: ["statsmodels", "pymc", "matplotlib"],
      license: "MIT license",
      title: "Statistical analysis decision guide",
      useWhen: [
        "用户问该用什么统计检验/模型、结果是否显著、怎么报告 p 值/置信区间/效应量。",
        "需要选择 t-test/ANOVA/nonparametric/chi-square/regression/mixed model/survival/time-series 等方法。",
        "需要检查假设、样本量、多重比较或结果报告质量。",
      ],
      workflow: [
        "明确研究问题、变量类型、配对/独立、组数、重复测量、层级结构和样本量。",
        "先画图和做描述性统计,检查异常值、缺失机制、分布和方差结构。",
        "根据研究设计选方法,而不是根据哪个 p 值小选方法。",
        "同时报告效应量、置信区间、样本量、检验假设和多重校正策略。",
        "不满足假设时考虑变换、稳健方法、非参数方法、bootstrap 或模型化替代。",
      ],
      pitfalls: [
        "p 值不是效应大小;“不显著”不是“无效应”。",
        "多指标/多基因/多模型比较要控制 FDR/FWER 或明确探索性。",
        "预注册/confirmatory 与 exploratory 分析要分开写;医学统计需领域专家和伦理/监管审阅。",
      ],
    },
    {
      name: "statsmodels",
      description:
        "Statistical modeling with statsmodels: OLS/GLM, logistic regression, mixed models, time series, diagnostics, robust covariance, and interpretable summaries.",
      tags: ["science", "statistics", "regression", "econometrics", "python"],
      related: ["statistical-analysis", "pymc"],
      license: "BSD-3-Clause license",
      title: "statsmodels statistical modeling",
      useWhen: [
        "用户需要可解释统计模型:线性/广义线性模型、Logit/Probit、计量模型、时间序列、诊断检验或标准误。",
        "需要类似 R 公式语法、系数表、置信区间、假设检验和模型摘要。",
        "scikit-learn 偏预测,而用户更关心推断和解释时,优先考虑 statsmodels。",
      ],
      workflow: [
        "明确 outcome、predictors、confounders、固定/随机效应、link function 和误差结构。",
        "用公式接口保持模型定义可读;对 categorical variables 明确 reference level。",
        "检查残差、异方差、多重共线性、影响点、自相关和模型拟合优度。",
        "根据数据结构选择稳健/clustered standard errors、mixed model 或 time-series model。",
        "输出系数时解释单位、方向、效应大小和置信区间,不要只贴 summary。",
      ],
      pitfalls: [
        "缺失值处理要显式;statsmodels 可能静默 drop rows,必须报告样本数变化。",
        "分类变量编码和交互项解释容易出错,必要时用边际效应或预测曲线辅助说明。",
        "时间序列模型要检查平稳性、季节性、滞后阶数和 out-of-sample 验证。",
      ],
    },
    {
      name: "scikit-learn",
      description:
        "Classical machine learning in Python with scikit-learn: preprocessing, pipelines, model selection, classification, regression, clustering, and evaluation.",
      tags: ["science", "machine-learning", "sklearn", "python", "modeling"],
      related: ["statistical-analysis", "matplotlib"],
      license: "BSD-3-Clause license",
      title: "scikit-learn machine learning",
      useWhen: [
        "用户要做结构化数据的分类、回归、聚类、降维、特征工程、模型选择或评估。",
        "需要可复现、可解释的传统 ML baseline,而不是直接上深度学习。",
        "需要 pipeline 防止数据泄漏。",
      ],
      workflow: [
        "明确预测目标、样本粒度、特征可用时间点和评价指标。",
        "先切分数据,再在 training split 内 fit preprocessing;使用 Pipeline/ColumnTransformer 防泄漏。",
        "建立 dummy/linear/tree baseline,再做交叉验证和调参。",
        "分类任务检查 class imbalance、calibration、confusion matrix、ROC/PR;回归任务检查残差和误差分布。",
        "报告验证策略、随机种子、数据切分、指标置信范围和限制。",
      ],
      pitfalls: [
        "时间序列、同一患者/用户/样本多行数据不能随机打散;用 GroupKFold/TimeSeriesSplit 等合适切分。",
        "不在测试集上做特征选择、缺失值填补参数学习或阈值调优。",
        "高准确率不等于可部署;检查偏差、漂移、解释性和科研合理性。",
      ],
    },
    {
      name: "sympy",
      description:
        "Exact symbolic math in Python with SymPy: algebra, calculus, equation solving, symbolic linear algebra, mechanics, simplification, and code generation.",
      tags: ["science", "symbolic-math", "algebra", "calculus", "python"],
      license: "SymPy license",
      title: "SymPy symbolic mathematics",
      useWhen: [
        "用户需要精确代数、微积分、方程求解、矩阵符号运算、级数、符号推导或生成可执行公式代码。",
        "浮点数值计算会丢精度,或需要展示推导过程而不仅是数值答案。",
        "需要把论文公式、模型方程或物理推导转成可验证 Python 代码。",
      ],
      workflow: [
        "用 symbols() 明确变量和假设(positive, real, integer 等),减少歧义。",
        "先保留 exact rational/symbolic 表达式,最后才 evalf() 转数值。",
        "对方程求解同时检查解析解和数值解;验证代回原方程。",
        "复杂表达式使用 simplify/factor/expand/collect 要有目标,不要盲目 simplify。",
        "需要高性能时用 lambdify 或 codegen,并用数值点测试等价性。",
      ],
      pitfalls: [
        "符号假设影响积分、求解和化简结果;结果异常时先检查 assumptions。",
        "多值函数、分段函数、复数域和奇点要明确说明。",
        "不要把符号结果当成实验结论;它只是数学推导或模型辅助。",
      ],
    },
    {
      name: "pymc",
      description:
        "Bayesian modeling with PyMC: hierarchical models, MCMC/NUTS, posterior predictive checks, LOO/WAIC comparison, and uncertainty-aware inference.",
      tags: ["science", "bayesian", "statistics", "pymc", "uncertainty"],
      related: ["statistical-analysis", "statsmodels"],
      license: "Apache License, Version 2.0",
      title: "PyMC Bayesian modeling",
      useWhen: [
        "用户需要贝叶斯回归、层级模型、部分池化、先验建模、后验不确定性或 posterior predictive checks。",
        "频率学模型无法自然表达层级结构、缺失机制、测量误差或先验知识。",
        "需要比较模型并解释不确定性,而不是只给点估计和 p 值。",
      ],
      workflow: [
        "写清楚生成过程:观测变量、潜变量、层级、噪声分布、先验和待估参数。",
        "从最小模型开始,确认采样稳定后再加层级/交互/非线性。",
        "检查 MCMC 诊断:R-hat、ESS、divergences、trace plot、energy/BFMI。",
        "用 posterior predictive check 看模型是否能复现实测数据的关键统计特征。",
        "模型比较用 LOO/WAIC 时同时报告不确定性,不要机械选择分数略高的模型。",
      ],
      pitfalls: [
        "解释先验选择和敏感性;不要把默认 weakly-informative prior 当作无先验。",
        "报告 posterior mean/median、HDI/credible interval、关键概率陈述。",
        "如果采样失败,优先重参数化、标准化变量、检查模型结构,不要盲目加 draws。",
      ],
    },
    {
      name: "pymoo",
      description:
        "Multi-objective and constrained optimization with pymoo: NSGA-II/III, MOEA/D, Pareto fronts, decision making, and benchmark problems.",
      tags: ["science", "optimization", "pareto", "multi-objective"],
      license: "Apache-2.0 license",
      title: "pymoo optimization",
      useWhen: [
        "用户有单目标或多目标优化问题,尤其需要 Pareto front、约束处理、设计变量边界和决策权衡。",
        "目标函数来自仿真、实验、ML 代理模型或昂贵黑盒函数。",
        "需要比较不同优化算法或把优化结果可视化。",
      ],
      workflow: [
        "明确定义变量、上下界、目标方向(min/max)、约束和不可行条件。",
        "先用小规模样例/已知 benchmark 验证问题编码,再跑真实昂贵目标。",
        "对随机算法固定 seed,记录 population size、generations、termination 条件。",
        "多目标结果必须展示 Pareto front,并解释 trade-off;不要只选一个点不说明偏好。",
        "对昂贵目标设置预算、checkpoint 和中间结果保存。",
      ],
      pitfalls: [
        "检查目标函数符号:pymoo 常以 minimize 表达,最大化需要取负或转换。",
        "约束方向要统一,避免 g(x) <= 0 / >= 0 写反。",
        "对 noisy objective,重复评估或使用稳健指标,不要过度解读单次最优。",
      ],
    },
    {
      name: "aeon",
      description:
        "Time-series machine learning with aeon: classification, regression, clustering, forecasting, anomaly detection, segmentation, distances, and benchmarking.",
      tags: ["science", "time-series", "machine-learning", "forecasting"],
      license: "BSD-3-Clause license",
      title: "aeon time-series machine learning",
      useWhen: [
        "用户有时间序列、传感器、金融/业务序列、实验过程曲线,想做分类、回归、聚类、预测、异常检测或相似性搜索。",
        "需要比较多个 time-series 模型、构造 benchmark、选择距离度量或评估切分策略。",
        "需要把非结构化序列问题转成可重复的 Python 分析流程。",
      ],
      workflow: [
        "明确任务类型:forecasting / classification / regression / clustering / anomaly detection / segmentation。",
        "检查数据形状:单变量还是多变量;等长还是不等长;采样频率是否规则;是否有缺失值。",
        "建立基线:先用简单模型或 naive forecast,再引入 aeon 的专用 estimator。",
        "使用时间感知验证:forecasting 用 rolling/temporal split;分类回归避免随机打乱造成泄漏。",
        "汇报指标时同时给 baseline、模型指标、置信区间或重复实验方差。",
      ],
      pitfalls: [
        "先检查是否已安装 aeon;缺失时只为当前任务安装必要依赖。",
        "数据预处理要保留时间顺序;不要在全量数据上先 fit scaler 再切分。",
        "对小样本或强自相关序列,优先做简单可解释模型和误差可视化。",
      ],
    },
    {
      name: "scanpy",
      description:
        "Single-cell RNA-seq analysis with Scanpy: QC, normalization, highly variable genes, PCA/UMAP, clustering, marker genes, and trajectory-ready preprocessing.",
      tags: ["science", "bioinformatics", "single-cell", "rnaseq", "scanpy"],
      related: ["scvi-tools", "statistical-analysis"],
      license: "BSD-3-Clause license",
      title: "Scanpy single-cell RNA-seq analysis",
      useWhen: [
        "用户要分析 scRNA-seq / single-cell omics 数据,包括 QC、过滤、归一化、降维、聚类、marker gene 和可视化。",
        "输入是 .h5ad、10x mtx、AnnData 或表达矩阵。",
        "需要构建可复现的单细胞分析 notebook/script。",
      ],
      workflow: [
        "确认数据来源、物种、批次、样本设计、是否含临床/隐私信息。",
        "QC:检查每个细胞 UMI/genes、线粒体比例、双细胞风险、空 droplets;记录过滤阈值理由。",
        "标准流程:normalize/log1p → HVG → scale/PCA → neighbors → UMAP/tSNE → Leiden/Louvain clustering。",
        "marker 分析要结合 batch/sample composition,不要把 cluster marker 直接解释成因果或诊断结论。",
        "保存中间 .h5ad、图和参数;图上标注样本、批次、cluster、已知 marker。",
      ],
      pitfalls: [
        "不做诊断、治疗或患者级结论;若数据可能含 PHI,先确认本地处理和脱敏要求。",
        "外部数据库注释或上传分析前必须征得用户同意。",
        "对小样本/强批次效应结果要明确不确定性和验证需求。",
      ],
    },
    {
      name: "scvi-tools",
      description:
        "Deep generative modeling for single-cell omics with scvi-tools: batch correction, latent representations, transfer learning, multimodal/spatial models, and differential expression.",
      tags: ["science", "bioinformatics", "single-cell", "scvi", "deep-learning"],
      related: ["scanpy", "statistical-analysis"],
      license: "BSD-3-Clause license",
      title: "scvi-tools single-cell generative models",
      useWhen: [
        "用户需要 scVI/scANVI/TOTALVI/MultiVI 等模型做 batch correction、latent embedding、label transfer 或多组学整合。",
        "Scanpy 标准流程不足以处理强批次效应、半监督注释、多模态数据或 probabilistic differential expression。",
        "用户希望在单细胞任务中量化模型不确定性。",
      ],
      workflow: [
        "先用 Scanpy 完成基本 QC,确认 AnnData 字段、batch key、label key、layer/raw counts 是否正确。",
        "只把原始 counts 或合适 layer 交给模型;不要把 log-normalized 数据误当 count 输入。",
        "设置并记录 batch covariates、categorical/continuous covariates、模型版本、seed、训练轮数和硬件。",
        "训练后检查 latent space、batch mixing、biological signal 保留、reconstruction/ELBO 趋势。",
        "差异表达和 label transfer 输出要结合实验设计和验证数据解释,不要给临床结论。",
      ],
      pitfalls: [
        "深度模型可能过度校正或抹掉真实生物差异;必须比较校正前后 marker/condition 信号。",
        "大数据训练耗 CPU/GPU/内存;先估算资源,必要时抽样 smoke test。",
        "私有生物医学数据默认本地处理;外部模型/云训练前先征得用户同意。",
      ],
    },
  ] as const;

  function ensureAgentSeedSkill(agentId: string, name: string, content: string): void {
    try {
      // Platform per-agent seeds live in a dedicated READ-ONLY layer ("seed-skills"),
      // physically separate from the user-writable per-agent skills dir, so the
      // user-level shared-library overlay never treats them as deletable user data
      // (agent-seed wins over legacy on read; reserved on write).
      const skillDir = join(ocConfigDir, "agents", agentId, "seed-skills", name);
      const skillPath = join(skillDir, "SKILL.md");
      if (existsSync(skillPath)) return;
      if (existsSync(skillDir)) {
        const st = lstatSync(skillDir);
        if (!st.isDirectory() || st.isSymbolicLink()) {
          console.error(`[entrypoint] WARN: scientist skill seed skipped for ${name}: non-directory or symlinked skill dir`);
          return;
        }
      } else {
        mkdirSync(skillDir, { recursive: true });
      }
      if (!existsSync(skillPath)) writeFileSync(skillPath, content, { mode: 0o644 });
    } catch (skillErr) {
      console.error(
        `[entrypoint] WARN: scientist skill seed skipped for ${name}: ${(skillErr as Error).message}`,
      );
    }
  }

  for (const seed of SCIENTIST_SKILL_SEEDS) {
    ensureAgentSeedSkill("scientist", seed.name, scientificSkillContent(seed));
  }

  function isAgentWithId(value: unknown, id: string): value is Record<string, unknown> {
    return isRecord(value) && value.id === id;
  }

  // unknown → 类型收窄适配器,实际成员判定委派给 @openclaude/protocol 单一权威
  // (上方 isHiddenSystemAgentIdShared)。此处不再手抄 'hidden-reviewer' 字面量。
  function isHiddenSystemAgentId(id: unknown): boolean {
    return typeof id === "string" && isHiddenSystemAgentIdShared(id);
  }

  function isHiddenSystemAgentRoute(route: unknown): boolean {
    return isRecord(route) && isHiddenSystemAgentId(route.agent);
  }

  const PLATFORM_SEED_DISPLAY_NAMES = new Set([
    "main",
    "MiniMax M3 助手",
    "GLM-5.2 助手",
    "全能助手",
    "资料研究员",
    "科研分析师",
    "代码工程师",
    "审阅员",
    "GPT 5.5 (Codex)",
    // 遗留 display 识别串:旧版镜像把 main 污染成 GPT 5.5 默认显示的容器在
    // merge 时被规范化回 ccb 默认(main 仍归 glm-5.2;codex agent 独立 seed)。
    "GPT 5.5 (default)",
    "GPT 5.5 队长",
    "GPT-5.6-Sol 队长",
  ]);

  const LEGACY_RESEARCHER_TOOLSETS = [
    CORE_TOOLSET_ID,
    BROWSER_TOOLSET_ID,
    RESEARCH_TOOLSET_ID,
  ] as const;
  const LEGACY_CODER_TOOLSETS = [CORE_TOOLSET_ID, BROWSER_TOOLSET_ID] as const;

  function legacyPlatformToolsetsForSeed(id: unknown): readonly (readonly string[])[] {
    switch (id) {
      case "researcher":
        return [LEGACY_RESEARCHER_TOOLSETS];
      case "coder":
        return [LEGACY_CODER_TOOLSETS];
      default:
        return [];
    }
  }

  function isLegacyPlatformSeedToolsets(id: unknown, toolsets: unknown): boolean {
    return legacyPlatformToolsetsForSeed(id).some((legacy) => sameStringArray(toolsets, legacy));
  }

  function patchPlatformSeedAgent(
    agent: Record<string, unknown>,
    desired: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const next = { ...agent };
    let patched = false;
    const displayNameBefore = typeof agent.displayName === "string" ? agent.displayName.trim() : "";
    const shouldRefreshDisplay = displayNameBefore === "" || displayNameBefore === desired.id || PLATFORM_SEED_DISPLAY_NAMES.has(displayNameBefore);

    const setField = (key: string, value: unknown) => {
      if (next[key] !== value) {
        next[key] = value;
        patched = true;
      }
    };

    setField("model", desired.model);
    setField("provider", desired.provider);

    if (desired.runnerKind !== undefined) {
      setField("runnerKind", desired.runnerKind);
    } else if (next.runnerKind !== undefined) {
      delete next.runnerKind;
      patched = true;
    }

    if (typeof next.persona !== "string" || next.persona.trim() === "") {
      if (desired.persona !== undefined) setField("persona", desired.persona);
    }
    if (shouldRefreshDisplay) {
      if (desired.displayName !== undefined) setField("displayName", desired.displayName);
      if (desired.avatarEmoji !== undefined) setField("avatarEmoji", desired.avatarEmoji);
    } else if (typeof next.avatarEmoji !== "string" || next.avatarEmoji.trim() === "") {
      if (desired.avatarEmoji !== undefined) setField("avatarEmoji", desired.avatarEmoji);
    }
    if (typeof next.permissionMode !== "string" || next.permissionMode.trim() === "") {
      if (desired.permissionMode !== undefined) setField("permissionMode", desired.permissionMode);
    }
    if (Array.isArray(desired.toolsets)) {
      if (!Array.isArray(next.toolsets)) {
        setField("toolsets", desired.toolsets);
      } else if (
        isLegacyPlatformSeedToolsets(desired.id, next.toolsets) &&
        !sameStringArray(next.toolsets, desired.toolsets)
      ) {
        setField("toolsets", desired.toolsets);
      }
    }

    // hidden-reviewer 是新保留的系统 agent。存量容器可能已有用户/市场同名
    // agent；必须强制收敛成隐藏系统 seed,不能保留 source/persona/toolsets/cwd
    // 等用户可控字段,否则会暴露到协作列表或扩大隐藏审查员工具面。
    if (desired.id === "hidden-reviewer") {
      for (const key of ["source", "cwd", "greeting", "mcpServers"]) {
        if (next[key] !== undefined) {
          delete next[key];
          patched = true;
        }
      }
      for (const key of ["persona", "permissionMode", "displayName", "avatarEmoji"] as const) {
        if (desired[key] !== undefined) setField(key, desired[key]);
      }
      if (Array.isArray(desired.toolsets) && !sameStringArray(next.toolsets, desired.toolsets)) {
        setField("toolsets", desired.toolsets);
      }
    }

    return patched ? next : null;
  }

  // 期望的 codex agent 配置 —— 型号由 protocol DEFAULT_CODEX_ENGINE_MODEL 统一。
  const desiredCodexAgent = {
    id: "codex",
    model: COMMERCIAL_CODEX_MODEL,
    permissionMode: "bypassPermissions",
    provider: "codex-native",
    runnerKind: "app-server",
    displayName: `${DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME} 队长`,
    avatarEmoji: "🤖",
  };

  const desiredMainAgent = {
    id: "main",
    model: COMMERCIAL_DEFAULT_MODEL,
    persona: ensureAgentPersona("main", "你是 OpenClaude 商业版的默认全能助手,用简洁中文直接回答。\n"),
    permissionMode: "bypassPermissions",
    provider: COMMERCIAL_DEFAULT_PROVIDER,
    displayName: "全能助手",
    avatarEmoji: "🧠",
  };

  const desiredHiddenReviewerAgent = {
    id: "hidden-reviewer",
    model: COMMERCIAL_HIDDEN_REVIEWER_MODEL,
    persona: ensureAgentPersona(
      "hidden-reviewer",
      // 裁决词汇(PASS / NEEDS_FIX)的单一权威源 = @openclaude/protocol 的 REVIEW_VERDICT_PASS /
      // REVIEW_VERDICT_NEEDS_FIX(packages/protocol/src/teamCards.ts)。entrypoint.ts 是容器内运行时
      // 脚本、非 tsc 编译、不能 import protocol,故此处硬编码这两个字面量;靠 commercial 的
      // runtimeEntrypointPolicy.test.ts 两源一致性测试锁死不漂移(protocol 加/改裁决词而这里没跟 → 测试红)。
      // 输出契约:审查完在回复末尾另起一行,独占一行输出 `VERDICT: PASS` 或 `VERDICT: NEEDS_FIX`,
      // 由 gateway parseVerificationVerdict(/^VERDICT:\s*(PASS|FAIL|PARTIAL|NEEDS_FIX)\s*$/m)可靠解析。
      [
        "你是 OpenClaude v5 团队模式的隐藏审查员。",
        "你的职责是在队长给出最终答复前，对草稿做独立审查：找事实错误、遗漏、过度承诺、执行风险和用户需求偏离。",
        "先用简洁要点列出必须修改的问题和建议改法；不要接管任务、不要重写全文。",
        "审查完成后，你必须在回复的最后另起一行，单独输出一条结构化裁决行，供系统解析：",
        "若无阻塞问题、可以放行，最后一行顶格、独占一行输出（行内不得有任何其它字符）：",
        "VERDICT: PASS",
        "若存在必须修改的问题，最后一行改为输出：",
        "VERDICT: NEEDS_FIX",
        "裁决行硬性格式要求：行首顶格、全大写、单独成行，严格等于 `VERDICT: PASS` 或 `VERDICT: NEEDS_FIX`（冒号后恰好一个空格，行内不得有其它任何字符）。",
        "只允许 PASS 和 NEEDS_FIX 这两个取值；不要输出 FAIL / PARTIAL / OK 或其它任何词。",
        "PASS = 无阻塞问题；NEEDS_FIX = 存在必须修改的问题。",
        "这一行是给系统解析用的、必须存在：缺少它系统会判定“审查未完成”并降级放行。",
        "",
      ].join("\n"),
      [],
      { force: true },
    ),
    permissionMode: "bypassPermissions",
    provider: COMMERCIAL_HIDDEN_REVIEWER_PROVIDER,
    displayName: "隐藏审查员",
    avatarEmoji: "🕵️",
    toolsets: [CORE_TOOLSET_ID],
  };

  // v5 纯市场模型:容器默认只 seed「全能助手」(main)。历史平台预置子 agent
  // (researcher/scientist/coder/reviewer/scholar)已退役 —— 其它用户可见 agent 一律走市场安装
  // (syncMarketplaceHub 直写 agents.yaml + source:marketplace 标记)。hidden-reviewer 是团队
  // 模式专用系统审查员,不带 source:marketplace,因此不会进入 AgentPicker/协作成员列表。
  // 存量容器里的幽灵 seed 不 prune,但 listCollaboratorAgents 的 marketplace-source 过滤已让它们在所有面惰性。
  const desiredSeedAgents = [desiredMainAgent, desiredCodexAgent, desiredHiddenReviewerAgent];

  // v5 轻量组队重构:不再预置团队(队长 turn 级自主 delegate_task 组队)。保留空数组,
  // 让下方 bootstrap 的 .map(cloneSeedTeam) 与 merge 团队循环自然成为 no-op —— 团队相关
  // helper(cloneSeedTeam/patchPlatformSeedTeam 等)因此仍被引用,不删(避免在非 tsc 校验的
  // 运行时脚本里拆一大片互相依赖的 helper);存量容器已有的团队条目按设计不 prune,保持惰性。
  const desiredSeedTeams: Record<string, unknown>[] = [];

  function cloneSeedTeam(team: Record<string, unknown>): Record<string, unknown> {
    return {
      ...team,
      members: Array.isArray(team.members)
        ? team.members.map((m) => (isRecord(m) ? { ...m } : m))
        : [],
      policy: isRecord(team.policy) ? { ...team.policy } : undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  function teamMemberIds(team: unknown): string[] {
    if (!isRecord(team) || !Array.isArray(team.members)) return [];
    return team.members
      .map((m) => (isRecord(m) && typeof m.agentId === "string" ? m.agentId : ""))
      .filter(Boolean);
  }

  const LEGACY_SCIENCE_TEAM_MEMBER_IDS = ["researcher", "coder", "reviewer"] as const;

  function hasLegacyPlatformSeedTeamPrompt(team: Record<string, unknown>, desiredId: unknown): boolean {
    const serialized = JSON.stringify(team);
    if (desiredId === "science_research_team") {
      return (
        serialized.includes("优先把资料检索交给 researcher") ||
        serialized.includes("把数据/复现交给 coder") ||
        serialized.includes("数据与图表工程师") ||
        serialized.includes("围绕研究问题检索和筛选高可信资料") ||
        // 2026-06 引用接地工作流上线:把上一版(无 oc-lit/cite manifest 流程)的科研 team
        // 也识别为 legacy,使存量 seed 升级到带引用接地的新 prompt。新 prompt 不含这些标记。
        serialized.includes("你是科研协作队长") ||
        serialized.includes("围绕研究问题整理和筛选高可信资料") ||
        serialized.includes("像严格审稿人一样检查证据是否支撑结论")
      );
    }
    if (desiredId === "programming_team") {
      return (
        serialized.includes("默认不假设浏览器工具已挂载") === false &&
        (serialized.includes("把技术调研交给 researcher,把实现交给 coder") ||
          serialized.includes("查官方文档、现有实现、依赖约束和可选方案") ||
          serialized.includes("优先查官方文档、仓库现有模式和真实约束"))
      );
    }
    return false;
  }

  function isDefaultSeedTeamShape(team: unknown, desired: Record<string, unknown>): boolean {
    if (!isRecord(team)) return false;
    const name = typeof team.name === "string" ? team.name : "";
    const leader = typeof team.leaderAgentId === "string" ? team.leaderAgentId : "";
    const memberIds = teamMemberIds(team);
    const desiredMemberIds = teamMemberIds(desired);
    const defaultName = name === "" || name === desired.name;
    const defaultLeader = leader === "" || leader === "main" || leader === "codex";
    const defaultMembers = memberIds.length === 0 || sameStringSet(memberIds, desiredMemberIds);
    const legacyScienceMembers =
      desired.id === "science_research_team" &&
      sameStringSet(memberIds, LEGACY_SCIENCE_TEAM_MEMBER_IDS) &&
      hasLegacyPlatformSeedTeamPrompt(team, desired.id);
    return defaultName && defaultLeader && (defaultMembers || legacyScienceMembers);
  }

  function patchPlatformSeedTeam(
    team: Record<string, unknown>,
    desired: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (!isDefaultSeedTeamShape(team, desired)) return null;
    const next = cloneSeedTeam(desired);
    const currentLeader = typeof team.leaderAgentId === "string" ? team.leaderAgentId : "";
    const currentMembers = teamMemberIds(team);
    if (
      currentLeader === desired.leaderAgentId &&
      sameStringSet(currentMembers, teamMemberIds(desired)) &&
      team.name === desired.name &&
      !hasLegacyPlatformSeedTeamPrompt(team, desired.id)
    ) {
      return null;
    }
    return next;
  }

  if (!existsSync(agentsPath)) {
    const initialDoc = {
      agents: desiredSeedAgents,
      routes: [],
      default: "main",
      teams: desiredSeedTeams.map(cloneSeedTeam),
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
      // 重新写一份完整的平台 seed yaml(保险)
      const initialDoc = {
        agents: desiredSeedAgents,
        routes: [],
        default: "main",
        teams: desiredSeedTeams.map(cloneSeedTeam),
      };
      writeFileSync(agentsPath, YAML.stringify(initialDoc), { mode: 0o644 });
      console.error(`[entrypoint] rewrote agents.yaml at ${agentsPath} (parse failed or empty)`);
    } else {
      const doc = parsed as { agents?: unknown; routes?: unknown; default?: unknown; teams?: unknown };
      const agents = Array.isArray(doc.agents) ? [...(doc.agents as unknown[])] : [];
      let mutated = false;

      let backupPath: string | null = null;
      const backupAgentsYamlOnce = (reason: string): string => {
        if (backupPath) return backupPath;
        const bakSuffix = randomBytes(4).toString("hex");
        backupPath = `${agentsPath}.bak.${bakSuffix}`;
        try {
          copyFileSync(agentsPath, backupPath);
        } catch (bakErr) {
          console.error(
            `[entrypoint] WARN: agents.yaml ${reason} 前 .bak 备份失败: ${(bakErr as Error).message}`,
          );
        }
        return backupPath;
      };

      for (const desiredAgent of desiredSeedAgents) {
        const idx = agents.findIndex((a) => isAgentWithId(a, desiredAgent.id));
        if (idx < 0) {
          if (desiredAgent.id === "main") agents.unshift(desiredAgent);
          else agents.push(desiredAgent);
          mutated = true;
          console.error(`[entrypoint] agents.yaml: appended ${desiredAgent.id} agent`);
          continue;
        }
        if (!isRecord(agents[idx])) continue;
        const patchedAgent = patchPlatformSeedAgent(agents[idx], desiredAgent);
        if (patchedAgent) {
          const bakPath = backupAgentsYamlOnce(`修复 ${desiredAgent.id} seed agent`);
          agents[idx] = patchedAgent;
          mutated = true;
          console.error(
            `[entrypoint] agents.yaml: normalized ${desiredAgent.id} seed agent (原文件备份到 ${bakPath})`,
          );
        }
      }

      const teams = Array.isArray(doc.teams) ? [...(doc.teams as unknown[])] : [];
      for (const desiredTeam of desiredSeedTeams) {
        const idx = teams.findIndex((t) => isRecord(t) && t.id === desiredTeam.id);
        if (idx < 0) {
          teams.push(cloneSeedTeam(desiredTeam));
          mutated = true;
          console.error(`[entrypoint] agents.yaml: appended ${desiredTeam.id} team`);
          continue;
        }
        if (!isRecord(teams[idx])) continue;
        const patchedTeam = patchPlatformSeedTeam(teams[idx], desiredTeam);
        if (patchedTeam) {
          const bakPath = backupAgentsYamlOnce(`修复 ${desiredTeam.id} team`);
          teams[idx] = patchedTeam;
          mutated = true;
          console.error(
            `[entrypoint] agents.yaml: normalized ${desiredTeam.id} team (原文件备份到 ${bakPath})`,
          );
        }
      }

      const agentIds = new Set(
        agents
          .filter((a): a is Record<string, unknown> => isRecord(a))
          .map((a) => a.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const rawRoutes = Array.isArray(doc.routes) ? [...(doc.routes as unknown[])] : [];
      const routes = rawRoutes.filter((route) => !isHiddenSystemAgentRoute(route));
      if (!Array.isArray(doc.routes) || routes.length !== rawRoutes.length) mutated = true;
      const nextDefault =
        typeof doc.default === "string" && agentIds.has(doc.default) && !isHiddenSystemAgentId(doc.default)
          ? doc.default
          : "main";
      if (doc.default !== nextDefault) mutated = true;
      if (mutated) {
        const newDoc = {
          ...doc,
          agents,
          routes,
          default: nextDefault,
          teams,
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
