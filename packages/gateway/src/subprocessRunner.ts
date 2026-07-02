import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { type McpServerConfig, type OpenClaudeConfig, paths } from '@openclaude/storage'
import { createLogger } from './logger.js'
import {
  OPENCLAUDE_VISION_MCP_ID,
  OPENCLAUDE_VISION_TOOLS,
  shouldEnableOpenClaudeVision,
} from './mcpVisionServer.js'
import { modelHintAppliedTotal } from './metrics.js'
import { buildPromptContext } from './promptSlots.js'
import type { ExecutionTarget } from './remoteTarget.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import { type TerminalBackend, createBackend } from './terminalBackend.js'

const runnerLog = createLogger({ module: 'subprocessRunner' })

/**
 * 构造容器侧 OC_REMOTE_* env。
 *
 * 宿主侧 mux 路径:`/run/ccb-ssh/u<uid>/h<hid>/{ctl.sock,known_hosts}`
 * 容器侧挂载:supervisor 把 host `/run/ccb-ssh/u<uid>` bind ro 到容器 `/run/ccb-ssh`
 * 所以容器内可见路径:`/run/ccb-ssh/h<hid>/{ctl.sock,known_hosts}`
 *
 * 这里直接按 hostId 重新拼容器侧绝对路径,不复用 hostMeta.controlPath —— 后者
 * 是宿主路径,容器里不存在。
 */
function buildRemoteTargetEnv(target: ExecutionTarget | undefined): Record<string, string> {
  if (!target || target.kind !== 'remote') {
    // 确保切回 local 时 CCB 看到的是空串 —— 不留 inherit 下来的旧值
    return {
      OC_REMOTE_TARGET: '',
      OC_REMOTE_HOST_ID: '',
      OC_REMOTE_CTL_SOCK: '',
      OC_REMOTE_KNOWN_HOSTS: '',
      OC_REMOTE_USER: '',
      OC_REMOTE_HOST: '',
      OC_REMOTE_PORT: '',
      OC_REMOTE_WORKDIR: '',
    }
  }
  const { hostId, hostMeta } = target
  const containerBase = `/run/ccb-ssh/h${hostId}`
  return {
    OC_REMOTE_TARGET: 'ssh',
    OC_REMOTE_HOST_ID: hostId,
    OC_REMOTE_CTL_SOCK: `${containerBase}/ctl.sock`,
    OC_REMOTE_KNOWN_HOSTS: `${containerBase}/known_hosts`,
    OC_REMOTE_USER: hostMeta.username,
    OC_REMOTE_HOST: hostMeta.host,
    OC_REMOTE_PORT: String(hostMeta.port),
    OC_REMOTE_WORKDIR: hostMeta.remoteWorkdir,
  }
}

/**
 * V3 S12e CG8 — contract C 段(best-effort)spawn-time trace env.
 *
 * 返回单 key 的 env overlay,固定 spread 到 backend.spawn({env}) 后段,**always
 * 覆盖**任何上游进程 env 上可能继承下来的 OPENCLAUDE_TRACE_ID(故采空串而非
 * key-omission)。
 *
 * 设计要点:
 *   - **空串而非省略**:env 块以 `...process.env` 起,如果省 key,gateway 自身
 *     process.env 里若意外有 `OPENCLAUDE_TRACE_ID` 会被 CCB 继承,语义错位。
 *     固定写 `''` 等同显式"本 spawn 无 trace stash"。
 *   - **单 key 形状**:与 `buildRemoteTargetEnv` 平行,放在同一处方便审计。
 *   - **首次 spawn / 重启 spawn 都用此 helper**:opts.traceId 是 sessionManager
 *     在 lock 内 mutate 的最新值,任何 re-spawn 通过 `this.opts.traceId` 读到当前
 *     trace。
 *
 * 见 docs/V3_S12e_PLAN_2026-05-11.md §492-497(contract C 段)。
 */
export function _buildCcbSpawnTraceEnv(
  traceId: string | undefined,
): { OPENCLAUDE_TRACE_ID: string } {
  return { OPENCLAUDE_TRACE_ID: traceId ?? '' }
}

/**
 * The model CCB uses for its hidden secondary calls — notably WebFetch's
 * applyPromptToMarkdown (queryHaiku → getSmallFastModel), plus a few hook /
 * search helpers. Upstream CCB defaults this to Haiku via ANTHROPIC_SMALL_FAST_MODEL.
 *
 * On v5 both prior behaviours were broken:
 *   - No pin → CCB fell back to `claude-haiku-4-5`, an OAuth-pool Claude request.
 *     The v5 pool has ~1 active Claude account, so WebFetch's secondary call
 *     failed with ACCOUNT_POOL_UNAVAILABLE / HTTP 402.
 *   - Pinning to the *main* static model → a plain thinking-disabled extraction
 *     ran on a heavyweight thinking model (glm-5.2 / deepseek-v4-pro). Ark rejects
 *     that request shape with upstream 400, surfaced to the agent as gateway 502.
 * Real session `webmr1zp65b2x07pe` (glm-5.2) hit both: WebFetch → 502 (upstream 400)
 * and → 402.
 *
 * Root fix: decouple the utility model from the main model and pin it to ONE
 * dedicated cheap static-key model. deepseek-v4-flash is the right choice: cheap,
 * 1M context, strong Chinese, no thinking-format quirks, and it never touches the
 * OAuth account pool. The commercial master's anthropicProxy dispatches by model
 * name (isDeepseekModel), so this routes correctly for any proxy-routed session
 * regardless of its main model.
 *
 * The caller gates this: it is applied only when the container routes through the
 * commercial proxy, NOT when host OAuth points CCB directly at api.anthropic.com
 * (where deepseek-v4-flash is not a valid model and Haiku must stay the default).
 * Ops can override the pinned model via OPENCLAUDE_SECONDARY_MODEL.
 */
export const DEFAULT_SECONDARY_UTILITY_MODEL = 'deepseek-v4-flash'

export function _buildSecondaryUtilityModelEnv(): Record<string, string> {
  const model =
    process.env.OPENCLAUDE_SECONDARY_MODEL?.trim() || DEFAULT_SECONDARY_UTILITY_MODEL
  return { ANTHROPIC_SMALL_FAST_MODEL: model }
}

/** Three-candidate fallback for resolving the bundled `openclaude-memory`
 *  MCP server entry path. Returns the first existing absolute path, or `null`
 *  if none exist (caller decides whether to log+skip or fall back to no MCP).
 *
 *  @param claudeCodePath Optional CCB install root. Used to construct the
 *    third candidate (the path inside the v3 commercial container image). */
