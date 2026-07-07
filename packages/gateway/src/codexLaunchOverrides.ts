/**
 * codexLaunchOverrides — assemble per-spawn `-c` overrides for codex CLI.
 *
 * Why this exists:
 *   ccb (Claude Code) goes through `subprocessRunner.ts`, which builds an
 *   `extra-prompt.md` from `buildPromptContext()` (SOUL/USER/AGENTS/SKILLS/
 *   MEMORY/TOOLS/RESEARCH slots) and an `mcp-config.json` mounting the
 *   `openclaude-memory` MCP server. Codex spawn paths (`codexRunner.ts`,
 *   `codexAppServerRunner.ts`) historically had **none** of that — naked
 *   codex CLI with only the user prompt. That made codex blind to the
 *   platform: persona, user identity, skill index, memory, sibling agents,
 *   browser tools, scheduled tasks were all invisible to it.
 *
 *   This module is the codex-side adapter: it produces the same platform
 *   context as ccb gets, encoded as codex's native injection points
 *   (`-c model_instructions_file` for the system prompt, `-c mcp_servers.X`
 *   for the MCP server). Both runners share this module so the two codex
 *   backends stay symmetrical.
 *
 * Verified with codex 0.125.0 on 2026-05-09:
 *   - `-c model_instructions_file="<path>"` injects the file content as
 *     developer instructions (visible to model).
 *   - `-c mcp_servers.X.command="..." -c mcp_servers.X.args=[...] -c mcp_servers.X.env={...}`
 *     spawns the MCP server and exposes its tools to codex's tool loop.
 *
 * Out of scope (intentional):
 *   - Persisting overrides into `~/.codex/config.toml` — all injection is
 *     per-spawn argv, so multiple agents on the same user never collide.
 *   - Bridging codex's native `~/.codex/memories/` or `~/.codex/skills/`
 *     subsystems — they are independent stores; we do not let codex's
 *     stage1/stage2 memory writer touch our MemoryStore.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLogger } from './logger.js'
import { modelHintAppliedTotal } from './metrics.js'
import { buildPromptContext } from './promptSlots.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'

const overridesLog = createLogger({ module: 'codexLaunchOverrides' })

// ── Codex-specific preamble ──
//
// Prepended to the platform context so codex understands *which* parts apply
// to it specifically. The platform slots (SOUL/USER/AGENTS/...) were authored
// for ccb voice; this preamble tells codex how to interpret them and which
// MCP server is its access point to platform memory/skills/agents.
//
// Design notes:
//   - "tool list authority" disclaimer prevents codex from hallucinating
//     ccb-only tools (Bash/Edit/Glob etc. are ccb internals, not codex's).
//     Codex must rely on its own tool/MCP list for what it can actually call.
//   - Explicit instruction to NOT use codex's native memory subsystem: codex
//     has its own `~/.codex/memories/` phase1/phase2 LLM-backed writer that
//     would silently fork-out a parallel memory store; we route memory through
//     the `oc-memory` CLI (Phase 2 — moved off the openclaude_memory MCP) and
//     skills/scheduling/agents through the `openclaude_memory` MCP, keeping one
//     source of truth.
const CODEX_PREAMBLE = `# OpenClaude Platform Context (codex adapter)

You are running inside the OpenClaude platform as a codex-backed agent. The
sections that follow describe the platform — your persona, the user, sibling
agents, available skills, accumulated memory, and other capabilities. They
take precedence over any default codex personality.

## How the OpenClaude memory / skill / scheduling system reaches you

Two access paths, split by tool:

**Long-term memory → run the \`oc-memory\` CLI in your shell** (a one-shot
command; there is no memory MCP tool):

- \`oc-memory memory --action <add|replace|remove|read> --target <memory|user> [--content "..."] [--needle "..."]\` — short Core memory (MEMORY.md / USER.md).
- \`oc-memory session-search "<query>" [--limit N] [--summarize]\` — recall prior conversations.
- \`oc-memory archival-add "<text>" [--tags a,b]\` / \`oc-memory archival-search "<query>"\` / \`oc-memory archival-delete <id>\` — long-form notes (unlimited, search-only).

See the \`memory-management\` skill for details.

**Skills, scheduling and sibling agents → the \`openclaude_memory\` MCP server**
(these ARE MCP tools):

- \`skill_search\` / \`skill_list\` / \`skill_view\` / \`skill_save\` / \`skill_delete\` — platform skills.
- \`create_reminder\` / \`list_reminders\` / \`update_reminder\` / \`delete_reminder\` — manage scheduled reminders/tasks.
- \`delegate_task\` (sync) / \`send_to_agent\` (async) — talk to sibling agents.

Do **not** read OR write codex's built-in \`~/.codex/memories/\` or
\`~/.codex/skills/\` to manage platform state — those are codex-private and
would fork the source of truth. Always go through the \`oc-memory\` CLI (memory)
and the \`openclaude_memory\` MCP tools (skills / scheduling / agents) above.
(The only exception is if the user *explicitly* asks you to inspect a
codex-native rollout file — and even then, do not migrate that content into a
parallel store.)

For reusable workflows, be proactive: after a complex multi-step task, call
\`skill_search\` to check existing coverage, then \`skill_save\` to create or
update a platform skill when the pattern is likely to recur.

## How to interpret tool descriptions in the sections below

The platform context was authored primarily for the ccb (Claude Code) backend,
so it may mention tools that ccb has natively but codex does **not** (file
edit, glob, web fetch, etc.). Treat these references as platform conventions
for the OpenClaude *project*, not as a guarantee that you personally can call
them. Your authoritative tool list is whatever your MCP servers + codex
built-ins expose right now.

## File and rich-content output conventions

When sending a file to the user, output its absolute path as plain text. Do
not use markdown image syntax (\`![]()\`). Inline rich-content code blocks
(\`chart\`, \`mermaid\`, \`htmlpreview\`) render in the OpenClaude web client.
For UI previews, interactive demos, HTML Canvas, animations, small games, or
design mockups, prefer a fenced \`htmlpreview\` block directly in the reply
unless the user explicitly asks for a saved/downloadable file.

---

`

// ── mcp-memory / vision entry resolution + vision MCP env ──
//
// P1f 把 resolveMcpMemoryEntry / resolveOpenClaudeVisionEntry /
// buildOpenClaudeVisionMcpEnv 三个共享函数并入 subprocessRunner.ts(CCB 路径
// 也用)。M1a 复活本文件时**反向 import**,不复制第二份 —— 单一权威在
// subprocessRunner。注意语义差(复活底稿 A2,有意保留):现版
// buildOpenClaudeVisionMcpEnv 不再注入 4 个 codex vision 专用 env 键
// (CODEX_HOME / OPENCLAUDE_VISION_CODEX_MODEL /
// OPENCLAUDE_VISION_CODEX_REFRESH_TIMEOUT_MS / OPENCLAUDE_VISION_CODEX_REFRESH_DISABLED)。
// 自 v1.0.341 起 understand_image 默认走 MiniMax backend(经容器 internal
// anthropic proxy),codex vision backend 不随 M1a 恢复;若未来要恢复,在
// subprocessRunner.buildOpenClaudeVisionMcpEnv 回补这 4 键即可(一处生效)。
import {
  buildOpenClaudeVisionMcpEnv,
  resolveMcpMemoryEntry,
  resolveOpenClaudeVisionEntry,
} from './subprocessRunner.js'

// re-export:历史上这三个符号的权威源在本文件(P1f 前),存量 import 兼容。
export { buildOpenClaudeVisionMcpEnv, resolveMcpMemoryEntry, resolveOpenClaudeVisionEntry }

// ── TOML literal encoding for `-c key=value` arguments ──

/** Encode a value as a single-line TOML literal suitable for codex `-c key=value`.
 *
 *  Why narrow inputs (string | string[] | Record<string,string>):
 *    - These are the only shapes we actually need to inject (file paths,
 *      argv arrays, env tables).
 *    - codex's `-c` parser expects the value to parse as TOML. JSON-style
 *      double-quoted basic strings are valid TOML, with the same `\"`,
 *      `\\`, `\n`, `\t`, `\uXXXX` escape vocabulary; `JSON.stringify`
 *      output for strings without surrogate pairs is therefore valid TOML.
 *    - Refusing unknown shapes (instead of stringifying) keeps the failure
 *      mode loud at call time rather than silently shipping a malformed
 *      argv to codex (which would fall back to "raw string" and produce
 *      confusing model behaviour).
 *
 *  Limitations: assumes input strings have no lone surrogates. Unicode
 *  scalars are fine.
 */
