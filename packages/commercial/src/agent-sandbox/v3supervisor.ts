/**
 * V3 Phase 3C — per-user openclaude-runtime container supervisor.
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §9.3 Task 3C / §3.2 容器身份
 *
 * 拓扑(MVP 单 host monolith):
 *   每个商用版用户 → 一个本镜像 openclaude/openclaude-runtime 启动的容器,
 *   挂在 docker bridge `openclaude-v3-net` (172.30.0.0/16) 上,容器内跑完整
 *   个人版 OpenClaude gateway,所有 anthropic 调用被 ANTHROPIC_BASE_URL 重定向
 *   到本机 commercial gateway 的内部代理 (172.30.0.1:18791)。
 *
 * 与 v2 supervisor 的关系:
 *   - v2 (`./supervisor.ts`) 是为"claude code agent" 设计的;ReadOnly rootfs +
 *     双 volume + tinyproxy + RPC unix socket + custom seccomp,适配那条独立路线。
 *   - v3 supervisor 完全独立,**不复用** v2 的 createContainer —— 字段差异巨大
 *     (单 volume / tmpfs config / cap-drop NET_RAW NET_ADMIN / 强制 --ip /
 *     ANTHROPIC_AUTH_TOKEN 双因子 / 不要 seccomp / 不要 readonly rootfs)。
 *   - v2/v3 共用 dockerode + SupervisorError 类型,其它互不影响。
 *
 * 双因子身份(§3.2 R2):
 *   - 因子 A:bound_ip — supervisor 用 docker `--ip` 在 provision 时强制分配,
 *     INSERT agent_containers 行落 bound_ip,uniq partial index 保证 active 集合
 *     里全局唯一。
 *   - 因子 B:secret — 32-byte 随机 → SHA256 → BYTEA 入库;明文塞进容器 env
 *     `ANTHROPIC_AUTH_TOKEN=oc-v3.<row_id>.<secret_hex>`,容器内 OpenClaude
 *     调 anthropic 时 Authorization Bearer 带回来,2D 内部代理 timing-safe 校验。
 *
 * 不在本文件管:
 *   - WS bridge endpoint 解析(3D 的 ensureRunning 包装本文件 + DB 查询)
 *   - idle sweep / orphan reconcile(3F / 3H 单独的 lifecycle scheduler)
 *   - volume GC(3G,banned 7d / no-login 90d)
 *   - 内部代理 listener(2H 已在 index.ts 启好)
 *   - docker network 创建(setup-host-net.sh 一次性脚本搞定,不要 inspect/create)
 *
 * 容器→host 横向防御(2026-04-21 安全审计 BLOCKER#2):
 *   本模块只负责"把容器挂在正确的 docker bridge + 强制 --ip + 双因子身份"。
 *   docker bridge `openclaude-v3-net` 由 setup-host-net.sh 以 ICC=false 创建
 *   (容器之间不互通);容器→host 的横向访问由 host 侧 iptables 独立链
 *   `V3_EGRESS_IN` 兜底:仅放行 172.30.0.1:18791(internal proxy),其它 host
 *   端口(PG / Redis / gateway 18789 admin / SSH)全部 DROP。
 *   该 iptables 规则随 boot 由 systemd unit `openclaude-v3-host-firewall.service`
 *   自动应用,即使本模块出 bug 漏配 cap-drop / 漏走 V3_NETWORK_NAME,host 层
 *   也能挡住容器→host 的横向。详见 `network.ts` 顶部 BLOCKER#2 注释 +
 *   `scripts/setup-host-net.sh` 的 ensure_v3_host_guard()。
 *
 *   **不开 FORWARD 链** —— 容器→公网仍然允许(浏览器/搜索/MCP fetch 必须走
 *   公网)。出口策略统一(SNAT / IPRoyal / per-account egress_proxy)留给
 *   Phase B,见 docs/v3/02-DEVELOPMENT-PLAN.md 后续 task。
 */

import type Docker from "dockerode";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { mkdir as fsMkdir, chown as fsChown, chmod as fsChmod } from "node:fs/promises";
import { isAbsolute as pathIsAbsolute, join as pathJoin, normalize as pathNormalize, sep as pathSep } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { ContainerService, ContainerSpec } from "../compute-pool/containerService.js";
import { AgentAppError } from "../compute-pool/nodeAgentClient.js";
import { listAllHosts as defaultListAllHosts } from "../compute-pool/queries.js";
import type { ComputeHostRow } from "../compute-pool/types.js";
import { computeInboundNonce } from "../bridgeSecret.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { rootLogger } from "../logging/logger.js";
import { V3_AGENT_GID, V3_AGENT_UID } from "./constants.js";
import { SupervisorError } from "./types.js";
import { getCodexTokenSnapshot } from "../account-pool/store.js";
import { pickCodexAccountForBinding } from "../account-pool/scheduler.js";
import { buildCodexRelayLocalBaseUrl, readCodexUpstreamBaseUrl } from "../http/internalCodexRelay.js";
import { zeroBuffer } from "../crypto/keys.js";
import {
  removeCodexContainerAuthDir,
  writeCodexContainerAuthFile,
} from "../codex-auth/codexAuthFile.js";

// ───────────────────────────────────────────────────────────────────────
// 常量(硬编码,设计有意为之)
// ───────────────────────────────────────────────────────────────────────

/** docker bridge 网络名 — setup-host-net.sh 创建,本模块只引用 */
export const V3_NETWORK_NAME = "openclaude-v3-net";

/** docker bridge 子网 / 网关 — self host 一侧,与 setup-host-net.sh 严格一致。
 *
 * **多机注意**:不同 host 的 bridge 用不同的 /24(self=172.30.0.0/24,
 * 远端 host 由 nodeScheduler 按 host 索引分配 172.30.X.0/24),所以容器 env
 * 里的 ANTHROPIC_BASE_URL / OPENCLAUDE_TRUST_BRIDGE_IP 必须**按 host 计算**,
 * 不能直接用这两个常量。本常量仅 master 自身用于:
 *   - master 上的 anthropicProxy bind(config.ts INTERNAL_PROXY_BIND/PORT)
 *   - Caddyfile reverse_proxy 反代(checkCaddyfileScript 测试)
 *   - monolith / self host 路径的 fallback 默认值
 * 容器 env 的 per-host 计算见 provisionV3Container 内 hostGatewayIp。
 */
export const V3_SUBNET_CIDR = "172.30.0.0/16";
export const V3_GATEWAY_IP = "172.30.0.1";

/** 同上注释 — master 自身用,容器 env 的 per-host 版本由 supervisor 计算。 */
export const V3_INTERNAL_PROXY_URL = "http://172.30.0.1:18791";

/**
 * 从 v3 docker bridge CIDR 推该 host 的 bridge gateway IP。
 *
 * v3 网络规划(setup-host-net.sh + node-agent createBridge):**所有 host
 * bridge 必为 X.Y.Z.0/24**,gateway 一律 `.1`。不接受 /28、/16 等其他 prefix
 * —— 这些都不是 v3 拓扑里会出现的形态,与其试图猜测 gateway 算法
 * (network address+1),不如 fail-fast 让运维感知到 host 装错网。
 *
 * 本函数在 provisionV3Container 容器 env 注入路径调用,任何形状不符 → 抛
 * SupervisorError("InvalidArgument") 在 docker create 前失败,避免静默退化
 * 导致跨 host 容器拿到错误 trust IP 触发 WS 1008 unauthorized。
 */
export function gatewayIpFromV3Cidr(cidr: string): string {
  const trimmed = cidr.trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(trimmed);
  if (!m) {
    throw new SupervisorError(
      "InvalidArgument",
      `bridge_cidr ${cidr} not in expected v3 form X.Y.Z.0/24`,
    );
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255) {
    throw new SupervisorError(
      "InvalidArgument",
      `bridge_cidr ${cidr} octet out of range`,
    );
  }
  return `${a}.${b}.${c}.1`;
}

/**
 * 容器内 OpenClaude gateway 监听端口(默认 18789,见 personal-version
 * `packages/storage/src/config.ts`,容器侧 entrypoint.ts bootstrap config 也是这个值)。
 */
export const V3_CONTAINER_PORT = 18789;

/** CLAUDE_CONFIG_DIR tmpfs 挂载点(防 settings.json 残留) */
export const V3_CONFIG_TMPFS_PATH = "/run/oc/claude-config";

/**
 * 容器内 CCB session JSONL 文件的持久化挂载点(tmpfs 的 projects 子目录),
 * supervisor 用独立 named volume 覆盖这段路径,让 `--resume <id>` 跨容器重启依然有效。
 *
 * 为什么 projects 要单独一个 volume 而不是跟主 volume 共用 subpath:
 *   - docker VolumeOptions.Subpath 需要目标路径在 volume 内 pre-create,否则 mount 报错;
 *     独立 volume 让 docker 基于镜像里的 `/run/oc/claude-config/projects/` 自动初始化,
 *     ownership(agent:agent)+ mode(0700)都继承,不用 supervisor 额外起 helper 容器 mkdir。
 *   - 持久化粒度独立:只 persist CCB 对话 JSONL,`.config.json` / `settings.json` /
 *     `.credentials.json` 仍在 tmpfs,每次冷启都清空,保留原设计"settings 不残留"的意图。
 */
export const V3_PROJECTS_MOUNT = "/run/oc/claude-config/projects";

/** 容器内单个 named volume 的挂载点(对应个人版 ~/.openclaude) */
export const V3_VOLUME_MOUNT = "/home/agent/.openclaude";

/**
 * 容器内 codex CLI HOME 持久化挂载点(D2 方案,2026-05-09)。
 *
 * 解决问题:用户 `codex mcp add` / 安装 plugin / 自定义 skill 全部写在 ~/.codex
 * 下的 config.toml + skills/。早期 ~/.codex 在 image overlay → 容器重启全丢。
 * Boss 要求"在正常环境使用一模一样,不阉割"。
 *
 * 共生关系:
 *   - V3_CODEX_AUTH_RO_MOUNT (`/run/oc/codex-auth`) 是独立 RO 目录,放 host 写
 *     的 auth.json。entrypoint.ts 在 ~/.codex/auth.json 建 symlink → /run/oc/codex-auth/auth.json
 *     新挂的 codex volume 与该 RO bind 不重叠。
 *   - codex system skills(image_gen 等)由 entrypoint.ts cpSync 从
 *     /opt/codex-system-skills 种子到 ~/.codex/skills/.system/。volume 首次挂载
 *     是空目录 → seed 一次 → marker 落 volume → 后续 restart skip。用户后加的
 *     ~/.codex/skills/<name>/ 不被 seed 覆盖。
 */
export const V3_CODEX_HOME_MOUNT = "/home/agent/.codex";

/**
 * 容器内 ~/.local 持久化挂载点(pip --user / npm prefix / pipx / uv tool)。
 *
 * 配套 Dockerfile 的 ENV PATH=/home/agent/.local/bin:... 与 ENV
 * NPM_CONFIG_USERCONFIG=/home/agent/.config/npm/npmrc(npmrc 内 prefix 指
 * /home/agent/.local),让用户级 npm install -g 落到这里持久化。
 */
export const V3_USER_LOCAL_MOUNT = "/home/agent/.local";

/**
 * 容器内 ~/.config 持久化挂载点(XDG configs)。
 *
 * 包括:gh / git scoped / npm userconfig (NPM_CONFIG_USERCONFIG 指向)/ pip /
 * vscode-server / 用户自定义 dotfile 等。entrypoint.ts 在此目录 bootstrap
 * `npm/npmrc`(prefix=/home/agent/.local)+ `pip/pip.conf`(break-system-packages=true)
 * 两个文件,idempotent — 用户后续手动改不被覆盖。
 */
export const V3_USER_CONFIG_MOUNT = "/home/agent/.config";

/** 容器内 entrypoint 跑的非 root 用户(uid:gid),与 Dockerfile USER 一致 */
const V3_AGENT_USER = "1000:1000";

/**
 * Codex CLI(GPT 模型走 codex app-server runner)的容器侧 auth **源**挂载点。
 *
 * **设计要点(plan v3 §D + 风险 #4)**:
 *   - 容器内 `CODEX_HOME=/home/agent/.codex`(entrypoint.ts 显式 set),codex CLI 启动时
 *     需要在 CODEX_HOME 下写 `.personality_migration` / `logs_*.sqlite` /
 *     `state_*.sqlite` / `memories/` / `skills/` / helper PATH binaries —— 因此
 *     **CODEX_HOME 必须可写**(挂 RO 会让 `codex app-server` exit 1)。
 *   - 本常量是 host auth 源的**独立 RO 挂载点**(不是 CODEX_HOME):docker bind-mount
 *     把 host 剥离 refresh_token 后的 auth.json 目录挂到 `/run/oc/codex-auth`,**ro**。
 *     entrypoint.ts 在 CODEX_HOME/auth.json 创建 symlink 指向 `/run/oc/codex-auth/auth.json`。
 *   - **必须挂目录而非单文件**:host atomic rename(`auth.json.tmp.<rand> → auth.json`)
 *     在文件 bind-mount 下绑死旧 inode,容器永远看不到新 token。挂目录后
 *     容器侧 dirfd → entry "auth.json",rename 替换 entry 后,symlink 解析到新 inode 即可见。
 *   - **永不挂 master 目录**(`codex-master-auth/`)—— 那里有完整 refresh_token,
 *     挂入容器即扩大泄漏面。本常量只引用 container 目录。
 *   - **始终挂载**(boss 未 OAuth 时目录内无 auth.json,symlink 解析 ENOENT,codex
 *     启动报"未授权"是预期行为;前端 modelPicker 在 GPT 未授权时也不会出选项)。
 *   - **安全边界**:RO 挂载保证 host auth 源不可被容器代码改写。CODEX_HOME 下的
 *     auth.json **symlink 本身不是安全控制** —— 容器内 agent 已经能读 token,改 symlink
 *     最多让自己的 codex 找不到 auth(自伤),不影响 host 文件。
 *   - **当前限制**:host 写入由 master gateway 完成,远端 host(useRemote=true)
 *     的容器拿不到 auth.json,GPT 模型仅在 master host 容器可用。跨 host 同步
 *     auth.json 是后续 task,plan v3 范围内不处理。
 */
export const V3_CODEX_AUTH_RO_MOUNT = "/run/oc/codex-auth";

/**
 * Host 侧容器 auth 目录默认路径。对应 codexAuthSync.writeContainerVariant
 * 写入的目标目录。env `OC_V3_CODEX_CONTAINER_DIR` 覆盖(仅本地 host 有效;
 * 远端 host 必须用 default,见 codex-auth/constants.ts)。
 *
 * v1.0.72:常量挪到 codex-auth/constants 避免循环依赖,这里 re-export
 * 保持向后兼容(index.ts 等老调用方不变)。
 */
export { DEFAULT_V3_CODEX_CONTAINER_DIR } from "../codex-auth/constants.js";
import { DEFAULT_V3_CODEX_CONTAINER_DIR } from "../codex-auth/constants.js";

const log = rootLogger.child({ subsys: "v3-supervisor" });

function readCodexContainerDirFromEnv(): string {
  const raw = process.env.OC_V3_CODEX_CONTAINER_DIR;
  if (raw == null || raw.trim() === "") return DEFAULT_V3_CODEX_CONTAINER_DIR;
  return raw.trim();
}

const LEGACY_CODEX_CONTAINER_ENV_KEYS = [
  "OC_CODEX_MODEL_PROVIDER",
  "OC_CODEX_PROVIDER_NAME",
  "OC_CODEX_BASE_URL",
  "OC_CODEX_WIRE_API",
  "OC_CODEX_PREFERRED_AUTH_METHOD",
  "OC_CODEX_DISABLE_RESPONSE_STORAGE",
] as const;

const LOCAL_RELAY_CODEX_CONTAINER_ENV_KEYS = [
  "OC_CODEX_MODEL_PROVIDER",
  "OC_CODEX_PROVIDER_NAME",
  "OC_CODEX_WIRE_API",
  "OC_CODEX_PREFERRED_AUTH_METHOD",
  "OC_CODEX_DISABLE_RESPONSE_STORAGE",
] as const;

/** Loopback base for the container-local gateway relay. */
export const V3_CODEX_LOCAL_RELAY_ORIGIN = `http://127.0.0.1:${V3_CONTAINER_PORT}`;

export function isCodexLocalRelayEnabled(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = sourceEnv.OC_V3_CODEX_LOCAL_RELAY_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Build non-secret Codex relay env for user containers.
 *
 * The new local relay needs runtime-image support from packages/gateway. Keep
 * it behind an explicit rollout gate so master can be deployed first, then a
 * new image can be built/distributed/flipped without handing old images a
 * loopback URL they do not understand.
 *
 * Important: the external upstream base URL (OC_CODEX_BASE_URL /
 * OC_CODEX_UPSTREAM_BASE_URL on master) is **not** passed through when the
 * local relay gate is enabled. Containers receive a loopback URL handled by
 * their own gateway, which then authenticates to master with
 * OPENCLAUDE_V3_CONTAINER_TOKEN. This prevents managed Codex traffic from
 * drifting to direct container egress or leaking proxy credentials.
 */
export function buildCodexRelayContainerEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];

  if (!isCodexLocalRelayEnabled(sourceEnv)) {
    if (!sourceEnv.OC_CODEX_MODEL_PROVIDER?.trim()) return out;
    for (const key of LEGACY_CODEX_CONTAINER_ENV_KEYS) {
      const value = sourceEnv[key]?.trim();
      if (value) out.push(`${key}=${value}`);
    }
    if (!sourceEnv.OC_CODEX_BASE_URL?.trim()) {
      const dedicatedUpstream = sourceEnv.OC_CODEX_UPSTREAM_BASE_URL?.trim();
      if (dedicatedUpstream) out.push(`OC_CODEX_BASE_URL=${dedicatedUpstream}`);
    }
    return out;
  }

  const provider = sourceEnv.OC_CODEX_MODEL_PROVIDER?.trim();
  if (!provider) return out;

  out.push(`OC_CODEX_MODEL_PROVIDER=${provider}`);
  for (const key of LOCAL_RELAY_CODEX_CONTAINER_ENV_KEYS) {
    if (key === "OC_CODEX_MODEL_PROVIDER") continue;
    const value = sourceEnv[key]?.trim();
    if (value) out.push(`${key}=${value}`);
  }

  const upstreamBaseUrl = readCodexUpstreamBaseUrl(sourceEnv);
  out.push(`OC_CODEX_BASE_URL=${buildCodexRelayLocalBaseUrl(V3_CODEX_LOCAL_RELAY_ORIGIN, upstreamBaseUrl)}`);
  return out;
}

