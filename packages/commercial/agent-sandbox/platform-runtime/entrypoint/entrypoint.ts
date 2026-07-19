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
  chownSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isProviderManagedEnvVar } from "/opt/openclaude/claude-code-best/src/utils/managedEnvConstants.ts";
// 隐藏系统 agent id 的单一权威(与 gateway 编译期共享,不再手抄黑名单)。绝对路径
// import 与上面 managedEnvConstants 同构:容器内整棵 packages 树在 /opt/openclaude/,
// entrypoint 用 tsx 直接跑、被 Dockerfile COPY 到 /usr/local/lib/openclaude(父链无
// node_modules),故用工作区根的绝对源码路径。本文件不进 commercial tsconfig 编译图,
// 一致性由 runtimeEntrypointPolicy.test.ts 守护。
import { isHiddenSystemAgentId as isHiddenSystemAgentIdShared } from "/opt/openclaude/packages/protocol/src/agentVisibility.ts";
// codex 型号目录(id → 显示名)。**不再**从这里取 seed 模型:模型权威已下沉到 platform-seed.yaml
// 声明(schema v2)。这里只用来按**声明的 model** 反查队长显示名 —— 显示名的单一权威仍在 protocol。
import { CODEX_ENGINE_MODELS } from "/opt/openclaude/packages/protocol/src/engineModels.ts";
// platform bundle 纯函数集(seed 声明校验 / seed·codex-skill 目录解析 / 覆写决策 / seed agent 合并)。
// 相对 import:本文件被打进 bundle 的 entrypoint/(生产)或镜像 /usr/local/lib/openclaude/(dev
// fallback),platformBundle.ts 与本文件同目录同步 COPY/bundle,故 `./` 在两处都解析得到。
// 该模块**不进 commercial tsc 编译图**(与 entrypoint.ts 同,靠 entrypointPlatform.test.ts 守护)。
import {
  assertVolumeAncestryNoSymlink,
  buildSeedAgent,
  decidePersonaWrite,
  DEV_FALLBACK_SEED_DOC,
  isPathWithin,
  resolvePlatformCodexSkillsDir,
  resolvePlatformSeedDir,
  safeWritePlatformVolumeFile,
  sha256Hex,
  shouldWriteSeededSkill,
  validatePlatformSeed,
  validateSeedAssetsExist,
  type PlatformSeedAgentDecl,
  type PlatformSeedDoc,
} from "./platformBundle.ts";

// entrypoint.ts 文件被 Dockerfile COPY 到 /usr/local/lib/openclaude/,而 yaml 模块装在
// 容器内 /opt/openclaude/node_modules/yaml(npm workspaces 装到根)。Node ESM/require
// 默认从文件位置沿父链找 node_modules,/usr/local/lib/openclaude/ 父链没 node_modules,
// 直接 import "yaml" 会 MODULE_NOT_FOUND。createRequire 锚到 /opt/openclaude/package.json
// 把 resolution 起点显式拉到工作区根。
const requireFromOC = createRequire("/opt/openclaude/package.json");
const YAML: typeof import("yaml") = requireFromOC("yaml");

// ───────────────────────────────────────────────
// 0. platform bundle seed 加载(runtime hotcfg P2a/§4a)
// ───────────────────────────────────────────────
// 自钉:realpath 穿透 current symlink 得本 entrypoint 所在 **rev-pinned** bundle 路径;seed /
// persona / codex-skill 一律相对本文件解析(不走 current),翻转期一次执行不混用两版。
const SELF_ENTRY_DIR = dirname(realpathSync(fileURLToPath(import.meta.url)));

// seed 根解析次序(设计 §5d):自身 bundle 相对 → /usr/local/share/openclaude-platform/seed → null。
const platformSeedDir = resolvePlatformSeedDir(SELF_ENTRY_DIR, existsSync, join);
// M5 confinement:seed 根 realpath 一次(穿透 current + 收 `..`),作为源路径 containment 基准。
const platformSeedDirReal = platformSeedDir === null ? null : realpathSync(platformSeedDir);
// 平台 seed 声明(执行三元组 model/provider/runnerKind + persona 引用 + 非计费 defaults + seedSkills
// 清单;schema v2)。**fail loud 放在下方 volume try 之外**:声明缺 model / provider 不在已知集 /
// 含 engine 键 / schema 版本未知 = 部署配置错,须立即崩(§5),不能被 volume-tolerant catch 吞成 WARN。
// dev fallback(yaml 缺失)= null → 回落 DEV_FALLBACK_SEED_DOC(仅 main 的最小内置**声明**)。
let platformSeed: PlatformSeedDoc | null = null;
// persona 文本在 top-level 预读(bundle ro,始终在);缺失 = 坏 bundle,fail loud。写卷在 volume try 里。
const seedPersonas: Record<string, string> = {};

