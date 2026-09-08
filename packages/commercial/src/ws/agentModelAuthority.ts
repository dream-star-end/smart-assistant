/**
 * agentModelAuthority —— master 侧「agentId → 有效模型」权威快照
 * (P0 计费旁路封堵:bridge 可信模型推导的数据源)。
 *
 * 为什么在 master 侧再立一份权威:M1a 起容器 gateway 的 engine 判定按 model
 * (engine/registry resolveEngine),帧不带 model 时回落 **agent.model**。
 * agent.model 的落库权威本来就在 master(seed 声明 + marketplace manifest),
 * 容器 agents.yaml 只是它的下发投影(entrypoint seed + syncMarketplaceHub
 * reconcile)。bridge 在 forward 前做 codex 分类,必须读同一份权威,而不是
 * 信 frame / lastSeen 这类客户端可控信号。
 *
 * 快照组成(与容器 agents.yaml 的 master 侧来源一一对应):
 *   1. marketplace 用户已装且能力就绪的 agent(listRuntimeReadyAgentSets)→ manifest.model
 *   2. 同一批次内能力就绪的平台预设 agent → manifest.model,
 *      同 slug 覆盖已装(与 internalMarketplaceSync 的「预设优先」合并规则一致)
 *   3. 内置 seed agents → 见下「seed 权威的两种形态」;内置 id 最后写入 = 最高优先
 *      (容器 reconcileAgents 对 reserved id 同样跳过 marketplace 同名项,语义对齐)
 *
 * 推导不出(用户在容器里手改 agents.yaml 自建的 agent 等)→ resolver 返 null,
 * bridge 对「帧无 model」的这类帧 fail-closed 拒(gateway seam 的 requestId
 * fail-closed guard 是同问题的容器侧兜底层)。
 *
 * ## seed 权威的两种形态(模型权威批次 §5;flag `OC_SEED_AUTHORITY_BY_REV` 切换)
 *
 * - **兼容路径(商业默认 / 显式 flag=0)**:seed 三元组 = master 本地常量
 *   (platformDefaults + protocol DEFAULT_CODEX_ENGINE_MODEL),与容器 entrypoint 的
 *   声明**双端各自持有**。滚动窗口里(新 bundle 已发、老容器未回收)两端可指向不同
 *   模型 → **计费分叉**(master 按新常量计费,容器按旧 bundle 执行)。
 * - **按 rev(selfhost 默认 / 显式 flag=1)**:seed 三元组 = **该容器实际运行的 bundle rev 的 seed 声明**
 *   (platform-seed.yaml schema v2,经 seedDeclarationLoader 全量校验读入)。调用方必须
 *   把容器 label `com.openclaude.runtime.bundle_rev` 传进来 —— 缺 rev / 该 rev 的 bundle
 *   读不出 → **抛 SeedDeclarationError,fail-closed 拒帧**,绝不回落常量(回落=分叉重现)。
 *   滚动窗口里新旧容器各按自己的 rev 计费,无分叉。
 *
 * 阶段 A 已保证「bundle 声明值 == master 常量」(runtimeEntrypointPolicy 一致性锚测试),
 * 故开 flag 前后判定集合等值 → 切换零行为变化;flag 关掉即回旧路径(可回滚)。
 */
import {
  AGENT_MODEL_AUTO, DEFAULT_CODEX_ENGINE_MODEL,
  assertIdentityCompatReady, IdentityCompatError, resolveIdentityCompat,
  type IdentityCompatProjection, type IdentityCompatResolution,
} from "@openclaude/protocol";

import {
  listRuntimeReadyAgentSets,
  loadMarketplaceRuntimeSnapshot,
  type InstalledAgent,
} from "../marketplace/marketplaceDb.js";
import { platformPresetAgentSlugs } from "../marketplace/platformPresets.js";
import { PLATFORM_DEFAULT_MODEL, PLATFORM_HIDDEN_REVIEWER_MODEL } from "../platformDefaults.js";
import type { Flavor, FlavorIdentity } from "../flavor/assertFlavor.js";
import { projectIdentityCompat, registeredIdentityCompatProfiles } from "../identity/identityCompat.js";
import { SeedDeclarationError, seedAgentModels, type SeedAgentExecution } from "./seedDeclarationLoader.js";

/** selfhost 默认按 rev;商业仍需显式 1。0 是两者的显式回滚。 */
export const SEED_AUTHORITY_BY_REV_ENV = "OC_SEED_AUTHORITY_BY_REV";

const LEGACY_SEED_AGENT_MODELS = new Map<string, string>([
  ["main", PLATFORM_DEFAULT_MODEL],
  ["codex", DEFAULT_CODEX_ENGINE_MODEL],
  ["hidden-reviewer", PLATFORM_HIDDEN_REVIEWER_MODEL],
]);

