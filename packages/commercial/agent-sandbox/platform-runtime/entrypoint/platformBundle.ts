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
 *   - **零跨包 import**:本文件被 host 侧单测(commercial)与容器 entrypoint(tsx)双向消费,
 *     绝不能 import 绝对路径的 protocol/commercial 源 —— host 上那会解析到 canonical 树而非本
 *     worktree。跨源一致性(KNOWN_SEED_PROVIDERS ↔ protocol STATIC_KEY_PROVIDERS、seed 声明 ↔
 *     master platformDefaults)由 runtimeEntrypointPolicy.test.ts 的**一致性锚测试**守护。
 *
 * ── schema v2(模型权威批次 §5 阶段 A,2026-07-12)──────────────────────────────
 * v1 的边界是"计费/引擎权威**不进**声明"(model/engine/provider/runnerKind 全部硬拒,权威在
 * entrypoint 本地常量 + master 常量双端硬编码)。v2 **反转**该边界:
 *   - seed agent 的执行三元组 `model` / `provider` / `runnerKind?` **必填于声明**(值校验),
 *     entrypoint 本地 billing 常量删除 —— 声明成为容器侧唯一权威;
 *   - `engine` 仍硬拒:engine 由 model 推导(protocol isCodexEngineModel / gateway registry),
 *     独立声明只会开出第二个权威源;
 *   - 阶段 A:声明值 == master platformDefaults/protocol 常量(一致性锚测试锁死),行为零变化;
 *     阶段 B:master 按容器 label 上的 bundle_rev 读**该 rev 的**声明推导计费模型
 *     (ws/seedDeclarationLoader.ts),滚动窗口新旧容器各按自己的 rev 计费,无分叉。
 */
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

/**
 * platform-seed.yaml 当前 schema 版本(不兼容变更须 bump + 刷新 emergency tuple)。
 * v2 = 执行三元组(model/provider/runnerKind)声明化。**未知版本一律 fail-loud**
 * (含旧 v1:v1 文档没有 model/provider,静默接受会让容器 seed 出没有模型的 agent)。
 */
export const PLATFORM_SEED_SCHEMA_VERSION = 2;

/**
 * 声明里**禁止**出现的键 —— `engine` 由 model 推导(protocol 的 codex 型号表 + gateway registry
 * 是唯一权威),声明化 = 第二权威源 → 与 model 漂移时无法裁决。model/provider/runnerKind 自 v2
 * 起改为**必填字段**(见下 ALLOWED_AGENT_KEYS + 值校验),不再在此拒。
 */
export const REJECTED_SEED_AGENT_KEYS = ["engine"] as const;

/**
 * provider 已知集(值校验白名单)。= protocol STATIC_KEY_PROVIDERS 的 id 全集 ∪ {codex-native}。
 * 本文件不能 import protocol(见文件头"零跨包 import"),故此处是**镜像**,由
 * runtimeEntrypointPolicy.test.ts 的一致性锚测试与 protocol 锁死(新增静态 provider 必须同步本集)。
 */
export const KNOWN_SEED_PROVIDERS: readonly string[] = [
  "deepseek",
  "minimax",
  "ark",
  "opencodego",
  "kimi",
  // 火山方舟 Agent Plan Kimi K3(kimi-k3-ark,2026-07-22)。
  "ark-k3",
  // Moonshot 官方 Kimi For Coding(kimi-k3,2026-07-17)。
  "moonshot",
  // 引擎路由 pin(非静态 key provider):gateway registry 按 provider==='codex-native' 硬 pin codex engine。
  "codex-native",
];

/**
 * runnerKind 允许值。gateway registry 对 codex-native 只接受 缺省 / 'app-server'(其余 fail-closed),
 * 故声明面同样只放行这一个值 —— 声明能表达的 ⊆ 消费端能接受的。
 */