function tomlValue(v: string | string[] | Record<string, string>): string {
  if (typeof v === 'string') {
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item !== 'string') {
        throw new TypeError(
          `tomlValue array: only string elements are supported, got ${typeof item}`,
        )
      }
    }
    return `[${v.map((item) => JSON.stringify(item)).join(',')}]`
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).map(([k, val]) => {
      if (typeof val !== 'string') {
        throw new TypeError(
          `tomlValue table: only string values are supported, got ${typeof val} for key "${k}"`,
        )
      }
      // Inline table keys: bare keys are letters/digits/_/-; everything else
      // must be quoted. We always quote to keep the encoder simple and safe.
      return `${JSON.stringify(k)}=${JSON.stringify(val)}`
    })
    return `{${entries.join(',')}}`
  }
  throw new TypeError(`tomlValue: unsupported value type (${typeof v})`)
}

const DEFAULT_CODEX_MCP_TOOL_TIMEOUT_SEC = 3600
const MIN_CODEX_MCP_TOOL_TIMEOUT_SEC = 60
const MAX_CODEX_MCP_TOOL_TIMEOUT_SEC = 7200

function normalizePositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

function codexMcpToolTimeoutSec(env: NodeJS.ProcessEnv = process.env): number {
  return normalizePositiveInt(
    env.OPENCLAUDE_CODEX_MCP_TOOL_TIMEOUT_SEC,
    DEFAULT_CODEX_MCP_TOOL_TIMEOUT_SEC,
    MIN_CODEX_MCP_TOOL_TIMEOUT_SEC,
    MAX_CODEX_MCP_TOOL_TIMEOUT_SEC,
  )
}

