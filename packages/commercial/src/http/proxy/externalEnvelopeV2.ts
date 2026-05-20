/**
 * V3 envv2 Phase 3(2026-05-21)— v2 normalizer 纯函数。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_ENVV2_PLAN_2026-05-21.md §Phase 3。
 *
 * ## 与 v1 (externalEnvelope.ts) 的区别
 *
 * v1 只做 §3.5.2 "outbound CC 形态归一化"(L0 prefix 注入,防 UA-gate-bypass 时 body
 * 形态混杂被反风控聚类)。v2 在此之上**强制** L0 身份指纹锚定 + L1/L2/L3 漂移分层:
 *
 *   - L0 (服务端强锁,跨机器跨项目跨 turn 必相同):
 *       (a) sysprompt prefix **永远在 system[0]**(L0 slot 强锁)。客户端若已送
 *           CC 三变体之一的 prefix,字面保留(保留 variant 信息);若送在非 0 位置
 *           — 移动到 system[0](客户端 preamble 被推到 prefix 之后);若没送 —
 *           注入 default prefix。Anthropic 看到的 system[0] 字面始终是 CC variant。
 *       (b) `<external-api-account fingerprint="<sha256-12>" />` **永远在 system[1]**
 *           (L0 slot 强锁),走 ephemeral cache_control 防污染上游 prefix cache key。
 *       fingerprint = `SHA256(salt || account.id).hex.slice(0,12)`,salt 是
 *       `claude_accounts.fingerprint_salt`(0072 migration),admin 不可见。
 *
 *       这一条**与 v1 行为不同**:v1 检测到 prefix 在任意位置就 skip,把 L0 形态控制
 *       权交给客户端(因 v1 只防 UA-gate-bypass,无 L0 强锁需求);v2 必须锁住 slot,
 *       否则同 account 跨机器场景下 Anthropic 看到的 system[0] 字面会漂(违反 I2)。
 *       — Codex Phase 3 code-review FAIL 锁版。
 *
 *   - L1 (服务端建议,可被客户端覆盖,允许 "同人换机器" 漂移):
 *       `metadata.user_id` 是 CCB JSON-stringify 的 `{device_id, account_uuid, ...}`。
 *       本 phase 只做 **framework**:解析 user_id;若是 plain object,strip 客户端
 *       塞的 `fingerprint` 字段(I5 防伪造);把 stripped 结果 stringify 写回。
 *       客户端发的 device_id/session_id/os_arch/cpu_count 等 L1/L2/L3 字段**保留**,
 *       不在本 phase 做派生注入(Codex Phase 3 plan-review FAIL 建议:派生 4 字段牵
 *       涉的随机源 / 编码格式 / device_id 与 applyUpstreamAuth.pinned_user_id 的
 *       优先级 / 客户端送了 vs 没送的边界,展开后逻辑量翻倍,Phase 3 范围内本不该挤;
 *       framework + strip 已经把 v2 主路径打通,派生留 Phase 4 灰度时单开 PR)。
 *
 *   - L2 (透传,可空):`git_remote_hash` / `cwd_basename_hash` — 不动。
 *   - L3 (透传,turn 级):`session_id` / `turn_counter` / timestamp — 不动。
 *
 * ## Idempotency (invariant I5)
 *
 * 跑两次 = 跑一次,且**不让客户端伪造 attribution**:
 *   - L0 attribution 用 **strip-then-inject** 模式:每次入口先删除所有 plain-object
 *     text block 中 `startsWith("<external-api-account fingerprint=")` 的项(无论值
 *     是客户端伪造还是上一次本函数注入),再插入服务端重算的版本到 system[1]。
 *     客户端 spoof 失败。
 *   - L0 prefix slot lock 保证 re-entry 时 system[0] 不重复堆叠:第二次进入时,
 *     system[0] 已是上次注入的 prefix,detectCcPrefix 命中 → foundPrefixIdx=0 → 不动。
 *   - L1 fingerprint 字段 strip 同样无脑删,本函数从不写入 L1 fingerprint(L1 字段
 *     全部漂移层,L0 才是身份锚)。
 *
 * ## 调用契约(本 phase 不接路由 — Phase 4 才接)
 *
 * - 调用方:**Phase 3 deploy 后无生产调用方**,所有外接 ApiKey 流量仍走 v1
 *   (`normalizeExternalApiKeyEnvelope`)。Phase 4 才在 handler 按 account 的
 *   `envelope_version` 派发到 v1 / v2。
 * - 副作用:原地 mutate `body.system` 与 `body.metadata.user_id`。
 * - 返回值:`void`。
 *
 * ## Phase 3 不变量(测试覆盖)
 *
 *   I1 同 account + 同 body → 两次 outbound byte-identical
 *   I2 同 account + 3 个不同 body → L0 (prefix + attribution) 字节相同
 *   I3 不同 account → attribution fingerprint 不同
 *   I5 客户端塞 attribution(伪造)→ 被 strip,服务端版本生效
 *   I5b 客户端塞 metadata.user_id.fingerprint(伪造)→ 被 strip
 *   I6 同 account.salt → fingerprint 字节相同
 */

