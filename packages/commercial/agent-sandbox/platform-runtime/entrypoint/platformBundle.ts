/**
 * platform-runtime/entrypoint/platformBundle.ts — entrypoint.ts 的可测纯函数集
 * (runtime hotcfg P2a/P0)。
 *
 * 抽出动机:entrypoint.ts 是 tsx 直跑脚本、有 top-level 副作用、且被 Dockerfile 单独 COPY
 * 到镜像绝对路径 —— 无法进 commercial 的 tsc 编译图,也不能直接 unit-spawn。把「平台 seed
 * 声明校验 / seed 目录解析 / persona·seed-skill·codex-skill 读取与覆写决策」这些**纯计算**
 * 抽到本模块,entrypoint.ts import 之,commercial 测试再 import 之做行为断言。
 *
 * 硬约束(本模块自持不变量):
 *   - **零 import 副作用**:只 export 纯函数/常量,import 本模块不触发任何 fs / env / 网络动作。
 *   - **零平台绝对路径硬依赖**:所有路径/存在性判定经参数或注入式回调传入,便于 host 侧测试。
 *   - **计费/引擎权威不进声明**:validatePlatformSeed 硬拒 model/engine/provider/runnerKind 键
 *     (设计 §4.1 R2-B1:声明化会破坏 master/容器双端同构 → 计费分叉;fail loud 防回潮)。
 */
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

/** platform-seed.yaml 当前 schema 版本(不兼容变更须 bump + 刷新 emergency tuple)。 */
export const PLATFORM_SEED_SCHEMA_VERSION = 1;

/** 声明里**禁止**出现的键 —— model/engine 权威留 entrypoint 常量,provider/runnerKind 是引擎路由。 */
export const REJECTED_SEED_AGENT_KEYS = ["model", "engine", "provider", "runnerKind"] as const;

/**
 * seed id / seed skill 名严格 slug(M5 confinement):小写字母数字起头,后续字母数字或连字符,
 * 总长 ≤64。禁 `.`/`/`/`..`/大写/空白 —— 这些 id 直接拼进容器卷内路径(agents/<id>/…),
 * slug 收敛即从源头堵死路径逃逸,消费端 containment 是二道防线。
 */
export const PLATFORM_SEED_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * persona 引用只允许 `personas/<slug>.md` 单层形态。拒 `../`(逃逸)、绝对路径(`/…`)、
 * 子目录(`personas/sub/x.md`,多一个 `/` 即不匹配)。与 slug 同为 M5 源头约束。
 */
export const PLATFORM_SEED_PERSONA_RE = /^personas\/[a-z0-9][a-z0-9-]{0,63}\.md$/;

/** 顶层允许字段白名单 —— 未知顶层字段 fail-loud(防 typo 静默失效 / 走私新语义)。 */
const ALLOWED_TOP_KEYS = new Set(["schemaVersion", "agents", "seedSkills"]);
/** agent 声明允许字段白名单 —— banned 计费键另有专属报错,其余未知字段 fail-loud。 */
const ALLOWED_AGENT_KEYS = new Set([
  "id",
  "persona",
  "forcePersona",
  "permissionMode",
  "displayName",
  "avatarEmoji",
  "toolsets",
]);

function assertSeedSlug(value: string, what: string): void {
  if (!PLATFORM_SEED_SLUG_RE.test(value)) {
    throw new Error(
      `platform-seed: ${what} "${value}" must match slug ^[a-z0-9][a-z0-9-]{0,63}$ (M5 path-confinement)`,
    );
  }
}

/** dev fallback:自身 bundle 相对 seed 之后的第二候选根(镜像 COPY 落点)。 */
export const PLATFORM_SEED_FALLBACK_DIR = "/usr/local/share/openclaude-platform/seed";
/** dev fallback:平台自有 codex skill 的第二候选根(镜像 COPY 落点)。 */
export const PLATFORM_CODEX_SKILLS_FALLBACK_DIR = "/usr/local/share/openclaude-platform/codex-skills";

