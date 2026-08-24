/**
 * v3 commercial 反关联指纹差异化 — 每个 claude_account 的稳定 persona(伪装客户端身份)。
 *
 * 背景见 0073 migration 注释 + memory feedback_one_account_one_human.md。
 *
 * 设计:
 *   - 每个 claude_account 在 createAccount 时由 generatePersona() 生成一次,
 *     存入 claude_accounts.persona JSONB 列,生命周期内**不变**。
 *   - master 转发上游时,buildSafeUpstreamHeaders 按 persona 注入下列头:
 *       user-agent
 *       x-stainless-arch
 *       x-stainless-lang
 *       x-stainless-os
 *       x-stainless-package-version
 *       x-stainless-runtime
 *       x-stainless-runtime-version
 *       x-stainless-retry-count
 *       accept-language
 *   - 变体池(VARIANTS)硬编码在本文件,代码 review + 演进可控;
 *     升级 CCB CLI 版本时同步更新池子。
 *
 * 为什么 persona 必须稳定不变:
 *   feedback_one_account_one_human.md (L0 strict identity pinning):
 *     "同一账号请求头每次不同"才是真号商画像。Anthropic 网关侧统计
 *     "一个 account 关联多少不同 client fingerprint"足以判定异常。
 *   因此持久化到 DB,scheduler 决定用哪个账号 → 该账号的 persona 直接 spread 到 headers,
 *   零运行时漂移。
 *
 * 为什么不直接复用 CCB 上行的真实头:
 *   1) CCB header 集本身仍是受我们控制的统一版本(单一镜像),不存在天然差异化。
 *   2) buildSafeUpstreamHeaders allowlist 已经把所有 stainless 头剥光(05-SECURITY
 *      规则:不信任客户端 header),保持这条规则,反代侧主动按账号注入更安全。
 *   3) "客户端真实头" + "我们改写"两条路径并存会产生 surprise,统一走 persona 注入
 *      是单一权威源。
 */

import { createHash, randomBytes } from "node:crypto";

/**
 * Persona schema — 与 0073/0074 migration 的 CHECK 约束完全对齐。
 *
 * 字段命名:JSON key 用 snake_case(对应 DB jsonb),最终 HTTP header 名转 kebab。
 * 全部 string 类型(包含 x_stainless_retry_count,Anthropic SDK 真实头本身就是 string)。
 */
export interface Persona {
  user_agent: string;
  x_stainless_arch: string;
  x_stainless_lang: string;
  x_stainless_os: string;
  x_stainless_package_version: string;
  x_stainless_runtime: string;
  x_stainless_runtime_version: string;
  x_stainless_retry_count: string;
  accept_language: string;
}

const PERSONA_KEYS: ReadonlyArray<keyof Persona> = [
  "user_agent",
  "x_stainless_arch",
  "x_stainless_lang",
  "x_stainless_os",
  "x_stainless_package_version",
  "x_stainless_runtime",
  "x_stainless_runtime_version",
  "x_stainless_retry_count",
  "accept_language",
] as const;

/**
 * 真实 Claude Code (CCB) 版本锚点 —— **必须与实际 ship 的二进制一致**。
 *
 * 反封复盘(2026-08):Anthropic 侧对订阅号最强的识别信号之一是"客户端伪装
 * 与真实二进制对不上"。旧实现把 UA 伪装成 stainless SDK 的
 * `anthropic-ai-claude-code/<pkg>`,而真实 Claude Code CLI(含官方 + CCB,
 * 共用 claude-code-best/src/utils/http.ts::getUserAgent)在 wire 上发的是
 * `claude-cli/<VERSION> (<USER_TYPE>, <ENTRYPOINT>)`,并带 `x-app: cli`。
 * 见 packages/commercial/src/auth/apiKeyIdentity.ts §UA 入站门控 —— 本仓自己
 * 也只放行 `claude-cli/*`。因此 persona 必须发**真实 claude-cli 画像**,而非
 * SDK 画像。
 *
 * 两个版本号是**不同**的东西,不能混用:
 *   - CCB_CLI_VERSION      → UA 里的 `claude-cli/<x>`,= claude-code-best/package.json version
 *   - CCB_SDK_VERSION      → `x-stainless-package-version`,= 内置 @anthropic-ai/sdk 版本
 *
 * 升级 CCB 时**同步**改这两个常量(与 claude-code-best/package.json 对齐)。
 * 为什么用常量而非"版本池":同一 ship 的二进制,全网真实用户发的就是同一
 * `claude-cli/<x>` + 同一 SDK 版本;伪造一批我们根本没在跑的旧版本,反而会
 * 在"UA 版本 vs 实际请求能力"上露馅(旧版 CLI 发不出新版才有的 body 特征)。
 * 账号间的天然差异改由 os / arch / node 运行时版本 / accept-language 承载 ——
 * 这些在真实用户里本就千差万别,且不与请求行为相关联。
 */
