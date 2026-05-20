/**
 * V3 CC 外接 plan Phase 7(2026-05-20)— 出站 envelope 归一化。
 * V3 envv2 Phase 2(2026-05-21)— 3 个 CC sysprompt prefix 从 in-code 硬编码迁到
 * DB(envelope_prefix_templates 表 + PrefixTemplateCache LISTEN/NOTIFY)。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_PLAN_2026-05-18.md §3.5.2 / §4 invariant #11 / §7 Phase 7,
 *    docs/V3_CC_EXTERNAL_ENDPOINT_ENVV2_PLAN_2026-05-21.md §Phase 2。
 *
 * ## 解决什么
 *
 * §3.5 的 UA gate(`auth/apiKeyIdentity.ts:resolve()` 顶部 `^claude-cli/` 前缀检查)是
 * **入站** header 防误用,客户端一行 `curl -A claude-cli/x.y.z` 即可伪造。
 *
 * 一旦 UA gate 被绕过(或未来放宽),非 CC 形态的 body 会带着合法 `oc-cc.*` key 直达
 * 上游 OAuth pool。2026-05-19 实测:Anthropic anti-abuse 反风控会在 `claude_accounts`
 * 维度看到"同一 account_uuid 既发 CC-shaped 又发 curl-shaped 请求",**整池被标 + 429
 * 蔓延全平台**(无 CC sysprompt prefix 的 body 直接 429,有则 200)。
 *
 * 本 helper 在外接 ApiKey 路径上**强制**把 outbound body 归一化成 CC 容器形态,任何
 * 客户端送什么 shape 都不重要,上游 Anthropic 看到的请求与容器内 CC CLI 发出的请求
 * 形态一致 — 上游无法靠"形态混杂"做反向风控识别。
 *
 * ## 与既有反风控层的关系
 *
 *   入站  §3.5  UA gate    — `auth/apiKeyIdentity.ts:resolve()` 顶,header prefix 检查
 *   出站  §3.5.2 本 helper  — handler 调,outbound body 强制 CC 形态(本文件)
 *   出站  既有 device_id pin — `upstream.ts:makeOAuthPoolUpstream.applyUpstreamAuth`,
 *                              `metadata.user_id` 中 device_id 锚定到 account 的
 *                              `pinned_user_id`(防 account 维度的 device_id 漂移)
 *
 * 三层互不重叠:UA 是 client claim,sysprompt 是 prompt 形态,device_id 是 metadata
 * identity。任一被绕都不会破坏另外两层。
 *
 * ## 调用契约
 *
 * - 调用方:`http/proxy/index.ts` handler,**仅** `identity.containerId === null
 *   && route.kind === "oauth"` 双重命中时调用。容器路径(`containerId !== null`)
 *   绝不调用 — 否则容器内 CCB 已构造好的 body 被多余 mutate,破坏既有缓存命中;
 *   DeepSeek 路径(`route.kind === "deepseek"`)亦绝不调用 — 用独立 API key、无
 *   OAuth pool、注入 CC prefix 只浪费 token + 是对 deepseek 模型的"语义无关 prompt
 *   污染"。
 * - 调用时机:**在 `estimateInputTokens(body)` 之前 + `selectUpstreamRoute` 之后**
 *   (Codex Phase 7 plan-review MINOR 采纳)。注入的 sysprompt prefix(~13 tokens)
 *   必须计入 preCheck 估算,保持"任何 mutate body 的步骤都在 input token 估算之前"
 *   的账务边界。
 * - 副作用:原地 mutate `body.system`;**不**触碰 `body.metadata`(metadata 由
 *   `applyUpstreamAuth` 后续阶段处理,职责分明)。
 * - 返回值:`void`。
 *
 * ## Idempotency
 *
 * 任何 body 跑两次本函数 = 跑一次。已含 CC sysprompt prefix 的 body(string / array
 * 形态均可)被检测到后直接 skip,不重复 prepend。具体见 invariant #11 测试。
 *
 * ## Phase 2 — Prefix 模板源
 *
 * 三个 CC sysprompt prefix 字面**不再硬编码**,运行时从 PrefixTemplateCache 读。
 * 调用方传 `prefixSource`(测试注入用)或不传(走 module singleton getPrefixTemplateCache())。
 * Cache 未 bootstrap / 任一 variant 行被误删 → 抛 EnvelopePrefixCacheNotReadyError,
 * **fail-closed**(handler 应吃到 500 而不是 fallback 到 in-code default,避免单一权威源漂移)。
 */