import { createHash } from "node:crypto";

import type { Logger } from "../../logging/logger.js";
import type { ProxyBody } from "./shared.js";
import {
  EnvelopePrefixCacheNotReadyError,
  type PrefixSource,
} from "./externalEnvelope.js";
import {
  getPrefixTemplateCache,
  type PrefixTemplateCache,
  type PrefixVariant,
  PREFIX_VARIANTS,
} from "../../envelope/prefixTemplateCache.js";

/**
 * Phase 3 不引入 module-level testing override:v1 那个 override 是为
 * `ccExternalEndpoint.integ.test.ts` 走完整 handler 链路时无法从 caller 注入而设。
 * v2 在 Phase 3 不接 handler,所有测试都从 caller 直接传 `prefixSource`,因此无需
 * 引入第二套 module 状态。
 */

/**
 * v2 normalizer 需要的 account 上下文,由 caller (Phase 4 handler) 从 scheduler
 * 选号结果 + 数据库行带入。Phase 3 测试直接构造此 struct。
 *
 *   - `id`              `claude_accounts.id`(uuid 字符串)
 *   - `pinned_user_id`  `claude_accounts.pinned_user_id`(0067 加,64 hex)— 本 phase
 *                       **不**用(L1 派生留 Phase 4),保留字段是为 Phase 4 派发时
 *                       签名兼容
 *   - `fingerprint_salt` `claude_accounts.fingerprint_salt`(0072 加,16 byte BYTEA)
 */
export interface V2AccountContext {
  readonly id: string;
  readonly pinned_user_id: string | null;
  readonly fingerprint_salt: Buffer;
}

/**
 * 默认 prefix 取源:与 v1 同型,走 singleton cache;未 bootstrap → null-only stub
 * (snapshotPrefixes 会显式抛 EnvelopePrefixCacheNotReadyError)。
 */
function defaultPrefixSource(): PrefixSource {
  const cache: PrefixTemplateCache | null = getPrefixTemplateCache();
  if (cache === null) return { get: () => null };
  return { get: (v) => cache.get(v) };
}

/**
 * 与 v1 `snapshotPrefixes` 同语义:一次性读 3 个 active prefix,任一 null → 抛错。
 * 内联在本文件而非复用 v1 export,是为了让 v2 与 v1 之间没有运行时耦合
 * (v1 那个函数没 export,且未来 v1 删除时本文件不依赖)。3 行 for-loop 重复 < 抽公共。
 */
function snapshotPrefixes(src: PrefixSource): readonly string[] {
  const out: string[] = [];
  for (const v of PREFIX_VARIANTS) {
    const text = src.get(v);
    if (text === null) {
      throw new EnvelopePrefixCacheNotReadyError(v);
    }
    out.push(text);
  }
  return out;
}

/**
 * 与 v1 `detectCcPrefix` 同语义。返回命中 PREFIX_VARIANTS 数组中的索引或 -1。
 */
