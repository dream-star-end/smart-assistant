/**
 * platformEnvelopeBuilder — V3 CC 外接 API key 路径的"平台 envelope rewrite"主入口。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_PHASE5_PLAN_2026-05-21.md §3.1 / §3.2 / §3.3。
 *
 * 历史:Phase 4 同位置曾有简化 helper(仅做 CC prefix 注入,无 attribution / PII strip /
 * 平台 context 注入)。Phase 5(2026-05-21)整合后此处是外接 ApiKey 路径 envelope rewrite
 * 的唯一 source-of-truth。
 *
 * # 处理顺序
 *
 *   [1] system[0] = 强制 attribution header(HMAC 派生 fp3,无 cache_control)
 *   [2] system[1] = 强制 CC DEFAULT_PREFIX(cache_control: ephemeral)
 *   [3] system[2..N] = 客户端原内容 PII strip
 *   [4] system[N+1] = 平台注入 OpenClaude 用户级 attribution block(ephemeral)
 *   [5] messages[0] = 检测到 CCB <system-reminder> 形态时整块替换为 server 版
 *   [6] metadata.user_id = 收紧到 3 必有 key:device_id/account_uuid/session_id
 *
 * # H1 不变量
 *
 *   - system[0]/[1]/[N+1] 多机字节级一致(同一 userId 跨机器跑)
 *   - metadata.user_id 的 key set 恒 3 项(device_id/account_uuid/session_id)
 *   - account_uuid 来自 HMAC(serverSecret, userId),稳定派生
 *   - session_id 服务端生成(crypto.randomUUID),不依赖客户端透传
 *
 * # H2 不变量
 *
 *   - messages[0] 不含 hostname / 用户名路径 / device-id / CLAUDE.md 片段
 *   - system[2..N] 同样 PII strip,不漏边界
 *
 * # 调用契约
 *
 *   - **在 pickUpstream 之前**调用 — 此时 OAuth account 还没选定,所以派生不能依赖
 *     account.id,统一走 HMAC(serverSecret, userId)
 *   - mutate `body.system` / `body.messages` / `body.metadata` in place
 *   - 永不抛错 — caller 在外接 API hot path,任何故障都用降级策略保 H1
 *   - ctx === null 时仍写 system[N+1] 占位块(保 block 数恒定)
 */

import { randomUUID, createHmac } from "node:crypto";

import type { Logger } from "../logging/logger.js";
import type { PlatformContext } from "./volumeContextReader.js";
import type { ProxyBody } from "../http/proxy/shared.js";

// ─── 常量 ───────────────────────────────────────────────────────────────

/**
 * Claude Code CLI 默认 sysprompt prefix。
 *
 * 字面 byte 必须跟 `claude-code-best/src/constants/system.ts:10` 的 `DEFAULT_PREFIX`
 * 完全一致 —— Anthropic anti-abuse 反风控按此前缀字面匹配 CC 客户端形态。CCB 升级
 * 改字符串时这里同步更新(罕见,这是稳定锚点)。
 */
const CC_DEFAULT_PREFIX =
  `You are Claude Code, Anthropic's official CLI for Claude.`;

/**
 * 兼容 CCB 已有的三种 prefix 变体,client 已经写对了就不强行覆盖。
 *
 * Phase 5 整合后此 list 是 commercial 包内唯一权威 list;CCB 升级三 prefix 字面时同步更新。
 */
const CC_SYSPROMPT_PREFIXES: readonly string[] = [
  CC_DEFAULT_PREFIX,
  `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`,
  `You are a Claude agent, built on Anthropic's Claude Agent SDK.`,
];

/**
 * CC version。复用 `OPENCLAUDE_CC_VERSION_FOR_OAUTH` env(同一 deployment 用一个版本号),
 * 没设时 fallback 跟 account-pool/refresh.ts:89 同步。
 */
function ccVersion(): string {
  return process.env.OPENCLAUDE_CC_VERSION_FOR_OAUTH || "2.1.888";
}

/** 平台注入的 attribution block 占位文本 — `[platform-context-unavailable]` 用于 ctx=null。 */
const PLATFORM_CONTEXT_UNAVAILABLE = "[platform-context-unavailable]";

/** PII strip 命中后的整块替换占位。 */
const REDACTED_PLACEHOLDER = "[redacted-by-platform]";

// ─── HMAC 派生(plan §3.2)─────────────────────────────────────────────