function appendCodexRelayEnv(env: string[]): void {
  env.push(...buildCodexRelayContainerEnv(process.env));
}

/**
 * 宿主侧远程执行 mux 目录 per-user 分片根。
 *
 * 完整布局(sshMux.ts 与本模块共同维护):
 *   /run/ccb-ssh/                       systemd RuntimeDirectory 0700 root:root
 *     u<uid>/                           本文件 ensureSshUserRunDir 创建,0750 root:AGENT_GID
 *       h<hostId>/                      sshMux acquireMux 创建,0750 root:AGENT_GID
 *         ctl.sock                      ssh ControlMaster 自建 → 改 0660 root:AGENT_GID
 *         known_hosts                   sshMux materialize,0640 root:AGENT_GID
 *
 * 容器侧挂载映射:`u<uid>` **整目录** ro 挂到 `/run/ccb-ssh`(去掉 u<uid> 前缀),
 * 容器内 CCB 只能看到当前 user 自己的所有 host 目录;跨用户隔离由 host path 不同保证。
 */
const V3_SSH_RUN_ROOT_HOST = "/run/ccb-ssh";
const V3_SSH_RUN_CONTAINER_MOUNT = "/run/ccb-ssh";

/**
 * CCB 平台基线目录的**默认**宿主路径(只读挂入容器 /run/oc/claude-config/ 的
 * AGENTS.md + CLAUDE.md + skills/ 整目录)。
 *
 * 用途:向容器内 Claude Code 子进程注入平台身份/守则/能力边界 + 基线 skills ——
 * 容器内任何进程(包括 AI 自己)都无法修改,走 kernel ro bind mount 兜底。
 *
 * 目录结构(repo 内 `packages/commercial/agent-sandbox/ccb-baseline/` 完整 rsync 上去):
 *   <baseline>/AGENTS.md                     → /opt/openclaude/AGENTS.md:ro
 *   <baseline>/CLAUDE.md                     → /run/oc/claude-config/CLAUDE.md:ro
 *   <baseline>/skills/                       → /run/oc/claude-config/skills:ro   (整目录)
 *       ├── system-info/SKILL.md
 *       ├── memory-management/SKILL.md
 *       ├── platform-capabilities/SKILL.md
 *       ├── scheduled-tasks/SKILL.md
 *       ├── skill-management/SKILL.md
 *       └── skill-search/SKILL.md
 *
 * 挂整个 skills/ 父目录(而不是逐 skill ro bind)好处:
 *   1. 新增基线 skill 只改 manifest 一行 + 新加目录,不动 docker 挂载代码
 *   2. 挂载数量恒定(2 条),不随 skill 数膨胀
 *   3. 并发安全:同一次 provision 里所有基线 skill 原子可见(而不是半挂状态)
 * 代价:容器内用户暂时无法再往 /run/oc/claude-config/skills/ 写用户自建 skill;
 * 这个能力由 PR4 的 SkillStore 合并路径(/home/agent/.claude/skills 可写 + /run/oc 只读基线)恢复。
 *
 * 覆盖优先级(高→低):
 *   1. V3SupervisorDeps.ccbBaselineDir(测试注入 / 多机部署)
 *   2. env `OC_V3_CCB_BASELINE_DIR`
 *   3. DEFAULT_V3_CCB_BASELINE_DIR
 *
 * **fail-closed**(默认):目录不存在 / 结构不全 / 校验不通过 → `provisionV3Container`
 * 抛 `SupervisorError("CcbBaselineMissing")`,用户启动失败,上层应报告运维。
 * 基线是"加固层",缺了意味着守则失效(AI 裸奔),商用版不允许这种降级默认上线。
 *
 * **显式 fail-open**:dev/test/local 可以设 `OC_V3_CCB_BASELINE_OPTIONAL=1`,
 * 基线缺失时 warn 并跳过挂载(容器照起,无守则);生产禁止设置。
 */
export const DEFAULT_V3_CCB_BASELINE_DIR =
  "/opt/openclaude/openclaude/packages/commercial/agent-sandbox/ccb-baseline";

/** baseline 内部结构 —— 用 POSIX 绝对路径拼 docker Bind */
export const V3_CCB_BASELINE_AGENTS_MD_REL = "AGENTS.md";
export const V3_CCB_BASELINE_CLAUDE_MD_REL = "CLAUDE.md";
export const V3_CCB_BASELINE_SKILLS_DIR_REL = "skills";

/**
 * 基线 skill 清单 —— 每一项都是 `<baseline>/skills/<name>/SKILL.md` 的子目录名。
 *
 * 新增 / 下线一条基线 skill:
 *   1. 改这个数组(新增 name 或删除过期 name)
 *   2. 在 `packages/commercial/agent-sandbox/ccb-baseline/skills/<name>/SKILL.md` 增删文件
 *   3. 如守则引用该路径,更新 `AGENTS.md` / `CLAUDE.md` / `skills/system-info/SKILL.md` 文案
 *
 * 校验意义:resolveCcbBaselineMounts 会为每条 name 强制 lstat + owner=root + mode + realpath,
 * 只要有一条不合规(缺 SKILL.md / group-writable / symlink 逃逸),整个 provision 走 fail-closed。
 * 这样基线永远是一个"全有或全无"的集合,避免 AI 只能看到部分 skill 的撕裂状态。
 *
 * 顺序无关;读来只是用来 iterate 校验,不影响运行时。
 */
export const V3_CCB_BASELINE_SKILL_NAMES = [
  "system-info",
  "memory-management",
  "platform-capabilities",
  "scheduled-tasks",
  "wechat-notify",
  "skill-management",
  "skill-search",
  "scansci-pdf",
  "web-context",
  "browser",
  "document-writing",
  "minimax-media",
] as const;

/**
 * 读 env `OC_V3_CCB_BASELINE_DIR`;为空或空字符串 → 回落默认路径。
 * 不做绝对路径校验(留给 resolveCcbBaselineMounts 的 stat 去 fail-closed)。
 */
function readCcbBaselineDirFromEnv(): string {
  const raw = process.env.OC_V3_CCB_BASELINE_DIR;
  if (raw == null || raw.trim() === "") return DEFAULT_V3_CCB_BASELINE_DIR;
  return raw.trim();
}

/**
 * 读 env `OC_V3_CCB_BASELINE_OPTIONAL`:只有显式设成 "1" / "true" / "yes" 才返回 true,
 * 其它任何值(含未设)都视为 false(fail-closed)。
 */
function readCcbBaselineOptionalFromEnv(): boolean {
  const raw = process.env.OC_V3_CCB_BASELINE_OPTIONAL?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * 校验单个 baseline 叶子路径(文件或目录):
 *   - lstat 必须是对应类型(`file` / `dir`),**拒绝 symlink**(避免把 /etc/shadow 之类
 *     挂进容器 ro 暴露)
 *   - realpath 必须严格在 baselineRoot 下(把"软链逃逸到 baseline 外"堵死)
 *   - owner 必须是 root(uid=0)—— 非 root owned 说明部署态失控,直接拒
 *   - mode 不允许 group/other 可写(020/002),防 baseline 被非 root 用户改
 *
 * 返回 normalized 绝对路径(和 realpath 一致,消除软链影响),失败抛 Error(调用方捕获)。
 */
function assertBaselineLeaf(
  leafPath: string,
  expected: "file" | "dir",
  baselineRoot: string,
): string {
  const st = lstatSync(leafPath);
  if (st.isSymbolicLink()) {
    throw new Error(`baseline leaf is a symlink: ${leafPath}`);
  }
  if (expected === "file" && !st.isFile()) {
    throw new Error(`baseline leaf is not a regular file: ${leafPath}`);
  }
  if (expected === "dir" && !st.isDirectory()) {
    throw new Error(`baseline leaf is not a directory: ${leafPath}`);
  }
  if (st.uid !== 0) {
    throw new Error(`baseline leaf not owned by root (uid=${st.uid}): ${leafPath}`);
  }
  // 低 3 位按 rwx for user/group/other。要求 group-write & other-write 都为 0。
  if ((st.mode & 0o022) !== 0) {
    throw new Error(
      `baseline leaf group/other writable (mode=${(st.mode & 0o777).toString(8)}): ${leafPath}`,
    );
  }
  // realpath 双重兜底:确保最终 bind 源不在 baselineRoot 外面
  const real = realpathSync(leafPath);
  const rootReal = realpathSync(baselineRoot);
  // 允许 real === rootReal(baseline 根本身也允许),否则要求 real 在 rootReal 下
  if (real !== rootReal && !real.startsWith(rootReal + pathSep)) {
    throw new Error(`baseline leaf realpath escapes baselineRoot: ${leafPath} → ${real}`);
  }
  return real;
}

/**
 * 校验 baseline 目录是否齐全 + 返回可直接拼 docker Bind 的绝对路径。
 *
 * 严格校验(按顺序):
 *   1. 输入是非空字符串
 *   2. 输入是绝对路径(path.normalize 后与 path.resolve 结果相等,允许尾斜杠)
 *   3. baseline root、`AGENTS.md`、`CLAUDE.md`、`skills/`,以及 `V3_CCB_BASELINE_SKILL_NAMES`
 *      里每一条 skill 目录都:非 symlink、类型正确、root owned、非 group/other writable
 *   4. `skills/` 下的顶层条目**必须完全等于** manifest(多余的 / 未声明的条目直接拒)
 *   5. 每条 skill 目录下**必须只有** `SKILL.md` 一个文件,不允许 subdir / 其它文件 / symlink
 *   6. 所有 realpath 都在 baseline root 内
 *
 * 任一项失败返回 null;调用方(provisionV3Container)按 OC_V3_CCB_BASELINE_OPTIONAL
 * 决定是 fail-closed 抛错还是 fail-open warn。
 *
 * 返回的路径是 **realpathSync 后**的,即使 baseline 目录结构本身经过软链(如部署软链
 * /opt/current/baseline → /opt/releases/xxx/baseline),docker Bind 也吃到真实路径。
 *
 * **为什么同时查 readdir**(R3 codex HIGH#1):
 *   我们挂的是 `skills/` 父目录整棵树 ro,manifest 逐条校验只看到"声明过的那几条",
 *   未声明的条目(运维 rsync 漏带 `--delete` 的残余目录、手工误放的临时文件、
 *   被攻击者替换成 symlink 的"看起来不像 skill 但父目录挂进去就暴露"的项)都会跟着
 *   父目录一起进容器。必须额外用 `readdirSync` 断言 `skills/` 和每条 skill 目录下
 *   的条目**恰好等于** manifest / `["SKILL.md"]`,否则拒。
 *
 *   这样基线的"全有或全无"语义就严格成立 ——
 *   skills/ 下看见的 ≡ manifest 声明的 ≡ 每条都 root owned + mode safe + SKILL.md 合规。
 */
export function resolveCcbBaselineMounts(
  baselineDir: string,
): { agentsMdHostPath: string; claudeMdHostPath: string; skillsDirHostPath: string } | null {
  if (typeof baselineDir !== "string" || baselineDir.trim() === "") return null;
  // 必须绝对路径;path.normalize 吞掉尾斜杠、多余 `/` 等等价写法。
  if (!pathIsAbsolute(baselineDir)) return null;
  const abs = pathNormalize(baselineDir).replace(/(?<!^)\/+$/, "");
  try {
    // 每一级目录 / 文件都必须通过相同的 lstat + owner + mode + realpath 校验。
    // **包含中间目录 `skills/`**:R2 codex 发现如果 skills/ 可写,攻击者可在
    // resolve 通过后、docker createContainer 调度前替换 skill 内容,造成
    // TOCTOU。堵 skills/ 这层校验后,非 root 用户无法改动该链路上的任何一环。
    assertBaselineLeaf(abs, "dir", abs);
    const agentsMdPath = pathJoin(abs, V3_CCB_BASELINE_AGENTS_MD_REL);
    const claudeMdPath = pathJoin(abs, V3_CCB_BASELINE_CLAUDE_MD_REL);
    const skillsDirPath = pathJoin(abs, V3_CCB_BASELINE_SKILLS_DIR_REL);
    const agentsReal = assertBaselineLeaf(agentsMdPath, "file", abs);
    const claudeReal = assertBaselineLeaf(claudeMdPath, "file", abs);
    // 中间目录 skills/ 必须和根一样被锁死(root owned + 非可写 + 非 symlink)
    const skillsDirReal = assertBaselineLeaf(skillsDirPath, "dir", abs);

    // R3 codex HIGH#1:父目录挂 ro → readdir 断言 skills/ 下看到的顶层条目集合
    // 恰好 ≡ manifest 集合(未声明的条目一律拒,不管类型是什么)。
    const manifestSet = new Set<string>(V3_CCB_BASELINE_SKILL_NAMES);
    const actualTop = new Set(readdirSync(skillsDirPath));
    if (actualTop.size !== manifestSet.size) {
      throw new Error(
        `skills/ has ${actualTop.size} top-level entries, manifest declares ${manifestSet.size}`,
      );
    }
    for (const name of actualTop) {
      if (!manifestSet.has(name)) {
        throw new Error(`skills/ has undeclared top-level entry: ${name}`);
      }
    }
    // (manifest 反向包含也要查一次 —— 否则 actualTop 漏了 manifest 某条,上面 size
    // 相等的分支不会 catch 到;其实下面 for name of manifest 的 lstat 会 ENOENT,
    // 但显式查一次意图更清晰、错误信息更好。)
    for (const name of manifestSet) {
      if (!actualTop.has(name)) {
        throw new Error(`skills/ missing declared manifest entry: ${name}`);
      }
    }

    // manifest 逐条校验:基线 skill 必须全部存在、每条 owner=root、
    // SKILL.md 齐全 —— parent-dir 挂载会把"全部 skill 一次性 ro 给 AI",
    // 所以校验也必须覆盖全部,否则 `skills/foo` 可能被运维误塞成 group-writable
    // / symlink 成某宿主敏感目录,从父目录挂进容器就暴露了。
    for (const name of V3_CCB_BASELINE_SKILL_NAMES) {
      const skillDir = pathJoin(skillsDirPath, name);
      assertBaselineLeaf(skillDir, "dir", abs);
      // R3 codex HIGH#1:skill 目录下**必须只有** SKILL.md。未来如果需要支持
      // scripts/ references/ 等,要显式扩这条白名单,并把新条目加入 lstat 校验闭环。
      const skillEntries = readdirSync(skillDir);
      if (skillEntries.length !== 1 || skillEntries[0] !== "SKILL.md") {
        throw new Error(
          `skill dir ${name} must contain exactly one entry (SKILL.md), got: ${JSON.stringify(skillEntries)}`,
        );
      }
      const skillMd = pathJoin(skillDir, "SKILL.md");
      assertBaselineLeaf(skillMd, "file", abs);
    }
    return {
      agentsMdHostPath: agentsReal,
      claudeMdHostPath: claudeReal,
      skillsDirHostPath: skillsDirReal,
    };
  } catch {
    // ENOENT / EACCES / 校验失败全走 fail-closed 路径(调用方处理)
    return null;
  }
}

/** managed label,GC / orphan reconcile 用 */
const V3_MANAGED_LABEL_KEY = "com.openclaude.v3.managed";
const V3_UID_LABEL_KEY = "com.openclaude.v3.uid";

/** IP 池 — 排除 .0 (network) / .1 (gateway) / .2-.9 (运维预留) / .255 (broadcast) */
const V3_IP_OCTET_MIN = 10;
const V3_IP_OCTET_MAX = 250;
/** 在 172.30.0/16 内随机选,失败重试上限(uniq 冲突时 INSERT 重试) */
const V3_IP_ALLOC_MAX_ATTEMPTS = 30;

/**
 * v3 容器资源硬限额默认值。env 可覆盖:
 *   - OC_V3_MEMORY_MB   → DEFAULT_V3_MEMORY_MB
 *   - OC_V3_CPUS        → DEFAULT_V3_CPUS(小数,0.5=半核)
 *   - OC_V3_PIDS_LIMIT  → DEFAULT_V3_PIDS_LIMIT
 *
 * 非法值(NaN / 非数字 / ≤0 / floor 后 <1)一律回退默认,不抛。选值理由:
 *   - Memory 4096 MB:v3 容器内跑 CCB + node + streaming + 用户工具 + skill 基线,
 *     v2 的 384MB 对 v3 场景不够;Opus 4.7 长上下文 + 多图附件实测峰值破 2GB
 *     被 cgroup OOM 反复杀(uid=1/4/75 多次记录),4GB 给上下文 + 编译 + 缓存留余量
 *   - CPUs 1.0 核:交互式 agent 够用;峰值由 idle sweep 30min 回收兜底
 *   - PidsLimit 4096:防 fork bomb,同时给团队模式留出余量。Codex 队长并发
 *     delegate_task + browser/vision/Node worker 线程曾在 1024 下触发 cgroup
 *     fork rejected,4096 仍由 4GB memory + 1 CPU 共同约束资源滥用。
 */
export const DEFAULT_V3_MEMORY_MB = 4096;
export const DEFAULT_V3_CPUS = 1.0;
export const DEFAULT_V3_PIDS_LIMIT = 4096;

/**
 * 解析 v3 容器资源限额。env 覆盖 + 非法值回退默认。
 *
 * 关键护栏(Codex round 1 BLOCKER):必须先 Math.floor 再要求 >=1,否则
 * OC_V3_MEMORY_MB=0.5 / OC_V3_CPUS=1e-10 / OC_V3_PIDS_LIMIT=0.5 会被 floor 到 0,
 * Docker 把 0 解读为"不限",跟修复目标直接冲突。
 */
function resolveV3ResourceLimits(): {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
} {
  const MIB = 1024 * 1024;
  const NANO_CPU = 1_000_000_000;

  const memEnv = Number(process.env.OC_V3_MEMORY_MB);
  const memMbFloored = Number.isFinite(memEnv) ? Math.floor(memEnv) : Number.NaN;
  const memMb = memMbFloored >= 1 ? memMbFloored : DEFAULT_V3_MEMORY_MB;

  const cpuEnv = Number(process.env.OC_V3_CPUS);
  const nanoCpusRaw = Number.isFinite(cpuEnv) ? Math.floor(cpuEnv * NANO_CPU) : Number.NaN;
  const nanoCpus = nanoCpusRaw >= 1 ? nanoCpusRaw : Math.floor(DEFAULT_V3_CPUS * NANO_CPU);

  const pidsEnv = Number(process.env.OC_V3_PIDS_LIMIT);
  const pidsFloored = Number.isFinite(pidsEnv) ? Math.floor(pidsEnv) : Number.NaN;
  const pidsLimit = pidsFloored >= 1 ? pidsFloored : DEFAULT_V3_PIDS_LIMIT;

  return { memoryBytes: memMb * MIB, nanoCpus, pidsLimit };
}

// ───────────────────────────────────────────────────────────────────────
// V3 advisory lock keys
//
// Postgres advisory lock 二元 (int4, int4) 形式:
//   - per-uid lifecycle lock (NS=USER_LIFECYCLE_LOCK_NS, key=uid):
//     互斥同一 uid 的 provision / volumeGc(防 GC 删 volume 时正在 provision 的
//     race;同时也防同 uid 并发 provision 在 PG uniq+docker name 双层冲突前撞)
//   - per-host admission lock (NS=HOST_CAP_LOCK_NS, key=FNV(host_uuid)):
//     按 host 切片串行 admission 检查,跨 host 完全并行。配合 per-host recount +
//     per-host max_containers,确保 compute_hosts.max_containers 在并发下硬限不破。
//
// 锁是 xact-scoped(`pg_advisory_xact_lock`),COMMIT/ROLLBACK 自动释放,
// 不需要手动 unlock,避免连接池借出后 lock 残留卡死后续事务。
//
// 选 magic key:固定 32-bit 常量,与项目其它 advisory lock 不撞;migrate.ts 用的是
// 0x0c_be_1e_5a_01n single-int8,不在二元 (int4,int4) 命名空间冲突。
//
// 锁顺序不变量(全代码库唯一约束 lock order):
//   1. acquireUserLifecycleLock(client, uid)         — per-uid 生命周期锁
//   2. acquireHostCapLock(client, effectiveHostUuid) — per-host admission 锁
// 任何新 advisory lock 加入时必须置入此顺序末端,反向获取 = 潜在死锁。
// provisionV3Container 是当前唯一同事务持两把锁的路径。
// ───────────────────────────────────────────────────────────────────────

/** 二元 advisory lock 命名空间 —— 同 uid 的 lifecycle 操作互斥 */
export const USER_LIFECYCLE_LOCK_NS = 0x0c_b3_d0_01;

/** 二元 advisory lock 命名空间 —— per-host cap admission control */
export const HOST_CAP_LOCK_NS = 0x0c_b3_ca_70;

/**
 * uid → int4 (PG advisory lock 接受的 32-bit signed 整数)。
 * MVP 单库 < 2^31 = 21 亿用户,实际 ≪ 1k,直接截即可;真撞了 2^31 P1 加 host_id
 * 再做 hash。`uid|0` 截顶 32 位 signed,负数也合法(PG 接受 negative int4)。
 */
function uidToLockKey(uid: number): number {
  // (uid | 0) 走 ToInt32 抽象,行为定义清楚(超过 2^31-1 会 wrap 成负数,仍合法 lock key)
  return uid | 0;
}

/**
 * Postgres canonical UUID 文本形式(36 字符 lowercase + 4 个连字符)。
 * 严格匹配 — 任何替代输入(uppercase / `{...}` 包裹 / 无连字符)= caller bug。
 */
const HOST_UUID_CANONICAL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * host_uuid (PG canonical 36-char lowercase) → int4 lock key。
 * FNV-1a 32-bit:无依赖、确定性、对 < 10^4 host 散列充分,碰撞触发的退化只是
 * 两台 host 串行 admission(语义无损,只是失去并行)。
 */
function hostIdToLockKey(hostUuid: string): number {
  let h = 0x811c_9dc5 | 0;
  for (let i = 0; i < hostUuid.length; i++) {
    h = (h ^ hostUuid.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x0100_0193) | 0;
  }
  return h;
}

/**
 * 在事务内 acquire per-uid lifecycle lock。COMMIT/ROLLBACK 自动 release。
 *
 * caller 必须已经 `BEGIN`(否则 advisory_xact_lock 在 autocommit 下立即释放,无效)。
 *
 * 用途:
 *   - provisionV3Container 事务的第一步
 *   - runVolumeGcTick 单 uid 处理事务的第一步
 * 两边持同一 (NS, uid) 锁 → PG 串行,GC 与 provision 不会撞 docker volume
 * remove vs container create 的 race。
 */
export async function acquireUserLifecycleLock(
  client: PoolClient,
  uid: number,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock($1::int4, $2::int4)",
    [USER_LIFECYCLE_LOCK_NS, uidToLockKey(uid)],
  );
}