// ── Public API ──

export interface CodexLaunchOverridesContext {
  agentId: string
  /** Current gateway AgentSession key. Forwarded only to mcp-memory so
   *  delegate_task can stream progress back to the exact parent WebChat
   *  session without falling back to last-active routing. */
  sessionKey?: string
  /** Path to agent's CLAUDE.md / SOUL.md persona file (forwarded to
   *  buildPromptContext; unused for codex preamble itself). */
  persona?: string
  /** Effective provider — passed to buildPromptContext for provider-specific
   *  hints (e.g. minimax MCP tips). For codex-native agents this is usually
   *  'codex-native', but provider-specific slot logic is keyed on `'minimax'`
   *  etc., so codex gets a no-op pass-through. */
  provider?: string
  model?: string
  /** UI effort level passed through; codex runners are no-op on effort
   *  changes today, but if a future user toggles "research mode" on a codex
   *  agent the RESEARCH slot would activate. */
  effortLevel?: string
  /** mkdtempSync'd directory the caller has prepared. We write the
   *  instructions file into this dir (no other side effects). */
  sessionDir: string
  /** CCB install root, only used to construct the third resolveMcpMemoryEntry
   *  fallback. Pass undefined when running outside a ccb-aware deployment
   *  (the mcp-memory MCP will simply be skipped if no candidate resolves). */
  claudeCodePath?: string
  /** Loopback address the mcp-memory child uses to call back into gateway
   *  (`/api/agents/.../message`, `/api/cron`, `/api/...`). Same value the
   *  ccb subprocessRunner injects today. */
  gatewayPort: number
  /** Gateway access token. WARNING: this is injected into the **mcp-memory
   *  subprocess env only** via `-c mcp_servers.openclaude_memory.env={...}`,
   *  NOT into codex's own process env. codex's own env scrubs OPENCLAUDE_*
   *  to avoid leaking gateway secrets to the ChatGPT API; the per-MCP-server
   *  env is a separate scope codex passes only to the MCP child. */
  gatewayToken: string
  /** Forwarded to mcp-memory env so delegate_task can enforce recursion caps. */
  delegationDepth?: number
  /** Optional override of OPENCLAUDE_HOME for the mcp-memory child. Defaults
   *  to `process.env.OPENCLAUDE_HOME ?? ''` (matching subprocessRunner). */
  openclaudeHome?: string
  /** Phase 5:GitHub session repo binding 快照。caller 在 spawn 前一次性取出,
   *  和 effectiveCwd 用同一份 snapshot,避免 launch overrides 与 spawn cwd 撕裂。
   *  ready 状态时,promptSlots 的 REPO slot 会注入仓库路径与基本元信息,让 codex
   *  从系统提示中就知道当前绑定到哪个项目;非 ready / null 时 REPO slot 不输出。
   *  无 sessionId 注入(legacy 路径)的 caller 直接传 undefined。 */
  repoSnapshot?: RepoSnapshot | null
}