/**
 * 派生 fp3 — 3 hex char(12 bit 熵),用于 attribution header 的 cc_version 后缀。
 *
 * `HMAC-SHA256(serverSecret, "fp3:" || userId).digest("hex").slice(0, 3)`
 *
 * 同一 userId 派生稳定,跨机器一致;ApiKey 跨实例切换不影响。
 */
export function deriveFp3(serverSecret: Buffer | string, userId: bigint): string {
  return createHmac("sha256", serverSecret)
    .update("fp3:" + userId.toString())
    .digest("hex")
    .slice(0, 3);
}

/**
 * 派生 account_uuid — HMAC 输出前 16 字节按 UUID v4 设 version/variant bit,format 后返。
 *
 * 同一 userId 派生稳定 → 多机看到的 metadata.user_id.account_uuid byte-level identical。
 */
export function deriveAccountUuid(serverSecret: Buffer | string, userId: bigint): string {
  const raw = createHmac("sha256", serverSecret)
    .update("account_uuid:" + userId.toString())
    .digest()
    .subarray(0, 16);
  // UUID v4 version + RFC 4122 variant bit
  raw[6] = (raw[6]! & 0x0f) | 0x40;
  raw[8] = (raw[8]! & 0x3f) | 0x80;
  const h = raw.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ─── PII strip(plan §3.1 step 3a / §3.3 边界)────────────────────────

/**
 * 检测一段文本是否含已知 PII pattern。命中即触发整块替换(plan §3.1 step 3a)。
 *
 * 监测类:
 *   1. Unix 绝对路径含用户名:`/Users/<name>/`, `/home/<name>/`
 *   2. Windows 绝对路径含用户名:`C:\Users\<name>\`(单/双 backslash 均匹配)
 *   3. CCB getOrCreateUserID 风格的 device-id(小写 hex32 或 hex64 — CCB shared.ts
 *      声明 deviceId 是 sha256(machineId).substring(0, 64),实际 32/64 双形态都需拦)
 *   4. hostname 标签上下文命中(`hostname:`, `host:`, `machine:`, `computer name:`)
 *      —— 字段化形态(冒号/等号后接值),避免误伤散文里的 "host" / "machine" 一般词
 *   5. CLAUDE.md / 用户指令片段 marker(`# User Instructions` 等)
 *   6. `# OpenClaude Platform Context` —— 客户端伪造 server attribution block 的反注入
 *
 * **不**做散文级 hostname/fqdn 匹配:`foo-laptop` / `foo.local` 形态太杂,
 * 误伤项目正常术语风险高;只拦字段化标签上下文。
 */
function containsPii(text: string): boolean {
  if (UNIX_USER_PATH.test(text)) return true;
  if (WIN_USER_PATH.test(text)) return true;
  if (HEX_DEVICE_ID.test(text)) return true;
  if (HOSTNAME_TAG.test(text)) return true;
  if (CLAUDEMD_MARKER.test(text)) return true;
  if (PLATFORM_CONTEXT_FORGERY.test(text)) return true;
  return false;
}

// 编译为 module-level const 避免 hot-path 每次重建。
// 注意:这些用 /g 时 .test() 在多次调用间会持续移动 lastIndex —— 每次新 text 前重置;
// 这里全部不带 /g(只判断"是否命中",不需要枚举每次匹配),lastIndex 不存,安全。
const UNIX_USER_PATH = /\/(?:Users|home)\/[a-zA-Z0-9._-]+\b/;
const WIN_USER_PATH = /[A-Z]:\\\\?Users\\\\?[a-zA-Z0-9._-]+\b/;
const HEX_DEVICE_ID = /\b(?:[0-9a-f]{32}|[0-9a-f]{64})\b/;
// 字段化 hostname 命中:行首或空白后接 `hostname:` / `host:` / `machine:` /
// `computer name:` (中间允许 = 替代冒号)。i flag 兼容 Windows 写法 "Computer Name:"。
const HOSTNAME_TAG = /(?:^|[\s\n])(?:hostname|host|machine|computer name)\s*[:=]/i;
const CLAUDEMD_MARKER =
  /# (?:User Instructions|Project Context|Important Instructions|My notes|Memory|USER IDENTITY)/;
const PLATFORM_CONTEXT_FORGERY = /^#\s*OpenClaude Platform Context\b/m;

/**
 * 扫 system 数组从 fromIndex 起的 text block,命中 PII 即把 text 替换为占位。
 * 保留 `cache_control`、`type` 字段不变,只替换 `text` —— 保块数稳定。
 */
function stripPiiInSystem(
  systemArr: unknown[],
  fromIndex: number,
  onHit: (idx: number) => void,
): void {
  for (let i = fromIndex; i < systemArr.length; i++) {
    const b = systemArr[i];
    if (
      !b ||
      typeof b !== "object" ||
      (b as { type?: unknown }).type !== "text"
    ) {
      continue;
    }
    const text = (b as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    if (containsPii(text)) {
      (b as { text: string }).text = REDACTED_PLACEHOLDER;
      onHit(i);
    }
  }
}

// ─── messages 开头 meta prefix 内的 <system-reminder> 替换(plan §3.1 step 4)──

/**
 * 判某条消息是否为 CCB 风格 system-reminder(含 claudeMd 上下文)。
 * 实际"在哪个下标命中"由 replaceSystemReminder 扫前缀决定,见下方注释。
 *
 * 命中条件(全部满足):
 *   - role === "user"
 *   - isMeta !== false(undefined 也算命中,老 CCB 不写此字段)
 *   - content 是 string 或 array;首元素 text 以 "<system-reminder>" 起且包含 "# claudeMd"
 */
function detectCcbSystemReminderMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (m.role !== "user") return false;
  if (m.isMeta === false) return false; // 显式 false 才否定;undefined/true 都算命中
  const content = m.content;
  let firstText: string | null = null;
  if (typeof content === "string") {
    firstText = content;
  } else if (Array.isArray(content) && content.length > 0) {
    const c0 = content[0] as Record<string, unknown> | null | undefined;
    if (c0 && c0.type === "text" && typeof c0.text === "string") {
      firstText = c0.text;
    }
  }
  if (firstText === null) return false;
  return firstText.startsWith("<system-reminder>") && firstText.includes("# claudeMd");
}

/**
 * 服务端拼装 CCB 风格 system-reminder 文本(平台 USER.md 等价 + 当前日期)。
 * 内容 = USER.md(原文)+ MEMORY.md 索引 + 当前 UTC 日期。
 *
 * ctx === null 时用占位文本,保 H1 多机一致(server-canonical default)。
 */
function buildServerSystemReminderText(ctx: PlatformContext | null, today: Date): string {
  const isoDate = today.toISOString().slice(0, 10);
  if (ctx === null) {
    return [
      "<system-reminder>",
      "As you answer the user's questions, you can use the following context:",
      "# claudeMd",
      PLATFORM_CONTEXT_UNAVAILABLE,
      "# currentDate",
      `Today's date is ${isoDate}.`,
      "</system-reminder>",
    ].join("\n");
  }
  const userMdTrimmed = ctx.userMd.trim();
  return [
    "<system-reminder>",
    "As you answer the user's questions, you can use the following context:",
    "# claudeMd",
    userMdTrimmed.length > 0 ? userMdTrimmed : PLATFORM_CONTEXT_UNAVAILABLE,
    "# currentDate",
    `Today's date is ${isoDate}.`,
    "</system-reminder>",
  ].join("\n");
}

/**
 * 在 messages 数组的"开头连续 meta user message"前缀里找第一条 claudeMd
 * `<system-reminder>` 消息,整块替换为 server 版。
 *
 * 为什么扫前缀而不是只看 messages[0](Codex Phase 5 round-1 BLOCKER 采纳):
 *
 *   CCB `services/api/claude.ts:1318` 会在 `messagesForAPI` 前 prepend
 *   `<available-deferred-tools>` 这种 `isMeta: true` 的 user message,真正
 *   含 `# claudeMd` 的 `<system-reminder>` 因此落在 `messages[1]+`。只看
 *   `messages[0]` 会 silently skip 替换,客户端 CLAUDE.md / 路径 PII 直接
 *   通过 H2 边界,直接破协议。
 *
 * 扫描规则:
 *   - 从 messages[0] 起,只要是 `role==="user"` 且 `isMeta !== false`,就视作
 *     meta prefix 的一部分,继续扫
 *   - 在 prefix 内找到第一个 `<system-reminder>` + `# claudeMd` 形态即替换并返回
 *   - 遇到第一条 `role !== "user"` 或 `isMeta === false` 即停止扫描;
 *     不扫真实用户轮次后的消息(防止替换子 turn 用户消息)
 */
function replaceSystemReminder(
  messages: unknown[],
  ctx: PlatformContext | null,
  today: Date,
): boolean {
  const replacementText = buildServerSystemReminderText(ctx, today);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!isMetaUserMessage(m)) {
      // 遇到第一条真实 user turn(或 assistant)即停止扫描
      return false;
    }
    if (!detectCcbSystemReminderMessage(m)) continue;
    // 命中,整块替换
    const mr = m as Record<string, unknown>;
    const content = mr.content;
    if (typeof content === "string") {
      mr.content = replacementText;
      return true;
    }
    if (Array.isArray(content) && content.length > 0) {
      const c0 = content[0] as Record<string, unknown>;
      c0.text = replacementText;
      return true;
    }
    return false;
  }
  return false;
}