/**
 * 在事务内 acquire per-host admission lock。COMMIT/ROLLBACK 自动 release。
 *
 * 严格只接受 PG canonical 36-char lowercase uuid:系统不变量是 hostUuid 必来自
 * `compute_hosts.id` 的出库值,任何非 canonical 输入 = caller bug,fail-closed
 * (KISS / 调用方 bug 显性化)。
 *
 * subkey = FNV-1a(hostUuid) → 不同 host 拿不同锁,跨 host admission 完全并行。
 *
 * 与 per-host recount(同事务 SELECT COUNT WHERE host_uuid=$1)+ per-host
 * max_containers(同事务 SELECT compute_hosts.max_containers WHERE id=$1)联用,
 * 是 v3 admission control 的硬上限闭环。
 */
export async function acquireHostCapLock(
  client: PoolClient,
  hostUuid: string,
): Promise<void> {
  if (!HOST_UUID_CANONICAL_RE.test(hostUuid)) {
    throw new SupervisorError(
      "InvalidArgument",
      `host uuid must be PG canonical lowercase 36-char form, got: ${JSON.stringify(hostUuid)}`,
    );
  }
  await client.query(
    "SELECT pg_advisory_xact_lock($1::int4, $2::int4)",
    [HOST_CAP_LOCK_NS, hostIdToLockKey(hostUuid)],
  );
}

// ───────────────────────────────────────────────────────────────────────
// 公共类型
// ───────────────────────────────────────────────────────────────────────

/**
 * provisionV3Container 的依赖注入。
 *
 * - `docker`:dockerode client(index.ts 单例)
 * - `pool`:pg Pool(用于 INSERT/UPDATE agent_containers,IP 唯一约束在 PG 层)
 * - `image`:openclaude/openclaude-runtime:<tag>(由 OC_RUNTIME_IMAGE env 注入)
 *
 * `randomIp` / `randomSecret` 为可选注入,生产用 crypto 默认实现;
 * 测试可以注入确定值便于断言。
 */
export interface V3SupervisorDeps {
  docker: Docker;
  pool: Pool;
  image: string;
  /** 测试钩子:覆盖 IP 分配。生产留空走默认。 */
  randomIp?: () => string;
  /** 测试钩子:覆盖 secret 生成。生产留空走默认。 */
  randomSecret?: () => string;
  /**
   * CCB 平台基线目录。覆盖 env `OC_V3_CCB_BASELINE_DIR`,env 不设则走
   * `DEFAULT_V3_CCB_BASELINE_DIR`。目录不存在或结构不全 → **默认 fail-closed**,
   * provision 抛 `SupervisorError("CcbBaselineMissing")`,用户启动失败,运维
   * 修好基线才能恢复。显式开 `OC_V3_CCB_BASELINE_OPTIONAL=1` 才走 warn+跳过挂载
   * 的降级路径(仅限 dev/test/local)。
   *
   * 详见 `DEFAULT_V3_CCB_BASELINE_DIR` / `resolveCcbBaselineMounts` 注释。
   */
  ccbBaselineDir?: string;
  /**
   * v3 file proxy —— HOST 根 secret(32 byte hex),用于给每个容器算
   * `OC_BRIDGE_NONCE = HMAC_SHA256(bridgeSecret, containerId)`。
   *
   * 注入 → provisionV3Container 会同时往容器 env 写入 OC_CONTAINER_ID +
   * OC_BRIDGE_NONCE;容器内 /healthz 依赖这两个 env 存在才广播
   * `file-proxy-v1` capability。
   *
   * 未注入 → 容器 env 里不写 OC_BRIDGE_NONCE → /healthz 不广播 capability →
   * containerFileProxy 探测到 CONTAINER_OUTDATED → 503(等同 file proxy 未启用)。
   */
  bridgeSecret?: string;
  /**
   * 多机 compute-pool facade。注入 + 传入的 `hostId !== selfHostId` 时,
   * provision/stop/status 的 docker 操作走 remote node-agent;否则所有
   * docker 调用仍然走本地 `deps.docker`(保留单机 MVP 行为,零风险)。
   *
   * 未注入 → 单机路径,所有 docker 操作直接用 `deps.docker`。
   */
  containerService?: ContainerService;
  /**
   * 本机在 compute_hosts 表里的 host_id(UUID)。与 `containerService` 一起注入
   * 才有意义 —— 用来判定"这次 provision 调度到的目标 host == 自己 vs. 远端"。
   * 不注入 → facade 路径也退化为"一切都是自己"。
   */
  selfHostId?: string;
  /**
   * v1.0.72 — 远端 host 的 per-container codex auth.json 写入路由。
   *
   * provisionV3Container / lazy migrate 决定要在远端 host 上落 codex
   * per-container auth 时调用。caller 已选好 hostUuid(必 ≠ selfHostId,
   * 否则走本地 writeCodexContainerAuthFile);本回调内部:
   *   1. computeQueries.getHostById(hostUuid) → ComputeHostRow
   *   2. hostRowToTarget(row) → NodeAgentTarget(含解密的 PSK)
   *   3. putRemoteCodexContainerAuth(target, containerId, ...)
   *   4. finally:target.psk?.fill(0) 清密钥 buffer
   *
   * 抛 Error → caller 当 codex 绑定失败,fallback 到 NULL bind / no codex
   * mount(与本地 try/catch fallback 相同语义)。
   *
   * 仅在 useRemote 路径有意义;不注入 → useRemote=true 时 codex 绑定退化
   * 为"无 codex 绑定"(不阻断 provision,GPT 在该容器内不可用)。
   */
  putRemoteCodexAuth?(
    hostUuid: string,
    containerId: string,
    accessToken: string,
    lastRefreshIso: string,
  ): Promise<void>;
  /**
   * v1.0.72 — 远端 host 的 per-container codex auth.json 删除。
   *
   * stopAndRemoveV3Container 在容器清理后调用,best-effort,失败不抛
   * (与本地 removeCodexContainerAuthDir 同语义)。
   */
  deleteRemoteCodexAuth?(hostUuid: string, containerId: string): Promise<void>;
  /**
   * v1.0.106 — 测试钩子:覆盖 `listAllHosts`(P1 远端 GC 路由用)。
   *
   * `removeV3Volume` 在多 host 场景下需要把 5 个 volume 在所有 ready/draining
   * host 上 fan-out 删一遍(banned/no-login user 已无 active 容器,无法定位
   * 权威 host;fan-out 是最可靠的兜底)。生产留空走 `queries.listAllHosts`,
   * 测试可注入 fake 列表精确控制 host 维度。
   */
  listAllHosts?: () => Promise<ComputeHostRow[]>;
}

/** provision 成功后返回。3D ensureRunning 拿来注入到 userChatBridge */
export interface ProvisionedV3Container {
  /** agent_containers.id(INSERT RETURNING) */
  containerId: number;
  /** agent_containers.user_id(传入即返回,方便 caller 不重查) */
  userId: number;
  /** docker bridge 上分配给容器的 IP */
  boundIp: string;
  /** 容器内 OpenClaude gateway 监听端口 */
  port: number;
  /** docker container ID(full hex 64) */
  dockerContainerId: string;
  /** 用户态 token —— 仅用于 caller 测试 / debug;生产路径不应该回看 */
  token: string;
  /**
   * 调度到的 host_uuid。null = 单机 MVP(容器在 master 本机);非 null 且 !==
   * deps.selfHostId = remote host(caller 的 readiness 要走 node-tunnel)。
   */
  hostId: string | null;
}

/** getV3ContainerStatus 返回 */
export interface V3ContainerStatus {
  containerId: number;
  userId: number;
  boundIp: string;
  port: number;
  dockerContainerId: string;
  /** docker inspect 后的标准化态。docker missing 也归 stopped(由 caller 决定 vanish) */
  state: "running" | "stopped" | "missing";
  /**
   * agent_containers.host_uuid。null = 单机 MVP 遗留行 / 本机;非 null 且 !==
   * deps.selfHostId = remote host(caller 的 readiness/stop 要走 node-tunnel)。
   */
  hostId: string | null;
}

// ───────────────────────────────────────────────────────────────────────
// 名字 / 校验工具
// ───────────────────────────────────────────────────────────────────────

/** uid → docker 容器名。`oc-v3-u<uid>`,uid 必须正整数 */
export function v3ContainerNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-v3-u${uid}`;
}

/** uid → 主 named volume 名(挂 /home/agent/.openclaude)。`oc-v3-data-u<uid>` */
export function v3VolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-v3-data-u${uid}`;
}

/**
 * uid → CCB projects(session JSONL)持久化 volume 名。`oc-v3-proj-u<uid>`。
 *
 * 独立于主 volume,专用于 `/run/oc/claude-config/projects` 挂载点。
 * 主 volume 死了这个也要一起死(GC / reconcile 成对操作),全 5 volume 生命周期绑定。
 */
export function v3ProjectsVolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-v3-proj-u${uid}`;
}

/**
 * uid → codex HOME 持久化 volume 名。`oc-v3-codex-u<uid>`(D2)。
 * 挂 /home/agent/.codex,持久化用户 MCP 配置 / plugins / 自定义 skills。
 */
export function v3CodexVolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-v3-codex-u${uid}`;
}

/**
 * uid → ~/.local 持久化 volume 名。`oc-v3-userlocal-u<uid>`(D2)。
 * 挂 /home/agent/.local,持久化 pip --user / npm prefix / pipx / uv tool 安装。
 */
export function v3UserLocalVolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-v3-userlocal-u${uid}`;
}

/**
 * uid → ~/.config 持久化 volume 名。`oc-v3-userconfig-u<uid>`(D2)。
 * 挂 /home/agent/.config,持久化 XDG configs(gh / git / npm userconfig / pip 等)。
 */
export function v3UserConfigVolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-v3-userconfig-u${uid}`;
}

/**
 * 5 volume 名的打包返回值(D2 持久化方案)。
 *
 * 历史:v1.0.0 ~ 1.0.27 只有 data 一个 volume → v1.0.28 加 projects 成 V3VolumePair
 * → v1.0.105 (D2) 加 codex / userLocal / userConfig 凑齐用户级持久化全套
 * (Boss 要求"在容器里像普通 Linux 一样装 MCP / 插件 / pip / npm 不丢")。
 *
 * 5 个 volume 生命周期严格绑定:ensureV3Volumes 一起建,removeV3Volume 一起删。
 * 任一 volume 创建失败直接抛,不尝试部分接管。
 */
export interface V3VolumeBundle {
  /** 主数据 volume(挂 /home/agent/.openclaude) */
  data: string;
  /** CCB projects volume(挂 /run/oc/claude-config/projects) */
  projects: string;
  /** codex CLI HOME volume(挂 /home/agent/.codex)— D2 */
  codex: string;
  /** ~/.local volume(挂 /home/agent/.local)— D2 */
  userLocal: string;
  /** ~/.config volume(挂 /home/agent/.config)— D2 */
  userConfig: string;
}

/** 在 172.30.0.0/16 内挑一个 IP(默认实现) */
function defaultPickRandomIp(): string {
  // 172.30.0.0/16 → 第三 + 第四 octet 任意
  // 排除 .0.0 (network), .0.1 (gateway), .255.255 (broadcast),其它都可
  // 简化:第三 octet 取 [0,255],第四取 [V3_IP_OCTET_MIN, V3_IP_OCTET_MAX]
  // 这样不撞 .0 / .255,也避开 .1 网关
  const third = Math.floor(Math.random() * 256);
  const fourth = V3_IP_OCTET_MIN + Math.floor(Math.random() * (V3_IP_OCTET_MAX - V3_IP_OCTET_MIN + 1));
  // 极小概率撞到 .0.1 网关:third=0 && fourth=1。fourth 起点 >= 10,绝不会
  return `172.30.${third}.${fourth}`;
}

/** 32-byte random → 64 hex(默认实现) */
function defaultRandomSecret(): string {
  return randomBytes(32).toString("hex");
}

/** SHA-256(secret_bytes) → 32-byte Buffer(与 containerIdentity.hashSecret 同算) */
function hashSecretToBuffer(secretHex: string): Buffer {
  return createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
}

/** node-agent 通过 docker CLI 跑 `docker run`,image 缺失时返回的错误文案。
 *  对应 v3ensureRunning 的 RETRY_AFTER_IMAGE_MISSING_SEC=300 长重试路径,
 *  避免 5s 风暴(详见 v3ensureRunning.ts:71 注释)。
 *
 *  匹配的文案样本(docker CLI 实测):
 *    - "Unable to find image 'foo:bar' locally" + "pull access denied"
 *    - "manifest unknown"
 *    - "repository ... not found"
 *  注意 dockerode 走 daemon API 走 statusCode=404 + "No such image" 路径,
 *  跟这里的 CLI 文案不同;两条路径都要覆盖。
 */