function detectCcPrefix(block: unknown, prefixes: readonly string[]): number {
  if (
    !block ||
    typeof block !== "object" ||
    (block as { type?: unknown }).type !== "text"
  ) {
    return -1;
  }
  const text = (block as { text?: unknown }).text;
  if (typeof text !== "string") return -1;
  for (let i = 0; i < prefixes.length; i++) {
    if (text.startsWith(prefixes[i]!)) return i;
  }
  return -1;
}

/**
 * 判某 block 是否为"客户端塞的 attribution"(spoof prevention I5)。
 *
 * 检测条件**严格**:plain object + type:"text" + text:string + 起始于
 * `<external-api-account fingerprint="`。绝不基于 cache_control / 其它字段判断,
 * 客户端伪造时也可能带 ephemeral cache_control(无法区分),所以只看文本前缀。
 *
 * 同样不命中 `<external-api-account>` 但不带 `fingerprint=` 的形态:本 phase 只
 * 锁 fingerprint 这一个属性,未来若加 attribution 其它属性(如 region / tier),
 * 形态会变成 `<external-api-account fingerprint="..." region="..."/>` —
 * startsWith 前缀仍可匹配,无需再改。
 */
const ATTRIBUTION_PREFIX = '<external-api-account fingerprint="';

function isAttributionBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  if ((block as { type?: unknown }).type !== "text") return false;
  const text = (block as { text?: unknown }).text;
  if (typeof text !== "string") return false;
  return text.startsWith(ATTRIBUTION_PREFIX);
}

/**
 * 计算 account-level fingerprint:`SHA256(salt || account.id).hex.slice(0, 12)`。
 *
 * 12 hex char = 48 bit:
 *   - 碰撞域 2^48 ≈ 2.8e14,对外接 ApiKey account 量(预计 < 1e5)远小于生日攻击
 *     阈值 √(2^48) ≈ 1.7e7,实用安全。
 *   - 上游 Anthropic 看到的 attribution token 是 48-bit hex,信息量足以聚类但不
 *     直接暴露 account.id / salt。
 *
 * salt || id 的 byte order 必须固定 — 任何顺序漂移都会让同 account 跨 deploy 算出
 * 不同 fingerprint(违反 I6)。这里固定 salt-first(16 byte) || id-utf8。
 */
function computeFingerprint(salt: Buffer, accountId: string): string {
  const idBuf = Buffer.from(accountId, "utf8");
  return createHash("sha256")
    .update(Buffer.concat([salt, idBuf]))
    .digest("hex")
    .slice(0, 12);
}

/**
 * L0 attribution block 构造。本函数是 v2 唯一权威源(prevent forge):
 * 客户端送的同形态 block 由 normalize 入口 strip 掉,服务端再注入这个版本。
 */
function buildAttributionBlock(fingerprint: string): {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
} {
  return {
    type: "text",
    text: `<external-api-account fingerprint="${fingerprint}" />`,
    cache_control: { type: "ephemeral" },
  };
}

/**
 * L1 派生字段:服务端建议的 4 个客户端指纹字段,客户端**已显式提供同名字段**时
 * 保留客户端值(allows "同人换机器" 漂移),未提供时 fill 服务端派生默认。
 *
 * 4 字段选择依据(对齐真实 CCB 用户分布,见 boss "一个 ApiKey 在 3 台机器跑还像
 * 真人吗" 验收标准):
 *   - `os_arch`         机器架构    2 候选 — CCB 用户里 arm64 / x64 各半
 *   - `cpu_count`       CPU 核数    4 候选 — 8 / 12 / 16 / 32(常见 dev/server 规格)
 *   - `node_version`    Node 版本   3 候选 — v20.18 / v22.10 / v24.0(LTS + 当前)
 *   - `hostname_prefix` 主机名前缀  3 候选 — 真人开发者命名习惯
 *
 * 不变量(同 L0 fingerprint):同 account → 同派生值;跨 account → 派生独立(不可
 * 关联,salt 隔离)。客户端覆盖优先(L1 漂移层语义)。
 *
 * 决策依据(Codex Phase 4 plan-review):2 候选的 os_arch 会让同 salt 不同 account
 * 有 50% 概率撞 arch — 但 L0 fingerprint 是身份锚,L1 撞了不破不变量,只是 L1 帮
 * 不上忙(同源信号被淹没,但 L0 不淹)。
 */
