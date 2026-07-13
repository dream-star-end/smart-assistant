/**
 * seedDeclarationLoader —— master 按 **bundleRev** 读该 rev 的 platform seed 执行声明
 * (模型权威批次 §5 阶段 B)。
 *
 * ## 为什么按 rev 读,而不是读 master 自己的常量
 *
 * 阶段 A 之前,seed agent(main/codex/hidden-reviewer)的执行三元组在**两处硬编码**:容器
 * entrypoint 本地常量 + master platformDefaults/protocol 常量。滚动窗口里(新 bundle 已发、
 * 老容器还没回收)两边可以指向不同模型 —— master 按新常量计费、容器按旧 bundle 执行,
 * **计费分叉**。阶段 A 把权威下沉到 bundle 内的 platform-seed.yaml(schema v2);阶段 B 让
 * master 按容器 label 上的 `com.openclaude.runtime.bundle_rev` 读**该容器实际运行的那个 rev
 * 的声明** —— 新旧容器各按自己的 rev 计费,滚动窗口零分叉。
 *
 * ## 完整性(方案 R2-M11)
 *
 * bundle rev 是内容 digest,但"磁盘上那棵树还是不是该 digest 对应的内容"必须校验,否则
 * 篡改 bundle 内的 seed yaml 就能改计费模型。这里**直接复用** supervisor 侧的全量校验器
 * `resolvePlatformBundleMount`(digest == 目录名 / MANIFEST 逐文件 sha256 / 结构 schema /
 * 必需叶子 / root-owned / 无 symlink / containment),**不另造弱校验**。
 *
 * 校验结果 + 解析出的声明进 LRU 缓存:rev 不可变 ⇒ 缓存恒新鲜(无需 TTL / 失效通知)。
 * **失败不进负缓存**(瞬态 IO 故障不能被钉死),且每次失败 console.error 打 critical 前缀。
 *
 * ## 消费契约(fail-closed)
 *
 * 调用方(bridge / agentModelAuthority)拿不到声明 → **拒帧**,绝不回落到 master 常量:
 * 回落 = 又把双端硬编码请回来了。label 缺失/bundle 缺失在阶段 A 核验之后应当不可能出现,
 * 出现即异常(critical 告警 + 拒)。
 *
 * ## schema 校验器的单一权威
 *
 * `validatePlatformSeed` 的唯一实现在 `agent-sandbox/platform-runtime/entrypoint/platformBundle.ts`
 * (bundle 源文件,容器 entrypoint 也用它)。该文件**不进 commercial tsc 编译图**(在 agent-sandbox/
 * 而非 src/ 下,静态 import 会把它拉进编译图触发 rootDir 越界,历史 S12a MAJOR 2),故这里用
 * **非字面量 dynamic import**(tsc 视作 any;master 与测试都跑在 tsx 下,按 .ts 解析)—— 与
 * entrypointPlatform.test.ts 同款手法。
 *
 * 注意:读的是 **master 自己源码树里的校验器**,不是 bundle 里的那份 —— bundle 里的 .ts 绝不
 * 在 master 进程里执行(master 持 DB 凭据/签名私钥,不给 bundle 内容任何代码执行面)。语义上
 * 这也正确:master 只接受**它认识的 schema 版本**,bundle 带来未知 schemaVersion → fail-loud。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

// 直接从 platformBundle 取(而非 agent-sandbox/index):避免为读一份 yaml 把 v3supervisor/dockerode
// 整条依赖链拉进来 —— 校验器本身是零依赖 leaf。
import {
  DEFAULT_PLATFORM_ROOT,
  resolvePlatformBundleMount,
} from "../agent-sandbox/platformBundle.js";

/** seed agent 的执行三元组(= platform-seed.yaml schema v2 的声明面)。 */
export interface SeedAgentExecution {
  readonly model: string;
  readonly provider: string;
  /** 仅 codex-native 的 'app-server';缺省 = 默认 runner。 */
  readonly runnerKind?: string;
}

