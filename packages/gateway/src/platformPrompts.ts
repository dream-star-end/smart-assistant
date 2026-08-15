/**
 * platformPrompts — 平台静态 prompt 文案的 LKG(last-known-good)快照加载器。
 *
 * 设计出处:V5_RUNTIME_HOTCFG_PLAN.md §1.2(LKG 快照语义)+ §4.2(P2b 文案文件化)。
 *
 * 权威边界(两通道不重叠,勿混):
 *   - **商业版权威** = platform bundle 的 `prompts/` 目录。supervisor 把稳定根
 *     `→ /run/oc/platform/current/prompts` 注入到 env `OPENCLAUDE_PLATFORM_PROMPTS_DIR`;
 *     `current` symlink 原子翻转 → 文案对存量容器**真热**生效。
 *   - **个人版权威** = 各消费方代码内的 fallback 常量(见 promptSlots.ts /
 *     codexLaunchOverrides.ts)。个人版**不设**该 env → 本加载器不起任何轮询、恒回落
 *     调用方传入的 fallback,行为与改造前逐字一致(零行为变化)。
 *
 * 单一不变量(勿破坏):
 *   - `getPlatformPrompt(key, fallback)` 的 fallback 参数由消费方拥有并传入;本模块
 *     **不持有**任何文案本体,只做「env 未设/加载失败 → 回落 fallback;加载成功 →
 *     返回快照」。这样避免与 promptSlots/codexLaunchOverrides 形成循环依赖,且把
 *     「代码 fallback ↔ bundle 文件」的逐字同步义务留在消费方(那里有 `__tests__/
 *     platformPrompts.test.ts` 的 `文件 === 常量` 断言把同步固化成 CI 门,漂移即红)。
 *   - LKG 语义:env 已设时启动整套读取+校验;任一文件缺失/超限/空/非 UTF-8 → **整套**
 *     不生效,保留上一份 last-known-good(首次失败即回落 fallback),并 console.error 告警。
 *   - 重载:TTL(30s)门控下,对 prompts 目录经 `current` symlink 的 realpath 做变化
 *     检测,rev 变了才整套重读;**不订阅散乱 fs 事件**(无 fs.watch)。此处用「访问时
 *     TTL 门控」实现轮询而非常驻定时器:prompt 每轮都会重建(访问频率 ≫ 30s),
 *     空闲时也无需感知翻转(下一次重建自会拾取);既满足 §1.2 的「TTL 轮询、非 fs 事件」,
 *     又避免在 gateway 进程里留一个永不回收的空转定时器。
 */
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export type PlatformPromptKey =
  | 'platform-capabilities'
  | 'memory-instructions'
  | 'codex-preamble'
  | 'cursor-preamble'

/** key → bundle 内文件名。整套 = 这三项;任一缺失即整套不生效(LKG)。 */
const PROMPT_FILES: Record<PlatformPromptKey, string> = {
  'platform-capabilities': 'platform-capabilities.md',
  'memory-instructions': 'memory-instructions.md',
  'codex-preamble': 'codex-preamble.md',
  'cursor-preamble': 'cursor-preamble.md',
}
const PROMPT_KEYS = Object.keys(PROMPT_FILES) as PlatformPromptKey[]

/**
 * key → 该 prompt **必需占位符**清单(m2 注入契约)。加载校验时若某文件缺任一必需占位符 →
 * 该轮整套加载失败(保留 LKG + 告警,fail-soft)。防止 bundle 侧误删占位符导致运行时
 * `replaceAll` 静默 no-op、注入契约悄悄断裂(如微信识图提示 / memdir 运行时路径注不进去)。
 *   - platform-capabilities:{{WECHAT_VISION_HINT}}(buildAgentsSlot 按模型注入 CLI/原生变体);
 *   - memory-instructions:{{MEMORY_DIR}}/{{MEMORY_MD}}/{{USER_MD}}(renderMemoryInstructions 注入);
 *   - codex-preamble / cursor-preamble:无(纯静态文案,无运行时注入点)。
 */
const REQUIRED_PLACEHOLDERS: Record<PlatformPromptKey, readonly string[]> = {
  'platform-capabilities': ['{{WECHAT_VISION_HINT}}'],
  'memory-instructions': ['{{MEMORY_DIR}}', '{{MEMORY_MD}}', '{{USER_MD}}'],
  'codex-preamble': [],
  'cursor-preamble': [],
}

const ENV_DIR_KEY = 'OPENCLAUDE_PLATFORM_PROMPTS_DIR'
/** 单文件字节上限(§1.2 消费侧的 prompt 面 cap;结构面另有 §1.3 supervisor 校验)。 */
const MAX_PROMPT_BYTES = 256 * 1024
/** rev 变化检测的 TTL 门控。 */
const TTL_MS = 30_000

interface Snapshot {
  /** resolved rev = 经 current symlink 的 prompts 目录 realpath;作为「变了才重读」的基准。 */
  rev: string
  prompts: Record<PlatformPromptKey, string>
}