const CCB_CLI_VERSION = "2.8.4";
const CCB_SDK_VERSION = "0.81.0";

/**
 * UA 里的 USER_TYPE / ENTRYPOINT —— 对应容器内外接用户的真实取值。
 * getUserAgent 格式:`claude-cli/<VERSION> (<USER_TYPE>, <ENTRYPOINT>)`。
 * 外接(非 Anthropic 内部)用户 USER_TYPE = "external";CLI 入口 ENTRYPOINT = "cli"。
 */
const CCB_USER_TYPE = "external";
const CCB_ENTRYPOINT = "cli";

/**
 * 变体池 — **只保留真实用户间天然会变、且与请求行为无关联**的维度。
 *
 * 选值原则:
 *   - 全部对应"真实存在的 Claude Code 用户分布":真实社区里 Apple Silicon Mac / Intel Mac /
 *     Linux 工作站 / Windows + WSL 都有,Anthropic 网关看到这些组合是正常的。
 *   - 不放过于稀有的组合(如 freebsd / arm32),会成为反向"挑出我们这种伪装池"的指纹。
 *   - runtime_version 是**跑 CLI 的宿主 node 版本**,真实用户各不相同(nvm / 系统 node),
 *     与 claude-cli 版本正交,可以安全差异化。
 *   - 版本号(claude-cli / SDK)**不**进池:见 CCB_CLI_VERSION 注释,用真实常量。
 *   - accept_language 覆盖主要市场 + 中文用户(boss 用户基底)。
 */
const PERSONA_VARIANTS = {
  arch: ["arm64", "x64"] as const,
  // os 与 arch 的真实联合分布:arm64 几乎都是 MacOS / Linux;x64 各 OS 都有。
  // 简化:os 独立采样,arch=arm64 + os=Windows 的极小概率在真实分布里也存在
  //(Windows on ARM)— 整体放行。
  os: ["MacOS", "Linux", "Windows"] as const,
  runtime: ["node"] as const,
  runtime_version: [
    "v20.11.1",
    "v20.18.0",
    "v22.11.0",
    "v22.14.0",
    "v22.16.0",
  ] as const,
  accept_language: [
    "en-US,en;q=0.9",
    "en-GB,en;q=0.9",
    "zh-CN,zh;q=0.9,en;q=0.8",
    "ja-JP,ja;q=0.9,en;q=0.8",
    "de-DE,de;q=0.9,en;q=0.8",
  ] as const,
  retry_count: ["0"] as const,
  lang: ["js"] as const,
} as const;

/**
 * 拼 user_agent —— 复刻真实 Claude Code CLI 的 wire UA。
 *
 * 真实格式(claude-code-best/src/utils/http.ts::getUserAgent):
 *   "claude-cli/<VERSION> (<USER_TYPE>, <ENTRYPOINT>)"
 *   例:"claude-cli/2.8.4 (external, cli)"
 *
 * 注意:不再是 stainless 默认 UA(`anthropic-ai-claude-code/...`)。真实 CLI 在
 * defaultHeaders 里用 getUserAgent() 覆盖了 SDK 默认 UA,所以 Anthropic 网关看到
 * 的就是 `claude-cli/*`。SDK 的身份仍通过 x-stainless-* 头单独表达。
 */