interface L1Defaults {
  os_arch: string;
  cpu_count: number;
  node_version: string;
  hostname_prefix: string;
}

const L1_OS_ARCH = ["arm64", "x64"] as const;
const L1_CPU_COUNT = [8, 12, 16, 32] as const;
const L1_NODE_VERSION = ["v20.18.0", "v22.10.0", "v24.0.0"] as const;
const L1_HOSTNAME_PREFIX = ["mac-", "ubuntu-", "dev-"] as const;

/**
 * Deterministic PRNG:`sha256(salt || account.id || field).readUInt32BE(0) % N`。
 *
 * - salt-first byte order 与 `computeFingerprint` 一致(I6 跨 deploy 稳定)
 * - field 名拼进 hash 输入,4 个字段间 PRNG 独立(否则同账号 4 字段会强相关)
 * - readUInt32BE 取前 32 bit:N ≤ 4 时,模偏差远小于 1 / N 的可观测阈值(2^32 / 4 = 1.07e9)
 */
function deriveL1Field(
  salt: Buffer,
  accountId: string,
  field: string,
  choices: readonly (string | number)[],
): string | number {
  const idBuf = Buffer.from(accountId, "utf8");
  const fieldBuf = Buffer.from(field, "utf8");
  const h = createHash("sha256")
    .update(Buffer.concat([salt, idBuf, fieldBuf]))
    .digest();
  const idx = h.readUInt32BE(0) % choices.length;
  return choices[idx]!;
}

function deriveL1Defaults(salt: Buffer, accountId: string): L1Defaults {
  return {
    os_arch: deriveL1Field(salt, accountId, "os_arch", L1_OS_ARCH) as string,
    cpu_count: deriveL1Field(salt, accountId, "cpu_count", L1_CPU_COUNT) as number,
    node_version: deriveL1Field(
      salt,
      accountId,
      "node_version",
      L1_NODE_VERSION,
    ) as string,
    hostname_prefix: deriveL1Field(
      salt,
      accountId,
      "hostname_prefix",
      L1_HOSTNAME_PREFIX,
    ) as string,
  };
}

/**
 * L1 框架 + 派生(Phase 4)。处理 `metadata.user_id` JSON:
 *
 *   - strip 客户端塞的 `fingerprint` 字段(spoof prevention I5b — L0 才是身份锚,
 *     L1 fingerprint 不接受客户端塞)
 *   - 4 个 L1 派生字段:客户端**已显式提供同名 key** 时保留客户端值(漂移层语义);
 *     缺字段时 fill 服务端派生默认
 *
 * 输入处理分支(Codex Phase 4 plan-review #4 采纳:malformed 不再 return unchanged):
 *   - `metadata` undefined → 创建 `metadata = { user_id: stringified-derived-L1 }`
 *   - `metadata.user_id` undefined / 空串 → 创建 `{ ...派生 }` stringify 写入
 *   - `metadata.user_id` 非 JSON 字符串 → log warn + 用 `{ ...派生 }` **覆盖**
 *     (老的非 JSON 字符串数据会丢 — 这是有意行为:既然不是 JSON 形态,在 outbound
 *     CC 形态下也无法被上游正确解析,代为补成合法 CC 形态)
 *   - `metadata.user_id` parse 出非 object(primitive / array)→ log warn +
 *     `{ ...派生 }` 覆盖(同上)
 *   - `metadata.user_id` parse 出 plain object → strip fingerprint + 4 字段缺位
 *     才 fill 派生 + stringify 写回(客户端字段全部保留)
 *
 * 返回结构化日志元信息(仅 boolean 标志,不含敏感值)。
 */
interface L1ApplyResult {
  stripped_client_fingerprint: boolean;
  derived_os_arch: boolean;
  derived_cpu_count: boolean;
  derived_node_version: boolean;
  derived_hostname_prefix: boolean;
  /** malformed 路径触发,需要 caller log warn 而非 info */
  malformed_user_id: boolean;
}