export const KNOWN_SEED_RUNNER_KINDS: readonly string[] = ["app-server"];

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
/** agent 声明允许字段白名单 —— banned 键(engine)另有专属报错,其余未知字段 fail-loud。 */
const ALLOWED_AGENT_KEYS = new Set([
  "id",
  // v2 执行三元组(model/provider 必填,runnerKind 可选)。
  "model",
  "provider",
  "runnerKind",
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
  /** v2 必填:该 seed agent 的计费/路由模型(容器 agents.yaml 的 agent.model)。 */
  model: string;
  /** v2 必填:provider ∈ KNOWN_SEED_PROVIDERS(静态 key provider 或 codex-native 引擎 pin)。 */
  provider: string;
  /** v2 可选:仅 'app-server'(codex-native runner 路由);缺省 = 默认 runner。 */
  runnerKind?: string;
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

/**
 * dev fallback 的**最小内置声明**(仅 bundle/fallback 路径上都没有 platform-seed.yaml 时用,
 * = 本地开发/裸镜像跑)。生产恒有 bundle(PLATFORM_BUNDLE_REQUIRED_LEAVES 含 seed/platform-seed.yaml,
 * 缺即 resolvePlatformBundleMount 拒),故本常量在生产**不可达**。
 *
 * 它仍是一份"声明"而非散落常量:entrypoint 对有/无 bundle 两条路径走**同一套** buildSeedAgent
 * 装配(model/provider 一律来自 decl)。值与 master platformDefaults 的一致性同样由一致性锚测试守护。
 */
export const DEV_FALLBACK_SEED_DOC: PlatformSeedDoc = {
  schemaVersion: PLATFORM_SEED_SCHEMA_VERSION,
  agents: [
    {
      id: "main",
      model: "glm-5.2",
      provider: "ark",
      permissionMode: "bypassPermissions",
      displayName: "全能助手",
      avatarEmoji: "🧠",
    },
  ],
  seedSkills: {},
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * 校验并规范化 platform-seed.yaml 已解析对象。**fail loud**(M5 confinement + v2 值校验):
 *   - 非对象 / schemaVersion 不符(未知版本含旧 v1 一律拒)/ agents 非数组 → 抛。
 *   - 未知顶层字段 / 未知 agent 字段 → 抛(防 typo 静默失效、走私新语义)。
 *   - 任一 agent 声明含 `engine` → 抛(engine 由 model 推导,禁第二权威源)。
 *   - **v2 执行三元组**:model 缺失/非非空字符串 → 抛;provider ∉ KNOWN_SEED_PROVIDERS → 抛;
 *     runnerKind 出现但 ∉ KNOWN_SEED_RUNNER_KINDS → 抛(声明能表达的 ⊆ 消费端能接受的)。
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
    // banned 键**先于** slug/unknown 检查:保留专属报错文案(第二权威源防线,测试锁定)。
    for (const banned of REJECTED_SEED_AGENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(raw, banned)) {
        throw new Error(
          `platform-seed: agent "${raw.id}" declares forbidden key "${banned}" — engine 由 model 推导` +
            `(protocol 型号表 + gateway registry 唯一权威),声明化会开出第二权威源(设计 §5)`,
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
    // v2 执行三元组:model/provider 必填 + 值校验;runnerKind 可选且值受限。
    if (typeof raw.model !== "string" || raw.model.trim() === "") {
      throw new Error(
        `platform-seed: agent "${raw.id}" must declare a non-empty string model (schema v2:执行三元组声明化)`,
      );
    }
    if (typeof raw.provider !== "string" || !KNOWN_SEED_PROVIDERS.includes(raw.provider)) {
      throw new Error(
        `platform-seed: agent "${raw.id}" provider ${JSON.stringify(raw.provider)} not in known set ` +
          `(${KNOWN_SEED_PROVIDERS.join("/")})`,
      );
    }
    const decl: PlatformSeedAgentDecl = { id: raw.id, model: raw.model, provider: raw.provider };
    if (raw.runnerKind !== undefined) {
      if (typeof raw.runnerKind !== "string" || !KNOWN_SEED_RUNNER_KINDS.includes(raw.runnerKind)) {
        throw new Error(
          `platform-seed: agent "${raw.id}" runnerKind ${JSON.stringify(raw.runnerKind)} not supported ` +
            `(only ${KNOWN_SEED_RUNNER_KINDS.join("/")} or omitted)`,
        );
      }
      decl.runnerKind = raw.runnerKind;
    }
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

/** buildSeedAgent 的 `dynamic` 覆写面 —— 只允许**展示层**字段(执行三元组恒来自声明)。 */
export interface SeedAgentDynamicFields {
  /** 如 codex 队长:显示名跟随 protocol 型号目录(按声明的 model 反查),避免型号表/声明两处抄。 */
  displayName?: string;
}

/** dynamic 覆写面里**禁止**出现的执行键(声明化回潮防线;运行时硬拒,非仅类型约束)。 */
const DYNAMIC_FORBIDDEN_KEYS = ["model", "provider", "runnerKind", "engine"] as const;

/**
 * 装配单个 seed agent(schema v2):**执行三元组(model/provider/runnerKind)恒取自声明** +
 * 声明的非计费字段 + 已写好的 persona 卷路径 + 可选的展示层动态覆写。
 *
 * v1 → v2 的权威反转:旧签名有个 `billing: Record<string, unknown>` 参数,由 entrypoint 本地常量
 * 注入 model/provider/runnerKind 并**覆盖**声明;v2 里 entrypoint 已无 billing 常量,声明即权威。
 * `dynamic` 只留给展示层(displayName),且运行时硬拒任何执行键 —— 防"绕道 dynamic 再造第二权威源"。
 *
 * 产物字段与旧内联 desiredXAgent 对象一致(下游 patchPlatformSeedAgent merge 逻辑零改动)。
 */
export function buildSeedAgent(args: {
  id: string;
  decl: PlatformSeedAgentDecl;
  personaPath?: string;
  dynamic?: SeedAgentDynamicFields;
}): Record<string, unknown> {
  const { decl } = args;
  if (decl.id !== args.id) {
    throw new Error(`buildSeedAgent: decl id "${decl.id}" != requested id "${args.id}"`);
  }
  if (args.dynamic) {
    for (const forbidden of DYNAMIC_FORBIDDEN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(args.dynamic, forbidden)) {
        throw new Error(
          `buildSeedAgent: dynamic override must not carry execution key "${forbidden}" — ` +
            `执行权威只在 platform-seed 声明(schema v2),覆盖面仅限展示字段`,
        );
      }
    }
  }
  const out: Record<string, unknown> = { id: args.id };
  if (args.personaPath !== undefined) out.persona = args.personaPath;
  // 执行三元组(声明权威)。
  out.model = decl.model;
  out.provider = decl.provider;
  if (decl.runnerKind !== undefined) out.runnerKind = decl.runnerKind;
  // 非计费声明字段。
  if (decl.permissionMode !== undefined) out.permissionMode = decl.permissionMode;
  if (decl.displayName !== undefined) out.displayName = decl.displayName;
  if (decl.avatarEmoji !== undefined) out.avatarEmoji = decl.avatarEmoji;
  if (decl.toolsets !== undefined) out.toolsets = [...decl.toolsets];
  // 展示层动态覆写(赢声明的 displayName)。
  if (args.dynamic?.displayName !== undefined) out.displayName = args.dynamic.displayName;
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// R2-M2:platform seed 资产存在性语义校验(entrypoint validate-only 与 deploy prepare CLI 共用)
// ───────────────────────────────────────────────────────────────────────

export interface SeedAssetCheckDeps {
  /** 路径存在判定(注入以便测试;生产 = existsSync)。 */
  exists: (path: string) => boolean;
  /** 解 symlink 取真实路径(注入;生产 = realpathSync;源必存在故不特判 ENOENT)。 */
  realpath: (path: string) => string;
  /** 路径拼接(注入;生产 = node:path join)。 */
  join: (...parts: string[]) => string;
}

/**
 * 对**已通过 schema 校验**的 platform seed 做**资产存在性 + containment** 语义校验:
 *   - 每个 agent 的 persona 引用(personas/<slug>.md)在 <seedDir> 内实际存在,且 realpath 不逃逸 seed 子树;
 *   - 每个 seedSkills[agentId][name] 对应 <seedDir>/skills/<agentId>/<name>/SKILL.md 实际存在且不逃逸。
 *
 * 返回错误原因清单(空 = 全过)。**纯函数**(fs/path 全注入),同时服务:
 *   1. deploy prepare 的 validatePlatformSeedCli(离线校验 bundle 产物,F2 接线);
 *   2. entrypoint validate-only 模式(canary boot 冒烟)。
 * schema 校验(validatePlatformSeed)已把 slug/persona-ref 收敛为一道防线;本函数补"引用的文件真的在"
 * 这一层(schema 只管形态,不管磁盘)。containment 为消费端二道防线,兜 schema 被绕过的路径逃逸。
 */
export function validateSeedAssetsExist(
  seedDir: string,
  seedDirReal: string,
  doc: PlatformSeedDoc,
  deps: SeedAssetCheckDeps,
): string[] {
  const errors: string[] = [];
  const checkContained = (abs: string, label: string): void => {
    if (!deps.exists(abs)) {
      errors.push(`${label} missing: ${abs}`);
      return;
    }
    if (!isPathWithin(seedDirReal, deps.realpath(abs))) {
      errors.push(`${label} escapes bundle seed dir: ${abs}`);
    }
  };
  for (const decl of doc.agents) {
    if (decl.persona) {
      checkContained(deps.join(seedDir, decl.persona), `persona for agent "${decl.id}"`);
    }
  }
  for (const [agentId, names] of Object.entries(doc.seedSkills)) {
    for (const name of names) {
      checkContained(
        deps.join(seedDir, "skills", agentId, name, "SKILL.md"),
        `seed skill "${agentId}/${name}"`,
      );
    }
  }
  return errors;
}

// ───────────────────────────────────────────────────────────────────────
// R2-M4:volume 平台写入的 symlink 逃逸纵深防御(纯函数 + 注入 fs 便于测)
// ───────────────────────────────────────────────────────────────────────

export interface AncestryLstat {
  isSymbolicLink(): boolean;
}

/**
 * 从 volumeRoot(**exclusive**)向下到 targetPath(**inclusive**),对每级**已存在**祖先 lstat 拒 symlink。
 * volumeRoot 自身及其之上视为部署可信(named volume 挂载点,不检查)。
 *
 * 意义(R2-M4 写侧纵深):卷内内容在两次 boot 之间由容器内进程(即 agent 本身)可写。攻击者可把
 * `agents/<id>` 换成指向 `/etc` 的 symlink,词法 containment(isPathWithin)判定不出来 —— 写
 * `agents/<id>/CLAUDE.md` 就穿透到卷外。逐级 lstat 已存在祖先(含 targetPath 自身,拒被换成 symlink
 * 的目标文件)即从写侧堵死。用 lstat 而非 exists:dangling symlink 上 exists=false 但 lstat 成功,
 * 必须识别为 symlink 拒之。命中 → 抛(调用方 catch → 跳过该 agent 平台 seed,不崩 entrypoint)。
 */
export function assertVolumeAncestryNoSymlink(
  targetPath: string,
  volumeRoot: string,
  lstat: (p: string) => AncestryLstat,
  dirname: (p: string) => string,
): void {
  const chain: string[] = [];
  let cur = targetPath;
  for (;;) {
    if (cur === volumeRoot) break;
    chain.push(cur);
    const parent = dirname(cur);
    if (parent === cur) {
      // 走到文件系统根仍未命中 volumeRoot → targetPath 词法上不在 volumeRoot 下,拒。
      throw new Error(`platform volume write target escapes volume root: ${targetPath} (root=${volumeRoot})`);
    }
    cur = parent;
  }
  // 自顶向下(靠近 root → 靠近 target)逐级检查已存在层级。
  for (const p of [...chain].reverse()) {
    let st: AncestryLstat;
    try {
      st = lstat(p);
    } catch {
      continue; // 该级尚未创建 → 跳过(mkdir 会补)
    }
    if (st.isSymbolicLink()) {
      throw new Error(`platform volume ancestry contains a symlink (refusing to write through it): ${p}`);
    }
  }
}

export interface SafeVolumeWriteFs {
  lstatSync: (p: string) => AncestryLstat;
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
  realpathSync: (p: string) => string;
  writeFileSync: (p: string, data: string | Buffer, opts: { mode: number }) => void;
  renameSync: (from: string, to: string) => void;
}

/**
 * 安全写平台文件到用户 volume(R2-M4 symlink 逃逸纵深防御,三步合一):
 *   1. assertVolumeAncestryNoSymlink:目标在 volumeRoot 以下每级已存在祖先(含目标)非 symlink,词法越界亦拒;
 *   2. mkdir 父目录(recursive)后 **realpath 复核**父目录仍落在 volumeRoot 子树内(拒 mkdir 沿 symlink 逃逸);
 *   3. 同目录**临时文件 + rename 原子落盘**(读者永不看到半写文件;rename 同目录同 fs 是原子的)。
 * 任一步失败抛(调用方 catch → 跳过该 agent 平台 seed,不崩 entrypoint)。纯函数,fs/path/rand 全注入便于测。
 */
export function safeWritePlatformVolumeFile(args: {
  targetPath: string;
  volumeRoot: string;
  content: string | Buffer;
  mode: number;
  fs: SafeVolumeWriteFs;
  dirname: (p: string) => string;
  randomSuffix: () => string;
}): void {
  const { targetPath, volumeRoot, content, mode, fs, dirname, randomSuffix } = args;
  assertVolumeAncestryNoSymlink(targetPath, volumeRoot, fs.lstatSync, dirname);
  const parent = dirname(targetPath);
  fs.mkdirSync(parent, { recursive: true });
  const volumeRootReal = fs.realpathSync(volumeRoot);
  const parentReal = fs.realpathSync(parent);
  // 容器 runtime 恒 POSIX;"/" 分隔判定子树。
  if (parentReal !== volumeRootReal && !parentReal.startsWith(volumeRootReal + "/")) {
    throw new Error(
      `platform volume write parent realpath escapes volume root: ${parentReal} not under ${volumeRootReal}`,
    );
  }
  const tmp = `${targetPath}.tmp-${randomSuffix()}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, targetPath);
}