/** 某个 bundleRev 的 seed 声明(已通过 bundle 全量校验 + schema 校验)。 */
export interface SeedDeclaration {
  readonly bundleRev: string;
  /** bundle realpath(审计/日志用)。 */
  readonly resolvedPath: string;
  readonly schemaVersion: number;
  /** agentId → 执行三元组。 */
  readonly agents: ReadonlyMap<string, SeedAgentExecution>;
}

export type SeedDeclarationErrorCode =
  /** bundleRev 缺失 / 格式非法(非 12 hex)—— 调用方 fail-closed 拒帧。 */
  | "SeedRevInvalid"
  /** 该 rev 的 bundle 不存在 / 完整性校验失败(digest、MANIFEST、结构、权限)。 */
  | "SeedRevUnavailable"
  /** bundle 在,但 seed yaml 读不出 / schema 校验不过(未知版本、缺 model、provider 非法…)。 */
  | "SeedSchemaInvalid";

/** 结构化错误 —— 调用方按 code 分流(拒帧 / 告警 / 触发 recycle),禁止靠 message 判定。 */
export class SeedDeclarationError extends Error {
  readonly code: SeedDeclarationErrorCode;

  constructor(code: SeedDeclarationErrorCode, message: string) {
    super(message);
    this.name = "SeedDeclarationError";
    this.code = code;
  }
}

/** bundleRev 严格形态(内容 digest 前 12 hex;与 supervisor label / current symlink 契约同源)。 */
export const SEED_BUNDLE_REV_RE = /^[0-9a-f]{12}$/;

/** LRU 上限:滚动窗口里同时在跑的 rev 一般 ≤2(旧+新),留足余量给回滚/多次热更。 */
const SEED_DECL_CACHE_MAX = 8;

/** key = `${platformRoot}\0${bundleRev}`(同一 rev 在不同根下是不同物理树,不共享缓存)。 */
const cache = new Map<string, SeedDeclaration>();

/** 仅供测试:清空 LRU(rev 不可变 ⇒ 生产无失效需求,故不导出通用 invalidate)。 */
export function __resetSeedDeclarationCacheForTests(): void {
  cache.clear();
}