function pickUserAgent(): string {
  return `claude-cli/${CCB_CLI_VERSION} (${CCB_USER_TYPE}, ${CCB_ENTRYPOINT})`;
}

/**
 * 确定性从 seed 选 variants — 同一 seed → 同一 persona。
 *
 * 实现:用 SHA-256 把 seed 摊成 32 字节,依次取 1 字节作为每个维度的 index,
 * mod variants.length。9 个维度 < 32 字节 → 不重用熵。
 */
function pick<T>(buf: Buffer, offset: number, pool: ReadonlyArray<T>): T {
  return pool[buf[offset] % pool.length];
}

/**
 * 生成一个新的 persona。
 *
 * @param seed 可选 32 字节随机 seed。不传时内部 randomBytes(32) — 用于 createAccount。
 *             传时(typically pinned_user_id 的二进制形式)用于"账号迁移 / 重建 persona"
 *             这种需要 deterministic 的场景(本仓现在没用,留 API surface 给未来 backfill 之外的需要)。
 */
export function generatePersona(seed?: Buffer): Persona {
  const buf = seed
    ? createHash("sha256").update(seed).digest()
    : randomBytes(32);

  const arch = pick(buf, 0, PERSONA_VARIANTS.arch);
  const os = pick(buf, 1, PERSONA_VARIANTS.os);
  const runtime = pick(buf, 2, PERSONA_VARIANTS.runtime);
  const runtimeVersion = pick(buf, 3, PERSONA_VARIANTS.runtime_version);
  const acceptLanguage = pick(buf, 4, PERSONA_VARIANTS.accept_language);
  const retryCount = pick(buf, 5, PERSONA_VARIANTS.retry_count);
  const lang = pick(buf, 6, PERSONA_VARIANTS.lang);

  return {
    // UA 与 x-stainless-package-version 用真实二进制锚点常量(见 CCB_CLI_VERSION),
    // 账号间差异化交给 os / arch / node 运行时版本 / accept-language。
    user_agent: pickUserAgent(),
    x_stainless_arch: arch,
    x_stainless_lang: lang,
    x_stainless_os: os,
    x_stainless_package_version: CCB_SDK_VERSION,
    x_stainless_runtime: runtime,
    x_stainless_runtime_version: runtimeVersion,
    x_stainless_retry_count: retryCount,
    accept_language: acceptLanguage,
  };
}

/**
 * 运行时校验 — 从 DB JSONB 列读出来的对象是不是合法 Persona。
 *
 * 0074 CHECK 约束已经在 DB 层兜底,但 master 进程内部 invariant 也要校验:
 *   - persona 列可能是 NULL(0073 → 0074 之间窗口);命中 NULL 必须 throw,
 *     由调用方决定 fallback 还是阻断。
 *   - schema drift 早暴露,而不是把 undefined 当 header 值发出去。
 */
export function assertPersona(p: unknown): asserts p is Persona {
  if (p === null || typeof p !== "object") {
    throw new TypeError(`persona is not an object: ${typeof p}`);
  }
  for (const k of PERSONA_KEYS) {
    const v = (p as Record<string, unknown>)[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new TypeError(`persona.${k} is not a non-empty string: ${typeof v}`);
    }
  }
}

/**
 * 把 Persona 转成 HTTP header 名/值 pairs(kebab-case),供 buildSafeUpstreamHeaders 注入。
 *
 * 返回数组而非 Record 是因为 headers Map 通常 case-insensitive,顺序也无关;
 * 调用方用 .set() / Headers.append() 写入即可。
 */
export function personaToHeaderPairs(p: Persona): ReadonlyArray<[string, string]> {
  return [
    ["user-agent", p.user_agent],
    ["x-stainless-arch", p.x_stainless_arch],
    ["x-stainless-lang", p.x_stainless_lang],
    ["x-stainless-os", p.x_stainless_os],
    ["x-stainless-package-version", p.x_stainless_package_version],
    ["x-stainless-runtime", p.x_stainless_runtime],
    ["x-stainless-runtime-version", p.x_stainless_runtime_version],
    ["x-stainless-retry-count", p.x_stainless_retry_count],
    ["accept-language", p.accept_language],
  ];
}