const NODE_AGENT_IMAGE_MISSING_PATTERNS: RegExp[] = [
  /unable to find image/i,
  /pull access denied/i,
  /manifest unknown/i,
  /repository .* not found/i,
  /no such image/i, // node-agent 若透传 docker daemon "No such image" 文案,与 dockerode 4xx 路径同源覆盖
];

/**
 * v1.0.7 — 远端 docker run 失败、message 命中以下任一文案时,把它归到
 * `TransientHostFault`,让 v3ensureRunning 把该 host 进 nodeScheduler cooldown。
 *
 *  匹配的文案样本(2026-04-26 实战):
 *    - "Address already in use"        — bridge IP/iptables/NAT 残留冲突
 *    - "port is already allocated"     — 同 host 端口已被占
 *    - "Conflict. The container name ... is already in use" — 同名容器残留
 *
 *  全部转 lowercase 比对,避免 docker 大小写文案漂移。匹配规则故意宽:
 *  此 code 只影响"短期避让该 host"的调度决定,误归类的代价只是 60s 内不挑该 host,
 *  对正确性无影响;漏归类则用户继续走 5s 死循环,代价大。
 */
const NODE_AGENT_HOST_FAULT_PATTERNS: RegExp[] = [
  /address already in use/i,
  /port is already allocated/i,
  /conflict.*container.*already in use/i,
];

/** 把 supervisor 内部错误归到 SupervisorError,便于上层按 code 处理。
 *  export 仅用于单测;生产路径只在本文件内调用。 */
export function wrapDockerError(err: unknown): SupervisorError {
  if (err instanceof SupervisorError) return err;
  // 远端 node-agent RPC 错误(走 docker CLI exec)。优先识别"image 缺失"
  // 文案 → ImageNotFound,让 v3ensureRunning 走 5min 长重试而不是 5s 风暴。
  // 其它 RUN_FAIL 落 Unknown,与原行为一致。
  if (err instanceof AgentAppError) {
    const message = err.message;
    // SupervisorError.cause 只接 {statusCode, message} 两字段(types.ts:124),
    // node-agent 的 hostId/agentErrCode 已经编码在 message 里(nodeAgentClient.ts:348
    // 拼成 "agent returned 500: {code:RUN_FAIL,error:...}"),不再额外塞。
    // v1.0.8:VOL_CREATE_FAIL 几乎都是 host 级 docker daemon 问题(磁盘满 /
    // overlay2 锁 / 权限),归 TransientHostFault 让 v3ensureRunning 标该 host
    // 60s cooldown,用户下次 5s 重连自动换台。即使是真·应用 bug(volume 名非法等),
    // 行为退化为"轮一遍所有 host 最后报 host_full",可接受不有害。
    if (err.agentErrCode === "VOL_CREATE_FAIL") {
      return new SupervisorError("TransientHostFault", message, {
        statusCode: err.httpStatus, message,
      });
    }
    if (
      err.agentErrCode === "RUN_FAIL" &&
      NODE_AGENT_IMAGE_MISSING_PATTERNS.some((re) => re.test(message))
    ) {
      return new SupervisorError("ImageNotFound", message, {
        statusCode: err.httpStatus, message,
      });
    }
    if (
      err.agentErrCode === "RUN_FAIL" &&
      NODE_AGENT_HOST_FAULT_PATTERNS.some((re) => re.test(message))
    ) {
      return new SupervisorError("TransientHostFault", message, {
        statusCode: err.httpStatus, message,
      });
    }
    return new SupervisorError("Unknown", message, {
      statusCode: err.httpStatus, message,
    });
  }
  const e = err as { statusCode?: number; message?: string; code?: string };
  const message = typeof e.message === "string" ? e.message : String(err);
  if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "ECONNREFUSED") {
    return new SupervisorError("DockerUnavailable", `docker daemon unreachable: ${message}`, { message });
  }
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : undefined;
  if (statusCode === 404) {
    if (/No such image/i.test(message) || /image.*not found/i.test(message)) {
      return new SupervisorError("ImageNotFound", message, { statusCode, message });
    }
    return new SupervisorError("NotFound", message, { statusCode, message });
  }
  if (statusCode === 409) {
    return new SupervisorError("NameConflict", message, { statusCode, message });
  }
  if (statusCode === 400) {
    return new SupervisorError("InvalidArgument", message, { statusCode, message });
  }
  return new SupervisorError("Unknown", message, { statusCode, message });
}

// ───────────────────────────────────────────────────────────────────────
// v1.0.84 PR #4 — image label guard(supply-chain check before docker create)
// ───────────────────────────────────────────────────────────────────────

/**
 * 镜像 label 必含的 feature token。runtime gateway 若没把 server-authored 文本
 * 的 HTTP sink 编进去(`v3MasterSink.ts` 模块缺失或被 build 漏选),容器表面正常
 * 跑但每个 codex turn 的权威文本都会通过老 durable session 路径丢失。该 label
 * 由 image build 时显式打入(scripts/v3-image-attest.ts 校验也用同一 token),
 * provision 前 inspect image 校验 → guard 闭环。
 */
const V3_RUNTIME_REQUIRED_FEATURE = "v3-sink";

type V3ImageGuardMode = "enforce" | "warn" | "off";

function readV3ImageGuardMode(): V3ImageGuardMode {
  const raw = (process.env.OC_V3_IMAGE_GUARD ?? "").trim().toLowerCase();
  if (raw === "warn") return "warn";
  if (raw === "off") return "off";
  // 默认 + 任何非法值 → enforce(fail-closed)。
  return "enforce";
}

/**
 * provision 前置 guard:确保即将 spawn 的 image 带 oc.runtime.features=v3-sink。
 *
 * 错误归一化契约(round-1 Codex 锁定):
 *   - label 缺 token → throw `SupervisorError("ImageOutdated", …)`。caller 在
 *     v3ensureRunning 按 code 分流,setQuarantined(host, image-mismatch) +
 *     ContainerUnreadyError("image_outdated")。
 *   - inspectImage 抛(daemon down / mTLS / 旧 agent 无路由)→ 透 wrapDockerError,
 *     行为与"docker create 撞同样故障"一致。wrapDockerError 已 SupervisorError
 *     pass-through,所以本函数自己抛 ImageOutdated 也会原样穿出。
 *   - inspectImage 返 null(image 真不存在)→ guard 放行,后续 docker create
 *     撞 ImageNotFound 走原 runtime-image-missing 路径,本 guard 不抢。
 *
 * 调用时机:`provisionV3Container` 内,**早于** `deps.pool.connect()` / BEGIN /
 * 任何 docker 副作用。早 fail 避免持 per-uid + host-cap 双锁。
 *
 * 模式由 env `OC_V3_IMAGE_GUARD` 控制:
 *   - `enforce`(默认 / 任何非法值)→ 缺 token 抛错
 *   - `warn`     → 缺 token console.warn 后放行,留给 ops 跟进
 *   - `off`      → guard 完全 short-circuit(本机 dev 或一次性绕过)
 */
async function assertImageHasV3Sink(
  deps: V3SupervisorDeps,
  hostId: string | undefined,
  image: string,
): Promise<void> {
  const mode = readV3ImageGuardMode();
  if (mode === "off") return;

  // resolve 出实际拿来 inspect / 写日志的 host 标识,保证 inspect 与 detail 文案
  // 永远引用同一个值(round-2 Codex 建议:避免日志里 inspect host 跟报错 host 错位)。
  const resolvedHost = hostId ?? deps.selfHostId ?? "self";

  let labels: Record<string, string> | null;
  try {
    if (deps.containerService) {
      // facade 路由(remote/self 都走它,内部按 isRemote 分流)
      const inspected = await deps.containerService.inspectImage(resolvedHost, image);
      labels = inspected === null ? null : (inspected.labels ?? {});
    } else {
      // 无 facade(纯单机 dev / 单测无 pool 路径)→ 直接 dockerode
      try {
        const info = (await deps.docker.getImage(image).inspect()) as {
          Config?: { Labels?: Record<string, string> | null };
        };
        labels = info.Config?.Labels ?? {};
      } catch (err) {
        if ((err as { statusCode?: number } | null)?.statusCode === 404) {
          labels = null;
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    throw wrapDockerError(err);
  }
  if (labels === null) return; // image absent — 让 ImageNotFound 路径接管

  const featuresRaw = (labels["oc.runtime.features"] ?? "").trim();
  const features = featuresRaw ? featuresRaw.split(/\s+/) : [];
  if (features.includes(V3_RUNTIME_REQUIRED_FEATURE)) return;

  const detail =
    `image=${image} host=${resolvedHost} ` +
    `oc.runtime.features=${JSON.stringify(featuresRaw)} ` +
    `(need token=${V3_RUNTIME_REQUIRED_FEATURE})`;

  if (mode === "warn") {
    // eslint-disable-next-line no-console
    console.warn(
      `[v3supervisor] image guard FAIL but mode=warn, allowing provision: ${detail}`,
    );
    return;
  }
  throw new SupervisorError(
    "ImageOutdated",
    `runtime image missing required feature label: ${detail}`,
  );
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // dockerode 抛 `{ statusCode: 404 }`;远端 RemoteNodeAgentBackend 走
  // nodeAgentClient 抛 `AgentAppError { httpStatus: 404 }`(见
  // compute-pool/nodeAgentClient.ts:344)。stopAndRemoveV3Container 在跨 host
  // 路径上调用 deps.containerService.stop/remove,需统一识别两种 404 形状。
  const e = err as { statusCode?: unknown; httpStatus?: unknown };
  return e.statusCode === 404 || e.httpStatus === 404;
}

function isNotModified(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err
    && (err as { statusCode: number }).statusCode === 304;
}

// ───────────────────────────────────────────────────────────────────────
// Volume:幂等创建 + label 校验(防同名被运维劫持)
// ───────────────────────────────────────────────────────────────────────

/**
 * 幂等创建单个用户 volume 并校验 label/driver/options。
 *
 * 复用 v2 volumes.ts 的 label 守护模式:create 之后 inspect,断言 managed +
 * uid 对得上,Driver=local 且 Options 为空。任何不符 → 拒绝接管。
 *
 * `purpose` 仅用于错误诊断(wire 消息可读),不落 label —— 两条 volume 靠名字
 * 前缀(oc-v3-data- / oc-v3-proj-)就能完全区分,多加 label 只增加接管时
 * 校验负担,没实际收益。
 */
async function ensureSingleV3Volume(
  docker: Docker,
  uid: number,
  name: string,
  purpose: "data" | "projects" | "codex" | "userLocal" | "userConfig",
): Promise<void> {
  await docker.createVolume({
    Name: name,
    Driver: "local",
    Labels: {
      [V3_MANAGED_LABEL_KEY]: "1",
      [V3_UID_LABEL_KEY]: String(uid),
    },
  });
  const info = await docker.getVolume(name).inspect();
  if (info.Driver && info.Driver !== "local") {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} (${purpose}) exists with driver=${info.Driver}, expected local`,
    );
  }
  const labels = (info.Labels ?? {}) as Record<string, string>;
  if (labels[V3_MANAGED_LABEL_KEY] !== "1") {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} (${purpose}) exists but is not managed by openclaude v3 (missing ${V3_MANAGED_LABEL_KEY})`,
    );
  }
  if (labels[V3_UID_LABEL_KEY] !== String(uid)) {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} (${purpose}) exists but belongs to uid=${labels[V3_UID_LABEL_KEY]}, expected ${uid}`,
    );
  }
  // bind / nfs / 其它带 Options 的 volume 拒绝接管(防同名 + label 伪造)
  const opts = (info as { Options?: Record<string, string> | null }).Options;
  if (opts && typeof opts === "object" && Object.keys(opts).length > 0) {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} (${purpose}) exists with custom Options=${JSON.stringify(opts)}; refuse to adopt`,
    );
  }
}

/**
 * 幂等创建用户全部 5 个 volume(D2 持久化方案):
 *   - 主 volume       (`oc-v3-data-u<uid>`)       → /home/agent/.openclaude
 *   - projects volume (`oc-v3-proj-u<uid>`)       → /run/oc/claude-config/projects
 *   - codex volume    (`oc-v3-codex-u<uid>`)      → /home/agent/.codex
 *   - userLocal volume(`oc-v3-userlocal-u<uid>`)  → /home/agent/.local
 *   - userConfig volume(`oc-v3-userconfig-u<uid>`)→ /home/agent/.config
 *
 * 5 个 volume 的生命周期绑定:ensureV3Volumes 一起建,removeV3Volume 一起删。
 * 任一 volume 被 label 守护拒绝 → 直接抛,不尝试部分接管(语义更清晰)。
 *
 * **purpose 标签** 串复用 ensureSingleV3Volume 的诊断用 enum;新增 codex /
 * userLocal / userConfig 三类只为出错时人能看懂哪个挂载点 fail,不落 label,
 * 与既有 data / projects 一致(靠名字前缀就能唯一区分)。
 */
async function ensureV3Volumes(docker: Docker, uid: number): Promise<V3VolumeBundle> {
  const data = v3VolumeNameFor(uid);
  const projects = v3ProjectsVolumeNameFor(uid);
  const codex = v3CodexVolumeNameFor(uid);
  const userLocal = v3UserLocalVolumeNameFor(uid);
  const userConfig = v3UserConfigVolumeNameFor(uid);
  await ensureSingleV3Volume(docker, uid, data, "data");
  await ensureSingleV3Volume(docker, uid, projects, "projects");
  await ensureSingleV3Volume(docker, uid, codex, "codex");
  await ensureSingleV3Volume(docker, uid, userLocal, "userLocal");
  await ensureSingleV3Volume(docker, uid, userConfig, "userConfig");
  return { data, projects, codex, userLocal, userConfig };
}

/**
 * 删 user volume(stop+remove 容器后才能删,否则 docker 409)。missing → noop。
 *
 * v1.0.106 P1:多 host fan-out。banned/no-login user 已无 active container 行,
 * 无法直接查权威 host;改成对所有 ready+draining host fan-out 调
 * `containerService.removeVolume(hostId, name)`(self 走本地 dockerode,remote
 * 走 node-agent HTTPS DELETE /volumes/{name},node-agent 端幂等返 204)。
 *
 * 错误聚合策略:
 *   - per-host 并行,per-name 串行(同 docker daemon 内不并发删避免锁抢)
 *   - not-found(本地 statusCode=404 / 远端 httpStatus=404)→ silent continue
 *   - 任一非 not-found 错误 → 收集到 errors[],继续删本 host 后续 volume
 *     最大化清理进度,避免误标 cleanup 成功后永久泄漏
 *   - errors.length > 0 → 抛 AggregateError,caller(gcSingleUidLocked)聚合
 *     到 outcome.failed,下轮 GC tick 重新 SELECT 重试
 *
 * Fallback:`deps.containerService` 未注入(测试 / 单机 MVP 场景)→ 退化为
 * 仅本机 dockerode 删除,保留向后兼容。
 *
 * 5 个 volume 全删,语义"哪个 host 上有就删哪个,没有跳过"。生命周期绑定:
 * ensureV3Volumes 一起建,本函数一起删(host 维度独立但 name 集合恒定 5 个)。
 */
export async function removeV3Volume(deps: V3SupervisorDeps, uid: number): Promise<void> {
  const names = [
    v3VolumeNameFor(uid),
    v3ProjectsVolumeNameFor(uid),
    v3CodexVolumeNameFor(uid),
    v3UserLocalVolumeNameFor(uid),
    v3UserConfigVolumeNameFor(uid),
  ];

  // 单机 MVP / 无 facade 测试:退化为本机 dockerode 直删(保留旧行为)。
  if (!deps.containerService) {
    for (const name of names) {
      try {
        await deps.docker.getVolume(name).remove();
      } catch (err) {
        if (isNotFound(err)) continue;
        throw wrapDockerError(err);
      }
    }
    return;
  }

  const listFn = deps.listAllHosts ?? defaultListAllHosts;
  const hosts = await listFn();
  // ready: 当前可承接 placement 的 host;draining: 不接新 placement 但仍可能
  // 持泄漏 volume,必须清。bootstrapping/quarantined/broken 跳过 — 删不了也没风险。
  const targets = hosts.filter(
    (h) => h.status === "ready" || h.status === "draining",
  );

  const errors: Error[] = [];
  await Promise.all(
    targets.map(async (host) => {
      for (const name of names) {
        try {
          await deps.containerService!.removeVolume(host.id, name);
        } catch (err) {
          if (isNotFound(err)) continue;
          const detail = err instanceof Error ? err.message : String(err);
          errors.push(new Error(`host=${host.id}(${host.name}) volume=${name}: ${detail}`));
          // 继续删本 host 后续 volume:保最大清理面,避免单 volume 失败拖整 host。
        }
      }
    }),
  );

  if (errors.length > 0) {
    throw new AggregateError(errors, `removeV3Volume failed for uid=${uid}`);
  }
}

// ───────────────────────────────────────────────────────────────────────
// 远程执行 mux per-user 目录
// ───────────────────────────────────────────────────────────────────────

/**
 * 宿主侧预创建 `/run/ccb-ssh/u<uid>`,模式 0750 owner=root group=V3_AGENT_GID。
 *
 * 为什么必须 supervisor 预创建(不能靠 docker 或 sshMux 兜底):
 *   - docker 发现 source 路径不存在会自动 mkdir 0755 root:root;mount 之后再 chmod
 *     的窗口里,容器已经在跑 → 容器可见的权限跟我们期望不一致。
 *   - sshMux.ensureRunDir 只在首次 acquireMux 时才跑,但 bind mount 发生在 docker
 *     createContainer 时。容器从未触发 acquireMux 的情况下(99% 场景),dir
 *     权限不会被收紧。
 *
 * 幂等:已存在目录则只 chmod/chown,不抛。
 *
 * 失败不阻塞容器启动 —— RuntimeDirectory=/run/ccb-ssh 必须存在(systemd unit 提供),
 * 若不存在(unit 没装好)本函数抛,上层 provisionV3Container 失败 → 用户启动失败,
 * 运维必须修好 systemd RuntimeDirectory 才能继续。
 */