// M5 Part B:把 bundle seed 下的**源文件**路径 join 后做 normalize+realpath containment,越界即抛。
// schema(validatePlatformSeed)已 slug/persona-ref 收敛为一道防线;这里是消费端二道防线,
// 兜住"schema 被绕过 / 未来新增声明字段忘了收敛"的路径逃逸。
function readConfinedSeedFile(relParts: string[], what: string): string {
  const abs = join(platformSeedDir!, ...relParts);
  const absReal = realpathSync(abs); // 源必存在(bundle ro);顺带解 symlink
  if (!isPathWithin(platformSeedDirReal!, absReal)) {
    throw new Error(`platform-seed: ${what} path escapes bundle seed dir: ${relParts.join("/")}`);
  }
  return readFileSync(absReal, "utf8");
}

if (platformSeedDir === null) {
  console.error(
    "[entrypoint] platform-seed dev fallback: no platform-seed.yaml on bundle/fallback path → seeding minimal main-only set (dev-only)",
  );
} else {
  platformSeed = validatePlatformSeed(
    YAML.parse(readFileSync(join(platformSeedDir, "platform-seed.yaml"), "utf8")),
  );
  for (const decl of platformSeed.agents) {
    if (decl.persona) {
      seedPersonas[decl.id] = readConfinedSeedFile([decl.persona], `persona for agent "${decl.id}"`);
    }
  }
}
// 默认全能助手 persona 的 dev-fallback 内置文案(仅 platformSeed 缺失时用;与 personas/main.md 同源)。
const MAIN_FALLBACK_PERSONA = "你是 OpenClaude 商业版的默认全能助手,用简洁中文直接回答。\n";

// ── seed 声明 = 容器侧计费/引擎权威(schema v2 §5 阶段 A)──────────────────────
// entrypoint 不再持任何本地 model/provider 常量:main/codex/hidden-reviewer 的执行三元组、以及
// 容器 config.defaults.model,全部从**声明**派生。有 bundle → 用 bundle 的声明;无 bundle(dev)→
// 用 platformBundle.DEV_FALLBACK_SEED_DOC(同一套 buildSeedAgent 装配,不走第二条硬编码路径)。
const seedDoc: PlatformSeedDoc = platformSeed ?? DEV_FALLBACK_SEED_DOC;
const seedDeclOf = (id: string): PlatformSeedAgentDecl | undefined =>
  seedDoc.agents.find((a) => a.id === id);
// main 是平台默认 agent:缺它 = 坏 bundle(fail loud,volume try 之外)。
const seedMainDecl = seedDeclOf("main");
if (!seedMainDecl) {
  throw new Error('platform-seed: agent "main" is required (它同时是容器 config.defaults.model 的权威)');
}
/** 容器级 config.defaults.model —— 取 main seed agent 的**声明** model(单一权威)。 */
const CONTAINER_DEFAULT_MODEL = seedMainDecl.model;

/**
 * codex-native seed agent 的队长显示名:按**声明的 model** 反查 protocol 型号目录取显示名。
 * 声明的 model 不是 protocol 承认的 codex 型号 → fail loud(gateway registry 也会 fail-closed,
 * 这里提前在 boot 期拒,而不是等 turn 里报错)。
 */
function codexLeaderDisplayName(model: string): string {
  const spec = CODEX_ENGINE_MODELS.find((m) => m.id === model);
  if (!spec) {
    throw new Error(
      `platform-seed: codex-native agent model "${model}" is not a known codex engine model ` +
        `(protocol CODEX_ENGINE_MODELS: ${CODEX_ENGINE_MODELS.map((m) => m.id).join("/")})`,
    );
  }
  return `${spec.displayName} 队长`;
}
/** agentId → 动态显示名(仅 codex-native)。top-level 预算,fail loud 在 volume try 之外。 */
const seedDynamicDisplayNames: Record<string, string> = {};
for (const decl of seedDoc.agents) {
  if (decl.provider === "codex-native") {
    seedDynamicDisplayNames[decl.id] = codexLeaderDisplayName(decl.model);
  }
}