function applyL1Defaults(
  body: ProxyBody,
  salt: Buffer,
  accountId: string,
): L1ApplyResult {
  const defaults = deriveL1Defaults(salt, accountId);
  const result: L1ApplyResult = {
    stripped_client_fingerprint: false,
    derived_os_arch: false,
    derived_cpu_count: false,
    derived_node_version: false,
    derived_hostname_prefix: false,
    malformed_user_id: false,
  };

  // 兜底创建 metadata(ProxyBody.metadata?: { user_id?, session_id? })
  if (!body.metadata) {
    body.metadata = {};
  }
  const md = body.metadata;

  const userId = md.user_id;
  let obj: Record<string, unknown>;

  if (typeof userId !== "string" || userId.length === 0) {
    // 缺字段 → fresh
    obj = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(userId);
    } catch {
      result.malformed_user_id = true;
      parsed = null; // 走 fresh path
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      obj = parsed as Record<string, unknown>;
    } else {
      if (!result.malformed_user_id) {
        // parse 成功但非 object(primitive / array)
        result.malformed_user_id = true;
      }
      obj = {};
    }
  }

  // strip 客户端伪造的 fingerprint(I5b)
  if (Object.prototype.hasOwnProperty.call(obj, "fingerprint")) {
    delete obj.fingerprint;
    result.stripped_client_fingerprint = true;
  }

  // 4 字段 fill-if-missing(客户端已提供则保留 = L1 漂移层语义)
  if (!Object.prototype.hasOwnProperty.call(obj, "os_arch")) {
    obj.os_arch = defaults.os_arch;
    result.derived_os_arch = true;
  }
  if (!Object.prototype.hasOwnProperty.call(obj, "cpu_count")) {
    obj.cpu_count = defaults.cpu_count;
    result.derived_cpu_count = true;
  }
  if (!Object.prototype.hasOwnProperty.call(obj, "node_version")) {
    obj.node_version = defaults.node_version;
    result.derived_node_version = true;
  }
  if (!Object.prototype.hasOwnProperty.call(obj, "hostname_prefix")) {
    obj.hostname_prefix = defaults.hostname_prefix;
    result.derived_hostname_prefix = true;
  }

  md.user_id = JSON.stringify(obj);
  return result;
}

/**
 * v2 主入口。
 *
 * @throws EnvelopePrefixCacheNotReadyError cache 未 bootstrap / variant 行缺失。
 */