async function ensureSshUserRunDir(uid: number): Promise<string> {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  const dir = pathJoin(V3_SSH_RUN_ROOT_HOST, `u${uid}`);
  await fsMkdir(dir, { recursive: true, mode: 0o750 });
  // mkdir 对已存在目录不改权限;显式 chmod + chown 抵御权限漂移。
  // owner=root(gateway/supervisor 进程) group=V3_AGENT_GID(容器 agent 用户)
  // → 容器通过 gid 进 dir、沿路径 connect() 到下层 ctl.sock;宿主其他 uid 无权。
  await fsChmod(dir, 0o750);
  await fsChown(dir, 0, V3_AGENT_GID);
  return dir;
}

// ───────────────────────────────────────────────────────────────────────
// IP 分配:INSERT-and-retry,unique partial index 兜底
// ───────────────────────────────────────────────────────────────────────

/**
 * 在事务内 INSERT 一行 active container 占住 bound_ip,撞 uniq 冲突就 ROLLBACK
 * 重试。成功返回 row id(用于拼 token,然后再 UPDATE container_internal_id)。
 *
 * 为什么用"先 INSERT 占位、后 docker create"的顺序:
 *   - 占位的 row 决定 row id,row id 进 token,token 进容器 env。
 *     如果先 docker create 再 INSERT,docker --ip 撞了同 IP 才发现要换 IP,
 *     然后撤销 docker → 比 INSERT 重试代价大很多。
 *   - 唯一约束 composite `idx_ac_host_bound_ip_active` (host_uuid, bound_ip)
 *     WHERE state='active' 在 PG 层做仲裁,业务层只 INSERT,避免 N 个进程同时
 *     SELECT 后撞 IP 的 race(2I-1 调度 N=1 也不能放 race)。0048 之前还共存
 *     一个全局 partial UNIQUE `uniq_ac_bound_ip_active`(M1 单 host 期的全局
 *     旧索引);0048 drop 后 retry 路径仍同时识别两个 constraint 名,以免
 *     deploy 顺序错位时炸。
 *
 * 失败模式:
 *   - 唯一冲突(23505) → 换 IP 重试,V3_IP_ALLOC_MAX_ATTEMPTS 次后放弃 → InvalidArgument
 *   - 其他 DB 错 → 直接抛(caller 翻译)
 */
async function allocateBoundIpAndInsertRow(
  client: PoolClient,
  uid: number,
  secretHash: Buffer,
  pickIp: () => string,
  hostUuid: string,
  image: string,
  fixedBoundIp?: string,
): Promise<{ id: number; boundIp: string }> {
  // image 列从 v3 一开始就被 0017 migration drop NOT NULL 留作 NULL,但 admin UI
  // 的 /agent-containers 列表(packages/web/public/modules/admin.js)始终读 c.image
  // 渲染为版本列。0017 注释说"image 字段语义被 OC_RUNTIME_IMAGE env 取代"在
  // 全 fleet 同步用同一镜像时成立,但 host upgrade 后老容器仍跑老镜像的场景,
  // per-container 快照才是对的。因此这里写 deps.image —— provision 时的镜像
  // 标签,与 v2 路径(subscriptions.ts INSERT)对称。
  // 历史 NULL 行不 backfill:v3 ephemeral 容器在 lazy reprovision 时自然修复,
  // 残留 NULL 行均已 vanished / stopped,admin 不再操作。
  const insertSql = `INSERT INTO agent_containers
       (user_id, host_uuid, bound_ip, secret_hash, state, port, image, runtime_channel, last_ws_activity, created_at, updated_at)
     VALUES
       ($1::bigint, $2::uuid, $3::inet, $4::bytea, 'active', $5::int, $6::text, $7::text, NOW(), NOW(), NOW())
     RETURNING id`;

  // B.4: scheduler 已经为我们选好了 IP — 不 retry,冲突直接 NameConflict。
  // 单次冲突意味着 scheduler 的 pickBoundIp 跟别的并发 request 撞了 → 交上层重试。
  if (fixedBoundIp !== undefined) {
    try {
      const r = await client.query<{ id: string }>(insertSql, [
        String(uid), hostUuid, fixedBoundIp, secretHash, V3_CONTAINER_PORT, image, getRuntimeChannel(),
      ]);
      const id = Number.parseInt(r.rows[0]!.id, 10);
      return { id, boundIp: fixedBoundIp };
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === "23505") {
        throw new SupervisorError(
          "NameConflict",
          `bound_ip ${fixedBoundIp} already taken (scheduler race)`,
        );
      }
      throw err;
    }
  }

  // 单机 MVP 路径:randomIp + retry-on-uniq-conflict
  for (let attempt = 0; attempt < V3_IP_ALLOC_MAX_ATTEMPTS; attempt++) {
    const candidate = pickIp();
    try {
      const r = await client.query<{ id: string }>(insertSql, [
        String(uid), hostUuid, candidate, secretHash, V3_CONTAINER_PORT, image, getRuntimeChannel(),
      ]);
      const id = Number.parseInt(r.rows[0]!.id, 10);
      return { id, boundIp: candidate };
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      // 23505 = unique_violation. 双名字白名单:
      //   - uniq_ac_bound_ip_active        — 0012 全局 partial UNIQUE,0048 drop
      //   - idx_ac_host_bound_ip_active    — 0030 per-host composite UNIQUE(0048 后的仲裁器)
      // 两个都接受,deploy 顺序错位(代码先上 / migration 先跑)时不会误杀 retry。
      // 故意不泛化到"23505 + 同表"—— 同表还有 `uniq_ac_user_id_active` 等非 IP unique,
      // 误把 user-active 冲突当 IP 冲突会掩盖真正 lifecycle bug(Codex 审查反馈)。
      if (
        e.code === "23505"
        && (
          e.constraint === "uniq_ac_bound_ip_active"
          || e.constraint === "idx_ac_host_bound_ip_active"
          || /uniq_ac_bound_ip_active|idx_ac_host_bound_ip_active/i.test(String((err as Error).message))
        )
      ) {
        // IP 撞了,换一个继续
        continue;
      }
      throw err;
    }
  }
  throw new SupervisorError(
    "InvalidArgument",
    `failed to allocate bound_ip after ${V3_IP_ALLOC_MAX_ATTEMPTS} attempts; subnet ${V3_SUBNET_CIDR} likely exhausted`,
  );
}

// ───────────────────────────────────────────────────────────────────────
// 主接口:provision / stop+remove / status
// ───────────────────────────────────────────────────────────────────────

/**
 * Provision 一个 v3 容器并启动。同 uid 已有 active 行 → 抛 NameConflict
 * (caller 自己决定要不要先 stopAndRemove,本函数不替你做)。
 *
 * 流程:
 *   1. BEGIN
 *   2. acquire per-uid lifecycle advisory lock      ← 与 volumeGc 互斥
 *   3. 确定 effectiveHostUuid(fail-closed:hostId 或 selfHostId,缺一 InvalidArgument)
 *   4. acquire per-host admission advisory lock     ← per-host 串行,跨 host 并行
 *   5. per-host cap query → 同事务读 compute_hosts.max_containers + active count
 *      ≥ max → log.info + ROLLBACK + throw HostFull(锁随事务释放)
 *   6. 确保 named volume(幂等;label 守护)
 *   7. INSERT agent_containers 占 bound_ip(uniq 冲突重试换 IP,host_uuid = effectiveHostUuid)
 *   8. 用 row id + secret 拼 token,bound_ip 走 docker create --ip
 *      注入 4 个 anthropic env + cap-drop NET_RAW NET_ADMIN + tmpfs
 *      /run/oc/claude-config + 单 volume + label
 *   9. start 容器 → UPDATE agent_containers SET container_internal_id = <id>
 *  10. COMMIT(advisory lock 自动释放)
 *  11. 任何 docker 步骤失败 → ROLLBACK + best-effort docker rm -f;不 wrap 让 caller 看根因
 *
 * 为什么 ensureV3Volume 改在事务内:
 *   - GC 在持有 per-uid lock 期间删 volume;provision 也必须在持锁期间 ensureV3Volume,
 *     否则 ensureV3Volume 在事务外跑 → GC 拿锁删 volume → provision INSERT → docker
 *     create 用一个空 volume,数据被 GC 静默丢弃。
 *   - docker createVolume 失败 → 整事务 ROLLBACK,row 不留痕,最终一致。
 */