export interface PlatformSeedAgentDecl {
  id: string;
  /** persona 文件相对 seed 根的路径(如 personas/main.md);无 persona 的 agent(如 codex)省略。 */
  persona?: string;
  /** true = 每次 boot 强制刷新 persona(hidden-reviewer 裁决词须稳定同步)。 */
  forcePersona?: boolean;
  permissionMode?: string;
  displayName?: string;
  avatarEmoji?: string;
  toolsets?: string[];
}

export interface PlatformSeedDoc {
  schemaVersion: number;
  agents: PlatformSeedAgentDecl[];
  /** agentId → seed skill 名单;内容在 <seedRoot>/skills/<agentId>/<name>/SKILL.md。 */
  seedSkills: Record<string, string[]>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * 校验并规范化 platform-seed.yaml 已解析对象。**fail loud**(M5 confinement 强化):
 *   - 非对象 / schemaVersion 不符 / agents 非数组 → 抛。
 *   - 未知顶层字段 / 未知 agent 字段 → 抛(防 typo 静默失效、走私新语义)。
 *   - 任一 agent 声明含 model/engine/provider/runnerKind → 抛(防绕道声明化计费字段)。
 *   - agent id / seedSkills key / skill 名非严格 slug → 抛(id 直接拼进卷内路径)。
 *   - persona 引用非 `personas/<slug>.md` 单层形态(../、绝对路径、子目录)→ 抛。
 *   - 重复 agent id → 抛。
 * 返回规范化后的强类型文档。
 */
export function validatePlatformSeed(parsed: unknown): PlatformSeedDoc {
  if (!isRecord(parsed)) {
    throw new Error("platform-seed: root must be a mapping");
  }
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`platform-seed: unknown top-level field "${key}" (allowed: schemaVersion/agents/seedSkills)`);
    }
  }
  if (parsed.schemaVersion !== PLATFORM_SEED_SCHEMA_VERSION) {
    throw new Error(
      `platform-seed: unsupported schemaVersion ${String(parsed.schemaVersion)} (expected ${PLATFORM_SEED_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(parsed.agents)) {
    throw new Error("platform-seed: agents must be an array");
  }
  const agents: PlatformSeedAgentDecl[] = [];
  const seenAgentIds = new Set<string>();
  for (const raw of parsed.agents) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.trim() === "") {
      throw new Error("platform-seed: each agent must be a mapping with a non-empty string id");
    }
    // banned 计费键**先于** slug/unknown 检查:保留专属报错文案(计费分叉防线,测试锁定)。
    for (const banned of REJECTED_SEED_AGENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(raw, banned)) {
        throw new Error(
          `platform-seed: agent "${raw.id}" declares forbidden key "${banned}" — model/engine/provider/runnerKind ` +
            `权威只在 entrypoint 常量 + master(计费同构),声明化会造成滚动窗口计费分叉(设计 §4.1)`,
        );
      }
    }
    assertSeedSlug(raw.id, "agent id");
    if (seenAgentIds.has(raw.id)) {
      throw new Error(`platform-seed: duplicate agent id "${raw.id}"`);
    }
    seenAgentIds.add(raw.id);
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_AGENT_KEYS.has(key)) {
        throw new Error(`platform-seed: agent "${raw.id}" has unknown field "${key}"`);
      }
    }
    const decl: PlatformSeedAgentDecl = { id: raw.id };
    if (raw.persona !== undefined) {
      if (typeof raw.persona !== "string") throw new Error(`platform-seed: agent "${raw.id}" persona must be a string path`);
      if (!PLATFORM_SEED_PERSONA_RE.test(raw.persona)) {
        throw new Error(
          `platform-seed: agent "${raw.id}" persona ref "${raw.persona}" must be personas/<slug>.md ` +
            `(no ../, absolute path, or subdirs — M5 path-confinement)`,
        );
      }
      decl.persona = raw.persona;
    }
    if (raw.forcePersona !== undefined) {
      if (typeof raw.forcePersona !== "boolean") throw new Error(`platform-seed: agent "${raw.id}" forcePersona must be boolean`);
      decl.forcePersona = raw.forcePersona;
    }
    if (raw.permissionMode !== undefined) {
      if (typeof raw.permissionMode !== "string") throw new Error(`platform-seed: agent "${raw.id}" permissionMode must be a string`);
      decl.permissionMode = raw.permissionMode;
    }
    if (raw.displayName !== undefined) {
      if (typeof raw.displayName !== "string") throw new Error(`platform-seed: agent "${raw.id}" displayName must be a string`);
      decl.displayName = raw.displayName;
    }
    if (raw.avatarEmoji !== undefined) {
      if (typeof raw.avatarEmoji !== "string") throw new Error(`platform-seed: agent "${raw.id}" avatarEmoji must be a string`);
      decl.avatarEmoji = raw.avatarEmoji;
    }
    if (raw.toolsets !== undefined) {
      if (!Array.isArray(raw.toolsets) || raw.toolsets.some((t) => typeof t !== "string")) {
        throw new Error(`platform-seed: agent "${raw.id}" toolsets must be a string array`);
      }
      decl.toolsets = raw.toolsets as string[];
    }
    agents.push(decl);
  }

  const seedSkills: Record<string, string[]> = {};
  if (parsed.seedSkills !== undefined) {
    if (!isRecord(parsed.seedSkills)) throw new Error("platform-seed: seedSkills must be a mapping");
    for (const [agentId, names] of Object.entries(parsed.seedSkills)) {
      assertSeedSlug(agentId, "seedSkills agent id");
      if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
        throw new Error(`platform-seed: seedSkills["${agentId}"] must be a string array`);
      }
      for (const n of names as string[]) assertSeedSlug(n, `seedSkills["${agentId}"] skill name`);
      seedSkills[agentId] = names as string[];
    }
  }
  return { schemaVersion: PLATFORM_SEED_SCHEMA_VERSION, agents, seedSkills };
}

/**
 * 归一化后的路径 containment 判定(M5 confinement 二道防线):`child` resolve 掉 `..` 后
 * 是否落在 `parent` 子树内(含 parent 自身)。纯计算(不触 fs),供消费端对 join 出来的
 * 源/目标路径做越界拒绝;symlink 逃逸由 bundle schema 校验(禁 symlink)+ 调用方 realpath 兜底。
 */
export function isPathWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/**
 * seed 根解析次序(设计 §5d):
 *   1. 自身 bundle 相对:<selfEntryDir>/../seed  (realpath 自钉,穿透 current symlink;真热)
 *   2. dev fallback:PLATFORM_SEED_FALLBACK_DIR
 *   3. 都无 platform-seed.yaml → null(调用方回落最小内置集 + dev-only 日志)
 * `exists` 注入以便测试;判定以 <root>/platform-seed.yaml 是否存在为准(yaml 缺失即视为无 seed)。
 */
export function resolvePlatformSeedDir(
  selfEntryDir: string,
  exists: (path: string) => boolean,
  join: (...parts: string[]) => string,
): string | null {
  const candidates = [join(selfEntryDir, "..", "seed"), PLATFORM_SEED_FALLBACK_DIR];
  for (const root of candidates) {
    if (exists(join(root, "platform-seed.yaml"))) return root;
  }
  return null;
}

/**
 * 平台自有 codex skill 根解析次序(设计 §2c/§5c):
 *   1. <selfEntryDir>/../codex-skills
 *   2. PLATFORM_CODEX_SKILLS_FALLBACK_DIR
 *   3. null(跳过 overlay + dev-only 日志)
 */
export function resolvePlatformCodexSkillsDir(
  selfEntryDir: string,
  exists: (path: string) => boolean,
  join: (...parts: string[]) => string,
): string | null {
  const candidates = [join(selfEntryDir, "..", "codex-skills"), PLATFORM_CODEX_SKILLS_FALLBACK_DIR];
  for (const root of candidates) {
    if (exists(root)) return root;
  }
  return null;
}

export function sha256Hex(buf: string | Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export type SeededSkillWriteMode = "skip-if-exists" | "hash-overwrite";

/**
 * 平台种子文件写入决策(共用纯函数,设计 §2c/§4a)—— 同时服务 codex-skills overlay 与
 * 平台 per-agent seed skill(M4a 把两处从各写一套判定统一到本函数):
 *   - skip-if-exists(镜像 populate 的 codex **原生** system skill,如 imagegen):仅缺失时写,
 *     绝不覆盖用户/codex 侧状态。
 *   - hash-overwrite(bundle 里**平台自有**内容,如 codex document-writing / scientist seed skill):
 *     缺失即写;已存在但内容 hash 不一致即覆写(修 skip-if-exists 缺陷 —— 平台更新的内容送不达)。
 */
export function shouldWriteSeededSkill(
  mode: SeededSkillWriteMode,
  targetExists: boolean,
  targetContent: string | Buffer | null,
  sourceContent: string | Buffer,
): boolean {
  if (!targetExists) return true;
  if (mode === "skip-if-exists") return false;
  // hash-overwrite:内容一致则不动(幂等,避免无谓 IO / mtime 抖动)。
  if (targetContent === null) return true;
  return sha256Hex(targetContent) !== sha256Hex(sourceContent);
}

/**
 * persona 平台热更新决策矩阵(M4b 纯函数,decision 与 IO 分离便于全矩阵单测)。
 * 语义(用户定制保护 —— 平台热更新明确排除用户改过的 persona):
 *   - force:hidden-reviewer 裁决词须稳定同步 → 无条件覆写。
 *   - write-new:目标不存在 → 写平台版。
 *   - already-latest:当前内容已 == 新平台版 → 不改内容(记录由调用方回填对齐)。
 *   - upgrade:当前内容 == 记录的「上次平台版 hash」(用户没改过)→ 升级到新平台版。
 *   - skip-no-record:记录缺失(存量 volume)→ 保守视为用户定制,跳过。
 *   - skip-customized:当前既非新平台版、也非上次平台版(用户改过)→ 跳过。
 * 全部返回后由调用方决定写文件 / 写 hash 记录(见 entrypoint.ts ensureAgentPersona)。
 */
export type PersonaWriteAction =
  | "force"
  | "write-new"
  | "already-latest"
  | "upgrade"
  | "skip-no-record"
  | "skip-customized";

export function decidePersonaWrite(args: {
  force: boolean;
  targetExists: boolean;
  /** targetExists 时 = sha256(当前卷内容);否则 null。 */
  currentHash: string | null;
  /** .platform-persona-hash 记录的上次平台 hash;缺失/损坏 = null。 */
  recordedHash: string | null;
  /** sha256(本次平台版内容)。 */
  platformHash: string;
}): PersonaWriteAction {
  if (args.force) return "force";
  if (!args.targetExists) return "write-new";
  if (args.currentHash === args.platformHash) return "already-latest";
  if (args.recordedHash === null) return "skip-no-record";
  if (args.currentHash === args.recordedHash) return "upgrade";
  return "skip-customized";
}

/**
 * 合并单个 seed agent:yaml 非计费声明 + entrypoint 注入的计费/动态字段 + 已写好的 persona 卷路径。
 * `billing`(model/provider/runnerKind/动态 displayName 等)是**计费/引擎权威**,永远覆盖声明。
 * 产物与旧内联 desiredXAgent 对象字段一致(下游 patchPlatformSeedAgent merge 逻辑零改动)。
 */
export function buildSeedAgent(args: {
  id: string;
  decl?: PlatformSeedAgentDecl;
  billing: Record<string, unknown>;
  personaPath?: string;
}): Record<string, unknown> {
  const decl = args.decl ?? { id: args.id };
  const out: Record<string, unknown> = { id: args.id };
  if (args.personaPath !== undefined) out.persona = args.personaPath;
  if (decl.permissionMode !== undefined) out.permissionMode = decl.permissionMode;
  if (decl.displayName !== undefined) out.displayName = decl.displayName;
  if (decl.avatarEmoji !== undefined) out.avatarEmoji = decl.avatarEmoji;
  if (decl.toolsets !== undefined) out.toolsets = [...decl.toolsets];
  for (const [k, v] of Object.entries(args.billing)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