import type { Logger } from "../../logging/logger.js";
import type { ProxyBody } from "./shared.js";
import {
  getPrefixTemplateCache,
  type PrefixTemplateCache,
  type PrefixVariant,
  PREFIX_VARIANTS,
} from "../../envelope/prefixTemplateCache.js";

/**
 * Prefix 取源接口。生产路径默认走 module singleton;测试可注入 stub 避免触碰
 * singleton 状态(测试间泄漏)。返回 null 等同 cache 未 ready / 行不存在,
 * 由本 helper 抛 EnvelopePrefixCacheNotReadyError。
 */
export interface PrefixSource {
  get(variant: PrefixVariant): string | null;
}

export class EnvelopePrefixCacheNotReadyError extends Error {
  readonly variant: PrefixVariant | "any";
  constructor(variant: PrefixVariant | "any") {
    super(`envelope prefix template cache not ready: ${variant}`);
    this.name = "EnvelopePrefixCacheNotReadyError";
    this.variant = variant;
  }
}

/**
 * 测试 hook:在不能 bootstrap singleton cache 的场景(integ harness 用 FakePool 而非
 * 真 DB)允许注入一个**模块级** override。生产路径不应触碰此 hook。
 *
 * **正常注入**应走 normalizeExternalApiKeyEnvelope 第 3 参 `prefixSource`(unit 测试);
 * 这里这个 module-level override 只为 `ccExternalEndpoint.integ.test.ts` 走完整
 * createCommercialHandler 链路时,无法从 caller 注入到 helper 的兜底口子。
 *
 * 必须在每个测试 setup 显式 reset(_resetTestingOverride),否则跨 test 泄漏。
 */
let testingDefaultOverride: PrefixSource | null = null;
export function _setExternalEnvelopeDefaultSourceForTesting(src: PrefixSource | null): void {
  testingDefaultOverride = src;
}

/** 默认 prefix 取源:测试 override 优先,再走 singleton cache;未 bootstrap → null-only stub(让 helper 显式抛)。 */
function defaultPrefixSource(): PrefixSource {
  if (testingDefaultOverride !== null) return testingDefaultOverride;
  const cache: PrefixTemplateCache | null = getPrefixTemplateCache();
  if (cache === null) {
    // cache 未 bootstrap — 不在这里抛,让上层路径抛 EnvelopePrefixCacheNotReadyError
    // 时带上具体 variant 名,error message 更可定位。
    return { get: () => null };
  }
  return { get: (v) => cache.get(v) };
}

/**
 * 把所有 3 个 active prefix 字面一次性读出来。cache miss(任一返回 null)→ 抛错。
 *
 * 在 helper 入口一次性读,而不是分散在 detectCcPrefix 内部按需读:语义清晰
 * (一次外接请求 = 一次 prefix snapshot),且如果 NOTIFY 中途到来,本次请求看到
 * 的快照仍一致(不会出现 detect 用旧值、inject 用新值的撕裂)。
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
 * 判某个 `system` array 中的 block 是否为"含 CC prefix 的 text block"。
 *
 * 检测条件写窄(Codex Phase 7 plan-review MINOR 采纳):必须是 plain object + type:text
 * + text:string,且 text 以三个 CC prefix 之一开头(startsWith,非 equals,以容纳 CCB
 * 实际拼接的 `<prefix>\n\n<rest>` 形态)。
 *
 * 对非 text block(如 type:"image")**不**误读其 `text` 字段。
 *
 * 返回命中的 prefix 索引(对齐 PREFIX_VARIANTS 数组顺序:0=default,
 * 1=agent_sdk_claude_code_preset, 2=agent_sdk),不命中返回 -1。
 * 索引进 log 帮助 ops 判断客户端打的哪种 CC 变体(parity 诊断)。
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
 * 强制把外接 API key 路径的 outbound body 归一化成 CC 容器形态(§3.5.2)。
 *
 * 仅 ApiKey strategy 路径调用(handler 判别 `identity.containerId === null`)。
 * Idempotent:已 CC-shaped 的 body 跑两次 = 跑一次。
 *
 * 行为:
 *   1. `body.system` 形态归一化:
 *      - `undefined` / 缺失 → `[]`
 *      - `string` → `[{type:"text", text:<string>}]`(转 array form 便于后续注入)
 *      - `array`  → 原数组(引用保留)
 *   2. 遍历 array 找"含 CC prefix 的 text block":命中(任意位置)→ skip 注入,
 *      保留客户端原 system 不动。
 *   3. 未命中 → array 头部 prepend `{type:"text", text: DEFAULT_PREFIX,
 *      cache_control:{type:"ephemeral"}}`。
 *
 * **不**触碰 `body.metadata`(device_id pin 由 `applyUpstreamAuth` 后续阶段处理)。
 * **不**伪造 `x-anthropic-billing-header`(给上游假指纹更糟,见 plan §3.5.2 决策)。
 *
 * @throws EnvelopePrefixCacheNotReadyError cache 未 bootstrap / 任一 variant 行缺失。
 */