export function normalizeExternalApiKeyEnvelopeV2(
  body: ProxyBody,
  account: V2AccountContext,
  log: Logger,
  prefixSource?: PrefixSource,
): void {
  const src = prefixSource ?? defaultPrefixSource();
  const prefixes = snapshotPrefixes(src);
  // PREFIX_VARIANTS[0] === "default"
  const defaultPrefix = prefixes[0]!;

  // ─── L0 (a) sysprompt prefix at system[0] — 与 v1 同语义 ───────────────────
  let systemArr: unknown[];
  const original = body.system;
  let origKind: "undefined" | "string" | "array";
  if (original === undefined) {
    systemArr = [];
    origKind = "undefined";
  } else if (typeof original === "string") {
    systemArr = [{ type: "text", text: original }];
    origKind = "string";
  } else {
    // schema 已保证 array;复制一份,后续 strip / insert 都在副本上做,避免 mutate
    // 客户端原 array(v1 那条路径里 prepend 也是 new array,不破坏调用方期望)
    systemArr = [...original];
    origKind = "array";
  }

  // 先 strip 所有 attribution(无论位置 / 来源 — 客户端伪造 I5 + idempotent re-entry)
  // 必须在 prefix 锚定之前做:strip 影响下面"prefix 在 array 中的位置"判断。
  // 倒序 splice 保下标稳定。
  let strippedAttribution = 0;
  for (let i = systemArr.length - 1; i >= 0; i--) {
    if (isAttributionBlock(systemArr[i])) {
      systemArr.splice(i, 1);
      strippedAttribution++;
    }
  }

  // L0 强锁(plan §3.1):**prefix 永远在 system[0]**,与客户端怎么排无关。
  // Codex Phase 3 code-review FAIL 锁版:之前实现"prefix 在任意位置即 skip"
  // (复用 v1 detect-anywhere 语义),让 attribution 跟着 prefix 的位置漂,
  // 等价于把 L0 形态控制权交给客户端 — 违反"L0 跨机器跨项目必同形态"不变量。
  //
  // 规则:
  //   1. 找到第一个 CC prefix block(任意位置)— 客户端的 prefix variant 保留意义
  //      (DEFAULT vs AGENT_SDK vs PRESET — 三种都是 CC,Anthropic 那侧看到任一都
  //       视作"CC client"),所以**保留**客户端 variant 字面,只锁位置。
  //   2. 若找到且不在 index 0:从原位置 splice 出来,unshift 到 system[0]
  //      (相对顺序变化:客户端塞在 prefix 之前的 preamble 被推到 prefix 后面 —
  //      可接受,反风控视角下 L0 必须形态固定;客户端 preamble 在哪不重要)。
  //   3. 找不到:unshift 一个新建的 default prefix 到 system[0]。
  //   4. 此时 system[0] 一定是 CC prefix,prefixVariant 同步标定。
  //
  // **不**额外 strip 第二个 prefix block —— 检测条件已经够窄(startsWith CC 三变体
  // 之一),客户端 system 中段碰巧塞第二个 CC prefix 字面这种 case 实际不会发生;
  // 若真发生(测试 / 反风控视角),Anthropic 看到的是"system[0] CC prefix + 后面
  // 还有 CC prefix"— 仍属合法 CC shape,与"L0 锁住第 0 位"不冲突。
  let prefixVariant = -1;
  let foundPrefixIdx = -1;
  for (let i = 0; i < systemArr.length; i++) {
    const v = detectCcPrefix(systemArr[i], prefixes);
    if (v >= 0) {
      prefixVariant = v;
      foundPrefixIdx = i;
      break;
    }
  }
  if (foundPrefixIdx > 0) {
    // 移动到 index 0(保留客户端的 prefix 字面 + variant)
    const [moved] = systemArr.splice(foundPrefixIdx, 1);
    systemArr.unshift(moved);
  } else if (foundPrefixIdx < 0) {
    // 注入服务端 default
    systemArr.unshift({
      type: "text" as const,
      text: defaultPrefix,
      cache_control: { type: "ephemeral" as const },
    });
    prefixVariant = 0;
  }
  // foundPrefixIdx === 0: 已在正确位置,不动

  // ─── L0 (b) attribution at system[1] — strict slot ────────────────────────
  // L0 强锁:attribution 永远在 system[1],紧跟 prefix。
  const fingerprint = computeFingerprint(account.fingerprint_salt, account.id);
  systemArr.splice(1, 0, buildAttributionBlock(fingerprint));

  body.system = systemArr as ProxyBody["system"];

  // ─── L1 framework + 派生 4 字段(Phase 4)─────────────────────────────────
  const l1 = applyL1Defaults(body, account.fingerprint_salt, account.id);

  // ─── L2 / L3 透传 — 本 phase 无操作 ─────────────────────────────────────────

  // 日志:仅结构指纹,绝不记 prompt 内容 / metadata 内容
  const logFields = {
    blocks: (body.system as unknown[]).length,
    orig_kind: origKind,
    prefix_variant: prefixVariant,
    fingerprint_b12: fingerprint,
    stripped_attribution: strippedAttribution,
    attribution_replaced: strippedAttribution > 0,
    stripped_l1_fingerprint: l1.stripped_client_fingerprint,
    derived_os_arch: l1.derived_os_arch,
    derived_cpu_count: l1.derived_cpu_count,
    derived_node_version: l1.derived_node_version,
    derived_hostname_prefix: l1.derived_hostname_prefix,
    has_pinned_user_id: account.pinned_user_id !== null,
  };
  if (l1.malformed_user_id) {
    // Codex Phase 4 plan-review #4:malformed metadata.user_id 不再 silent fail-open;
    // log warn 让运维侧看到客户端发的脏数据流量。
    log.warn("external_envelope_v2_l1_malformed_user_id", logFields);
  } else {
    log.info("external_envelope_v2_applied", logFields);
  }
}