export interface CodexLaunchOverrides {
  /** Absolute path of the instructions file. Caller writes
   *  `instructionsContent` to this path before spawn. */
  instructionsFile: string
  /** Content the caller must writeFile to instructionsFile. */
  instructionsContent: string
  /** Absolute path the caller must writeFile the gateway token to (mode
   *  0600), or null when no mcp-memory entry resolved (no token needed).
   *
   *  Why this exists (v3 hardening): the mcp-memory subprocess receives its
   *  gateway-callback token via `OPENCLAUDE_GATEWAY_TOKEN_FILE=<path>` rather
   *  than `OPENCLAUDE_GATEWAY_TOKEN=<token>` because the codex spawn argv
   *  exposes `-c mcp_servers.openclaude_memory.env={...}` to `ps -ef` and
   *  `/proc/<pid>/cmdline`. Putting the token in a 0600 file inside the
   *  caller's mkdtemp'd sessionDir keeps argv inspection-safe. */
  tokenFile: string | null
  /** Token content the caller must writeFile to tokenFile (mode 0600).
   *  Null when tokenFile is null. */
  tokenContent: string | null
  /** Optional v3 container token file for openclaude-vision MCP refresh. */
  visionTokenFile: string | null
  /** Token content the caller must writeFile to visionTokenFile (mode 0600). */
  visionTokenContent: string | null
  /** argv fragments to splice into the codex spawn args between the
   *  subcommand (`exec` / `app-server`) and the trailing positional
   *  (`-` / threadId / `--listen`).
   *
   *  Order is stable and deterministic for snapshot tests:
   *    1. model_instructions_file
   *    2. mcp_servers.openclaude_memory.command (if entry resolved)
   *    3. mcp_servers.openclaude_memory.args
   *    4. mcp_servers.openclaude_memory.env (no token literal — points at tokenFile)
   *
   *  Empty MCP entries are omitted (no key set at all) when the bundled
   *  mcp-memory entry can't be resolved; in that case codex still gets the
   *  instructions file but no platform memory access. This is the same
   *  graceful degradation ccb's subprocessRunner does at L734. */
  argvOverrides: string[]
}

/**
 * Build per-spawn launch overrides for a codex subprocess.
 *
 * This function is **pure** — it does no file I/O. The caller is expected to:
 *   1. mkdtempSync a session-scoped directory and pass it as `ctx.sessionDir`.
 *   2. writeFileSync(`overrides.instructionsFile`, `overrides.instructionsContent`).
 *   3. Spawn codex with the subcommand argv interleaved with `overrides.argvOverrides`.
 *   4. On shutdown, rmSync(sessionDir, { recursive: true, force: true })
 *      AND clear any cached reference to `overrides` so the next spawn
 *      lazy-rebuilds with a fresh instructions file path. (Re-using a
 *      stale overrides object after sessionDir cleanup would point codex
 *      at a deleted file.)
 */