export async function provisionV3Container(
  deps: V3SupervisorDeps,
  uid: number,
  hostId?: string,
  boundIp?: string,
  bridgeCidr?: string | null,
): Promise<ProvisionedV3Container> {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  if (typeof deps.image !== "string" || deps.image.trim() === "") {
    throw new SupervisorError("InvalidArgument", "deps.image (OC_RUNTIME_IMAGE) is required");
  }

  const containerName = v3ContainerNameFor(uid);
  const pickIp = deps.randomIp ?? defaultPickRandomIp;
  const mintSecret = deps.randomSecret ?? defaultRandomSecret;

  // effectiveHostUuid — admission gate / advisory lock / INSERT 行 host_uuid 的
  // **唯一**权威源,所有下游(advisory lock / cap query / INSERT / docker side
  // effects)都用同一变量。
  //
  // 取值规则:hostId 是字符串就用它(含 ""),否则 fallback 到 selfHostId。
  // 关键不要用 `||` 短路 — `hostId === ""` 会被吃掉静默退化到 selfHostId,
  // 与此同时 raw hostId 在下面又驱动 useRemote 走远端路径,导致"lock/cap 用
  // selfHostId、docker 操作用 ''"双源错位。此处显式三元让 "" 进 canonical 校验
  // 被拒,fail-closed。
  const effectiveHostUuid: string =
    typeof hostId === "string" ? hostId : (deps.selfHostId ?? "");
  if (!effectiveHostUuid) {
    throw new SupervisorError(
      "InvalidArgument",
      "provisionV3Container requires host context (hostId or deps.selfHostId)",
    );
  }
  // Canonical UUID 校验前置:必须在 assertImageHasV3Sink / useRemote 路由之前。
  // 否则非 canonical hostId 在 multi-host 路径下会先进
  // containerService.inspectImage(hostId) → getHostById(hostId),错误形态变成
  // "unknown hostId" / PG cast 失败,而不是 fail-closed 契约承诺的统一
  // InvalidArgument。下游 acquireHostCapLock 里还有一次同样校验(export 函数
  // defense-in-depth),不重复抛只是早一点抛。
  if (!HOST_UUID_CANONICAL_RE.test(effectiveHostUuid)) {
    throw new SupervisorError(
      "InvalidArgument",
      `host uuid must be PG canonical lowercase 36-char form, got: ${JSON.stringify(effectiveHostUuid)}`,
    );
  }

  // 多机路由:effectiveHostUuid 已校验为合法 canonical UUID,直接与 selfHostId
  // 比较;containerService facade 已就位 → remote。任一条件不满足 → 退化为单机
  // 路径(保留 MVP 行为完全不变)。注意基于 effectiveHostUuid 而非 raw hostId —
  // 后者已在上面被 canonical 校验过滤,但 useRemote 用 SSOT 更直观也防 future
  // 改动再开第二条语义支路。
  const useRemote =
    typeof deps.selfHostId === "string"
    && effectiveHostUuid !== deps.selfHostId
    && deps.containerService !== undefined;

  // v1.0.84 PR #4 — supply-chain guard:provision 之前先 inspect image labels,
  // 缺 v3-sink token 直接抛 ImageOutdated。早于 BEGIN / docker create,失败不留
  // 半事务和 docker 副作用。模式 OC_V3_IMAGE_GUARD ∈ enforce/warn/off,缺省 enforce。
  await assertImageHasV3Sink(deps, hostId, deps.image);

  const client = await deps.pool.connect();
  let row: { id: number; boundIp: string };
  let secret: string;
  let secretHash: Buffer;
  let volumeNames: V3VolumeBundle;
  let createdDockerId = "";
  try {
    await client.query("BEGIN");

    // 锁顺序不变量:per-uid lifecycle → per-host admission(详见 advisory lock 段落注释)。
    await acquireUserLifecycleLock(client, uid);
    await acquireHostCapLock(client, effectiveHostUuid);

    // per-host admission gate(同事务读 active 计数 + max_containers,与 host-cap
    // lock 同寿命,关 COMMIT/ROLLBACK 自动释放)。
    // 设计不变量:agent_containers 进入 state='active' 的唯一入口是
    // allocateBoundIpAndInsertRow,仅由 provisionV3Container 调用,必经此 gate。
    // 无 reconcile/repair 反向 (vanished→active) 路径。详见 PR 设计描述。
    //
    // 不在本 gate 同事务复核 compute_hosts.status:pickHost 已在 SQL 层用
    // PLACEMENT_GATE_PREDICATE 过滤掉 non-ready host;唯一 race 是"pickHost 完成
    // → admin 改 status='draining' → 进 gate" 这极短窗口,后果是新容器落到正在
    // draining 的 host,语义上仅延后 drain 完成,不破数据。R6.8 host live
    // migration 上线时再做。
    const capQ = await client.query<{ active: string; max_containers: number | null }>(
      `SELECT
           (SELECT COUNT(*) FROM agent_containers
             WHERE state = 'active' AND host_uuid = $1::uuid)::text AS active,
           (SELECT max_containers FROM compute_hosts WHERE id = $1::uuid)
             AS max_containers`,
      [effectiveHostUuid],
    );
    const capRow = capQ.rows[0];
    if (!capRow || capRow.max_containers == null) {
      // compute_hosts 行 missing / 被删 race:host 已不可调度,拒收。
      throw new SupervisorError(
        "InvalidArgument",
        `host ${effectiveHostUuid} not found in compute_hosts`,
      );
    }
    const active = Number.parseInt(capRow.active ?? "0", 10);
    const maxContainers = capRow.max_containers;
    if (active >= maxContainers) {
      // info 日志:单 host 满是正常调度压力,不告警。trade-off 写在 plan 评审里:
      // "全集群不可用"语义由 NodePoolUnavailableError 承担,不在此处兜底。
      log.info("v3 per-host cap hit", {
        hostId: effectiveHostUuid,
        active,
        max: maxContainers,
        uid,
      });
      // 结构化字段 (hostId/active/max/uid) 由上面的 log.info 落 structured log,
      // SupervisorError 的 message 包含 host + 当前/上限即可,caller 只看 code='HostFull'。
      throw new SupervisorError(
        "HostFull",
        `host ${effectiveHostUuid} at cap (${active}/${maxContainers})`,
      );
    }

    // ensureV3Volumes 必须在持 per-uid lock 期间调,防 GC race(见函数 doc)
    try {
      if (useRemote) {
        // 远端路径:label 守护由 node-agent 侧负责;这里只确保 5 个 volume 存在。
        // 顺序与 ensureV3Volumes 本地路径保持一致(diagnostic 一致性,部分失败时
        // master log 与本地路径同形态 — data → proj → codex → userLocal → userConfig)。
        const dataName = v3VolumeNameFor(uid);
        const projectsName = v3ProjectsVolumeNameFor(uid);
        const codexName = v3CodexVolumeNameFor(uid);
        const userLocalName = v3UserLocalVolumeNameFor(uid);
        const userConfigName = v3UserConfigVolumeNameFor(uid);
        await deps.containerService!.ensureVolume(hostId!, dataName);
        await deps.containerService!.ensureVolume(hostId!, projectsName);
        await deps.containerService!.ensureVolume(hostId!, codexName);
        await deps.containerService!.ensureVolume(hostId!, userLocalName);
        await deps.containerService!.ensureVolume(hostId!, userConfigName);
        volumeNames = {
          data: dataName,
          projects: projectsName,
          codex: codexName,
          userLocal: userLocalName,
          userConfig: userConfigName,
        };
      } else {
        volumeNames = await ensureV3Volumes(deps.docker, uid);
      }
    } catch (err) {
      throw wrapDockerError(err);
    }

    secret = mintSecret();
    if (!/^[0-9a-f]{64}$/.test(secret)) {
      throw new SupervisorError(
        "InvalidArgument",
        "secret generator must return 64 lowercase hex chars (32 bytes)",
      );
    }
    secretHash = hashSecretToBuffer(secret);

    row = await allocateBoundIpAndInsertRow(client, uid, secretHash, pickIp, effectiveHostUuid, deps.image, boundIp);

    // 3) docker create with --ip + 4 个 anthropic env + cap-drop + tmpfs + 单 volume
    const token = `oc-v3.${row.id}.${secret}`;

    // hostGatewayIp:容器所在 host 的 docker bridge gateway IP(.1 of bridge_cidr)。
    // self host = 172.30.0.1,远端 host 各自 172.30.X.1。**两件事必须用本变量,
    // 不能用 V3_GATEWAY_IP 常量**:
    //   1) ANTHROPIC_BASE_URL — 容器出站 API 流量目标:self 直连 master 的
    //      anthropicProxy(本机 bridge gw),remote 经 node-agent internalproxy
    //      (绑在 host 自己 bridge gw 上)再 mTLS 反代回 master。
    //   2) OPENCLAUDE_TRUST_BRIDGE_IP — 容器 WS 入站旁路信任 IP,必须 = 容器
    //      看到的实际 source IP(本机 bridge gw),否则 WS auth 走 token 路径
    //      但 master 不带 bearer → 1008 unauthorized → 用户弹 Token 失效。
    //
    // bridgeCidr 的来源(三层 fallback):
    //   1) placement.bridgeCidr 来自 schedule(),已做过 compute_hosts.bridge_cidr
    //      / 历史容器反推 / fallback 公式 三层兼容
    //   2) bridgeCidr 缺失但是 monolith / self 路径(useRemote=false)→ V3_GATEWAY_IP
    //   3) bridgeCidr 缺失但目标是 remote → fail fast,避免静默退化注入 self IP
    //      让远端容器再次踩 1008 bug
    let hostGatewayIp: string;
    if (typeof bridgeCidr === "string" && bridgeCidr.length > 0) {
      hostGatewayIp = gatewayIpFromV3Cidr(bridgeCidr);
    } else if (!useRemote) {
      hostGatewayIp = V3_GATEWAY_IP;
    } else {
      throw new SupervisorError(
        "InvalidArgument",
        `remote host ${hostId} requires bridgeCidr; got ${bridgeCidr === null ? "null" : "undefined"}`,
      );
    }
    const internalProxyUrl = `http://${hostGatewayIp}:18791`;

    const env: string[] = [
      `ANTHROPIC_BASE_URL=${internalProxyUrl}`,
      `ANTHROPIC_AUTH_TOKEN=${token}`,
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1",
      `CLAUDE_CONFIG_DIR=${V3_CONFIG_TMPFS_PATH}`,
      // **bridge IP trust 旁路只在 v3 supervisor 真正 spawn 容器时注入**:
      //   bridge 经 docker bridge gateway <host bridge .1> 把 ws upgrade 转给
      //   容器 18789/ws,bridge 不持有容器 personal-version accessToken,所以
      //   personal-version 在 packages/gateway/src/server.ts 加了一个 "源 IP =
      //   $OPENCLAUDE_TRUST_BRIDGE_IP 时跳过 token 校验" 的旁路。env 不设默认 noop,
      //   全靠 supervisor 显式注入,确保镜像哪怕被旁路其他渠道跑起来也仍然 fail-closed。
      //   不在 entrypoint.sh 兜默认值 — 避免镜像变成"只要 host 能从 .1 触达就免认证"。
      `OPENCLAUDE_TRUST_BRIDGE_IP=${hostGatewayIp}`,
      // PR4: 让容器内 mcp-memory 的 SkillStore 能看到 ro 挂载的平台基线 skill。
      // mcp-memory 只认这个显式 env —— 不 fallback 到 CLAUDE_CONFIG_DIR,personal 版
      // 不注入该 env 自动退化为 user-only,不会把用户自建 skill 误判成只读基线。
      // baseline mount 本身若缺失/OPTIONAL=1,SkillStore 构造期会抛 → mcp-memory
      // catch 后 warn+fallback user-only,不影响容器启动。
      `OPENCLAUDE_BASELINE_SKILLS_DIR=${V3_CONFIG_TMPFS_PATH}/skills`,
      // v3 server-authored sink:容器内 sessionManager turn-end 把权威 assistant
      // 文本 POST 到 master 的 /internal/v3/server-authored-message。复用同一条
      // 出站通道(self-host plain 18791,远端 mTLS 18443),route splitter 按
      // path 分流(见 packages/commercial/src/index.ts dispatchInternal)。
      //   - URL 与 ANTHROPIC_BASE_URL 同根,但解耦命名:gateway 代码不应看
      //     "anthropic" 字眼判断 sink 走向。
      //   - Bearer 与 ANTHROPIC_AUTH_TOKEN 同值(都是 oc-v3.<id>.<secret> 容器身份),
      //     但 sink 模块只读 OPENCLAUDE_V3_CONTAINER_TOKEN,不复用 anthropic env。
      // 两个 env 均缺失 → gateway 检测到 sink 未配置,直接走旧 durable 路径
      // (容器 SQLite,在 v3 表里永远 session_not_found 然后失败),即回到
      // 修复前的丢消息行为。**生产必须有这两个 env;personal 版没有它们,
      // V3MasterSink getter 返回 null,旧路径继续工作。**
      `OPENCLAUDE_V3_MASTER_BASE_URL=${internalProxyUrl}`,
      `OPENCLAUDE_V3_CONTAINER_TOKEN=${token}`,
      // 商用版容器:跳过 personal-version 默认 cron jobs(daily-reflection /
      // weekly-curation / skill-check / heartbeat)的首次 seed。这些 job 每天会触发
      // ~11 次自动 agent 调用,过 anthropicProxy 扣 users.credits。商用用户没主动
      // 用 agent 也照扣,与产品语义不符。env 只影响 cron.yaml 不存在时的 bootstrap,
      // 已存在的用户自建 cron 不动。处理逻辑见 packages/gateway/src/cron.ts::ensureCronFile。
      "OC_SEED_DEFAULT_CRON=0",
      // v1.0.193:容器内 gateway `/api/file` ACL 切到 trusted-backend 模式
      // (`isTrustedContainerFileServeEnabled` in packages/gateway/src/server.ts)。
      // 语义:范围限定到 `/home/agent/**` + `/tmp/openclaude-*`,内层走 blocklist。
      // `FILE_BLOCKED_PATTERNS` 是 trusted 模式下的唯一权威 ACL inventory ——
      // **本文件如果新加入任何 master 注入的敏感 env/挂载/state 文件,必须同步
      // 加 regex 进 FILE_BLOCKED_PATTERNS + security.test.ts 用例**。
      // 关闭(env 未设置 / 设为非 "1")→ gateway 退化回 personal/legacy 严白名单
      // 行为(FILE_ALLOWED_DIRS + TEMP_PREFIX + agent_cwd MEDIA_EXTENSIONS)。
      "OC_V3_TRUSTED_FILE_SERVE=1",
    ];
    appendCodexRelayEnv(env);

    // v3 file proxy:bridgeSecret 就位 → 注入 OC_CONTAINER_ID + OC_BRIDGE_NONCE。
    // 容器内 gateway 靠这两个 env 做 bridge bypass 校验 + /healthz capability 广播。
    // 缺失(deps.bridgeSecret 未注入)→ 容器不广播 file-proxy-v1,HOST 代理探测到
    // CONTAINER_OUTDATED 自动降级。
    //
    // 同一把 bridgeSecret 同时给 WeChat broker → 容器 inbound 通道签 nonce
    // (`OPENCLAUDE_INBOUND_NONCE`,见 docs/v3/wechat-broker-design.md D3d)。
    // 编码 base64url 故意与 file-proxy 的 hex 不同 —— 输入域也加了 "inbound:" 前缀,
    // 两条通道在 HMAC 输出空间正交,不会出现 nonce cross-replay。
    if (deps.bridgeSecret) {
      env.push(`OC_CONTAINER_ID=${String(row.id)}`);
      env.push(
        `OC_BRIDGE_NONCE=${createHmac("sha256", deps.bridgeSecret)
          .update(String(row.id))
          .digest("hex")}`,
      );
      env.push(`OPENCLAUDE_INBOUND_NONCE=${computeInboundNonce(deps.bridgeSecret, row.id)}`);
    }

    // CCB 基线只读挂载。**fail-closed 默认**:基线缺失/校验失败 → 抛
    // SupervisorError("CcbBaselineMissing"),用户启动失败,运维必须修基线才能恢复。
    // 基线是"守则加固层",生产不允许容器在无守则状态启动(AI 裸奔风险)。
    //
    // 显式降级:env `OC_V3_CCB_BASELINE_OPTIONAL=1` (或 "true"/"yes") → warn 并跳过
    // 挂载,容器照常启动。仅 dev/test/local 用,生产禁止设置。
    //
    // 基线齐全 → 在 Binds 上追加三条 :ro 项(单文件 AGENTS.md / CLAUDE.md +
    // 整目录 skills/)。AGENTS.md 覆盖 runtime image 里的仓库开发规则,让
    // Codex 原生规则扫描拿到商业用户容器规则;skills/ 覆盖 tmpfs 内
    // /run/oc/claude-config/skills 整个子树。docker daemon 会按挂载点深度
    // 排序,tmpfs 先于 bind 挂上,然后 ro bind 叠加,顺序正确无需我们干预。
    // 远端 host:baseline 落在 node-agent 维护的 /var/lib/openclaude/baseline(Batch A 推入),
    // 不再由 master 的本地目录做结构校验(能连上 node-agent 本身就是一种 liveness)。
    // 此路径拿到 {AGENTS.md, CLAUDE.md, skills/} 即用,校验责任在 node-agent bootstrap 的 baseline pull。
    let baselineMounts: {
      agentsMdHostPath: string;
      claudeMdHostPath: string;
      skillsDirHostPath: string;
    } | null;
    let baselineDir: string;
    if (useRemote) {
      const remotePaths = await deps.containerService!.resolveBaselinePaths(hostId!);
      baselineMounts = remotePaths;
      baselineDir = remotePaths.skillsDirHostPath.replace(/\/skills$/, "");
    } else {
      baselineDir = deps.ccbBaselineDir ?? readCcbBaselineDirFromEnv();
      baselineMounts = resolveCcbBaselineMounts(baselineDir);
    }
    const baselineOptional = readCcbBaselineOptionalFromEnv();
    if (!baselineMounts) {
      if (baselineOptional) {
        // eslint-disable-next-line no-console
        console.warn(
          "[v3supervisor] CCB baseline dir missing/incomplete (OPTIONAL=1); container will spawn WITHOUT platform guardrails",
          { baselineDir, uid },
        );
      } else {
        // eslint-disable-next-line no-console
        console.error(
          "[v3supervisor] CCB baseline dir missing/incomplete; refusing to spawn container (set OC_V3_CCB_BASELINE_OPTIONAL=1 to override in dev)",
          { baselineDir, uid },
        );
        throw new SupervisorError(
          "CcbBaselineMissing",
          `CCB baseline dir missing or failed validation: ${baselineDir}`,
        );
      }
    }

    // 远程执行 mux per-user 目录:ro 挂到容器 /run/ccb-ssh。
    // 用户启用远程执行机前,dir 是空目录(无 host 子目录),容器侧 CCB 检测到
    // 空目录按本地执行处理,符合 feature off 语义。启用后 sshMux 会在宿主侧
    // dir 里 materialize u<uid>/h<hid>/{ctl.sock,known_hosts},对容器立即可见。
    // 在 binds 组装前先创建 —— docker 不自动 mkdir,容器 bind 前我们控制权限。
    //
    // 远端 host:ssh mux 跨机策略在 Batch C 解决(scheduler 持 host affinity,
    // 远端 node-agent 代管 /run/ccb-ssh/u<uid>)。B.3 阶段远端跳过 ssh 挂载 —
    // 等同"远端容器暂不支持 CCB 远程执行",能支撑单元测试/基本流量。
    const sshUserRunDir = useRemote ? null : await ensureSshUserRunDir(uid);

    const binds: string[] = [
      `${volumeNames.data}:${V3_VOLUME_MOUNT}:rw`,
      `${volumeNames.projects}:${V3_PROJECTS_MOUNT}:rw`,
      // D2 持久化(2026-05-09):codex / ~/.local / ~/.config 全 per-user 持久化,
      // 让 codex mcp add / pip --user / npm 用户级 install / XDG configs 跨重启保留。
      // 详见三个 V3_*_MOUNT 常量上的 docstring。
      `${volumeNames.codex}:${V3_CODEX_HOME_MOUNT}:rw`,
      `${volumeNames.userLocal}:${V3_USER_LOCAL_MOUNT}:rw`,
      `${volumeNames.userConfig}:${V3_USER_CONFIG_MOUNT}:rw`,
    ];

    // Codex auth ro bind-mount(plan v3 §F1/F2/D1)。仅本地 provision 路径挂 ——
    // 远端 host 上无对应目录,跨机同步 auth.json 是后续 task(GPT 模型在远端
    // 容器报未授权,与未 OAuth 路径合并到同一种 fail mode,前端 modelPicker
    // 不会给远端用户出 GPT 选项 / 后端 canUseModel 在执行路径再兜底一次)。
    //
    // 两种 mount 模式(K/L):
    //   - codex_account_id NOT NULL → mount per-container `<codexContainerDir>/<row.id>/`
    //   - codex_account_id NULL(legacy / 池空 / 任一步失败回滚)→ mount 共享
    //     `<codexContainerDir>/`(对应 master gateway 的 syncCodexAuthFile 路径)
    //
    // **mount 不可变 invariant**:启动时定型,运行时永不切换。lazy migrate 只换
    // account_id 不换 mount;NULL 容器永远锁死在 legacy(决策 K/L/N3)。
    //
    // 始终挂载:目录由本模块在 provision 前 mkdir(idempotent),即使 host 还没
    // 跑过 codexAuthSync,容器看到的是空目录,codex 启动报无 auth(预期)。
    // host 写入后无需重启容器,mount 是目录而非单文件,新 entry 立即可见。
    // Codex per-container auth bind(plan v3 §F1/F2/D1 + v1.0.72 跨 host 同步)。
    // 本地与远端 host 共享同一 picker + UPDATE,只在"写文件"和"bind source 路径"
    // 上分流:
    //   - 本地:writeCodexContainerAuthFile + bind <env-resolvable codexContainerDir>/<row.id>
    //   - 远端:deps.putRemoteCodexAuth + bind <DEFAULT_V3_CODEX_CONTAINER_DIR>/<row.id>
    //          (远端路径硬编码,不读 master env;远端 node-agent AllowedRoots 锁同值)
    //
    // 任一步失败 → fallback:
    //   - 本地:legacy shared dir mount(NULL bind),codex CLI 启动报"未授权"
    //          但容器仍可正常跑非 GPT 流量
    //   - 远端:不挂 codex mount(MVP D 决策)。远端没有 shared dir 模型 ——
    //          NULL bind 不存在等价物。codex CLI 启动报"未授权"行为一致。
    //
    // **mount 不可变 invariant**(决策 K/L/N3):启动时定型,运行时永不切换。
    // lazy migrate 只换 account_id 不换 mount;NULL 容器永远锁死在 legacy mount
    // (本地)或 no-mount(远端)。
    let codexMountSource: string | null = null;
    {
      // 远端 host 必须用 DEFAULT 常量(node-agent AllowedRoots 锁住),本地走 env 可覆盖
      const codexContainerDir = useRemote
        ? DEFAULT_V3_CODEX_CONTAINER_DIR
        : readCodexContainerDirFromEnv();
      let boundCodexAccountId: bigint | null = null;
      try {
        const picked = await pickCodexAccountForBinding(String(row.id), {});
        if (picked) {
          let snap: Awaited<ReturnType<typeof getCodexTokenSnapshot>> = null;
          try {
            snap = await getCodexTokenSnapshot(picked.account_id);
            if (snap && snap.token) {
              const accessToken = snap.token.toString("utf8");
              const lastRefreshIso = new Date().toISOString();
              if (useRemote) {
                if (!deps.putRemoteCodexAuth) {
                  throw new Error(
                    "useRemote=true but deps.putRemoteCodexAuth not wired",
                  );
                }
                // hostId! 安全:useRemote=true 蕴含 typeof hostId === "string"(见 useRemote 定义)
                await deps.putRemoteCodexAuth(
                  hostId!,
                  String(row.id),
                  accessToken,
                  lastRefreshIso,
                );
              } else {
                await writeCodexContainerAuthFile({
                  rootDir: codexContainerDir,
                  containerId: String(row.id),
                  containerUid: V3_AGENT_UID,
                  containerGid: V3_AGENT_GID,
                  auth: { accessToken, lastRefreshIso },
                });
              }
              // UPDATE 在同一事务内,COMMIT 时一并落盘;若后续步骤失败 rollback
              // 自动回滚到 NULL,但 host 文件(本地或远端)留在 per-container 子目录
              // 是孤儿 —— 由 stopAndRemoveV3Container / volume gc / 重 provision
              // 的同名 row.id 覆盖兜底(本 PR 接受这层不一致)。
              await client.query(
                `UPDATE agent_containers SET codex_account_id = $1, updated_at = NOW() WHERE id = $2`,
                [String(picked.account_id), String(row.id)],
              );
              boundCodexAccountId = picked.account_id;
            }
          } finally {
            if (snap?.token) zeroBuffer(snap.token);
            if (snap?.refresh) zeroBuffer(snap.refresh);
          }
        }
      } catch (codexErr) {
        // codex 路径任意失败 → 回退;不打断 provision。
        // eslint-disable-next-line no-console
        console.error(
          `[v3supervisor] WARN: codex account binding failed (useRemote=${useRemote}); falling back: ${(codexErr as Error).message}`,
        );
      }

      if (boundCodexAccountId !== null) {
        // per-container subdir 由 writeCodexContainerAuthFile / putRemoteCodexAuth 创建
        codexMountSource = pathJoin(codexContainerDir, String(row.id));
      } else if (!useRemote) {
        // 本地 fallback:legacy shared dir mount
        try {
          // mode 0755:owner=root rwx,其他用户(含容器内 agent uid)只能 r-x。
          // 防容器内进程往 host 这个目录写,但允许进入查 auth.json。
          await fsMkdir(codexContainerDir, { recursive: true, mode: 0o755 });
        } catch (mkErr) {
          // mkdir 失败不致命:bind-mount 时 docker 自身会报错,SupervisorError
          // 走标准 wrapDockerError 路径。这里只做日志,不打断 provision。
          // eslint-disable-next-line no-console
          console.error(
            `[v3supervisor] WARN: ensure codex container dir failed: ${(mkErr as Error).message}`,
          );
        }
        codexMountSource = codexContainerDir;
      }
      // useRemote && fallback → codexMountSource = null → 跳过下方 binds.push,
      // 不挂 codex mount(远端没有 shared dir 模型)
      if (codexMountSource !== null) {
        binds.push(`${codexMountSource}:${V3_CODEX_AUTH_RO_MOUNT}:ro`);
      }
    }

    if (sshUserRunDir) {
      // ro 防容器内 agent 篡改 ctl.sock / known_hosts。容器对 unix socket
      // 的 connect() 走 inode 的 w 位而非 mount 的 ro 位,仍然可连接;ro 只阻塞
      // write/unlink/rename/create,正好是我们要拒绝的攻击面。
      binds.push(`${sshUserRunDir}:${V3_SSH_RUN_CONTAINER_MOUNT}:ro`);
    }
    if (baselineMounts) {
      binds.push(
        // Codex 原生 project rules 文件。挂到默认 WORKDIR /opt/openclaude 下,
        // 覆盖镜像里用于开发 OpenClaude 仓库的 AGENTS.md,避免商业用户容器
        // 误读 worktree/deploy 等平台内部规则。
        `${baselineMounts.agentsMdHostPath}:/opt/openclaude/AGENTS.md:ro`,
        `${baselineMounts.claudeMdHostPath}:${V3_CONFIG_TMPFS_PATH}/CLAUDE.md:ro`,
        // 挂 skills/ 整目录,一次性覆盖所有基线 skill(system-info /
        // memory-management / platform-capabilities / scheduled-tasks /
        // skill-management / skill-search / document-writing)。新增基线 skill
        // 不再改这里,改 V3_CCB_BASELINE_SKILL_NAMES manifest 即可。
        //
        // 用户自建 skill 由 PR4 的 SkillStore baseline-wins 合并视图在
        // /home/agent/.openclaude/agents/<id>/skills/ 提供,通过 env
        // OPENCLAUDE_BASELINE_SKILLS_DIR 让容器内 mcp-memory 把这个 ro 目录
        // 叠加成 source=platform 只读视图,读路径走平台优先、写路径只落用户目录。
        `${baselineMounts.skillsDirHostPath}:${V3_CONFIG_TMPFS_PATH}/skills:ro`,
      );
    }

    // v3 容器资源硬限额(Memory / NanoCpus / PidsLimit)。env 覆盖见 resolveV3ResourceLimits。
    const { memoryBytes, nanoCpus, pidsLimit } = resolveV3ResourceLimits();

    if (useRemote) {
      // 远端路径:facade 组装 HostConfig(硬化选项在 node-agent /containers/run 侧固定)。
      // ContainerSpec 只携带因容器而异的字段,env/binds/label 用对象形式,facade 转字符串。
      const envMap: Record<string, string> = {};
      for (const e of env) {
        const i = e.indexOf("=");
        if (i > 0) envMap[e.slice(0, i)] = e.slice(i + 1);
      }
      const bindObjs = binds.map((b) => {
        // b 形如 "src:target:rw" 或 "src:target:ro"
        const lastColon = b.lastIndexOf(":");
        const mid = b.lastIndexOf(":", lastColon - 1);
        const src = b.slice(0, mid);
        const target = b.slice(mid + 1, lastColon);
        const mode = b.slice(lastColon + 1);
        return { source: src, target, readonly: mode === "ro" };
      });
      const spec: ContainerSpec = {
        containerDbId: row.id,
        boundIp: row.boundIp,
        image: deps.image,
        name: containerName,
        env: envMap,
        labels: { [V3_UID_LABEL_KEY]: String(uid) },
        binds: bindObjs,
        memoryBytes,
        nanoCpus,
        pidsLimit,
        internalPort: V3_CONTAINER_PORT,
      };
      try {
        const r = await deps.containerService!.createAndStart(hostId!, spec);
        // v1.0.8 守门:node-agent 协议要求 containerInternalId 是非空字符串。
        // 一旦返回 undefined / null / "" / 空白 / 整个 r 为 null,以前会让
        // createdDockerId="" 并继续 UPDATE → COMMIT 一行 container_internal_id IS NULL
        // 的"孤儿 row",后续 getV3ContainerStatus 把它当 "stopped" 卡用户死循环重连。
        // 这里抛 RemoteContractViolation → 走 catch → ROLLBACK,孤儿不入库。
        if (
          !r ||
          typeof r.containerInternalId !== "string" ||
          r.containerInternalId.trim().length === 0
        ) {
          throw new SupervisorError(
            "RemoteContractViolation",
            `node-agent createAndStart returned empty containerInternalId (host=${hostId})`,
          );
        }
        createdDockerId = r.containerInternalId;
      } catch (err) {
        // RemoteContractViolation 已经是 SupervisorError,不再 wrap;dockerErr 才 wrap。
        if (err instanceof SupervisorError) throw err;
        throw wrapDockerError(err);
      }
    } else {
      let container;
      try {
        container = await deps.docker.createContainer({
          name: containerName,
          Image: deps.image,
          Env: env,
          // 镜像本身 USER agent (uid=1000),supervisor 这层再强制一遍防镜像被改回 root
          User: V3_AGENT_USER,
          Labels: {
            [V3_MANAGED_LABEL_KEY]: "1",
            [V3_UID_LABEL_KEY]: String(uid),
          },
          AttachStdin: false,
          AttachStdout: false,
          AttachStderr: false,
          Tty: false,
          OpenStdin: false,
          // 强制 --ip:在 EndpointsConfig 上设 IPAMConfig.IPv4Address
          // (docker create 接受 NetworkingConfig.EndpointsConfig.<net>.IPAMConfig)
          NetworkingConfig: {
            EndpointsConfig: {
              [V3_NETWORK_NAME]: {
                IPAMConfig: { IPv4Address: row.boundIp },
              },
            },
          },
          HostConfig: {
            NetworkMode: V3_NETWORK_NAME,
            // 资源硬限额 — 单容器吃不光宿主;env OC_V3_MEMORY_MB / OC_V3_CPUS / OC_V3_PIDS_LIMIT 覆盖
            Memory: memoryBytes,
            // MemorySwap == Memory → 禁 swap;不设 docker 会默认配 2×Memory
            MemorySwap: memoryBytes,
            MemorySwappiness: 0,
            NanoCpus: nanoCpus,
            PidsLimit: pidsLimit,
            // §9.3 cap-drop NET_RAW + NET_ADMIN(防 raw socket 伪造源 IP / 改路由)
            CapDrop: ["NET_RAW", "NET_ADMIN"],
            CapAdd: [],
            // 禁 privileged
            Privileged: false,
            // SecurityOpt: ["no-new-privileges"] 已于 2026-05-09 (D1) 移除。
            //
            // 移除原因: codex 频繁需要 sudo apt install / 系统级配置, 镜像
            // 已为 agent (uid=1000) 配 NOPASSWD ALL sudoers (见 Dockerfile
            // /etc/sudoers.d/agent)。`no-new-privileges` 内核标记会阻止 exec
            // 继承新权限, sudo 即使保留 setuid bit 也无效。
            //
            // 配套兜底:
            //   - docker namespace (pid/mount/uts/ipc/net) 隔离,容器 root
            //     不能直接访问宿主进程/文件系统
            //   - capabilities: docker 默认 root 保留 CHOWN / DAC_OVERRIDE /
            //     FOWNER / SETUID / SETGID 等, **但默认不含 CAP_SYS_ADMIN**,
            //     mount/setns/pivot_root 等 namespace 级操作仍受限。CapDrop
            //     又去掉 NET_RAW + NET_ADMIN, raw socket / 路由改写 / iptables
            //     即使 root 也不行
            //   - cgroups 资源限制 (Memory/NanoCpus/PidsLimit)
            //   - bridge net 单独子网, 走 supervisor 的 bound_ip 入站策略
            //   - 任何 host 敏感路径都没挂进容器, 只挂 named volume +
            //     codex-auth ro bind
            //   - supervisor 启动 User=1000:1000, 进程默认以 agent 起,
            //     必须主动 sudo 才提权
            //
            // 已知风险扩展面:
            //   - 容器内 root 可改本容器 named volume ownership/mode -> 用户
            //     自家状态投毒 (只伤自己)
            //   - 未开 userns-remap 时容器 uid 0 直接映射 host uid 0 (同一
            //     uid namespace), capabilities 仍受容器 namespace 约束所以
            //     **不等同**宿主普通 root, 但若有 docker daemon / runc /
            //     kernel breakout CVE 风险面更大。中长期评估 userns-remap。
            // 安全权衡详见 Dockerfile.openclaude-runtime sudoers 段注释。
            SecurityOpt: [],
            // CLAUDE_CONFIG_DIR tmpfs(防 ~/.claude/settings.json 残留)
            // uid/gid=1000 必须显式给 — 容器跑 agent (1000:1000),tmpfs 默认 root:root
            // 0700 会让 ccb 子进程 EACCES 读写 settings.json,表现为静默 exit 0(踩雷于 2026-04-21)
            //
            // 注意:projects 子目录由下方 projects volume 覆盖挂载,CCB 的 session JSONL
            // (`~/.claude/projects/<cwd>/<sessId>.jsonl`)因此跨容器重启依然在 —— 否则
            // 用户再次进入历史会话,CCB `--resume <id>` 找不到 JSONL 直接 exit 1,前端
            // 看到"AI 进程异常退出"(2026-04-22 修复)。
            Tmpfs: {
              [V3_CONFIG_TMPFS_PATH]: "rw,nosuid,nodev,size=4m,mode=0700,uid=1000,gid=1000",
            },
            // 双 volume:
            //   - 主 volume → /home/agent/.openclaude(个人版状态目录)
            //   - projects volume → /run/oc/claude-config/projects(CCB 对话 JSONL)
            //
            // projects volume 必须是独立 named volume(不能用 subpath),docker 基于镜像
            // 里 /run/oc/claude-config/projects 目录初始化 ownership=agent:agent + mode=0700,
            // 无需 supervisor 再起 helper 容器 mkdir。
            //
            // 额外两条 :ro bind(若基线齐全):
            //   - <baseline>/AGENTS.md  → /opt/openclaude/AGENTS.md:ro(Codex native rules)
            //   - <baseline>/CLAUDE.md  → /run/oc/claude-config/CLAUDE.md:ro
            //   - <baseline>/skills/    → /run/oc/claude-config/skills:ro(整目录,覆盖所有基线 skill)
            // 内核层强制只读,容器内 ccb 和用户都无法改动平台守则。
            Binds: binds,
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            // 给容器分一些 shm,但限到 64MB 防 OOM 绕过
            ShmSize: 64 * 1024 * 1024,
            UsernsMode: "",
          },
        });
        createdDockerId = container.id;
      } catch (createErr) {
        throw wrapDockerError(createErr);
      }

      try {
        await container.start();
      } catch (startErr) {
        // start 失败,回收 container 后让 PG 事务回滚
        try {
          await container.remove({ force: true });
        } catch {
          /* swallow */
        }
        throw wrapDockerError(startErr);
      }
    }

    // 4) UPDATE container_internal_id
    await client.query(
      `UPDATE agent_containers
          SET container_internal_id = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [String(row.id), createdDockerId],
    );

    await client.query("COMMIT");

    return {
      containerId: row.id,
      userId: uid,
      boundIp: row.boundIp,
      port: V3_CONTAINER_PORT,
      dockerContainerId: createdDockerId,
      token,
      hostId: effectiveHostUuid,
    };
  } catch (err) {
    // 回滚 PG;尽力清理 docker(若 createContainer 之后失败)
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallow */
    }
    if (createdDockerId) {
      try {
        if (useRemote) {
          await deps.containerService!.remove(hostId!, createdDockerId, { force: true });
        } else {
          await deps.docker.getContainer(createdDockerId).remove({ force: true });
        }
      } catch {
        /* swallow */
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 优雅停止并删除一个 active 容器,把 row 标 vanished。
 *
 * 顺序(2026-04-21 codex round 1 finding #4 修复):
 *   1. UPDATE agent_containers SET state='vanished' WHERE id = $1 —— 优先落
 *      DB,因为这是 admin / idle sweep 的"权威意图":这个行就是要走。
 *      docker 实际清理是否成功是 best-effort;失败留半死容器也是 GC 兜的事
 *      (`v3volumeGc` 见到 vanished 行的 docker_id 还残留时再 force remove)
 *   2. docker stop(t=5,SIGTERM 给 npm 5 秒) —— missing 吞掉
 *   3. docker remove(force) —— missing 吞掉
 *   4. 任意 docker 步骤 wrapped 抛错 → 抛给 caller(admin 看错日志,但 row
 *      已经是 vanished,下次 ensureRunning 会判 "无 active 行" 走 provision,
 *      不会被半死行卡在 stopped/missing 状态再死循环)
 *
 * 不删 volume(GC 走 3G,banned 7d / no-login 90d 才动)。
 *
 * 旧顺序的 bug:先 docker stop,如果非 404 异常抛出 → 整个函数挂出错,
 * UPDATE 没跑 → 行残留 active + 容器残留半死。下次 ensureRunning 命中
 * stopped/missing 分支,要么"stopped" 拒绝 ensureRunning 长时间,要么
 * 自递归调本函数死循环 wrap 同一个 docker 错。
 */
/**
 * R6.11 Phase 2.C — `options.requireNoOpenMigration: true` 让 caller(idle sweep /
 * orphan reconcile Direction B)在 SELECT-then-UPDATE 中间窗口被并发 migration
 * 写入 ledger 时,自动 skip 销毁动作 — 由 reconciler 作为单点权威负责后续。
 *
 * **race 覆盖范围(诚实标注,Codex Phase 2.C 评审 Finding 1)**:
 *   READ COMMITTED 下,UPDATE 子查询 (`NOT EXISTS … agent_migrations`) 见到的是
 *   *statement-start* snapshot,**不**是 row lock 获得时的最新行。本守卫覆盖的
 *   真实区间是「SELECT 完成 → 本条 UPDATE 语句开始」之间 writer 已 commit 的
 *   ledger 行,**不**覆盖「UPDATE 语句开始 → 行锁获得」(微秒级)之间新 commit 的行。
 *
 *   这是 best-effort 第二道闸,**主**安全机制仍是:
 *     1. SELECT 层 NOT EXISTS predicate(把 99.9% 时间的 mid-migration 行排除)
 *     2. reconciler 单点权威(在下一轮 tick 把 ledger 推到终态;但**注意**:本函数
 *        若漏过守卫已经把 `agent_containers.state` 翻 vanished + docker stop/remove
 *        过,reconciler 只能 terminalize ledger,**不能**反向恢复 agent_containers
 *        或重新启容器。意味着一旦发生该微秒级误判,用户体感为容器消失 → 下次访问
 *        触发 re-provision,数据卷尚在不丢但活跃 ws 连接断;这是 Phase 2.C MVP
 *        可接受的损耗,实测漏检率超阈值再升级到 advisory lock)
 *
 *   微秒窗口闭合(Phase 2.D / 3 候选):
 *     - per-container advisory lock(`pg_advisory_xact_lock(agent_container_id)`),
 *       writer/reader 都先取锁再读写 ledger / agent_containers
 *     - 或 reader 显式 `SELECT … FOR UPDATE` 锁住 `agent_containers` 行后再判
 *       ledger,与 writer 的 INSERT-then-UPDATE 事务序列化
 *   Phase 2.C 不引入这些复杂度,先用"best-effort 双闸 + reconciler 兜底"过 MVP,
 *   实测漏检率超阈值再升级。
 *
 * 默认行为(不传 options)保持向后兼容:admin / ensureRunning stale recovery /
 * migration reconciler 自身这些"显式销毁"路径不应该被 ledger 行挡住,继续走
 * 无条件 UPDATE。
 *
 * 返回值含义:
 *   - true:UPDATE 命中 1 行(或不带守卫),已落 vanished,docker 步骤已尝试
 *           (本身可能 partial 抛 PartialV3Cleanup,与历史语义一致)
 *   - false:requireNoOpenMigration=true 且 守卫 UPDATE 命中 0 行 →
 *           (a)行已被并发删 / id 错,或
 *           (b)守卫拦截:并发 migration 已 INSERT 一条 open ledger 行
 *           两种情况下都 **不**进 docker 清理,函数静默返回。下次 tick 会再扫。
 *
 * 历史 callers(Promise<void> 风格)不接 return 值 TS 兼容,silently 抛弃 boolean。
 */
export async function stopAndRemoveV3Container(
  deps: V3SupervisorDeps,
  containerRow: { id: number; container_internal_id?: string | null; host_uuid?: string | null },
  timeoutSec = 5,
  options?: { requireNoOpenMigration?: boolean },
): Promise<boolean> {
  // 1) DB 先翻 vanished —— admin 意图就是销毁,不依赖 docker 步骤是否干净。
  //    用 RETURNING host_uuid 兜底:v1.0.20 修了 v3orphanReconcile 的 isNotFound bug
  //    后,本函数其余 5 处调用点(idleSweep / ensureRunning stale recovery / admin
  //    stop/restart/remove)都没传 host_uuid,跨 host 容器在远端 docker 不会被真清,
  //    留下 ghost 撞下次 docker run name/IP 冲突 → host markCooldown(60s)反复 retry。
  //    这里就近从 DB 读出 host_uuid,所有调用点自动 host-aware,零额外 query。
  //
  //  R6.11 Phase 2.C:requireNoOpenMigration=true 时加 NOT EXISTS 守卫,
  //    rowCount=0 → 静默 false,不进 docker。详见函数 docstring 与
  //    docs/v3/02-DEVELOPMENT-PLAN.md §14.2.6 reader/reconciler 单点权威约束。
  //
  //    **race 覆盖范围(诚实标注)**:READ COMMITTED 下 UPDATE 的子查询见到的是
  //    *statement-start* snapshot 的 agent_migrations 行,**不**是 row lock 获取时
  //    的最新行。因此本守卫覆盖的真实区间是「SELECT 完成 → 本条 UPDATE 语句开始」
  //    之间 writer 已 commit 的 ledger 行;**不**覆盖「UPDATE 语句开始 → 行锁获得」
  //    之间(微秒级)新 commit 的行。这是 best-effort 第二道闸,**主**安全机制仍是
  //    reconciler 单点写入 — 任何漏过本守卫的极小窗口会在下一轮 reconciler tick(默认
  //    60s)被识别。要真正闭合微秒窗口需引入 per-container advisory lock 或对
  //    `agent_containers` 显式 SELECT … FOR UPDATE,Phase 2.D/3 视实测漏检率决定。
  const guardSql = options?.requireNoOpenMigration === true
    ? ` AND NOT EXISTS (
          SELECT 1 FROM agent_migrations m
           WHERE m.agent_container_id = agent_containers.id
             AND m.phase NOT IN ('committed', 'rolled_back')
        )`
    : "";
  const updateResult = await deps.pool.query<{ host_uuid: string | null }>(
    `UPDATE agent_containers
        SET state='vanished',
            updated_at=NOW()
      WHERE id = $1${guardSql}
      RETURNING host_uuid`,
    [String(containerRow.id)],
  );
  const rowFound = (updateResult.rowCount ?? 0) > 0;
  if (!rowFound && options?.requireNoOpenMigration === true) {
    // 守卫拦截 OR 行不存在:不进 docker,让 reconciler 处理
    return false;
  }
  const dbHostUuid: string | null = updateResult.rows[0]?.host_uuid ?? null;
  // caller 显式传 host_uuid 优先(reconcile 已显式传,且并发场景下 caller 更可信);
  // caller 没传 → 用 UPDATE RETURNING 兜底。
  const callerHostUuid: string | null = containerRow.host_uuid ?? null;
  // caller vs DB 不一致 → 留诊断线索(理论不该发生,可能 row 被并发改 / 容器迁移)。
  if (
    callerHostUuid !== null
    && dbHostUuid !== null
    && callerHostUuid !== dbHostUuid
  ) {
    // eslint-disable-next-line no-console
    console.warn("[v3supervisor.stopAndRemove] caller host_uuid != db host_uuid", {
      containerId: containerRow.id,
      callerHostUuid,
      dbHostUuid,
    });
  }
  const effectiveHostUuid: string | null = callerHostUuid ?? dbHostUuid;

  // 2) 容器实际清理 best-effort;先 stop 再 remove,各自吞 missing。
  //    R2 finding 加固:此后任何错都已经过了 DB UPDATE,意图已落库。
  //    R3 finding 加固:stop 失败也仍然 try remove({force:true}) ——
  //    force remove 通常能覆盖大部分 stop 失败 case(daemon 抖动、容器
  //    死锁等),缩短"row vanished 但 docker 残骸还在"的窗口。
  //    任一 stage 失败,记录,最后聚合抛 PartialV3Cleanup(含 stages)。
  if (!containerRow.container_internal_id) return true;
  const cid = containerRow.container_internal_id;
  // 多 host 系统标志:selfHostId 已配 + containerService 注入。
  // 单机 legacy 模式下 (selfHostId 缺失) host_uuid 为 null 是正常的,允许走本地。
  const isMultiHost =
    typeof deps.selfHostId === "string" && deps.containerService !== undefined;
  // 安全 gate A:多 host 系统下 host 未知 → 不假设本地。
  // 触发条件:UPDATE 0 行(row 已并发删 / id 错)且 caller 没传,
  //         或 row 在 DB 里 host_uuid 就是 null(legacy row 跑在多 host 系统)。
  // 默认本地 docker.remove 在跨 host 时是 noop(404),但语义上不对:
  // 调用方期望"清这个容器",容器实际在远端,我们却往本地打。明确 skip + warn 比静默
  // 好,出问题排障也能从日志看到 host_uuid 缺失。
  if (effectiveHostUuid === null && isMultiHost) {
    // eslint-disable-next-line no-console
    console.warn(
      "[v3supervisor.stopAndRemove] host_uuid unknown in multi-host system, skipping docker cleanup",
      { containerId: containerRow.id, cid, rowFound },
    );
    return true;
  }
  // 决定走远端还是本地(只在 effectiveHostUuid 非 null 时区分)。
  const isRemote =
    typeof effectiveHostUuid === "string"
    && typeof deps.selfHostId === "string"
    && effectiveHostUuid !== deps.selfHostId;
  // 安全 gate B:cross-host 但 containerService 缺失 → 不静默回退本地(会清错宿主)。
  // 跟 v3orphanReconcile 已有 fail-safe gate 语义一致(containerService 未注入 → skip)。
  if (isRemote && deps.containerService === undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      "[v3supervisor.stopAndRemove] cross-host row but containerService missing, skipping docker cleanup",
      { containerId: containerRow.id, cid, hostUuid: effectiveHostUuid },
    );
    return true;
  }
  const useRemote = isRemote;
  const failures: Array<{ stage: "stop" | "remove"; err: SupervisorError }> = [];
  try {
    if (useRemote) {
      await deps.containerService!.stop(effectiveHostUuid!, cid, { timeoutSec });
    } else {
      await deps.docker.getContainer(cid).stop({ t: timeoutSec });
    }
  } catch (err) {
    if (!isNotFound(err) && !isNotModified(err)) {
      failures.push({ stage: "stop", err: wrapDockerError(err) });
    }
  }
  // stop 失败后仍尝试 force remove;remove 成功 OR remove 404 (容器已不存在)
  // 都视作清理完成(残骸已不在)。R4 finding:之前 remove 404 时只是不追加
  // failure,但 stop 的 failure 还在,会误报 PartialV3Cleanup;实际上容器已没了,
  // 应等同清理成功。
  let containerCleared = false;
  try {
    if (useRemote) {
      await deps.containerService!.remove(effectiveHostUuid!, cid, { force: true });
    } else {
      await deps.docker.getContainer(cid).remove({ force: true });
    }
    containerCleared = true;
  } catch (err) {
    if (isNotFound(err)) {
      containerCleared = true; // 容器已不存在,清理目的达成
    } else {
      failures.push({ stage: "remove", err: wrapDockerError(err) });
    }
  }
  // F3:per-container codex auth 文件 best-effort 清理(绝不阻塞清理流程)。
  //   - 本地容器:rm <codexContainerDir>/<cid>/auth.json + rmdir 空 parent
  //   - 远端容器(v1.0.72):RPC DELETE /files?path=<远端 default 路径>;
  //     deps.deleteRemoteCodexAuth 未注入 → skip;失败 → 吞错。
  //     远端不 rmdir parent(node-agent 无该 endpoint),留空 <cid>/ 目录,
  //     与 deleteRemoteCodexContainerAuth 注释一致。
  if (!useRemote) {
    try {
      const codexContainerDir = readCodexContainerDirFromEnv();
      await removeCodexContainerAuthDir(codexContainerDir, String(containerRow.id));
    } catch {
      /* swallow */
    }
  } else if (deps.deleteRemoteCodexAuth) {
    try {
      await deps.deleteRemoteCodexAuth(effectiveHostUuid!, String(containerRow.id));
    } catch {
      /* swallow */
    }
  }
  // 容器确认已清理 + 之前只有 stop 失败(没有 remove 失败) → 视作完整成功
  if (containerCleared && failures.every((f) => f.stage === "stop")) return true;
  if (failures.length > 0) throw aggregatePartialV3Cleanup(failures);
  return true;
}

/** v3 stop/remove 已在 DB 翻 vanished 后 docker 步骤失败 —— 把原 SupervisorError
 *  包成 PartialV3Cleanup,保留原 message + statusCode 用于上层 admin HTTP 翻译。
 *  R3:支持多 stage 失败聚合(stop 和 remove 都失败的极端 case)。 */
function aggregatePartialV3Cleanup(
  failures: Array<{ stage: "stop" | "remove"; err: SupervisorError }>,
): SupervisorError {
  const stages = failures.map((f) => f.stage).join("+");
  const detail = failures.map((f) => `${f.stage}: ${f.err.message}`).join("; ");
  // cause 取第一个失败的 cause(通常 daemon 错相同)
  const firstCause = failures[0]?.err.cause;
  return new SupervisorError(
    "PartialV3Cleanup",
    `v3 container ${stages} failed after DB marked vanished: ${detail}`,
    firstCause,
  );
}

/**
 * 把 active 行的 last_ws_activity 刷成 NOW()。
 *
 * 用法:
 *   - ensureRunning 命中 'running' 分支(用户重连)调一次 → idle sweep 计时重置
 *   - provision 时 INSERT 已经写 NOW(),不需要再调
 *   - vanished 行不刷(WHERE state='active' 兜住)
 *
 * 不抛 — caller 拿不到错也无所谓,bridge 不会因为这个 break;最坏情况下
 * 30min idle sweep 误杀 active 容器,用户重连即重 provision,数据全在 volume。
 */
export async function markV3ContainerActivity(
  deps: V3SupervisorDeps,
  agentContainerId: number,
): Promise<void> {
  if (!Number.isInteger(agentContainerId) || agentContainerId <= 0) return;
  try {
    await deps.pool.query(
      `UPDATE agent_containers
          SET last_ws_activity = NOW(),
              updated_at = NOW()
        WHERE id = $1::bigint AND state = 'active'`,
      [String(agentContainerId)],
    );
  } catch {
    // 不冒泡 — 见上方注释
  }
}

/**
 * 查 active row + docker inspect 求标准化态。
 * 用户没 active row → null。docker inspect 404 → state='missing'。
 *
 * INV-4 (R6.11 §13.3) — SELECT WHERE 末尾追加 NOT EXISTS,过滤"被 open agent_migrations
 * 锁住"的行。本闸门:
 *   - 不是 INV-3 的替代品 — INV-3 在 ensureRunning 入口短路返 503;INV-4 单独命中
 *     时(open migration + INV-3 没拦,例如 race / 外部 caller)只让 status 返 null,
 *     reader 会落到 provision / file proxy 落到 503 CONTAINER_NOT_RUNNING
 *   - 价值:(a) 防 reuse 路径误把"被迁移行"当 reuse 候选 (b) file proxy 同享此 SELECT,
 *     迁移期间不路由到 maybe-stale 容器(short-window 503 由前端重试自愈)
 *   - NOT EXISTS 子查询用完整表名 `agent_containers.id` 引用外层(PG 标准支持),不引入
 *     alias `c`;FakePool SELECT regex `/SELECT id, user_id, host\(bound_ip\)/` 在
 *     `v3EnsureRunning.test.ts:187` 和 `v3Supervisor.test.ts:326` 都继续匹配,无回归
 *   - 索引兜底:`agent_migrations_one_open_by_container_idx (agent_container_id)
 *     WHERE phase NOT IN ('committed','rolled_back')` 是 UNIQUE partial,sub-ms
 *
 * P1 同步扩展点:placeholder dev plan §13.3 verbatim 写 `state IN ('active','pending_apply')`。
 * 当前 schema 不允许 `pending_apply`(0001-0070 未引入),先保留 `state='active'`;P1
 * 加状态时 reader 同步扩展(`findOpenByUser` 内部已 verbatim 写,届时只改本处一行)。
 */
export async function getV3ContainerStatus(
  deps: V3SupervisorDeps,
  uid: number,
): Promise<V3ContainerStatus | null> {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  const r = await deps.pool.query<{
    id: string;
    user_id: string;
    bound_ip: string;
    port: number;
    container_internal_id: string | null;
    host_uuid: string | null;
    created_at: Date;
  }>(
    // host(bound_ip): PG INET 类型 ::text 会带 /32 netmask(e.g. 172.30.227.97/32),
    // 这串拼进 ws://host:port/ws 会让 dns lookup 直接 fail,readiness probe 永远 false,
    // ensureRunning 路径表现为 4503 reason="starting" 死循环。host(inet) 只取地址本体,
    // 与 IPv4/IPv6 都兼容,与 provision 路径 INSERT 时传入的 JS string 一致。
    // P1a 隔离:按 runtime_channel 过滤 —— v3 实例只见 v3 容器、v5 只见 v5,
    // 防换 (user_id,runtime_channel) 复合唯一后 v3/v5 互相捞到对方的 active 行。
    `SELECT id, user_id, host(bound_ip) AS bound_ip, port, container_internal_id, host_uuid, created_at
       FROM agent_containers
      WHERE user_id = $1::bigint AND state='active' AND runtime_channel = $2::text
        AND NOT EXISTS (
          SELECT 1 FROM agent_migrations m
           WHERE m.agent_container_id = agent_containers.id
             AND m.phase NOT IN ('committed', 'rolled_back')
        )
      LIMIT 1`,
    [String(uid), getRuntimeChannel()],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  if (!row.container_internal_id) {
    // 行被外部 SELECT 看到 = 事务已 COMMIT;但 container_internal_id IS NULL 是
    // 异常态(provisionV3Container 正常 COMMIT 都会 UPDATE container_internal_id)。
    // 成因:
    //   1) 远端 createAndStart 返回空 containerInternalId(v1.0.8 已被 RemoteContractViolation 守门)
    //   2) 进程异常崩溃留下的边缘状态 / migration 前的旧数据
    //
    // 15s grace 仅遮蔽 commit 后极短窗口内并发 SELECT 的理论可能;真实跑这个分支
    // 基本是孤儿。超 15s → 视作 missing,ensureRunning 自愈走 stopAndRemove +
    // re-provision(stopAndRemoveV3Container 对 NULL container_internal_id 提前
    // return,只翻 state='vanished',不动 docker)。
    //
    // 修复 v1.0.7 报告的死循环:row 1120 这种孤儿 row 让用户看到 "5秒后重连" 无穷循环。
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    return {
      containerId: Number.parseInt(row.id, 10),
      userId: Number.parseInt(row.user_id, 10),
      boundIp: row.bound_ip,
      port: row.port ?? V3_CONTAINER_PORT,
      dockerContainerId: "",
      state: ageMs < 15_000 ? "stopped" : "missing",
      hostId: row.host_uuid,
    };
  }

  const useRemote =
    typeof row.host_uuid === "string"
    && typeof deps.selfHostId === "string"
    && row.host_uuid !== deps.selfHostId
    && deps.containerService !== undefined;

  let state: V3ContainerStatus["state"];
  try {
    if (useRemote) {
      const info = await deps.containerService!.inspect(row.host_uuid!, row.container_internal_id);
      state = info.state === "running" ? "running" : "stopped";
    } else {
      const info = await deps.docker.getContainer(row.container_internal_id).inspect();
      const running = Boolean(info.State && info.State.Running);
      state = running ? "running" : "stopped";
    }
  } catch (err) {
    if (isNotFound(err)) {
      state = "missing";
    } else {
      throw wrapDockerError(err);
    }
  }

  return {
    containerId: Number.parseInt(row.id, 10),
    userId: Number.parseInt(row.user_id, 10),
    boundIp: row.bound_ip,
    port: row.port ?? V3_CONTAINER_PORT,
    dockerContainerId: row.container_internal_id,
    state,
    hostId: row.host_uuid,
  };
}

// ───────────────────────────────────────────────────────────────────────
// V3 Phase 3I — 镜像预热(gateway 启动时 fire-and-forget)
// ───────────────────────────────────────────────────────────────────────

/** preheatV3Image 单次结果 — 主要给测试 / log 用,生产路径不需要看 */
export interface V3ImagePreheatResult {
  /** 镜像 tag(传入即返回,方便日志) */
  image: string;
  /** "already" = 本地已有,docker pull 仍然跑过(NO-OP);"pulled" = 真拉了 */
  outcome: "already" | "pulled" | "error";
  /** error 文案(outcome='error' 才有) */
  error?: string;
  /** 全过程毫秒 */
  durationMs: number;
}

/**
 * 异步预热 v3 镜像(gateway 启动时 fire-and-forget 调用)。
 *
 * 为什么需要:Phase 3B 用 `docker save / docker load` 一次性载入镜像后,
 * 一般本地都已存在,首次 provision 不需要拉。但部署节奏不可控(运维忘了 load /
 * 升级途中老镜像被 GC),首次用户冷启会因为 docker pull 卡 30-60s,体验崩。
 * 启动时主动 pull 一次(本地已有 → noop),把这次延迟摊到启动时。
 *
 * 设计取舍:
 *   - **不阻塞启动** —— gateway 不能等镜像 pull 才接 ws,callsite 必须 .catch(...)
 *   - **不抛错** —— 镜像不可达(私有 registry 网络抖动 / 删了)只是首次 provision
 *     变慢,gateway 仍然能跑,3I 这里 best-effort
 *   - 测试可注入 `image()` 调度返回(ReadableStream from dockerode pull)便于断言
 *     调用次数;实际生产不需要 mock
 *   - 默认在 inspect 走通后跳过 pull(镜像已在本地,90% 路径秒返回)。这条路径
 *     比裸 docker.pull 快得多(避开 manifest 拉取)
 */
export async function preheatV3Image(
  docker: Docker,
  image: string,
  logger?: { info?: (m: string, meta?: unknown) => void; warn?: (m: string, meta?: unknown) => void },
): Promise<V3ImagePreheatResult> {
  const startedAt = Date.now();
  if (typeof image !== "string" || image.trim() === "") {
    return { image, outcome: "error", error: "image is empty", durationMs: 0 };
  }
  // 路径 A:inspect 命中(本地已有)→ 直接 noop 返回
  try {
    await docker.getImage(image).inspect();
    const durationMs = Date.now() - startedAt;
    logger?.info?.("[v3 preheat] image already present locally", { image, durationMs });
    return { image, outcome: "already", durationMs };
  } catch (err) {
    if (!isNotFound(err)) {
      // inspect 抛非 404(daemon 不可达 / 权限)→ 不强行 pull,返回 error
      const durationMs = Date.now() - startedAt;
      const message = (err as Error)?.message ?? String(err);
      logger?.warn?.("[v3 preheat] image inspect failed; skipping pull", { image, error: message });
      return { image, outcome: "error", error: message, durationMs };
    }
  }
  // 路径 B:本地没有 → docker pull(stream API,followProgress 直到结束)
  try {
    await new Promise<void>((resolve, reject) => {
      // dockerode v3 typings 把 callback 标得严,unknown 兜
      const dAny = docker as unknown as {
        pull: (img: string, cb: (err: Error | null, stream: NodeJS.ReadableStream) => void) => void;
        modem: { followProgress: (s: NodeJS.ReadableStream, cb: (err: Error | null) => void) => void };
      };
      dAny.pull(image, (err, stream) => {
        if (err) return reject(err);
        dAny.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
      });
    });
    const durationMs = Date.now() - startedAt;
    logger?.info?.("[v3 preheat] image pulled", { image, durationMs });
    return { image, outcome: "pulled", durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = (err as Error)?.message ?? String(err);
    logger?.warn?.("[v3 preheat] image pull failed; first provision will pay latency", { image, error: message });
    return { image, outcome: "error", error: message, durationMs };
  }
}