function cacheGet(key: string): SeedDeclaration | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  // LRU:命中即刷新最近使用位置(Map 保序)。
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cachePut(key: string, value: SeedDeclaration): void {
  cache.set(key, value);
  while (cache.size > SEED_DECL_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** critical 日志(部署态失控信号:容器在跑某个 rev,master 却读不出它的声明 → 计费拒帧)。 */
function logCritical(code: SeedDeclarationErrorCode, message: string): void {
  console.error(`[seed-declaration] critical ${code}: ${message}`);
}

// ── schema 校验器(单一权威,非字面量 dynamic import;见文件头)────────────────────
type ValidatePlatformSeedFn = (parsed: unknown) => {
  schemaVersion: number;
  agents: { id: string; model: string; provider: string; runnerKind?: string }[];
};

const VALIDATOR_MODULE_PATH = fileURLToPath(
  new URL("../../agent-sandbox/platform-runtime/entrypoint/platformBundle.ts", import.meta.url),
);

let validatorPromise: Promise<ValidatePlatformSeedFn> | null = null;

async function loadValidator(): Promise<ValidatePlatformSeedFn> {
  if (validatorPromise === null) {
    validatorPromise = (async () => {
      // 非字面量路径 → tsc 不解析(any);tsx 运行时按 .ts 载入。
      const mod: unknown = await import(VALIDATOR_MODULE_PATH);
      const fn = (mod as { validatePlatformSeed?: unknown }).validatePlatformSeed;
      if (typeof fn !== "function") {
        throw new Error(`validatePlatformSeed not exported by ${VALIDATOR_MODULE_PATH}`);
      }
      return fn as ValidatePlatformSeedFn;
    })();
    // 加载失败不钉死(与"失败不负缓存"同精神):下次调用重试。
    validatorPromise.catch(() => {
      validatorPromise = null;
    });
  }
  return validatorPromise;
}

/**
 * 读并校验某个 bundleRev 的 seed 声明。命中 LRU 直接返回(rev 不可变 ⇒ 恒新鲜)。
 *
 * 失败一律抛 SeedDeclarationError(带 code)+ console.error critical;**成功才缓存**。
 *
 * @param platformRoot 平台稳定根(默认 DEFAULT_PLATFORM_ROOT;bundle 落 `<root>/bundles/<rev>`)
 * @param bundleRev    容器 label `com.openclaude.runtime.bundle_rev` 的值(12 hex)
 */
export async function loadSeedDeclaration(
  platformRoot: string | undefined,
  bundleRev: string | null | undefined,
): Promise<SeedDeclaration> {
  const root = platformRoot ?? DEFAULT_PLATFORM_ROOT;
  if (typeof bundleRev !== "string" || !SEED_BUNDLE_REV_RE.test(bundleRev)) {
    const msg = `bundleRev ${JSON.stringify(bundleRev)} is missing or malformed (want /^[0-9a-f]{12}$/)`;
    logCritical("SeedRevInvalid", msg);
    throw new SeedDeclarationError("SeedRevInvalid", msg);
  }

  const key = `${root}\u0000${bundleRev}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  // 1) bundle 完整性:复用 supervisor 全量校验器(digest==目录名 / MANIFEST sha256 / 结构 / 权限)。
  const bundlePath = join(root, "bundles", bundleRev);
  let resolvedPath: string;
  try {
    const resolved = resolvePlatformBundleMount(bundlePath, {
      ancestorRoot: root,
      platformRoot: root,
    });
    if (resolved.bundleRev !== bundleRev) {
      // 理论不可达(校验器已断言目录名 == digest),留作纵深。
      throw new Error(`resolved bundleRev ${resolved.bundleRev} != requested ${bundleRev}`);
    }
    resolvedPath = resolved.resolvedPath;
  } catch (err) {
    const msg = `bundle for rev ${bundleRev} unusable: ${(err as Error).message}`;
    logCritical("SeedRevUnavailable", msg);
    throw new SeedDeclarationError("SeedRevUnavailable", msg);
  }

  // 2) seed 声明:读 + schema 校验(master 自己的校验器,未知 schemaVersion fail-loud)。
  let decl: SeedDeclaration;
  try {
    const validate = await loadValidator();
    const raw = readFileSync(join(resolvedPath, "seed", "platform-seed.yaml"), "utf8");
    const doc = validate(parseYaml(raw));
    const agents = new Map<string, SeedAgentExecution>();
    for (const a of doc.agents) {
      // 校验器已保证形态;这里只做一次防御性收窄(dynamic import 的返回是 any 面)。
      if (typeof a.id !== "string" || typeof a.model !== "string" || typeof a.provider !== "string") {
        throw new Error(`agent declaration malformed: ${JSON.stringify(a)}`);
      }
      agents.set(a.id, {
        model: a.model,
        provider: a.provider,
        ...(a.runnerKind !== undefined ? { runnerKind: a.runnerKind } : {}),
      });
    }
    decl = { bundleRev, resolvedPath, schemaVersion: doc.schemaVersion, agents };
  } catch (err) {
    const msg = `seed declaration of rev ${bundleRev} invalid: ${(err as Error).message}`;
    logCritical("SeedSchemaInvalid", msg);
    throw new SeedDeclarationError("SeedSchemaInvalid", msg);
  }

  cachePut(key, decl);
  return decl;
}

/**
 * agentId → 执行三元组(bridge/agentModelAuthority 的消费口)。
 * 失败抛 SeedDeclarationError(调用方 fail-closed 拒帧,不回落 master 常量)。
 */
export async function seedAgentModels(
  bundleRev: string | null | undefined,
  platformRoot?: string,
): Promise<ReadonlyMap<string, SeedAgentExecution>> {
  const decl = await loadSeedDeclaration(platformRoot, bundleRev);
  return decl.agents;
}