// R2-M4:所有平台向 volume 的写入统一走本 helper —— 祖先 symlink 逃逸拒 + mkdir 后 realpath 复核
// + 临时文件 rename 原子落盘(纯逻辑在 platformBundle.safeWritePlatformVolumeFile,此处注入真实 fs)。
// 失败抛,由调用方 catch → 跳过该 agent 平台 seed(不崩 entrypoint)。
function platformVolumeWrite(
  targetPath: string,
  volumeRoot: string,
  content: string | Buffer,
  mode: number,
): void {
  safeWritePlatformVolumeFile({
    targetPath,
    volumeRoot,
    content,
    mode,
    fs: { lstatSync, mkdirSync, realpathSync, writeFileSync, renameSync },
    dirname,
    randomSuffix: () => randomBytes(6).toString("hex"),
  });
}

// R2-M4:目录 mkdir 后复核 realpath 仍在 volume 子树内(codex skill overlay 走 cpSync 整目录,
// 不经 safeWritePlatformVolumeFile;单文件写已在该函数内自带此复核)。逃逸即抛 → 调用方 catch 跳过。
function assertDirWithinVolume(dir: string, volumeRoot: string): void {
  const dirReal = realpathSync(dir);
  const rootReal = realpathSync(volumeRoot);
  if (dirReal !== rootReal && !dirReal.startsWith(rootReal + "/")) {
    throw new Error(`path escapes volume root after mkdir: ${dirReal} not under ${rootReal}`);
  }
}

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

// 计费/引擎权威(model/provider/runnerKind)**已下沉到 platform-seed.yaml 声明**(schema v2,
// 模型权威批次 §5 阶段 A):entrypoint 不再持 COMMERCIAL_DEFAULT_MODEL / _PROVIDER /
// COMMERCIAL_CODEX_MODEL / COMMERCIAL_HIDDEN_REVIEWER_* 这些本地常量 —— 双端硬编码(entrypoint
// 常量 + master platformDefaults)正是滚动窗口计费分叉的根;权威改为"该容器 bundle rev 的声明",
// master 阶段 B 按容器 label 上的 bundle_rev 读同一份声明(ws/seedDeclarationLoader.ts)。
// 容器级默认模型见上方 CONTAINER_DEFAULT_MODEL(= main seed agent 的声明 model)。
// v5 纯市场:容器只 seed 声明里的 main + codex + hidden-reviewer,其它可见 agent 走市场安装。

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
    defaults.model = CONTAINER_DEFAULT_MODEL;
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
    config.defaults = { model: CONTAINER_DEFAULT_MODEL, permissionMode: "bypassPermissions", toolsets: [CORE_TOOLSET_ID] };
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

// ───────────────────────────────────────────────
// 1.5 validate-only 模式(R2-M2c:激活 saga 的 canary boot 冒烟入口)
// ───────────────────────────────────────────────
// OC_ENTRYPOINT_VALIDATE_ONLY=1 时:此刻 **env 清洗已完成**(上方 cleanEnv 全部构建),
// **bundle 解析已完成**(module top 的 SELF_ENTRY_DIR realpath + resolvePlatformSeedDir 已定
// rev 分流路径;platform-seed schema 校验与 persona 引用读取在 module top 已 fail-loud)。
// 这里只补 **seed skill 文件存在性**语义校验(persona 引用上方 readConfinedSeedFile 已 fail-loud;
// 但 seedSkills 文件原本要到下方 volume 块才读)—— 复用与 deploy prepare CLI 同一 validateSeedAssetsExist。
// 通过则 exit 0,**不写任何 volume、不 spawn gateway、不要求真实 master 可达**;任一失败非 0 退出 + stderr 原因。
// F2 以 `docker run --rm` + 假 anthropic env 调用本模式做激活前冒烟。entrypoint.sh 无需感知(此处早退)。
if ((process.env.OC_ENTRYPOINT_VALIDATE_ONLY || "").trim() === "1") {
  try {
    if (platformSeed && platformSeedDir) {
      const seedErrors = validateSeedAssetsExist(platformSeedDir, platformSeedDirReal!, platformSeed, {
        exists: existsSync,
        realpath: realpathSync,
        join,
      });
      if (seedErrors.length > 0) {
        console.error(`[entrypoint] validate-only FAILED (seed assets):\n  ${seedErrors.join("\n  ")}`);
        process.exit(1);
      }
    }
    console.error(
      "[entrypoint] validate-only OK: env scrub + bundle/seed parse + persona/seed-skill semantic checks passed (no volume write, no gateway spawn)",
    );
    process.exit(0);
  } catch (validateErr) {
    console.error(`[entrypoint] validate-only FAILED: ${(validateErr as Error).message}`);
    process.exit(1);
  }
}