export async function buildCodexLaunchOverrides(
  ctx: CodexLaunchOverridesContext,
): Promise<CodexLaunchOverrides> {
  // Build the platform context (same 7-slot pipeline ccb uses), prepend the
  // codex-specific preamble. We do NOT add the preamble inside promptSlots
  // because that file is provider-agnostic and shouldn't carry adapter
  // concerns — keeping it here means promptSlots stays clean and the codex
  // adapter can evolve without touching the slot pipeline.
  // vision retired from the codex MCP path → oc-vision CLI (baseline skill),
  // same as web-context/browser. No MCP tool is injected on the codex path now;
  // mcp-memory below is the only remaining codex-side MCP server.
  const availableMcpTools: string[] = []
  const platformResult = await buildPromptContext({
    agentId: ctx.agentId,
    persona: ctx.persona,
    provider: ctx.provider,
    model: ctx.model,
    effortLevel: ctx.effortLevel,
    // Phase 5:repo binding 信息透传给 REPO slot。SubprocessRunner 已通过
    // buildLearningContext(repoSnapshot) → buildPromptContext 走通,这里给两个
    // codex 路径补齐,让 codex 子进程也看到 REPO slot(系统提示里的仓库元信息)。
    repoSnapshot: ctx.repoSnapshot ?? undefined,
    availableMcpTools,
  })
  const instructionsContent = `${CODEX_PREAMBLE}${platformResult.content}`
  const instructionsFile = resolve(ctx.sessionDir, 'extra-prompt.md')

  // observability:per-model 行为补丁注入(MODEL_HINT)→ structured log + prom counter。
  // 不打 prompt 原文,只 sha256[:8] + bytes;subprocessRunner 同款。
  const hint = platformResult.applied.find((s) => s.name === 'MODEL_HINT')
  const canonicalModelId = hint?.meta?.model_id
  if (hint && canonicalModelId) {
    // 同 subprocessRunner:label/log 字段都只用 canonical id,不带 raw ctx.model,
    // 防止外部可控字符串污染 Prom 基数 / 日志后端字段索引(详见对端注释)。
    overridesLog.info('model_hint_applied', {
      agentId: ctx.agentId,
      model_id: canonicalModelId,
      backend: 'codex',
      hint_bytes: hint.bytes,
      hint_sha256: hint.sha256.slice(0, 8),
    })
    modelHintAppliedTotal.inc({ model_id: canonicalModelId, backend: 'codex' })
  }

  const argvOverrides: string[] = ['-c', `model_instructions_file=${tomlValue(instructionsFile)}`]

  // mcp-memory injection — best-effort. If the bundled entry can't be
  // resolved (corrupted install, hand-edited path), we still ship the
  // instructions file so the agent has identity/persona/skills metadata
  // even without the memory tool. Mirrors subprocessRunner's
  // `if (mcpEntry) {...}` else-warn behaviour.
  const mcpEntry = resolveMcpMemoryEntry(ctx.claudeCodePath)
  let tokenFile: string | null = null
  let tokenContent: string | null = null
  if (mcpEntry) {
    // v3 hardening: the gateway token NEVER lands in argv. Instead, we point
    // mcp-memory at a 0600 file via OPENCLAUDE_GATEWAY_TOKEN_FILE; the caller
    // writes ctx.gatewayToken into that file before spawn. mcp-memory
    // (`readGatewayToken()`) reads the file at startup. argv only carries the
    // file path, which is not sensitive (mkdtemp'd sessionDir, also visible).
    tokenFile = resolve(ctx.sessionDir, 'gateway-token')
    tokenContent = ctx.gatewayToken
    const mcpEnv: Record<string, string> = {
      OPENCLAUDE_AGENT_ID: ctx.agentId,
      OPENCLAUDE_HOME: ctx.openclaudeHome ?? process.env.OPENCLAUDE_HOME ?? '',
      ...(ctx.sessionKey ? { OPENCLAUDE_SESSION_KEY: ctx.sessionKey } : {}),
      OPENCLAUDE_GATEWAY_PORT: String(ctx.gatewayPort),
      OPENCLAUDE_GATEWAY_TOKEN_FILE: tokenFile,
      OPENCLAUDE_DELEGATION_DEPTH: String(ctx.delegationDepth ?? 0),
      ...(process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
        ? { OPENCLAUDE_BASELINE_SKILLS_DIR: process.env.OPENCLAUDE_BASELINE_SKILLS_DIR }
        : {}),
    }
    argvOverrides.push(
      '-c',
      `mcp_servers.openclaude_memory.command=${tomlValue('npx')}`,
      '-c',
      `mcp_servers.openclaude_memory.args=${tomlValue(['tsx', mcpEntry])}`,
      '-c',
      `mcp_servers.openclaude_memory.env=${tomlValue(mcpEnv)}`,
      '-c',
      `mcp_servers.openclaude_memory.default_tools_approval_mode=${tomlValue('approve')}`,
      '-c',
      `mcp_servers.openclaude_memory.tool_timeout_sec=${codexMcpToolTimeoutSec()}`,
    )
  }

  return {
    instructionsFile,
    instructionsContent,
    tokenFile,
    tokenContent,
    // vision MCP retired → oc-vision CLI (baseline skill); no vision token is
    // written on the codex path anymore. Fields kept on the interface (always
    // null) until the codex vision-token plumbing is fully removed.
    visionTokenFile: null,
    visionTokenContent: null,
    argvOverrides,
  }
}

// Internal export for tests only — not part of the stable API.
export const _internals = { tomlValue, CODEX_PREAMBLE, codexMcpToolTimeoutSec }
