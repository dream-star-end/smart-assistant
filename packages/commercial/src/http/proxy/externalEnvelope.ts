/**
 * V3 CC 外接 plan Phase 7(2026-05-20)— 出站 envelope 归一化。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_PLAN_2026-05-18.md §3.5.2 / §4 invariant #11 / §7 Phase 7。
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
 * 形态均可)被检测到后直接 skip,不重复 prepend。具体见 `CC_SYSPROMPT_PREFIXES` 常量
 * 注释 + invariant #11 测试。
 */

import type { Logger } from "../../logging/logger.js";
import type { ProxyBody } from "./shared.js";

/**
 * 官方 Claude Code CLI sysprompt prefix 常量。
 *
 * **就地硬编码,不引入 claude-code-best 依赖**(commercial 不该 build-time 引 CCB)。
 * 源:`claude-code-best/src/constants/system.ts:10-12`。
 *
 * 三个变体覆盖容器内 `getCLISyspromptPrefix()` 所有产出:
 *   - DEFAULT:交互式 / 非 vertex 默认
 *   - AGENT_SDK_CLAUDE_CODE_PRESET:`isNonInteractive=true && hasAppendSystemPrompt=true`
 *   - AGENT_SDK:`isNonInteractive=true && hasAppendSystemPrompt=false`
 *
 * 上游 Anthropic anti-abuse fingerprinter 把这 3 个字面前缀作为"CC 客户端"的强特征,
 * 服务端注入任一即可让外接请求落入"CC 形态"分桶。本 helper 注入 DEFAULT_PREFIX
 * 是因为它在 1P/3P 路径上最稳;客户端如果已发 SDK 变体也照样跳过(startsWith 三选一)。
 *
 * **注意**:三个字符串以**字面 byte** 形式参与 startsWith 匹配。CCB 上游升级若改这三
 * 个字符串(罕见,这是 anti-abuse 锚点),本文件需同步更新 — Phase 7 plan §3.5.2 已
 * 锁这条契约。
 */
const CC_DEFAULT_PREFIX =
  `You are Claude Code, Anthropic's official CLI for Claude.`;
const CC_AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX =
  `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`;
const CC_AGENT_SDK_PREFIX =
  `You are a Claude agent, built on Anthropic's Claude Agent SDK.`;

const CC_SYSPROMPT_PREFIXES: readonly string[] = [
  CC_DEFAULT_PREFIX,
  CC_AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  CC_AGENT_SDK_PREFIX,
];

/**
 * 判某个 `system` array 中的 block 是否为"含 CC prefix 的 text block"。
 *
 * 检测条件写窄(Codex Phase 7 plan-review MINOR 采纳):必须是 plain object + type:text
 * + text:string,且 text 以三个 CC prefix 之一开头(startsWith,非 equals,以容纳 CCB
 * 实际拼接的 `<prefix>\n\n<rest>` 形态)。
 *
 * 对非 text block(如 type:"image")**不**误读其 `text` 字段。
 *
 * 返回命中的 prefix 索引(0=DEFAULT, 1=AGENT_SDK_CLAUDE_CODE_PRESET, 2=AGENT_SDK),
 * 不命中返回 -1。索引进 log 帮助 ops 判断客户端打的哪种 CC 变体(parity 诊断)。
 */
function detectCcPrefix(block: unknown): number {
  if (
    !block ||
    typeof block !== "object" ||
    (block as { type?: unknown }).type !== "text"
  ) {
    return -1;
  }
  const text = (block as { text?: unknown }).text;
  if (typeof text !== "string") return -1;
  for (let i = 0; i < CC_SYSPROMPT_PREFIXES.length; i++) {
    if (text.startsWith(CC_SYSPROMPT_PREFIXES[i]!)) return i;
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
 */
export function normalizeExternalApiKeyEnvelope(
  body: ProxyBody,
  log: Logger,
): void {
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
    const v = detectCcPrefix(block);
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
    text: CC_DEFAULT_PREFIX,
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