export function resolveMcpMemoryEntry(claudeCodePath?: string): string | null {
  const moduleDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
  const candidates: string[] = [
    resolve(moduleDir, '../../mcp-memory/src/index.ts'),
    resolve(process.cwd(), 'packages/mcp-memory/src/index.ts'),
  ]
  if (claudeCodePath) {
    candidates.push(resolve(claudeCodePath, '..', 'openclaude/packages/mcp-memory/src/index.ts'))
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Resolve the built-in OpenClaude vision MCP entry used by CCB text-only
 * providers (DeepSeek/custom). Mirrors resolveMcpMemoryEntry's three layouts:
 * source checkout, process.cwd() checkout, and v3 runtime image layout. */
export function resolveOpenClaudeVisionEntry(claudeCodePath?: string): string | null {
  const moduleDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
  const candidates: string[] = [
    resolve(moduleDir, 'mcpVisionServer.ts'),
    resolve(process.cwd(), 'packages/gateway/src/mcpVisionServer.ts'),
  ]
  if (claudeCodePath) {
    candidates.push(
      resolve(claudeCodePath, '..', 'openclaude/packages/gateway/src/mcpVisionServer.ts'),
    )
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Build the env table for the built-in openclaude-vision MCP server child.
 *  Used by CCB text-only providers (DeepSeek/custom) that need understand_image
 *  via the MiniMax-backed vision MCP. */
export function buildOpenClaudeVisionMcpEnv(
  agentId: string,
  opts: { containerTokenFile?: string } = {},
): Record<string, string> {
  return {
    OPENCLAUDE_AGENT_ID: agentId,
    ...(process.env.OPENCLAUDE_HOME ? { OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME } : {}),
    ...(process.env.OPENCLAUDE_VISION_TIMEOUT_MS
      ? { OPENCLAUDE_VISION_TIMEOUT_MS: process.env.OPENCLAUDE_VISION_TIMEOUT_MS }
      : {}),
    ...(process.env.OPENCLAUDE_VISION_MAX_IMAGE_BYTES
      ? {
          OPENCLAUDE_VISION_MAX_IMAGE_BYTES: process.env.OPENCLAUDE_VISION_MAX_IMAGE_BYTES,
        }
      : {}),
    ...(process.env.OPENCLAUDE_VISION_MAX_CONCURRENT
      ? { OPENCLAUDE_VISION_MAX_CONCURRENT: process.env.OPENCLAUDE_VISION_MAX_CONCURRENT }
      : {}),
    ...(process.env.OPENCLAUDE_V3_MASTER_BASE_URL
      ? { OPENCLAUDE_V3_MASTER_BASE_URL: process.env.OPENCLAUDE_V3_MASTER_BASE_URL }
      : {}),
    // minimax vision backend 经容器 internal anthropic proxy 调 MiniMax-M3。base url 非 secret,
    // 可直接放 env;bearer 走 containerTokenFile(下方,token file,不进 argv)。
    ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
    ...(process.env.OPENCLAUDE_VISION_BACKEND
      ? { OPENCLAUDE_VISION_BACKEND: process.env.OPENCLAUDE_VISION_BACKEND }
      : {}),
    ...(opts.containerTokenFile
      ? { OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: opts.containerTokenFile }
      : process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
        ? { OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN }
        : {}),
  }
}

// ───────────────────────────────────────────────
// SubprocessRunner
//
// 给单个 sessionKey 长驻一个 CCB 子进程。
// CCB 命令行:
//   <runtime> <ccb-entry> -p \
//     --input-format=stream-json \
//     --output-format=stream-json \
//     --include-partial-messages \
//     [--resume <sessionId>] \
//     [--system-prompt-file <persona>] \
//     [--add-dir <cwd>] \
//     [--permission-mode <mode>]
//
// 我们写入 stdin 一行 JSON(SDK user message),从 stdout 读流式 JSONL(SDK 消息流)。
// CCB 自己处理 auth(订阅 OAuth / API key)、工具循环、压缩、CLAUDE.md。
// ───────────────────────────────────────────────

export interface SubprocessRunnerOpts {
  sessionKey: string
  agentId: string
  /** Phase 5 重命名(原 `cwd`):agent 的项目基础目录 = 没绑定 GitHub repo 时
   *  CCB 的 --add-dir / Docker workspaceHostDir。绑了 ready repo 时,本字段
   *  会被 effectiveAddDir(由 getRepoSnapshot 返的 workspaceDir)覆盖。 */
  agentBaseDir: string
  config: OpenClaudeConfig
  persona?: string // 注入 system prompt 的文件
  model?: string
  permissionMode?: string
  resumeSessionId?: string // 续上之前的 CCB session
  // Per-agent overrides
  agentProvider?: string // 覆盖 config.provider
  agentMcpServers?: McpServerConfig[] // agent 专属 MCP servers
  agentToolsets?: string[] // resolved toolsets for this agent (filters MCP servers)
  delegationDepth?: number // current delegation recursion depth (0 = top-level)
  // Optional CCB effort level passed via env (CLAUDE_CODE_EFFORT_LEVEL).
  // When undefined, no env var is set and CCB falls back to its model-default
  // effort (typically "high" on Opus 4.7 per Anthropic API). Only set values
  // CCB recognises in EFFORT_LEVELS — currently 'low'|'medium'|'high'|'xhigh'|'max'.
  // Source-of-truth lives in claude-code-best/src/utils/effort.ts.
  effortLevel?: string
  /**
   * 执行目标。undefined / { kind:'local' } → CCB 所有工具在本地容器里执行(默认)。
   * { kind:'remote', ... } → 下次 spawn 时注入 OC_REMOTE_* env,CCB RemoteExecutor
   * 启用 ssh ControlMaster 分支。env 只在 spawn 时读,调用 setExecutionTarget()
   * 后需要 shutdown() 让下次 submit 触发重启才能生效 —— 与 setEffortLevel 同构。
   */
  executionTarget?: ExecutionTarget
  /** Phase 5:peerId / sessionId(用于 getRepoSnapshot 查询当前 repo 状态)。
   *  理论上 sessionKey 已经能推出 sessionId,但为避免重复解析串错,显式传。
   *  null/undefined → 不查 repo snapshot(Codex / 旧调用兼容)。 */
  sessionId?: string
  /** Phase 5:读 SessionRepoWorkspaceManager 的 RepoSnapshot(单进程下即权威 state)。
   *  在 start() 内调用一次,用于:
   *    1) 决定 effective addDir(ready 时切到 workspaceDir,其它情况 fall-back agentBaseDir)
   *    2) 写 _boundRepoBinding(只有 ready 状态才记)
   *  undefined 或返 null → 等同于"未绑定",addDir = agentBaseDir。 */
  getRepoSnapshot?: (sessionId: string) => RepoSnapshot | null
  /** V3 S12e CG8 — contract C(best-effort)turn trace stash for env injection.
   *  当 spawn 发生时通过 `OPENCLAUDE_TRACE_ID` env 注入,CCB 子进程内部如何使用是
   *  CCB 仓事,gateway 端不验证(S12e 不算贯通硬门)。
   *
   *  生命周期与 `effortLevel` / `model` / `executionTarget` 同构:
   *    - 缓存在 opts 上,**只在 spawn 时被读**;长驻进程内 setTraceId() 不影响当前
   *      子进程,需触发 shutdown() / 等下次 submit() 自动 respawn 才生效。
   *    - 后续 turn 的 traceId 物理上无法 refresh 到已 spawn 的 env(env 在 fork
   *      时确定);完整 per-turn CCB trace 接收要走 stdin JSON-RPC 扩展,留 S11c。
   *
   *  通过 `setTraceId()` 在 sessionManager.submit() 的 lock 内 mutate;无 side
   *  effect(不主动 restart),与现有 setEffortLevel/setModel 同步。 */
  traceId?: string
  /**
   * Workload tag threaded to CCB's `--workload <tag>` flag, which CCB writes
   * into `x-anthropic-billing-header` as `cc_workload=<tag>`. Anthropic uses
   * it to route e.g. cron-initiated traffic to a lower-QoS pool, keeping
   * automated background calls from competing with interactive user calls
   * for rate-limit headroom.
   *
   * Runner creation-time attribute — fixed for the life of the subprocess.
   * Don't try to mutate per-turn: CCB consumes the value through
   * `runWithWorkload(cmd.workload ?? options.workload, ...)` in print.ts and
   * `options.workload` is set once at process startup.
   *
   * CCB sanitizer accepts lowercase `[a-z0-9_-]{0,32}` only — callers should
   * pass values matching that shape (currently only `'cron'`).
   */
  workload?: string
  /**
   * Skill-training run id. Set ONLY when this session is a SkillOpt training run;
   * forwarded to the mcp-memory subprocess as `OPENCLAUDE_SKILL_TRAIN_RUN_ID`, which
   * gates the draft-only `skill_propose` tool and binds its writes to this run.
   * Spawn-time attribute (read once when the mcp env is built), like delegationDepth.
   */
  skillTrainRunId?: string
  /** Skill-eval 会话标记(禁 skill 写入,mcp env OPENCLAUDE_SKILL_EVAL_MODE=1)。 */
  skillEvalMode?: boolean
  /** Skill-eval 'without' arm:隐藏该技能(prompt SKILLS 摘要 + mcp skill_* 双侧)。 */
  skillEvalExclude?: string
  /** Skill-eval 'draft' arm:以草稿目录替换该技能。 */
  skillEvalDraft?: { name: string; dir: string }
}

// CCB 输出的 SDK message 类型(简化):兼容 stream-json 输出
export interface SdkMessage {
  type: string
  subtype?: string
  session_id?: string
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      is_error?: boolean
    }>
    stop_reason?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  result?: string
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
}

/** Permission response from the user (sent back to CCB as control_response) */
export type PermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string }

/**
 * Inputs for `buildCcbCliArgs`. Everything that influences the subprocess's
 * CLI argv lives here so the argv construction is a pure function — trivially
 * unit-testable, no side effects, no file I/O.
 */
export interface CcbCliArgsInput {
  /** e.g. 'bun' or 'node' (maps to `run` vs `--experimental-strip-types`) */
  runtime: string
  /** Entry file path, e.g. src/entrypoints/cli.tsx */
  entry: string
  model?: string
  permissionMode?: string
  extraPromptFile?: string
  mcpConfigFile?: string
  addDir?: string
  resumeSessionId?: string | null
  /**
   * 屏蔽 CCB 的 Project / Local CLAUDE.md 自动扫描,只读 User memory
   * (= `${CLAUDE_CONFIG_DIR}/CLAUDE.md`,在 v3 商业版容器里就是平台基线 ro mount)。
   *
   * 商业版 v3 用户容器镜像里 `/opt/openclaude/` 仓库副本含 `CLAUDE.md`、
   * `claude-code-best/CLAUDE.md` 等内部文件,默认情况下 CCB 项目内存父链扫描会
   * 把它们注入系统提示 → 个人版 dev 流程 / 反编译声明等敏感信息泄露给商业版用户。
   * 启用此项后,CCB 启动时传 `--setting-sources user`,Project + Local 全跳过,
   * 仅保留平台显式 mount 的 baseline CLAUDE.md(走 User memory 通道)。
   *
   * 个人版 / dev 实例不应启用 —— boss 自己使用时仍要 Project memory(本仓 CLAUDE.md)。
   */
  restrictedMemorySources?: boolean
  /**
   * Workload tag → CCB `--workload <tag>` → `cc_workload=<tag>` in the
   * attribution header. CCB sanitizer rejects anything outside
   * `[a-z0-9_-]{0,32}`, so pass only lowercase short tags
   * (currently only `'cron'`).
   */
  workload?: string
}

/**
 * Build the argv array that we pass to the CCB subprocess.
 *
 * IMPORTANT invariant: `--permission-prompt-tool stdio` is always present,
 * regardless of `permissionMode`. CCB's permissions.ts step 1e keeps
 * `requiresUserInteraction()` tools (AskUserQuestion, ExitPlanMode, …)
 * bypass-immune — they still return `behavior:'ask'` even in
 * bypassPermissions mode. Without a permission-prompt-tool, that ask falls
 * through `getCanUseToolFn`'s fallback branch in CCB's print.ts and
 * toolExecution.ts then treats the unresolved ask as a deny, surfacing the
 * tool's raw ask-message (e.g. "Answer questions?") as the tool error.
 *
 * Non-interactive tools are unaffected — step 2a's bypass-allow in
 * permissions.ts fires before any ask result is ever produced for them.
 */
export function buildCcbCliArgs(input: CcbCliArgsInput): string[] {
  const {
    runtime,
    entry,
    model,
    permissionMode,
    extraPromptFile,
    mcpConfigFile,
    addDir,
    resumeSessionId,
    restrictedMemorySources,
    workload,
  } = input
  const args: string[] = [
    runtime === 'bun' ? 'run' : '--experimental-strip-types',
    entry,
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
  ]
  if (model) args.push('--model', model)
  if (permissionMode) {
    args.push('--permission-mode', permissionMode)
    // bypassPermissions 需要配合 --dangerously-skip-permissions 才真正放行所有工具
    if (permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    }
  }
  // See function JSDoc: stdio prompting must be enabled in ALL modes so CCB
  // emits `can_use_tool` control_requests on stdout that the gateway bridges
  // to the web frontend. Required even under bypassPermissions for
  // interactive tools like AskUserQuestion.
  args.push('--permission-prompt-tool', 'stdio')
  // Single merged prompt file: persona + identity + platform + skills + memory
  // (Cannot pass --append-system-prompt-file twice; Commander takes last value only)
  if (extraPromptFile) args.push('--append-system-prompt-file', extraPromptFile)
  // Wire up MCP memory/skills/search server
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile)
  if (addDir) args.push('--add-dir', addDir)
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  // v3 商业版用户容器: 只允许 User memory(=平台 baseline ro mount), Project/Local 全跳过。
  // 见 CcbCliArgsInput.restrictedMemorySources 注释。
  if (restrictedMemorySources) args.push('--setting-sources', 'user')
  // CCB `--workload <tag>` is a hidden CLI flag intended for SDK daemon
  // callers that spawn CCB for background work (cron / scheduled tasks).
  // The tag is wrapped around every turn via runWithWorkload() in print.ts
  // and surfaces as `cc_workload=<tag>` in x-anthropic-billing-header,
  // letting Anthropic route the traffic at a lower QoS.
  if (workload) args.push('--workload', workload)
  // 必须给一个 prompt placeholder,CCB stream-json 会从 stdin 接管
  args.push('')
  return args
}

// Cap for in-memory stdout/stderr accumulation per runner. If CCB ever emits
// a chunk without newline (malformed output, corrupt base64, wedged write),
// the buffer can grow unboundedly and eat gigabytes of RSS. When we cross
// the limit we kill the subprocess and log "ccb.overflow".
//
// Configurable via OPENCLAUDE_CCB_MAX_STDOUT_BUF_BYTES (default 8 MiB,
// clamped to [1 MiB, 256 MiB]).
function readStdoutBufCap(): number {
  const raw = Number(process.env.OPENCLAUDE_CCB_MAX_STDOUT_BUF_BYTES)
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.max(raw, 1 << 20), 256 << 20)
  }
  return 8 << 20
}
const MAX_STDOUT_BUF_BYTES = readStdoutBufCap()
const MAX_STDERR_BUF_BYTES = MAX_STDOUT_BUF_BYTES // same cap applies to stderr