// Debian `/etc/profile` 会在 `bash -lc` 中重置 Dockerfile 注入的 PATH，导致 Codex
// 看不到 `/run/oc/platform/current/bin`。用户 profile 会稳定把 `~/.local/bin` 加回
// PATH，因此为 platform-bundle 新增但镜像尚未内置的 oc-plugin 安装一个保留名链接。
// 不覆盖普通文件/目录/异向链接：这些异常只告警，避免 entrypoint 擅自删除用户内容。
const PLATFORM_PLUGIN_SOURCE = "/run/oc/platform/current/bin/oc-plugin";
const USER_PLATFORM_BIN_DIR = "/home/agent/.local/bin";
const USER_PLUGIN_LINK = join(USER_PLATFORM_BIN_DIR, "oc-plugin");
try {
  if (!existsSync(PLATFORM_PLUGIN_SOURCE)) {
    throw new Error("platform oc-plugin source is missing");
  }
  mkdirSync(USER_PLATFORM_BIN_DIR, { recursive: true });
  try {
    const target = lstatSync(USER_PLUGIN_LINK);
    if (!target.isSymbolicLink() || readlinkSync(USER_PLUGIN_LINK) !== PLATFORM_PLUGIN_SOURCE) {
      console.error(
        `[entrypoint] WARN: reserved ${USER_PLUGIN_LINK} already exists with an unexpected target; preserved`,
      );
    }
  } catch (linkErr) {
    if ((linkErr as NodeJS.ErrnoException).code !== "ENOENT") throw linkErr;
    symlinkSync(PLATFORM_PLUGIN_SOURCE, USER_PLUGIN_LINK);
  }
} catch (pluginLinkErr) {
  console.error(
    `[entrypoint] WARN: oc-plugin PATH link setup failed (non-fatal): ${(pluginLinkErr as Error).message}`,
  );
}

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
    // R3-m1:guard 必须在 mkdir **之前** —— recursive mkdir 会跟随 symlinked 祖先在卷外创建目录,
    // 事后 realpath 复核只能挡住文件写、挡不住目录已越界落盘。
    assertVolumeAncestryNoSymlink(targetSystemSkills, CODEX_HOME_DIR, lstatSync, dirname);
    mkdirSync(targetSystemSkills, { recursive: true });
    assertDirWithinVolume(targetSystemSkills, CODEX_HOME_DIR); // R2-M4:mkdir 后 realpath 复核
    for (const entry of readdirSync(bakedSystemSkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDir = join(bakedSystemSkills, entry.name);
      const sourceSkillMd = join(sourceDir, "SKILL.md");
      const targetDir = join(targetSystemSkills, entry.name);
      const targetSkillMd = join(targetDir, "SKILL.md");
      // (1) 镜像 populate 的 codex **原生** system skill:skip-if-exists,绝不覆盖用户/codex 侧状态。
      if (!existsSync(sourceSkillMd) || existsSync(targetSkillMd)) continue;
      // R2-M4:cp 前拒祖先/目标 symlink 逃逸(卷内容两次 boot 间可被容器改)。命中 → 跳过该 skill,不崩。
      try {
        assertVolumeAncestryNoSymlink(targetDir, CODEX_HOME_DIR, lstatSync, dirname);
      } catch (guardErr) {
        console.error(
          `[entrypoint] WARN: codex system skill "${entry.name}" skipped (symlink guard): ${(guardErr as Error).message}`,
        );
        continue;
      }
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

// ── (2) 平台自有 codex skill overlay(runtime hotcfg §2c)──
// 镜像 codex 原生 skill(上面 skip-if-exists)之后,叠加 **bundle 里平台自有** 的 codex skill
// (如 document-writing)。平台 skill 走 **hash 不一致即覆写**:平台更新版本时旧的 skip-if-exists
// 会让新内容送不达(缺陷)—— 这里修正。目录解析:自身 bundle ../codex-skills → dev fallback →
// 跳过(dev-only 日志)。原生 skill 的 skip-if-exists 不动(只有平台自有这层是 hash-overwrite)。
try {
  const platformCodexSkillsDir = resolvePlatformCodexSkillsDir(SELF_ENTRY_DIR, existsSync, join);
  const targetSystemSkills = join(TARGET_SKILLS, ".system");
  if (platformCodexSkillsDir === null) {
    console.error(
      "[entrypoint] platform codex-skills overlay skipped: no bundle/codex-skills on path (dev-only)",
    );
  } else {
    // R3-m1:guard 先于 mkdir(理由同上方 baked skills 段)。
    assertVolumeAncestryNoSymlink(targetSystemSkills, CODEX_HOME_DIR, lstatSync, dirname);
    mkdirSync(targetSystemSkills, { recursive: true });
    assertDirWithinVolume(targetSystemSkills, CODEX_HOME_DIR); // R2-M4:mkdir 后 realpath 复核
    for (const entry of readdirSync(platformCodexSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDir = join(platformCodexSkillsDir, entry.name);
      const sourceSkillMd = join(sourceDir, "SKILL.md");
      if (!existsSync(sourceSkillMd)) continue;
      const targetDir = join(targetSystemSkills, entry.name);
      const targetSkillMd = join(targetDir, "SKILL.md");
      const targetExists = existsSync(targetSkillMd);
      const sourceContent = readFileSync(sourceSkillMd);
      const targetContent = targetExists ? readFileSync(targetSkillMd) : null;
      if (shouldWriteSeededSkill("hash-overwrite", targetExists, targetContent, sourceContent)) {
        // R2-M4:覆写前拒祖先/目标 symlink 逃逸(rmSync+cpSync 会穿透 symlinked targetDir)。命中 → 跳过该 skill。
        try {
          assertVolumeAncestryNoSymlink(targetDir, CODEX_HOME_DIR, lstatSync, dirname);
        } catch (guardErr) {
          console.error(
            `[entrypoint] WARN: platform codex skill "${entry.name}" skipped (symlink guard): ${(guardErr as Error).message}`,
          );
          continue;
        }
        // 覆写:先清目标目录再整目录 cp,避免旧版残留附属文件;平台 skill 是权威。
        rmSync(targetDir, { recursive: true, force: true });
        cpSync(sourceDir, targetDir, { recursive: true, preserveTimestamps: true });
      }
    }
  }
} catch (e) {
  console.error(
    `[entrypoint] WARN: platform codex-skills overlay failed (non-fatal): ${(e as Error).message}`,
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

// mmx 等"容器→master 内桥"平台 CLI 的凭据文件。为什么不用 env:codex 引擎路径上这两个值
// 会被双重清洗剥掉 —— gateway buildCodexEnv 剥全部 OPENCLAUDE_* 前缀(遥测封堵,不可破),
// codex shell_environment_policy 默认又剥 *TOKEN* 形名字;经 argv `-c` 回注则违反
// 「容器 token 不进 argv/日志」不变量(codexLaunchOverrides.test 有防回归断言)。
// 文件通道三个不变量全保:scrub 不变、argv 无秘密、CCB ambient env 路径原样(文件只是回退)。
// token 随容器生命周期轮换 → 每次 boot 无条件覆写;同容器 trust domain(模型本就持有本容器
// bearer,与 CCB env 等价),0600 + 对齐 volume 属主仅防误读。消费方:oc-minimax.py(mmx)。
const containerAuthPath = join(ocConfigDir, "container-auth.json");
try {
  const mmxMasterBase = (process.env.OPENCLAUDE_V3_MASTER_BASE_URL || "").trim();
  const mmxContainerToken = (process.env.OPENCLAUDE_V3_CONTAINER_TOKEN || "").trim();
  if (mmxMasterBase && mmxContainerToken) {
    writeFileSync(
      containerAuthPath,
      `${JSON.stringify({ masterBaseUrl: mmxMasterBase, containerToken: mmxContainerToken })}\n`,
      { mode: 0o600 },
    );
    const dirStat = statSync(ocConfigDir);
    chownSync(containerAuthPath, dirStat.uid, dirStat.gid);
  }
} catch (err) {
  console.warn("[entrypoint] container-auth.json write failed(mmx 将回退 env,codex 路径可能不可用):", err);
}

// ── 默认工作目录(runtime hotcfg §3.2 R1-M6/R2-B2)──
// OPENCLAUDE_DEFAULT_WORKSPACE 由 supervisor 注入,指向 data named volume **内**路径
// (/home/agent/.openclaude/workspace)—— 关键:必须落在 volume 内,容器重建后文件仍在;
// 早期错落 /home/agent/workspace(writable layer)容器回收即丢。gateway sessionManager 缺省
// cwd 读该 env。env 未设(个人版/dev)= 现状不建。owner 对齐 volume(与 container-auth 同法)。
const defaultWorkspace = (process.env.OPENCLAUDE_DEFAULT_WORKSPACE || "").trim();
if (defaultWorkspace) {
  try {
    mkdirSync(defaultWorkspace, { recursive: true });
    const dirStat = statSync(ocConfigDir);
    chownSync(defaultWorkspace, dirStat.uid, dirStat.gid);
  } catch (wsErr) {
    console.error(
      `[entrypoint] WARN: default workspace mkdir failed (non-fatal): ${(wsErr as Error).message}`,
    );
  }
}

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
        model: CONTAINER_DEFAULT_MODEL,
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

  // M4b:persona 平台热更新 —— 用「上次写入的平台版本 hash」判定用户是否改过,记录在
  // agents/<id>/.platform-persona-hash。三态升级规则:
  //   目标不存在                              → 写 + 记 hash;
  //   当前内容 hash == 记录的上次平台 hash(用户没改过)→ 升级到新平台版 + 更新记录;
  //   当前 hash 与记录不符(用户定制)/ 记录缺失(存量 volume,保守)→ 跳过 + log。
  // force(hidden-reviewer 裁决词须稳定同步)→ 无条件覆写 + 刷新记录(不受定制保护)。
  // 用「记录上次平台 hash」取代旧的 legacyContents 逐版枚举:泛化为「用户改没改过」的单一判据,
  // 平台文案演进无需再维护历史全集。
  const PERSONA_HASH_FILE = ".platform-persona-hash";

  function readPlatformPersonaHash(hashPath: string): string | null {
    try {
      const raw = readFileSync(hashPath, "utf8").trim();
      return /^[0-9a-f]{64}$/.test(raw) ? raw : null; // 损坏/非法 → 视为无记录(保守)
    } catch {
      return null; // 记录缺失 → null
    }
  }
  function writePlatformPersonaHash(hashPath: string, hash: string): void {
    try {
      // R2-M4:hash 记录也走 symlink 逃逸纵深防御 + 原子落盘(与 persona 同 volume 子树)。
      platformVolumeWrite(hashPath, ocConfigDir, `${hash}\n`, 0o644);
    } catch (e) {
      console.error(
        `[entrypoint] WARN: ${hashPath} persona-hash record write failed (non-fatal): ${(e as Error).message}`,
      );
    }
  }

  function ensureAgentPersona(
    agentId: string,
    content: string,
    opts: { force?: boolean } = {},
  ): string {
    const personaDir = join(ocConfigDir, "agents", agentId);
    const personaPath = join(personaDir, "CLAUDE.md");
    const hashPath = join(personaDir, PERSONA_HASH_FILE);
    // M5 containment(二道防线):写目标必须落在 agents/<id>/ 子树内(agentId 虽为代码字面量,
    // 仍做归一化越界拒,与 seed-skill 写路径同款防线)。
    if (!isPathWithin(join(ocConfigDir, "agents"), personaPath)) {
      console.error(`[entrypoint] WARN: ${agentId} persona path escapes agents dir, skipped`);
      return personaPath;
    }
    // R3-m1:guard 先于 mkdir(recursive mkdir 会穿 symlinked 祖先在卷外建目录);
    // R2-M4:mkdir 后再 realpath 复核。两道均命中 → WARN 跳过该 agent persona,不崩。
    try {
      assertVolumeAncestryNoSymlink(personaDir, ocConfigDir, lstatSync, dirname);
      mkdirSync(personaDir, { recursive: true });
      assertDirWithinVolume(personaDir, ocConfigDir);
    } catch (guardErr) {
      console.error(
        `[entrypoint] WARN: ${agentId} persona dir escapes volume (symlink guard), skipped: ${(guardErr as Error).message}`,
      );
      return personaPath;
    }
    const platformHash = sha256Hex(content);

    // 读当前内容(存在时)比对是否被用户改过。读失败(perm 等)→ 保守跳过。
    const targetExists = existsSync(personaPath);
    let currentContent: string | null = null;
    if (targetExists) {
      try {
        currentContent = readFileSync(personaPath, "utf8");
      } catch (personaErr) {
        console.error(
          `[entrypoint] WARN: ${agentId} persona read skipped: ${(personaErr as Error).message}`,
        );
        return personaPath;
      }
    }
    const currentHash = currentContent === null ? null : sha256Hex(currentContent);
    const recordedHash = targetExists ? readPlatformPersonaHash(hashPath) : null;

    // 决策矩阵在 platformBundle.ts 纯函数(全矩阵单测);此处只做 IO。
    const action = decidePersonaWrite({
      force: opts.force ?? false,
      targetExists,
      currentHash,
      recordedHash,
      platformHash,
    });
    switch (action) {
      case "force":
      case "write-new":
        try {
          // R2-M4:persona 写走祖先 symlink 逃逸拒 + 原子落盘。命中 → 跳过该 agent seed,不崩。
          platformVolumeWrite(personaPath, ocConfigDir, content, 0o644);
          writePlatformPersonaHash(hashPath, platformHash);
        } catch (wErr) {
          console.error(
            `[entrypoint] WARN: ${agentId} persona platform write skipped (symlink/escape guard): ${(wErr as Error).message}`,
          );
        }
        break;
      case "upgrade":
        try {
          platformVolumeWrite(personaPath, ocConfigDir, content, 0o644);
          writePlatformPersonaHash(hashPath, platformHash);
          console.error(`[entrypoint] agents.yaml: upgraded ${agentId} persona to new platform version`);
        } catch (wErr) {
          console.error(
            `[entrypoint] WARN: ${agentId} persona upgrade write skipped (symlink/escape guard): ${(wErr as Error).message}`,
          );
        }
        break;
      case "already-latest":
        // 已是最新平台版:仅回填/更新记录(存量 volume 记录缺失时补上,免下次误判为定制)。
        if (recordedHash !== platformHash) writePlatformPersonaHash(hashPath, platformHash);
        break;
      case "skip-no-record":
        console.error(
          `[entrypoint] agents.yaml: ${agentId} persona has no platform-hash record → treated as user-customized, skip platform upgrade (conservative)`,
        );
        break;
      case "skip-customized":
        console.error(
          `[entrypoint] agents.yaml: ${agentId} persona user-customized → skip platform upgrade (customization protected)`,
        );
        break;
    }
    return personaPath;
  }


  function ensureAgentSeedSkill(agentId: string, name: string, content: string): void {
    try {
      // Platform per-agent seeds live in a dedicated READ-ONLY layer ("seed-skills"),
      // physically separate from the user-writable per-agent skills dir, so the
      // user-level shared-library overlay never treats them as deletable user data
      // (agent-seed wins over legacy on read; reserved on write).
      const skillDir = join(ocConfigDir, "agents", agentId, "seed-skills", name);
      const skillPath = join(skillDir, "SKILL.md");
      // M5 containment(二道防线):写目标必须落在 agents/<id>/seed-skills/ 子树内。
      if (!isPathWithin(join(ocConfigDir, "agents", agentId, "seed-skills"), skillPath)) {
        console.error(`[entrypoint] WARN: seed skill "${name}" write path escapes seed-skills dir, skipped`);
        return;
      }
      if (existsSync(skillDir)) {
        const st = lstatSync(skillDir);
        if (!st.isDirectory() || st.isSymbolicLink()) {
          console.error(`[entrypoint] WARN: scientist skill seed skipped for ${name}: non-directory or symlinked skill dir`);
          return;
        }
      }
      // M4a:平台自有 seed skill 从 skip-if-exists 改**内容 hash 不一致即覆写**(与 codex-skills
      // overlay 同款 shouldWriteSeededSkill("hash-overwrite"))—— 平台更新 skill 内容时旧的
      // skip-if-exists 会让新版本送不达存量 volume(缺陷)。内容一致则幂等跳过。
      const targetExists = existsSync(skillPath);
      const targetContent = targetExists ? readFileSync(skillPath) : null;
      if (!shouldWriteSeededSkill("hash-overwrite", targetExists, targetContent, content)) return;
      // R2-M4:seed skill 写走祖先 symlink 逃逸拒 + mkdir realpath 复核 + 原子落盘(mkdir 内含于 helper)。
      platformVolumeWrite(skillPath, ocConfigDir, content, 0o644);
    } catch (skillErr) {
      console.error(
        `[entrypoint] WARN: scientist skill seed skipped for ${name}: ${(skillErr as Error).message}`,
      );
    }
  }

  // 平台 seed skill:清单在 platform-seed.yaml 的 seedSkills(agentId → 名单),内容在 bundle
  // <seedDir>/skills/<agentId>/<name>/SKILL.md;幂等 seed 到 volume 的 agents/<id>/seed-skills/
  // 只读层(不覆盖已存在)。dev fallback(platformSeed 缺失)跳过(无 seedDir 可读)。
  if (platformSeed && platformSeedDir) {
    for (const [seedAgentId, skillNames] of Object.entries(platformSeed.seedSkills)) {
      for (const skillName of skillNames) {
        const skillMd = join(platformSeedDir, "skills", seedAgentId, skillName, "SKILL.md");
        if (!existsSync(skillMd)) {
          console.error(
            `[entrypoint] WARN: platform seed skill file missing, skipped: ${seedAgentId}/${skillName}`,
          );
          continue;
        }
        // M5 containment(二道防线):源必须落在 bundle seed 子树内(seedAgentId/skillName 已 slug
        // 校验为一道防线;platformSeedDirReal 非空——本块由 `platformSeed && platformSeedDir` 守护)。
        if (!isPathWithin(platformSeedDirReal!, realpathSync(skillMd))) {
          console.error(
            `[entrypoint] WARN: platform seed skill escapes bundle seed dir, skipped: ${seedAgentId}/${skillName}`,
          );
          continue;
        }
        ensureAgentSeedSkill(seedAgentId, skillName, readFileSync(skillMd, "utf8"));
      }
    }
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

  // ── 平台 seed agent 构建(runtime hotcfg P2a + 模型权威 §5 阶段 A)──
  // **全部字段来自 platform-seed.yaml 声明**(schema v2):执行三元组(model/provider/runnerKind)
  // 与非计费字段(persona 引用 / permissionMode / displayName / avatarEmoji / toolsets)同源;
  // entrypoint 侧唯一的动态注入是**展示层** codex 队长 displayName(按声明的 model 反查 protocol
  // 型号目录,见 seedDynamicDisplayNames;buildSeedAgent 硬拒任何执行键走 dynamic 面)。
  // persona 文本来自 bundle personas/<id>.md(top-level 预读入 seedPersonas);写卷经 ensureAgentPersona。
  // 产物字段与旧内联 desiredXAgent 一致,下游 patchPlatformSeedAgent merge 逻辑零改动。
  // dev fallback(无 bundle)= DEV_FALLBACK_SEED_DOC 的最小 main-only 声明,走同一条装配路径。
  //
  // v5 纯市场:seed 集合 = 声明里的 agent(生产 = main + codex + hidden-reviewer);其它可见 agent
  // 一律走市场安装(syncMarketplaceHub 直写 agents.yaml + source:marketplace)。hidden-reviewer
  // 不带 source:marketplace → 不进 AgentPicker/协作列表。存量幽灵 seed 不 prune。
  const desiredSeedAgents: Record<string, unknown>[] = [];
  for (const decl of seedDoc.agents) {
    const personaContent = seedPersonas[decl.id];
    // persona 卷路径:声明带 persona 引用 → 写卷(main 在 dev fallback 无 bundle 时用内置文案);
    // 无 persona 声明(codex)→ 不写、产物不带 persona 字段(与旧内联对象一致)。
    let personaPath: string | undefined;
    if (personaContent !== undefined) {
      personaPath = ensureAgentPersona(decl.id, personaContent, { force: decl.forcePersona ?? false });
    } else if (decl.id === "main") {
      personaPath = ensureAgentPersona("main", MAIN_FALLBACK_PERSONA);
    }
    const dynamicDisplayName = seedDynamicDisplayNames[decl.id];
    desiredSeedAgents.push(
      buildSeedAgent({
        id: decl.id,
        decl,
        personaPath,
        dynamic: dynamicDisplayName !== undefined ? { displayName: dynamicDisplayName } : undefined,
      }),
    );
  }

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