export function seedAuthorityByRevEnabled(
  env: NodeJS.ProcessEnv = process.env,
  flavor?: Flavor,
): boolean {
  if (env[SEED_AUTHORITY_BY_REV_ENV] === "0") return false;
  if (env[SEED_AUTHORITY_BY_REV_ENV] === "1") return true;
  // Only the boot-verified deployment flavor opts into the selfhost default.
  // Runtime channel=v5 is shared by commercial and selfhost, not identity proof.
  return flavor === "selfhost";
}

/** Manifest auto uses the SAME connection revision as the seed layer. */
function manifestModel(rawManifest: string, autoModel: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawManifest);
    if (parsed === null || typeof parsed !== "object") return null;
    const model = (parsed as { model?: unknown }).model;
    if (typeof model !== "string" || model.trim() === "") return null;
    return model === AGENT_MODEL_AUTO ? autoModel : model;
  } catch {
    return null;
  }
}

/**
 * 纯函数快照构建(单测锚点):installed → presets(覆盖)→ seed(覆盖)。
 * 后写覆盖 = 优先级递增,与文件头注释的 1→3 顺序一致。
 *
 * `seedExecutions`(阶段 B):某 bundle rev 的 seed 声明(agentId → 执行三元组)。
 *   - 传入 → seed 层**完全由声明决定**(master 侧不再有 seed id/model 硬编码);
 *   - 省略 → 旧的 master 常量镜像(main/codex/hidden-reviewer),供 flag 未开时使用。
 */
export function buildAgentModelSnapshot(
  installedAgents: readonly InstalledAgent[],
  presetAgents: readonly InstalledAgent[],
  seedExecutions?: ReadonlyMap<string, SeedAgentExecution>,
  identityCompat?: IdentityCompatProjection,
): Map<string, string> {
  const autoModel = seedExecutions === undefined
    ? PLATFORM_DEFAULT_MODEL
    : seedExecutions.get("main")?.model;
  if (typeof autoModel !== "string" || autoModel.trim() === "" || autoModel === AGENT_MODEL_AUTO) {
    throw new SeedDeclarationError("SeedSchemaInvalid", "seed revision must declare a concrete main model");
  }
  const map = new Map<string, string>();
  for (const list of [installedAgents, presetAgents]) {
    for (const a of list) {
      const model = manifestModel(a.rawManifest, autoModel);
      if (model !== null) map.set(a.slug, model);
    }
  }
  const marketplaceModels = new Map(map);
  // 内置 seed(最高优先;容器侧 reserved id 同语义)。
  if (seedExecutions !== undefined) {
    for (const [agentId, exec] of seedExecutions) {
      map.set(agentId, exec.model);
    }
  } else {
    for (const [agentId, model] of LEGACY_SEED_AGENT_MODELS) map.set(agentId, model);
  }
  // An explicitly registered namespace is never a second local/seed override.
  for (const { profile, readiness } of identityCompat?.profiles ?? []) {
    map.delete(profile.legacyAgentId);
    if (readiness !== "ready") {
      map.delete(profile.canonicalAgentId);
    } else {
      const model = marketplaceModels.get(profile.canonicalAgentId);
      map.delete(profile.canonicalAgentId);
      if (model !== undefined) {
        map.set(profile.canonicalAgentId, model);
        map.set(profile.legacyAgentId, model);
      }
    }
  }
  return map;
}

/**
 * Marketplace readiness can contain a colliding unready slug, but seed Agents
 * retain execution precedence over marketplace content. Filter those IDs from
 * the deny projection using the same per-bundle seed authority as the model map.
 */
export function runtimeDeniedAgentIds(
  denied: ReadonlySet<string>,
  seedExecutions?: ReadonlyMap<string, SeedAgentExecution>,
): Set<string> {
  const seedIds =
    seedExecutions === undefined
      ? new Set(LEGACY_SEED_AGENT_MODELS.keys())
      : new Set(seedExecutions.keys());
  return new Set([...denied].filter((agentId) => !seedIds.has(agentId)));
}