export class SubprocessRunner extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  /**
   * Cached UTF-8 byte count of `stdoutBuf`. Updated incrementally on append
   * and line-flush so per-chunk cap checks are O(1) instead of O(len).
   */
  private stdoutBufBytes = 0
  /** Running byte count for stderr within a single "line" window — caps runaway stderr. */
  private stderrBufBytes = 0
  private currentSessionId: string | null = null
  /**
   * Count of `_oc_telemetry` lines silently dropped because their `session_id`
   * field was missing or empty. Design rule: telemetry session_id is runtime
   * expected but implementation tolerates absence (drop + count, don't error).
   * See docs/ccb-telemetry-refactor-plan.md §3.1 + §5.1.
   */
  private missingSessionIdCount = 0
  private starting = false
  private closed = false
  private shuttingDown = false
  // ── Crash-loop supervision (exponential backoff) ──
  // Every time the subprocess exits unexpectedly (or start() throws before a
  // successful spawn) we increment _consecutiveCrashes and push _backoffUntil
  // forward. Subsequent start() calls refuse until the backoff window expires,
  // protecting the host from runaway fork/spawn storms when a config is broken
  // or CCB immediately segfaults. The counter resets to 0 when the process
  // either shuts down cleanly OR stayed up long enough to be considered stable
  // (STABLE_UPTIME_MS), so isolated crashes after a long run don't immediately
  // trigger seconds-long backoffs.
  private _consecutiveCrashes = 0
  private _backoffUntil = 0
  private _lastStartAt = 0
  private static BACKOFF_BASE_MS = 500
  private static BACKOFF_MAX_MS = 30_000
  private static STABLE_UPTIME_MS = 5 * 60_000
  /** True once we force-killed due to buffer overflow; prevents double-kill. */
  private overflowKilled = false
  private sessionDir: string | null = null
  /** Timestamp of last stdout activity — used for liveness detection */
  public lastActivityAt: number = Date.now()

  constructor(private opts: SubprocessRunnerOpts) {
    super()
    this.currentSessionId = opts.resumeSessionId ?? null
  }

  get sessionId(): string | null {
    return this.currentSessionId
  }

  /** Forget the cached CCB session id. Next start() will NOT pass --resume,
   *  forcing CCB to allocate a fresh session. Used by sessionManager when a
   *  previous run failed with "No conversation found with session ID: ..." —
   *  without this, the runner keeps re-requesting the same dead id every
   *  restart and perpetually crashes. */
  clearSessionId(): void {
    this.currentSessionId = null
  }

  /** Update config (e.g. after OAuth token refresh). Takes effect on next start(). */
  updateConfig(config: OpenClaudeConfig): void {
    this.opts.config = config
  }

  /** Current effort level (used by sessionManager.getOrCreate to detect changes
   *  before deciding whether to recycle the subprocess). */
  get effortLevel(): string | undefined {
    return this.opts.effortLevel
  }

  /** Update effort level. Caller is responsible for restarting the subprocess
   *  (via shutdown(); next submit() auto-restarts) for the new value to take
   *  effect — env vars are only read at process startup. */
  setEffortLevel(level: string | undefined): void {
    this.opts.effortLevel = level
  }

  /** Current model id (used by sessionManager.submit to detect changes
   *  before deciding whether to recycle the subprocess). 2026-04-26 v1.0.4
   *  起新增,配合 InboundMessage.model 让用户在前端 pill 切模型生效。 */
  get model(): string | undefined {
    return this.opts.model
  }

  /** Update model. Caller is responsible for restarting the subprocess
   *  (via shutdown(); next submit() auto-restarts) for the new value to take
   *  effect — model is only passed as `--model` cli arg at spawn time. */
  setModel(model: string | undefined): void {
    this.opts.model = model
  }

  /** Current resolved toolsets. Toolsets are consumed only when writing the
   *  MCP config before subprocess spawn, so callers must restart the runner
   *  after changing this value. */
  get toolsets(): string[] | undefined {
    return this.opts.agentToolsets
  }

  /** Update resolved toolsets for the next spawn. Pure opts mutator, parallel
   *  to setModel / setEffortLevel; no subprocess side effects. */
  setToolsets(toolsets: string[] | undefined): void {
    this.opts.agentToolsets = toolsets
  }

  /** Current execution target (used by sessionManager to detect changes). */
  get executionTarget(): ExecutionTarget {
    return this.opts.executionTarget ?? { kind: 'local' }
  }

  /** Update execution target. Caller must restart the subprocess (shutdown()
   *  + next submit() auto-restarts) for OC_REMOTE_* env to be re-read. */
  setExecutionTarget(target: ExecutionTarget): void {
    this.opts.executionTarget = target
  }

  /** V3 S12e CG8 — current trace id stash(opts-only, no in-flight effect).
   *  See SubprocessRunnerOpts.traceId JSDoc for lifecycle. */
  get traceId(): string | undefined {
    return this.opts.traceId
  }

  /** V3 S12e CG8 — update trace id stash. Caller is responsible for the
   *  restart-on-effort/model-change path; on its own this is a pure mutator
   *  with NO subprocess side effects(parallel to setEffortLevel / setModel).
   *  The new value will land in `OPENCLAUDE_TRACE_ID` env at the *next* spawn
   *  (or re-spawn triggered elsewhere in this submit's lock). */
  setTraceId(traceId: string | undefined): void {
    this.opts.traceId = traceId
  }

  /** Phase 5:本进程启动时是否绑定到 ready repo workspace。
   *  null = 未 ready-bound(未绑 / cloning / failed / 还没 start);
   *  非 null = 本 runner 当前活跃进程在 spawn 时拿到的 ready snapshot,
   *  recycle 决策(sessionManager.recyclePeerForRepoChange)用此字段比版本。 */
  private _boundRepoBinding: { selectionVersion: number; workspaceDir: string } | null = null

  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return this._boundRepoBinding
  }

  /** True if the subprocess is currently alive or being started */
  get isRunning(): boolean {
    return (this.proc !== null && !this.closed) || this.starting
  }

  async start(): Promise<void> {
    if (this.proc || this.starting) return
    // ── Crash-loop gate ──
    // If the previous crash(es) pushed _backoffUntil into the future, refuse to
    // spawn until the window passes. This prevents fork storms when CCB is
    // wedged on a broken config / immediate segfault. The window only exists
    // after _recordCrash() has set it, so normal startup is unaffected.
    const gateNow = Date.now()
    if (gateNow < this._backoffUntil) {
      const waitSeconds = Math.ceil((this._backoffUntil - gateNow) / 1000)
      throw new Error(
        `CCB subprocess is crash-looping; please wait ${waitSeconds}s before retrying (${this._consecutiveCrashes} consecutive crashes)`,
      )
    }

    this.starting = true
    this.closed = false
    this.overflowKilled = false
    this.stdoutBuf = ''
    this.stdoutBufBytes = 0
    this.stderrBufBytes = 0

    // Wrap the entire setup in try/catch so ANY pre-spawn failure (config
    // resolution, buildLearningContext, backend.spawn, …) records a crash and
    // triggers backoff. Without this, a start() that throws before `this.proc`
    // is assigned would never bump _consecutiveCrashes, and the caller could
    // retry immediately and re-throw, burning CPU.
    try {
    const { config } = this.opts
    let ccbDir: string
    try {
      ccbDir = resolve(config.auth.claudeCodePath)
    } catch (err) {
      this.starting = false
      throw err
    }
    if (!existsSync(ccbDir)) {
      this.starting = false
      throw new Error(
        `Claude Code path not found: ${ccbDir}. Set auth.claudeCodePath in ~/.openclaude/openclaude.json`,
      )
    }
    const entryRaw = config.auth.claudeCodeEntry ?? 'src/entrypoints/cli.tsx'
    // Phase 5:子进程 cwd 即将切到 effectiveAddDir(repo workspaceDir 或 agentBaseDir),
    // 不再是 ccbBinaryDir。entry 若是相对路径(默认 'src/entrypoints/cli.tsx'),
    // 在新 cwd 下会找不到文件。这里相对于 ccbBinaryDir 解析成绝对路径,无论
    // 是 'bun run /abs/cli.tsx' 还是 'node --experimental-strip-types /abs/cli.tsx'
    // 都能正确加载。已经是绝对路径(用户在 openclaude.json 自定义)的就直传。
    const entry = isAbsolute(entryRaw) ? entryRaw : resolve(ccbDir, entryRaw)
    const runtime = config.auth.claudeCodeRuntime ?? 'bun'

    // ─── Phase 5: read repo snapshot ONCE before learning context + spawn args ──
    // ready 时切到 repo workspaceDir,其它情况(null / cloning / failed)fall-back agentBaseDir。
    // _boundRepoBinding 只在 ready 时记录,recycle 决策(sessionManager.recyclePeerForRepoChange)
    // 据此判断是否 cwd-version 错位。
    let repoSnapshot: RepoSnapshot | null = null
    if (this.opts.sessionId && this.opts.getRepoSnapshot) {
      try {
        repoSnapshot = this.opts.getRepoSnapshot(this.opts.sessionId)
      } catch (err) {
        runnerLog.warn(
          'getRepoSnapshot threw; treating as no-bind',
          { sessionKey: this.opts.sessionKey },
          err,
        )
        repoSnapshot = null
      }
    }
    const effectiveAddDir =
      repoSnapshot?.status === 'ready' && repoSnapshot.workspaceDir
        ? repoSnapshot.workspaceDir
        : this.opts.agentBaseDir
    if (repoSnapshot?.status === 'ready' && repoSnapshot.workspaceDir) {
      this._boundRepoBinding = {
        selectionVersion: repoSnapshot.selectionVersion,
        workspaceDir: repoSnapshot.workspaceDir,
      }
    } else {
      this._boundRepoBinding = null
    }

    // ─── L1/L2/L3: prepare learning-loop context for the subprocess ───
    let learningContext: { extraPromptFile?: string; mcpConfigFile?: string }
    try {
      learningContext = await this.buildLearningContext(repoSnapshot)
    } catch (err) {
      this.starting = false
      // _boundRepoBinding 已在 439-444 落字段;start() 抛错没真正 spawn,清掉
      // 避免 isRunning=false + binding!=null 的不变量割裂。
      this._boundRepoBinding = null
      throw err
    }

    const args = buildCcbCliArgs({
      runtime,
      entry,
      model: this.opts.model,
      permissionMode: this.opts.permissionMode,
      extraPromptFile: learningContext.extraPromptFile,
      mcpConfigFile: learningContext.mcpConfigFile,
      addDir: effectiveAddDir,
      resumeSessionId: this.currentSessionId,
      // v3 商业版用户容器判定。双信号 OR 兜底:
      //  - OC_CONTAINER_ID:私有 env,v3supervisor 仅在 bridgeSecret 就位时注入(语义最清晰)。
      //  - CLAUDE_CONFIG_DIR === '/run/oc/claude-config':v3supervisor.ts:1189 无条件注入,
      //    即使 bridgeSecret 缺失(降级模式,容器无 OC_CONTAINER_ID)依然能识别为 v3 容器。
      // 个人版 master / dev 都不会出现这两条之一,信号空间不重叠。
      restrictedMemorySources:
        !!process.env.OC_CONTAINER_ID ||
        process.env.CLAUDE_CONFIG_DIR === '/run/oc/claude-config',
      workload: this.opts.workload,
    })

    // ── Provider-aware auth injection ──
    // CCB auth priority: ANTHROPIC_AUTH_TOKEN > CLAUDE_CODE_OAUTH_TOKEN > settings.json
    // We must inject the right env vars per provider so CCB routes to the correct API.
    const providerEnv: Record<string, string> = {}
    const effectiveProvider = this.opts.agentProvider ?? this.opts.config.provider

    // True only when host OAuth is injected below and CCB is pointed DIRECT at
    // api.anthropic.com (ANTHROPIC_BASE_URL wiped). In that mode the hidden
    // secondary model must stay an Anthropic-native model, so we skip the
    // deepseek-v4-flash pin (deepseek is not routable at api.anthropic.com).
    let routesDirectToAnthropic = false

    if (effectiveProvider === 'claude-subscription') {
      // Claude subscription: inject OAuth token, route to Anthropic API
      //
      // CRITICAL: Tell CCB that the host owns provider routing.
      // Without this, CCB's managedEnv.ts will Object.assign settings.json env
      // (ANTHROPIC_BASE_URL=minimax, ANTHROPIC_AUTH_TOKEN=minimax_key) OVER our
      // spawn env, routing Claude requests to MiniMax instead of Anthropic.
      // With this flag, CCB strips provider vars from settings.json during load.
      providerEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      if (this.opts.config.auth.claudeOAuth?.accessToken) {
        providerEnv.CLAUDE_CODE_OAUTH_TOKEN = this.opts.config.auth.claudeOAuth.accessToken
        // Host is injecting its own Claude OAuth for direct Anthropic routing.
        // Wipe any inherited ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN so a user
        // settings.json can't redirect CCB to a Minimax-compatible endpoint and
        // steal OAuth-authed traffic. MANAGED_BY_HOST alone strips these from
        // settings-sourced env, but a stray export in the gateway's own shell
        // env could still bleed through — defense in depth.
        providerEnv.ANTHROPIC_BASE_URL = ''
        providerEnv.ANTHROPIC_AUTH_TOKEN = ''
        providerEnv.ANTHROPIC_MODEL = ''
        routesDirectToAnthropic = true
      }
      // else: no host OAuth to inject — some upstream (e.g. v3 commercial
      // supervisor) has already put ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
      // into process.env at container-boot time, pointing CCB at the internal
      // proxy. Leave those alone; MANAGED_BY_HOST still protects against
      // settings.json overrides.
    } else {
      // MiniMax / DeepSeek / custom provider: DON'T inject any OAuth token.
      // Let CCB fall through to settings.json (which has ANTHROPIC_BASE_URL +
      // ANTHROPIC_AUTH_TOKEN pointing to the provider's Anthropic-compatible endpoint).
      // This is the "default" path — settings.json controls routing.
    }
    // Pin CCB's hidden secondary model (WebFetch/hook/search) to a cheap static
    // model — but ONLY when the container routes through the commercial proxy
    // (which dispatches by model name and can reach deepseek-v4-flash). In the
    // direct-Anthropic path above, leave ANTHROPIC_SMALL_FAST_MODEL unset so CCB
    // keeps its Anthropic-native Haiku default.
    if (!routesDirectToAnthropic) {
      Object.assign(providerEnv, _buildSecondaryUtilityModelEnv())
    }

    let proc: ReturnType<TerminalBackend['spawn']>
    try {
      const backend: TerminalBackend = createBackend(this.opts.config.terminal)
      proc = backend.spawn({
        command: runtime,
        args,
        ccbBinaryDir: ccbDir,
        // Docker /workspace mount + Local --add-dir 内容统一用 effectiveAddDir;
        // ready 时是 repo workspaceDir,其它情况 = agentBaseDir。
        workspaceHostDir: effectiveAddDir,
        // Phase 5:Local 模式子进程的真 cwd。Docker 模式 backend 忽略此字段
        // (容器 cwd 由 -w /workspace 控制,与 workspaceHostDir 同源)。
        // 这样 CCB 启动后 process.cwd() 就直接指向项目目录,STATE.cwd
        // 与 Bash 工具的 working directory 都跟系统提示对齐。
        subprocessCwd: effectiveAddDir,
        env: {
          ...process.env,
          ...providerEnv,
          OPENCLAUDE_SESSION_KEY: this.opts.sessionKey,
          OPENCLAUDE_AGENT_ID: this.opts.agentId,
          // Per-session effort level (xhigh / max from chat-mode pills, or
          // undefined to let CCB use its model-default — Opus 4.7 → high).
          // Empty string deletes any inherited CLAUDE_CODE_EFFORT_LEVEL so a
          // gateway-process env doesn't bleed into spawned CCBs.
          CLAUDE_CODE_EFFORT_LEVEL: this.opts.effortLevel ?? '',
          // Note: CLAUDE_CODE_DISABLE_BACKGROUND_TASKS used to be set to '1'
          // here to strip run_in_background from Bash/Agent/PowerShell tool
          // schemas (visibility band-aid for Opus 4.7 over-using background
          // mode). Removed once CCB started streaming bash_output_tail
          // SDK events at 1 Hz — the underlying UX problem (background
          // commands looking idle) is now solved end-to-end (CCB
          // sdkEventQueue → gateway ccbMessageParser → web tool_output_tail
          // block), so the model can pick run_in_background:true again.
          IS_SANDBOX: '1',
          FEATURE_VERIFICATION_AGENT: '1',
          // 禁用 CCB 自带 Kairos cron 工具(CronList/CronCreate/CronDelete)。它们操作
          // CCB 进程内的第二调度器(内存/scheduled_tasks.json),与 gateway cron.yaml
          // (管理中心/create_reminder 的权威源)天然分裂:面板建的任务 CronList 看不到,
          // 只有 CronCreate→gateway 的单向镜像桥。定时任务的唯一权威 = gateway cron,
          // agent 侧读写走 openclaude-memory MCP 的 reminder 工具族(list/create/
          // update/delete,同一 /api/cron)。
          CLAUDE_CODE_DISABLE_CRON: '1',
          // 远程执行目标:kind='remote' 时让 CCB RemoteExecutor 启用 ssh mux 分支。
          // 空串 = 本地执行(默认);OC_REMOTE_* 其余变量仅在 remote 分支设。
          // 容器里 ctl.sock 的真实路径是宿主侧 /run/ccb-ssh/u<uid>/h<hid>/ctl.sock,
          // bind 进容器后去掉 u<uid> 前缀 → /run/ccb-ssh/h<hid>/ctl.sock;
          // 因此这里把 hostMeta.controlPath/knownHostsPath 的 `/u<uid>` 部分
          // 剥掉后注入(substitute 宿主路径为容器内视图)。
          ...buildRemoteTargetEnv(this.opts.executionTarget),
          // V3 S12e CG8 — contract C 段 trace env(best-effort,放最末永远覆盖
          // process.env 继承)。空串 = "本 spawn 无 trace stash",见
          // `_buildCcbSpawnTraceEnv` JSDoc。
          ..._buildCcbSpawnTraceEnv(this.opts.traceId),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // create process group so shutdown() can kill all children
      })
    } catch (err) {
      this.starting = false
      // 见 449 catch 同理:spawn 抛错时 binding 字段已置位,清掉保不变量。
      this._boundRepoBinding = null
      throw err
    }

    this.proc = proc as unknown as ChildProcessWithoutNullStreams
    // Emit BEFORE any stdout listener is attached, so subscribers (e.g. session
    // manager's per-CCB cost-tracker reset) run strictly before any 'message'
    // or 'session_id' event of the new process can arrive.
    //
    // `resumed` tells consumers whether CCB will restore historical state on
    // start. When --resume is passed CCB calls restoreCostStateForSession
    // which sets STATE.totalCostUSD back to the persisted cumulative — so the
    // gateway's per-session cost-delta baseline must NOT be reset to 0.
    this.emit('spawn', { resumed: !!this.currentSessionId })

    proc.stdin.on('error', (err) =>
      runnerLog.warn('stdin error', { sessionKey: this.opts.sessionKey }, err),
    )
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => this.handleStdout(chunk))

    proc.stderr.setEncoding('utf-8')
    this.stderrBufBytes = 0
    proc.stderr.on('data', (chunk: string) => {
      this.lastActivityAt = Date.now() // stderr activity also counts as "alive"
      this.stderrBufBytes += Buffer.byteLength(chunk, 'utf8')
      // If stderr goes pathological (single burst > cap), kill to avoid RSS
      // blow-up from downstream listeners that might buffer all of it.
      if (this.stderrBufBytes > MAX_STDERR_BUF_BYTES) {
        this.handleBufferOverflow('stderr', this.stderrBufBytes)
        this.stderrBufBytes = 0
        return
      }
      // Reset counter on newline — stderr is usually line-oriented log output.
      if (chunk.includes('\n')) this.stderrBufBytes = 0
      this.emit('stderr', chunk)
    })

    proc.on('exit', (code, signal) => {
      this.proc = null
      this.closed = true
      // Phase 5:进程死了,清 binding。下次 start 会按当时 repo state 重新评估。
      // 哪怕本次是 graceful (recycle),session.lock 已经在 caller 那边持有,
      // 不存在 stale binding 被中间状态读到的窗口;但写下来语义更对称。
      this._boundRepoBinding = null
      // Use explicit shuttingDown flag (set by shutdown()) to distinguish
      // graceful shutdown from crash. Exit code alone is unreliable:
      // - SIGSEGV/SIGKILL → code=null but NOT graceful
      // - CCB may exit with non-0 code on normal termination
      const crashed = !this.shuttingDown
      this.shuttingDown = false
      if (crashed) {
        this._recordCrash()
      } else {
        // Graceful shutdown wipes any accumulated backoff — the operator is
        // in control, not a crash-loop, so the next start() should not be gated.
        // Also zero _lastStartAt so a post-restart crash can't consult a stale
        // "stable uptime" timestamp from this now-dead subprocess.
        this._consecutiveCrashes = 0
        this._backoffUntil = 0
        this._lastStartAt = 0
      }
      this.emit('exit', { code, signal, crashed })
    })

    proc.on('error', (err) => {
      this.emit('error', err)
    })

    // Spawn succeeded — record timestamp for STABLE_UPTIME_MS check. A crash
    // more than STABLE_UPTIME_MS after this point is treated as a fresh failure
    // (counter resets) rather than compounding on past crashes.
    this._lastStartAt = Date.now()
    this.starting = false
    } catch (err) {
      // Any failure between backoff-gate-pass and spawn-succeeded is a "start
      // failed" crash. Record it so the gate fires on the next call.
      this.starting = false
      this._recordCrash()
      throw err
    }
  }

  /**
   * Bump the crash counter and compute the next backoff window.
   * Called from the exit handler (crashed=true) and the start() catch block.
   *
   * Backoff = BASE * 2^(n-1), clamped to MAX. First crash → 500ms, second →
   * 1s, third → 2s, … up to 30s. Counters reset on graceful shutdown (see
   * exit handler) or when the previous run was stable for STABLE_UPTIME_MS.
   */
  private _recordCrash(): void {
    const now = Date.now()
    // If we had a long-lived stable run before this crash, don't punish it —
    // reset the counter so an isolated crash after hours of uptime starts
    // fresh at 500ms instead of compounding on a counter from yesterday.
    if (
      this._lastStartAt > 0 &&
      now - this._lastStartAt >= SubprocessRunner.STABLE_UPTIME_MS
    ) {
      this._consecutiveCrashes = 0
    }
    this._consecutiveCrashes++
    const expBackoff =
      SubprocessRunner.BACKOFF_BASE_MS * 2 ** (this._consecutiveCrashes - 1)
    const backoff = Math.min(expBackoff, SubprocessRunner.BACKOFF_MAX_MS)
    this._backoffUntil = now + backoff
    // Consume the stable-uptime window: _lastStartAt is only meaningful for
    // one "this crash happened after a long stable run" check. If we kept it
    // after recording the crash, repeated pre-spawn failures would all see
    // the same old timestamp, reset the counter each time, and the exponential
    // backoff would never escalate past 500ms. Only a successful spawn should
    // re-arm the window.
    this._lastStartAt = 0
    runnerLog.warn('ccb.crash — scheduling exponential backoff', {
      sessionKey: this.opts.sessionKey,
      consecutiveCrashes: this._consecutiveCrashes,
      backoffMs: backoff,
    })
  }

  private handleStdout(chunk: string): void {
    this.lastActivityAt = Date.now()

    // We scan `chunk` in place WITHOUT doing `stdoutBuf += chunk` first.
    // For each complete line formed by `stdoutBuf + chunk[0..nl]` (first line)
    // or `chunk[prev..nl]` (subsequent lines), we check the byte length
    // BEFORE materializing the full line. Only the trailing partial (no
    // newline) is appended to `stdoutBuf`. This guarantees the in-memory
    // working set never exceeds MAX_STDOUT_BUF_BYTES even if the chunk itself
    // contains multiple oversized lines.
    let offset = 0
    let firstLineConsumesBuf = this.stdoutBufBytes > 0
    while (true) {
      const nlIdx = chunk.indexOf('\n', offset)
      if (nlIdx < 0) break

      const tail = chunk.slice(offset, nlIdx)
      const tailBytes = Buffer.byteLength(tail, 'utf8')
      const lineBytes =
        (firstLineConsumesBuf ? this.stdoutBufBytes : 0) + tailBytes
      if (lineBytes > MAX_STDOUT_BUF_BYTES) {
        this.handleBufferOverflow('stdout', lineBytes)
        this.stdoutBuf = ''
        this.stdoutBufBytes = 0
        return
      }

      // Materialize the full line (≤ cap bytes), emit parsed message
      let fullLine: string
      if (firstLineConsumesBuf) {
        fullLine = this.stdoutBuf + tail
        this.stdoutBuf = ''
        this.stdoutBufBytes = 0
        firstLineConsumesBuf = false
      } else {
        fullLine = tail
      }
      const trimmed = fullLine.trim()
      if (trimmed) {
        try {
          const msg = JSON.parse(trimmed) as SdkMessage
          // OpenClaude telemetry side-channel: `_oc_telemetry` lines are
          // observability events, not SDK messages. Route them to the
          // dedicated 'telemetry' listener and skip the normal pipeline:
          //   - NEVER update currentSessionId from a telemetry line
          //     (Gateway session tracking must stay driven by real SDK
          //     messages only)
          //   - NEVER emit 'message' (parser would crash on unknown type)
          //
          // session_id on telemetry is required-but-tolerated: if missing
          // we silently drop and bump missingSessionIdCount so anomalies
          // show up in diagnostics instead of crashing.
          // Design doc: ccb-telemetry-refactor-plan.md §3.1 + §5.1.
          if ((msg as { type?: string }).type === '_oc_telemetry') {
            const telemetryMsg = msg as SdkMessage & {
              type: '_oc_telemetry'
              session_id?: string
            }
            if (
              typeof telemetryMsg.session_id !== 'string' ||
              telemetryMsg.session_id.length === 0
            ) {
              this.missingSessionIdCount++
            } else {
              this.emit('telemetry', telemetryMsg)
            }
          } else {
            // Always update session ID (CCB may report a new one after --resume)
            if (msg.session_id && msg.session_id !== this.currentSessionId) {
              this.currentSessionId = msg.session_id
              this.emit('session_id', this.currentSessionId)
            }
            this.emit('message', msg)
          }
        } catch (err) {
          this.emit('parse_error', { line: trimmed, err })
        }
      }

      offset = nlIdx + 1
    }

    // Trailing partial (no newline) — append to stdoutBuf after cap check.
    if (offset < chunk.length) {
      const trailing = offset === 0 ? chunk : chunk.slice(offset)
      const trailingBytes = Buffer.byteLength(trailing, 'utf8')
      const projected = this.stdoutBufBytes + trailingBytes
      if (projected > MAX_STDOUT_BUF_BYTES) {
        this.handleBufferOverflow('stdout', projected)
        this.stdoutBuf = ''
        this.stdoutBufBytes = 0
        return
      }
      this.stdoutBuf += trailing
      this.stdoutBufBytes += trailingBytes
    }
  }

  /**
   * Called when stdout or stderr accumulates beyond the buffer cap.
   * Emits an `overflow` event with details and kills the subprocess group.
   * Idempotent — a second trigger during the same kill window is a no-op.
   */
  private handleBufferOverflow(stream: 'stdout' | 'stderr', size: number): void {
    if (this.overflowKilled || this.closed) return
    this.overflowKilled = true
    const proc = this.proc
    const pid = proc?.pid
    const info = { stream, size, cap: MAX_STDOUT_BUF_BYTES, pid, sessionKey: this.opts.sessionKey }
    runnerLog.error('ccb.overflow — force-killing subprocess', info)
    this.emit('overflow', info)
    // Trigger an exit path: force-kill the process group so MCP children die too.
    try {
      if (pid) {
        try { process.kill(-pid, 'SIGKILL') } catch { proc?.kill('SIGKILL') }
      } else {
        proc?.kill('SIGKILL')
      }
    } catch (err) {
      runnerLog.warn('overflow kill failed', { sessionKey: this.opts.sessionKey }, err)
    }
  }

  // 发送一条 user message。CCB stream-json 输入格式:每行一个 SDK user message JSON
  // content 可以是单个字符串(全文本),也可以是完整的 Anthropic content block 数组(支持图片/多模态)
  //
  // PR2 v1.0.66 — `_requestId` 形参为兼容 sessionManager.submit 的统一签名而存在
  // (CodexAppServerRunner 才真用)。CCB 路径不消费,纯 noop;打前缀下划线表明
  // 参数有意忽略,不报 unused warning。
  async submit(
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
    _requestId?: string,
  ): Promise<void> {
    if (!this.proc) await this.start()
    if (!this.proc) throw new Error('failed to start CCB subprocess')
    const content =
      typeof userTextOrBlocks === 'string'
        ? [{ type: 'text', text: userTextOrBlocks }]
        : userTextOrBlocks
    const userMsg = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    }
    try {
      this.proc.stdin.write(`${JSON.stringify(userMsg)}\n`)
    } catch (err: any) {
      runnerLog.warn('stdin write failed', { sessionKey: this.opts.sessionKey }, err)
    }
  }

  // ─── Build per-session learning-loop context files ───
  // Writes temp files under /tmp/openclaude-<sessionKey>-XXXXXX/:
  //   extra-prompt.md   — USER.md content + skill metadata digest
  //   mcp-config.json   — MCP server pointing at @openclaude/mcp-memory
  private async buildLearningContext(repoSnapshot: RepoSnapshot | null = null): Promise<{
    extraPromptFile?: string
    mcpConfigFile?: string
  }> {
    const out: { extraPromptFile?: string; mcpConfigFile?: string } = {}
    // Use mkdtempSync for a unique per-run directory: prevents a restarted runner
    // for the same sessionKey from racing with the old runner's shutdown cleanup.
    // Clean up any previous session directory before creating a new one
    // (guards against crash/retry scenarios where start() is called again).
    this.cleanupSessionDir()
    const safeDirName = this.opts.sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')
    const sessionDir = mkdtempSync(resolve(tmpdir(), `openclaude-${safeDirName}-`))
    this.sessionDir = sessionDir

    // Resolve provider/toolset-scoped MCP availability before building the
    // prompt, so provider hints only mention tools that will really exist.
    const effectiveProvider = this.opts.agentProvider ?? this.opts.config.provider
    const toolsetDefs = this.opts.config.toolsets
    const agentToolsets = this.opts.agentToolsets
    let allowedMcpIds: Set<string> | null = null // null = no filtering (all allowed)
    if (agentToolsets && agentToolsets.length > 0 && toolsetDefs) {
      allowedMcpIds = new Set<string>()
      for (const ts of agentToolsets) {
        const ids = toolsetDefs[ts]
        if (ids) for (const id of ids) allowedMcpIds.add(id)
      }
      // Built-in 平台 MCP **总是豁免 toolset 过滤**(各自有独立 gating):
      //   - openclaude-memory:总开;
      //   - openclaude-vision:由 shouldEnableOpenClaudeVision 控制(纯文本模型 understand_image)。
      // 注:vision 之前漏了这行,导致**有 toolset 的 agent(如 main/全能助手 core toolset)拿不到
      // understand_image** —— 纯文本模型上传图被 strip 后又没工具兜底,表现为"不支持图片识别"。
      allowedMcpIds.add('openclaude-memory')
      allowedMcpIds.add(OPENCLAUDE_VISION_MCP_ID)
    }
    const openClaudeVisionAllowed =
      shouldEnableOpenClaudeVision(effectiveProvider, this.opts.model) &&
      (!allowedMcpIds || allowedMcpIds.has(OPENCLAUDE_VISION_MCP_ID))
    const openClaudeVisionEntry = openClaudeVisionAllowed
      ? resolveOpenClaudeVisionEntry(this.opts.config.auth.claudeCodePath)
      : null
    const availableMcpTools = new Set<string>()
    const addAvailableTools = (tools?: readonly string[]) => {
      for (const tool of tools ?? []) availableMcpTools.add(tool)
    }
    if (openClaudeVisionEntry) {
      addAvailableTools(OPENCLAUDE_VISION_TOOLS)
    }
    for (const srv of this.opts.config.mcpServers ?? []) {
      if (srv.enabled === false) continue
      if (srv.provider && srv.provider !== effectiveProvider) continue
      if (allowedMcpIds && !allowedMcpIds.has(srv.id)) continue
      addAvailableTools(srv.tools)
    }
    for (const srv of this.opts.agentMcpServers ?? []) {
      if (srv.enabled === false) continue
      addAvailableTools(srv.tools)
    }

    // (Marketplace skills/agents are reconciled deterministically in
    //  dispatchInbound BEFORE agent resolution — earlier in the same turn than
    //  this spawn — so the hub overlay is already fresh here. mcp-memory also kicks
    //  a background sync on startup. All call the same idempotent reconcile.)

    // Build merged extra system prompt via structured prompt slots
    try {
      const promptResult = await buildPromptContext({
        agentId: this.opts.agentId,
        persona: this.opts.persona,
        provider: effectiveProvider,
        model: this.opts.model,
        availableMcpTools: [...availableMcpTools],
        // 把当前 effort 传进 slot builder 决定是否注入"科研模式守则"。
        // effort 切换本就会 recycle subprocess,新 runner 启动时会重建 extra-prompt.md。
        effortLevel: this.opts.effortLevel,
        // Phase 5:GitHub repo 当前快照(none / cloning / ready / failed) — 决定是否注入 REPO slot。
        repoSnapshot,
        skillEvalExclude: this.opts.skillEvalExclude,
        skillEvalDraft: this.opts.skillEvalDraft,
      })
      if (promptResult.content) {
        const path = resolve(sessionDir, 'extra-prompt.md')
        writeFileSync(path, promptResult.content)
        out.extraPromptFile = path
      }
      // observability:MODEL_HINT 命中(per-model 行为补丁注入)→ structured log + prom counter。
      // 不打 prompt 原文(可能含敏感引导),只记 sha256[:8] + bytes。
      // 关键安全约束:label 与 log 字段都只用 hint.meta.model_id(provider 已 canonicalize),
      // 不携带 spawn 入参的 raw model — 后者外部可控,用作 label 会撑爆 Prom counter
      // cardinality(观测面 DoS),作为日志字段同样会污染按字段建索引的日志后端。
      // 需要 raw → canonical 的对应关系时,用 sessionKey/agentId 与上下文 launch log 关联。
      const hint = promptResult.applied.find((s) => s.name === 'MODEL_HINT')
      const canonicalModelId = hint?.meta?.model_id
      if (hint && canonicalModelId) {
        runnerLog.info('model_hint_applied', {
          sessionKey: this.opts.sessionKey,
          agentId: this.opts.agentId,
          model_id: canonicalModelId,
          backend: 'ccb',
          hint_bytes: hint.bytes,
          hint_sha256: hint.sha256.slice(0, 8),
        })
        modelHintAppliedTotal.inc({ model_id: canonicalModelId, backend: 'ccb' })
      }
    } catch (err) {
      runnerLog.warn(
        'failed to build extra prompt',
        { sessionKey: this.opts.sessionKey, agentId: this.opts.agentId },
        err,
      )
    }

    // Write MCP config pointing at the mcp-memory stdio server
    // and any user-configured MCP servers (vision / search / image-gen / …).
    try {
      const mcpServers: Record<string, any> = {}

      // ── Built-in: openclaude-memory (L1/L2/L3 learning loop) ──
      // Path resolution shared with codexLaunchOverrides so ccb / codex / app-server
      // all point npx at the same bundled entry. Note: env construction below
      // is intentionally NOT shared (v3 subprocessRunner has tighter
      // OPENCLAUDE_HOME semantics — only forward when host process actually
      // set it; codex side passes empty-string default).
      const mcpEntry = resolveMcpMemoryEntry(this.opts.config.auth.claudeCodePath)
      if (mcpEntry) {
        mcpServers['openclaude-memory'] = {
          type: 'stdio',
          command: 'npx',
          args: ['tsx', mcpEntry],
          env: {
            OPENCLAUDE_AGENT_ID: this.opts.agentId,
            // 2026-04-22: 只在 host 进程里确实 set 了 OPENCLAUDE_HOME 时才向下传 —— 空串
            // 会被 mcp-memory 的 paths.ts 当成"有值",与 `??` 语义冲突,让所有 memory/skill
            // 路径退化为相对 cwd 的路径,跨容器串。v3 容器由 entrypoint.ts 显式注入
            // `/home/agent/.openclaude`,个人版本机通常用默认 `~/.openclaude` 就行,
            // 传 undefined 让下游 `??` 正确兜底到 homedir。
            ...(process.env.OPENCLAUDE_HOME
              ? { OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME }
              : {}),
            OPENCLAUDE_SESSION_KEY: this.opts.sessionKey,
            OPENCLAUDE_GATEWAY_PORT: String(this.opts.config.gateway.port),
            OPENCLAUDE_GATEWAY_TOKEN: this.opts.config.gateway.accessToken,
            OPENCLAUDE_DELEGATION_DEPTH: String(this.opts.delegationDepth ?? 0),
            ...(process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
              ? {
                  OPENCLAUDE_BASELINE_SKILLS_DIR:
                    process.env.OPENCLAUDE_BASELINE_SKILLS_DIR,
                }
              : {}),
            // SkillOpt training: expose the draft-only skill_propose tool bound to
            // this run. Only set for training sessions, so normal sessions never see it.
            ...(this.opts.skillEvalMode ? { OPENCLAUDE_SKILL_EVAL_MODE: '1' } : {}),
            ...(this.opts.skillEvalExclude
              ? { OPENCLAUDE_SKILL_EVAL_EXCLUDE: this.opts.skillEvalExclude }
              : {}),
            ...(this.opts.skillEvalDraft
              ? {
                  OPENCLAUDE_SKILL_EVAL_DRAFT_NAME: this.opts.skillEvalDraft.name,
                  OPENCLAUDE_SKILL_EVAL_DRAFT_DIR: this.opts.skillEvalDraft.dir,
                }
              : {}),
            ...(this.opts.skillTrainRunId
              ? { OPENCLAUDE_SKILL_TRAIN_RUN_ID: this.opts.skillTrainRunId }
              : {}),
          },
        }
      } else {
        runnerLog.warn('mcp-memory entry not found, skipping built-in MCP', {
          sessionKey: this.opts.sessionKey,
        })
      }

      // ── MCP servers: three-layer merge + toolset filtering ──
      // Layer 1: System shared tools (no provider field) — always included
      // Layer 2: Global provider-scoped MCPs (filtered by effectiveProvider)
      // Layer 3: Agent-specific MCPs (override same-id globals)
      // Toolset filter: if agent has toolsets configured, only include MCPs
      // whose id appears in at least one of the agent's toolset definitions.

      // Built-in: openclaude-vision. This gives DeepSeek (and explicitly
      // opted-in text-only providers) an understand_image tool without
      // routing native multimodal providers through a Codex fallback.
      if (openClaudeVisionAllowed) {
        if (openClaudeVisionEntry) {
          mcpServers[OPENCLAUDE_VISION_MCP_ID] = {
            type: 'stdio',
            command: 'npx',
            args: ['tsx', openClaudeVisionEntry],
            env: buildOpenClaudeVisionMcpEnv(this.opts.agentId),
          }
        } else {
          runnerLog.warn('openclaude-vision entry not found, skipping built-in MCP', {
            sessionKey: this.opts.sessionKey,
          })
        }
      }

      // Layer 1 + 2: Global MCPs
      for (const srv of this.opts.config.mcpServers ?? []) {
        if (srv.enabled === false) continue
        if (srv.provider && srv.provider !== effectiveProvider) continue
        if (allowedMcpIds && !allowedMcpIds.has(srv.id)) continue
        mcpServers[srv.id] = {
          type: 'stdio',
          command: srv.command,
          args: srv.args ?? [],
          env: srv.env ?? {},
        }
      }

      // Layer 3: Agent-specific MCPs (override same id, bypass toolset filter)
      for (const srv of this.opts.agentMcpServers ?? []) {
        if (srv.enabled === false) continue
        mcpServers[srv.id] = {
          type: 'stdio',
          command: srv.command,
          args: srv.args ?? [],
          env: srv.env ?? {},
        }
      }

      // (browser per-agent profile now handled by the oc-browser daemon, which
      // owns its own per-agent --user-data-dir; browser is no longer an MCP.)

      if (Object.keys(mcpServers).length > 0) {
        const mcpPath = resolve(sessionDir, 'mcp-config.json')
        writeFileSync(mcpPath, JSON.stringify({ mcpServers }, null, 2))
        out.mcpConfigFile = mcpPath
      }
    } catch (err) {
      runnerLog.warn(
        'failed to write mcp config',
        { sessionKey: this.opts.sessionKey, agentId: this.opts.agentId },
        err,
      )
    }

    return out
  }

  // 发送权限审批响应 — CCB 在 stdio 模式下等待 control_response
  sendPermissionResponse(requestId: string, response: PermissionResponse): boolean {
    if (!this.proc) return false
    try {
      const msg = {
        type: 'control_response',
        response: {
          request_id: requestId,
          subtype: 'success',
          response,
        },
      }
      this.proc.stdin.write(`${JSON.stringify(msg)}\n`)
      return true
    } catch {
      return false
    }
  }

  /** Read-only snapshot of telemetry drop diagnostics. */
  getTelemetryDiagnostics(): { missingSessionIdCount: number } {
    return { missingSessionIdCount: this.missingSessionIdCount }
  }

  // 发送 interrupt control request — CCB 会中止当前 turn
  interrupt(): boolean {
    if (!this.proc) return false
    try {
      const req = {
        type: 'control_request',
        request_id: `int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        request: { subtype: 'interrupt' },
      }
      this.proc.stdin.write(`${JSON.stringify(req)}\n`)
      return true
    } catch {
      return false
    }
  }

  /** Remove the session's temp directory (extra-prompt.md, mcp-config.json, …). */
  private cleanupSessionDir(): void {
    if (this.sessionDir) {
      try { rmSync(this.sessionDir, { recursive: true, force: true }) } catch {}
      this.sessionDir = null
    }
  }

  async shutdown(): Promise<void> {
    // Always clean up the session directory, even if there is no live process
    // (failed starts, already-exited runners, crash paths).
    if (!this.proc) {
      // Phase 5:无活进程,binding 也跟着清。否则 start 在 starting 中 throw 后留下
      // stale binding,下次 isRunning=false 但 binding 还在,sessionManager 决策表会读错。
      this._boundRepoBinding = null
      this.cleanupSessionDir()
      return
    }
    this.shuttingDown = true
    try {
      this.proc.stdin.end()
    } catch {}
    const proc = this.proc
    const pid = proc.pid
    await new Promise<void>((res) => {
      const timer = setTimeout(() => {
        // Kill entire process group (including MCP subprocesses)
        try {
          if (pid) process.kill(-pid, 'SIGKILL') // negative pid = process group
        } catch {
          try {
            proc.kill('SIGKILL')
          } catch {}
        }
        res()
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(timer)
        res()
      })
    })
    this.proc = null
    this.closed = true
    // Phase 5:本进程已死,清掉 ready binding。下次 start() 会按当时 repo state 重新评估。
    this._boundRepoBinding = null
    this.cleanupSessionDir()
  }
}