/** 是否属于"开头 meta 前缀"集合(role=user 且 isMeta !== false)。 */
function isMetaUserMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (m.role !== "user") return false;
  if (m.isMeta === false) return false;
  return true;
}

// ─── 平台 context attribution block(plan §3.1 step 3c)────────────────

/**
 * 拼装 system[N+1] 注入块文本。
 * ctx === null 时用占位文本,保 H1 多机一致;有内容时 USER.md + MEMORY.md + skills 摘要。
 */
function buildPlatformContextText(ctx: PlatformContext | null): string {
  if (ctx === null) {
    return [
      "# OpenClaude Platform Context",
      PLATFORM_CONTEXT_UNAVAILABLE,
    ].join("\n");
  }
  const parts: string[] = ["# OpenClaude Platform Context"];
  if (ctx.userMd.trim().length > 0) {
    parts.push("## User", ctx.userMd.trim());
  }
  if (ctx.memoryMd.trim().length > 0) {
    parts.push("## Memory Index", ctx.memoryMd.trim());
  }
  if (ctx.skills.length > 0) {
    parts.push("## Skills");
    for (const s of ctx.skills) {
      // SKILL.md frontmatter 已 trim;name + description 是元数据,无 PII 风险
      parts.push(`- **${s.name}** — ${s.description}`);
    }
  }
  if (parts.length === 1) {
    // 三段都空:写占位(避免空 block 看起来是攻击者塞的 marker)
    parts.push(PLATFORM_CONTEXT_UNAVAILABLE);
  }
  return parts.join("\n");
}