/** loadAgentModelResolverForUser 的阶段 B 入参(bridge 在 ensureRunning 之后拿到 label 传入)。 */
export interface AgentModelResolverOptions {
  /** 容器 label `com.openclaude.runtime.bundle_rev`(12 hex)。flag 开启时必需,缺失即 fail-closed。 */
  bundleRev?: string | null;
  /** 平台稳定根(默认 DEFAULT_PLATFORM_ROOT);非标准布局 / 测试才传。 */
  platformRoot?: string;
  /** Boot-verified flavor. Never infer selfhost from a request or runtime channel. */
  flavor?: Flavor;
  /** Same boot proof used by the authenticated sync endpoint; required for registration. */
  flavorIdentity?: FlavorIdentity;
  /** Read-only dependency seams for isolated tests. */
  loadRuntimeSnapshot?: typeof loadMarketplaceRuntimeSnapshot;
  loadPresetSlugs?: typeof platformPresetAgentSlugs;
  /** 测试注入(默认 process.env)。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * Callable for the hot-path model lookup, with an attached fail-closed readiness
 * predicate. The predicate is optional only so older test/assembly injections that
 * predate capability readiness remain source-compatible; the production loader
 * always provides it.
 */
export type AgentModelResolver = ((agentId: string) => string | null) & {
  isRuntimeDenied?: (agentId: string) => boolean;
  /**
   * Invoke on EVERY new execution, before model precedence (including an explicit
   * model). Registered targets always read fresh readiness; never a display TTL.
   * The identity changes runner semantics only, never key/owner/hash/claim fields.
   */
  authorizeExecution?: (agentId: string) => Promise<{
    identity: IdentityCompatResolution;
    model: string | null;
  }>;
};

/**
 * bridge dep `loadAgentModelResolver` 的生产实现:拉一次 DB 快照(+ 阶段 B 的 seed 声明),
 * 返回 sync resolver closure。刷新语义由 bridge 侧 handle 承载(周期 + miss 补触发)。
 *
 * **fail-closed**:flag 开启但 bundleRev 缺失 / 该 rev 的 bundle 读不出 → 抛
 * SeedDeclarationError —— bridge 现有的 loadAgentModelResolver catch 会 close(1011),
 * 不静默放行(与 loadAllowedModelChecker 同语义)。
 */
export async function loadAgentModelResolverForUser(
  uid: bigint,
  opts?: AgentModelResolverOptions,
): Promise<AgentModelResolver> {
  // seed 声明**先于** DB 加载:rev 缺失/非法/bundle 坏 = 这条连接注定 fail-closed,不必再打 DB。
  // (rev 不可变 ⇒ LRU 命中时这里是纯内存查表,无额外延迟。)
  const seedExecutions = seedAuthorityByRevEnabled(opts?.env, opts?.flavor)
    ? await seedAgentModels(opts?.bundleRev, opts?.platformRoot)
    : undefined;
  const profiles = registeredIdentityCompatProfiles(opts?.flavorIdentity, uid);
  const loadRuntimeSnapshot = opts?.loadRuntimeSnapshot ?? loadMarketplaceRuntimeSnapshot;
  const loadPresetSlugs = opts?.loadPresetSlugs ?? platformPresetAgentSlugs;
  const presetSlugs = await loadPresetSlugs();
  // Preserve the existing non-registered path. Registered targets share the exact
  // read-only snapshot API with authenticated marketplace sync.
  const runtimeSnapshot = profiles.length > 0
    ? await loadRuntimeSnapshot(Number(uid), presetSlugs)
    : null;
  const agentSets = runtimeSnapshot?.agentSets ?? await listRuntimeReadyAgentSets(Number(uid), presetSlugs);
  let identityCompat: IdentityCompatProjection = runtimeSnapshot
    ? projectIdentityCompat(uid, profiles, runtimeSnapshot)
    : { schema: 1, userId: uid.toString(), profiles: [] };
  let snapshot = buildAgentModelSnapshot(agentSets.installed, agentSets.presets, seedExecutions, identityCompat);
  let denied = runtimeDeniedAgentIds(agentSets.denied, seedExecutions);
  const resolver = ((agentId: string) => snapshot.get(agentId) ?? null) as AgentModelResolver;
  resolver.isRuntimeDenied = (agentId: string) =>
    resolveIdentityCompat(agentId, identityCompat).status === "registered-unavailable" || denied.has(agentId);
  resolver.authorizeExecution = async (agentId) => {
    const known = resolveIdentityCompat(agentId, identityCompat);
    if (known.status === "no-registration") return { identity: known, model: resolver(agentId) };
    let fresh: Awaited<ReturnType<typeof loadMarketplaceRuntimeSnapshot>>;
    try {
      fresh = await loadRuntimeSnapshot(Number(uid), await loadPresetSlugs());
    } catch {
      throw new IdentityCompatError("COMPAT_AUTHORITY_UNAVAILABLE", "identity readiness authority unavailable");
    }
    const projection = projectIdentityCompat(uid, profiles, fresh);
    const identity = resolveIdentityCompat(agentId, projection);
    const models = buildAgentModelSnapshot(fresh.agentSets.installed, fresh.agentSets.presets, seedExecutions, projection);
    // Keep the synchronous lookup/denial projection aligned for the remaining
    // frame checks; an initially unready warm connection can recover safely.
    identityCompat = projection;
    snapshot = models;
    denied = runtimeDeniedAgentIds(fresh.agentSets.denied, seedExecutions);
    assertIdentityCompatReady(identity);
    const model = models.get(identity.executionAgentId) ?? null;
    if (model === null) throw new IdentityCompatError("COMPAT_NOT_READY", "registered agent model unavailable");
    return { identity, model };
  };
  return resolver;
}