// ── 模块级状态(单进程单例;测试经 _internals.resetForTests 复位)──
let initialized = false
/** env 值(去空白);null = 个人版未设 → 永不轮询、恒回落 fallback。 */
let promptsDir: string | null = null
/** 最近一次校验通过的整套快照;null = 从未加载成功(首次失败仍为 null → 回落 fallback)。 */
let snapshot: Snapshot | null = null
let lastPollAt = 0

// fatal:true → 非法 UTF-8 抛错(而非静默替换成 U+FFFD),使「非 UTF-8」成为校验失败项。
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

/** 整套读入 + 逐文件校验(缺失/超限/空/非 UTF-8/缺必需占位符任一即抛)。全过或全不过 —— 无半套。 */
function readValidatedSet(dir: string): Snapshot {
  // M3:realpath **解析一次**得 resolved rev 目录,三个文件全部从 resolved rev 读 —— 翻转中途
  // current 若被 mv -T 翻转,整套仍恒为同一 rev(消 dir 逐个读时 current 翻转的 TOCTOU)。
  const rev = realpathSync(dir) // 经 current symlink 的稳定基准;symlink 断裂即抛,走 LKG
  const prompts = {} as Record<PlatformPromptKey, string>
  for (const key of PROMPT_KEYS) {
    const file = join(rev, PROMPT_FILES[key]) // 从 resolved rev 读,而非含 current 的原 dir
    const buf = readFileSync(file) // 文件缺失 → 抛 → 整套不生效
    if (buf.byteLength > MAX_PROMPT_BYTES) {
      throw new Error(
        `${PROMPT_FILES[key]} 超出单文件上限 ${MAX_PROMPT_BYTES}B(实际 ${buf.byteLength}B)`,
      )
    }
    const text = utf8Decoder.decode(buf) // 非 UTF-8 → 抛
    if (text.trim().length === 0) throw new Error(`${PROMPT_FILES[key]} 为空`)
    // m2:必需占位符缺失即整套失败(注入契约不被 bundle 侧误删而静默断裂)。
    for (const ph of REQUIRED_PLACEHOLDERS[key]) {
      if (!text.includes(ph)) throw new Error(`${PROMPT_FILES[key]} 缺必需占位符 ${ph}`)
    }
    prompts[key] = text
  }
  return { rev, prompts }
}

/** 尝试加载整套;成功 → 替换快照;失败 → 保留 LKG(或首次失败保持 null)+ console.error 告警。 */
function tryLoad(reason: string): void {
  if (!promptsDir) return
  try {
    snapshot = readValidatedSet(promptsDir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(
      `[platform-prompts] 加载失败(${reason}),保留${snapshot ? 'last-known-good 快照' : '代码内 fallback'}:`,
      msg,
    )
  }
}

/** 首次访问时惰性初始化:读 env;未设则永不轮询;已设则启动整套读取。 */
function ensureInitialized(): void {
  if (initialized) return
  initialized = true
  const dir = process.env[ENV_DIR_KEY]?.trim()
  if (!dir) {
    promptsDir = null // 个人版:零文件依赖、零轮询
    return
  }
  promptsDir = dir
  lastPollAt = Date.now()
  tryLoad('startup')
}

/** TTL 门控下按 rev 变化触发整套重读(访问时轮询,无常驻定时器)。 */
function maybePoll(): void {
  if (!promptsDir) return
  const now = Date.now()
  if (now - lastPollAt < TTL_MS) return
  lastPollAt = now
  let currentRev: string | null = null
  try {
    currentRev = realpathSync(promptsDir)
  } catch {
    // realpath 失败(如翻转中 symlink 暂断)→ 落到 tryLoad(内部会再失败并保留 LKG+告警)。
  }
  if (currentRev !== null && snapshot && currentRev === snapshot.rev) return // rev 未变,跳过重读
  tryLoad('ttl-reload')
}

/**
 * 同步读取平台静态 prompt。
 * @param key 三个平台 prompt 之一。
 * @param fallback 消费方拥有的个人版权威文案(env 未设/加载失败时返回它)。
 */
export function getPlatformPrompt(key: PlatformPromptKey, fallback: string): string {
  ensureInitialized()
  maybePoll()
  if (snapshot && snapshot.prompts[key] !== undefined) return snapshot.prompts[key]
  return fallback
}

/** 测试内部钩子(非稳定 API)。 */
export const _internals = {
  TTL_MS,
  MAX_PROMPT_BYTES,
  PROMPT_FILES,
  REQUIRED_PLACEHOLDERS,
  /** 复位模块级状态,使下一次 getPlatformPrompt 重新读 env。 */
  resetForTests(): void {
    initialized = false
    promptsDir = null
    snapshot = null
    lastPollAt = 0
  },
  /** 绕过 TTL 门控强制一次 rev 检查 + 按需重读(测试「翻转 rev 后重读」用)。 */
  pollNow(): void {
    lastPollAt = 0
    maybePoll()
  },
  /** 当前快照 rev(null = 未加载成功)。 */
  currentRev(): string | null {
    return snapshot?.rev ?? null
  },
  /** 是否持有已校验快照(区分「LKG 生效」与「回落 fallback」)。 */
  hasSnapshot(): boolean {
    return snapshot !== null
  },
}