// ─── metadata 重写(plan §3.1 step 5)─────────────────────────────────

/**
 * 强制重写 body.metadata 到 3-key shape:device_id / account_uuid / session_id。
 *
 * - device_id:占位(客户端原值或空串);applyUpstreamAuth → rewriteMetadataDeviceId
 *   后续阶段会覆盖为 pinned_user_id,这里写值只为过 proxyBodySchema 校验
 * - account_uuid:HMAC 派生,稳定 + 多机一致
 * - session_id:服务端生成 UUID v4,**不**透传客户端 session_id(防机器画像)
 *
 * 顶层 metadata 上的 session_id(如客户端写在那)一并 strip。
 */
function rewriteMetadata(body: ProxyBody, accountUuid: string): void {
  const existing = body.metadata?.user_id;
  let clientDeviceId = "";
  if (typeof existing === "string") {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const did = (parsed as { device_id?: unknown }).device_id;
        if (typeof did === "string") clientDeviceId = did;
      }
    } catch {
      // 客户端 metadata.user_id 非 JSON:占位空串,后续 applyUpstreamAuth 覆盖
    }
  }
  const tight = {
    device_id: clientDeviceId,
    account_uuid: accountUuid,
    session_id: randomUUID(),
  };
  body.metadata = { user_id: JSON.stringify(tight) };
}

// ─── builder entry(plan §3.1 主流程)─────────────────────────────────

export interface BuildPlatformEnvelopeDeps {
  body: ProxyBody;
  ctx: PlatformContext | null;
  userId: bigint;
  serverSecret: Buffer | string;
  log: Logger;
  /** 测试 hook;默认 new Date()。 */
  now?: () => Date;
}

export interface BuildPlatformEnvelopeResult {
  /** 已注入 attribution header 的 system 数组长度。 */
  systemBlocks: number;
  /** PII strip 命中的 block index 列表(去重)。日志用,不进 body。 */
  piiStrippedIndexes: number[];
  /** messages[0] system-reminder 是否替换。 */
  systemReminderReplaced: boolean;
  /** 派生的 fp3。日志用。 */
  fp3: string;
}