export function normalizeExternalApiKeyEnvelope(
  body: ProxyBody,
  log: Logger,
  prefixSource?: PrefixSource,
): void {
  const src = prefixSource ?? defaultPrefixSource();
  const prefixes = snapshotPrefixes(src);
  // PREFIX_VARIANTS[0] === "default" — 0071 migration 与本文件 union 同序约束,
  // 这里下标 0 = default text。
  const defaultPrefix = prefixes[0]!;

  // 1) 归一化 body.system 形态成 array — `origKind` 进 log 帮助 ops 看客户端原始
  //    形态(用于 parity 诊断:容器 CCB 一直发 array,curl/SDK 客户端常发 string 或缺失)。
  let systemArr: unknown[];
  const original = body.system;
  let origKind: "undefined" | "string" | "array";
  if (original === undefined) {
    systemArr = [];
    origKind = "undefined";
  } else if (typeof original === "string") {
    // 即使是空串也走 string 分支,转成 `[{type:text, text:""}]` 再判 prefix(必不命中,
    // prepend 注入)。空串不进 array 注入分支的零特殊处理,避免空串/undefined 行为分裂。
    systemArr = [{ type: "text", text: original }];
    origKind = "string";
  } else {
    // schema 已保证 array;原引用保留,prepend 时新建 array(下方 step 3)
    systemArr = original;
    origKind = "array";
  }

  // 2) 遍历找 CC prefix block(任意位置;命中即 skip)。
  //    记录命中的 prefix 变体索引,进 log 用 — 帮 ops 看客户端打的是
  //    DEFAULT(0)/ AGENT_SDK_CLAUDE_CODE_PRESET(1)/ AGENT_SDK(2)哪种 CC 形态。
  let prefixVariant = -1;
  for (const block of systemArr) {
    const v = detectCcPrefix(block, prefixes);
    if (v >= 0) {
      prefixVariant = v;
      break;
    }
  }

  if (prefixVariant >= 0) {
    // string 形态本应在 step 1 已转 array;但 startsWith 命中是 string 的合法情况
    // (整个字符串以 prefix 开头,转 array 后第一个 block.text 命中)。
    // skip 注入:把归一化结果写回 body.system,保持后续 estimateInputTokens 看到 array form。
    if (original !== systemArr) {
      body.system = systemArr as ProxyBody["system"];
    }
    // 升 info 级(2026-05-20 v1.0.183):prod LOG_LEVEL=info 下也能直证 helper
    // 真的命中过 + outbound 形态 parity 诊断。**不**记 prompt 内容(任何 text/hash),
    // 仅结构指纹:blocks(归一化后 array 长度)+ origKind(客户端原 system 形态)+
    // prefix_variant(命中的 3 个 CC 变体之一)。
    log.info("external_envelope_skip", {
      reason: "cc_prefix_present",
      blocks: systemArr.length,
      orig_kind: origKind,
      prefix_variant: prefixVariant,
    });
    return;
  }

  // 3) 未命中 → prepend DEFAULT_PREFIX block(带 ephemeral cache_control)
  const injectedBlock = {
    type: "text" as const,
    text: defaultPrefix,
    cache_control: { type: "ephemeral" as const },
  };
  body.system = [injectedBlock, ...systemArr] as ProxyBody["system"];
  // 升 info 级:同 skip 路径口径,仅结构指纹。prefix_variant=0(注入的就是 DEFAULT)。
  log.info("external_envelope_injected", {
    blocks: (body.system as unknown[]).length,
    orig_kind: origKind,
    prefix_variant: 0,
  });
}