/**
 * 主入口。mutate `body` in place,返回结构指纹用于日志(**不**回 prompt 文本)。
 *
 * 设计:builder 永不抛 —— 任何内部异常都吞并 fallback。最坏情形(全失败)
 * 也会留 H1 关键不变量(强制 system[0]/[1] + metadata.user_id 3-key),
 * 仅 PII strip / system-reminder 替换可能 skip。
 */
export function buildPlatformEnvelope(
  deps: BuildPlatformEnvelopeDeps,
): BuildPlatformEnvelopeResult {
  const { body, ctx, userId, serverSecret, log } = deps;
  const now = deps.now ?? (() => new Date());

  const fp3 = deriveFp3(serverSecret, userId);
  const accountUuid = deriveAccountUuid(serverSecret, userId);

  // ── 1. 归一化 body.system 形态成 array ──
  let systemArr: unknown[];
  const original = body.system;
  if (original === undefined) {
    systemArr = [];
  } else if (typeof original === "string") {
    systemArr = [{ type: "text", text: original }];
  } else {
    systemArr = [...original]; // shallow copy:不污染 caller 引用
  }

  // ── 2. 剥掉已有的 CC attribution header / CC prefix(避免双重注入)──
  // CCB 客户端发的 system[0]/[1] 是它自己的 attribution+prefix;我们用 server 派生覆盖。
  // 早期 Phase 4 helper 是 "skip if prefix already present";Phase 5 改成 "always replace"
  // (plan §3.1 step 1+2 强制重写)。
  const tail = stripLeadingCcAttribution(systemArr);

  // ── 3. PII strip tail(对应 plan 五步里的 system[2..N])──
  const piiHits: number[] = [];
  stripPiiInSystem(tail, 0, (i) => piiHits.push(i + 2)); // +2 因为最终位置会被 prepend 推后

  // ── 4. 拼装最终 system 数组 ──
  const attributionBlock = {
    type: "text" as const,
    text: `x-anthropic-billing-header: cc_version=${ccVersion()}.${fp3}; cc_entrypoint=sdk; cch=00000;`,
  };
  const ccPrefixBlock = {
    type: "text" as const,
    text: CC_DEFAULT_PREFIX,
    cache_control: { type: "ephemeral" as const },
  };
  const platformContextBlock = {
    type: "text" as const,
    text: buildPlatformContextText(ctx),
    cache_control: { type: "ephemeral" as const },
  };
  body.system = [
    attributionBlock,
    ccPrefixBlock,
    ...tail,
    platformContextBlock,
  ] as ProxyBody["system"];

  // ── 5. messages[0] <system-reminder> 替换 ──
  let systemReminderReplaced = false;
  try {
    systemReminderReplaced = replaceSystemReminder(body.messages, ctx, now());
  } catch (err) {
    log.warn("platform-envelope: system-reminder replace threw", {
      err: errSummary(err),
    });
  }

  // ── 6. metadata 重写 ──
  try {
    rewriteMetadata(body, accountUuid);
  } catch (err) {
    log.warn("platform-envelope: metadata rewrite threw", { err: errSummary(err) });
  }

  return {
    systemBlocks: (body.system as unknown[]).length,
    piiStrippedIndexes: piiHits,
    systemReminderReplaced,
    fp3,
  };
}

/**
 * 从 systemArr 头部剥掉客户端可能写过的 attribution header / CC prefix block —— 我们要
 * 用 server 派生版本覆盖,不能保留客户端原值。
 *
 * 检测条件保守(只剥确认形态),误剥项目级 dynamic block 风险低:
 *   - block.type === "text" 且 text 以 "x-anthropic-billing-header" 起 → 剥
 *   - block.type === "text" 且 text 是 CC_SYSPROMPT_PREFIXES 之一的开头 → 剥
 *
 * 返回剥完剩下的 tail 数组(新数组,**不** mutate 入参)。
 */
function stripLeadingCcAttribution(systemArr: unknown[]): unknown[] {
  let i = 0;
  while (i < systemArr.length && shouldStripLeadingBlock(systemArr[i])) {
    i++;
  }
  return systemArr.slice(i);
}

function shouldStripLeadingBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const b = block as { type?: unknown; text?: unknown };
  if (b.type !== "text" || typeof b.text !== "string") return false;
  if (b.text.startsWith("x-anthropic-billing-header")) return true;
  for (const p of CC_SYSPROMPT_PREFIXES) {
    if (b.text.startsWith(p)) return true;
  }
  return false;
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
