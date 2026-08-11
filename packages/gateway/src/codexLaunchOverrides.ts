/**
 * codexLaunchOverrides — assemble per-spawn `-c` overrides for codex CLI.
 *
 * Why this exists:
 *   ccb (Claude Code) goes through `subprocessRunner.ts`, which builds an
 *   `extra-prompt.md` from `buildPromptContext()` (SOUL/USER/AGENTS/SKILLS/
 *   MEMORY/TOOLS/MODEL_HINT/RESEARCH/REPO slots) and an `mcp-config.json` mounting the
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
 *   - `-c mcp_servers.X.default_tools_approval_mode="approve"` pre-approves
 *     that server's tools for the trusted personal OpenClaude adapter.
 *
 * Out of scope (intentional):
 *   - Persisting overrides into `~/.codex/config.toml` — all injection is
 *     per-spawn argv, so multiple agents on the same user never collide.
 *   - Bridging codex's native `~/.codex/memories/` or `~/.codex/skills/`
 *     subsystems — they are independent stores; we do not let codex's
 *     stage1/stage2 memory writer touch our MemoryStore.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { buildPromptContext } from './promptSlots.js'

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
//     would silently fork-out a parallel memory store; we route everything
//     through `openclaude_memory` MCP to keep one source of truth.
const CODEX_PREAMBLE = `# OpenClaude Platform Context (codex adapter)

You are running inside the OpenClaude platform as a codex-backed agent. The
sections that follow describe the platform — your persona, the user, sibling
agents, available skills, accumulated memory, and other capabilities. They
take precedence over any default codex personality.

## How the OpenClaude memory / skill / scheduling system reaches you

Use the **\`openclaude_memory\`** MCP server. Its tools are your access path:

- \`memory(op, scope, ...)\` — read/append to short Core memory.
- \`archival_search\` / \`archival_add\` / \`archival_delete\` — long-form notes.
- \`skill_list\` / \`skill_view\` / \`skill_save\` / \`skill_delete\` — platform skills.
- \`session_search\` — recall prior conversations.
- \`create_reminder\` — schedule a cron-driven reminder.
- \`delegate_task\` (sync) / \`send_to_agent\` (async) — talk to sibling agents.

Do **not** read OR write codex's built-in \`~/.codex/memories/\` or
\`~/.codex/skills/\` to manage platform state — those are codex-private and
would fork the source of truth. Always go through the \`openclaude_memory\`
MCP tools above. (The only exception is if the user *explicitly* asks you to
inspect a codex-native rollout file — and even then, do not migrate that
content into a parallel store.)

## How to interpret tool descriptions in the sections below

The platform context was authored primarily for the ccb (Claude Code) backend,
so it may mention tools that ccb has natively but codex does **not** (file
edit, glob, web fetch, etc.). Treat these references as platform conventions
for the OpenClaude *project*, not as a guarantee that you personally can call
them. Your authoritative tool list is whatever your MCP servers + codex
built-ins expose right now.

## Execution discipline

- Translate multi-step work into bounded, verifiable success criteria and
  report the current stage; do not grow the scope indefinitely.
- Use one plan reviewer and one full-diff reviewer unless that reviewer finds
  a concrete blocker requiring another pass. Review is evidence, not ceremony.
- Before a categorical diagnosis, cite the code path, log, test, or primary
  source that proves it. Never attribute an interruption to the user without
  timestamped evidence.
- When recursively searching shared or temporary trees (especially \`/tmp\`),
  traverse regular files only and skip devices, FIFOs, and sockets (for
  example, use \`grep --devices=skip\` or \`find ... -type f\`). Opening a
  special file can block an otherwise completed turn indefinitely.
- If later evidence disproves an earlier claim, correct it explicitly.
- After tools create external side effects, reconcile the actual external
  state before claiming success or failure.

## File and rich-content output conventions

When sending a file to the user, output its absolute path as plain text. Do
not use markdown image syntax (\`![]()\`). Inline rich-content code blocks
(\`chart\`, \`mermaid\`, \`htmlpreview\`) render in the OpenClaude web client.

---

`

const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Keep native Codex effort forwarding identical across exec and app-server.
 *  `max` is currently verified only for GPT-5.6 Sol; the common four levels
 *  preserve the existing behaviour for other Codex models. */
export function codexReasoningEffortForModel(
  model: string | undefined,
  effort: string | undefined,
): CodexReasoningEffort | null {
  if (!effort || !CODEX_REASONING_EFFORTS.has(effort)) return null
  if (effort !== 'max') return effort as CodexReasoningEffort
  const modelName = model?.toLowerCase().split('/').pop() ?? ''
  return /^gpt[-_]?5\.6[-_]sol$/.test(modelName) ? 'max' : null
}

const PROJECT_RULE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const
const PROJECT_RULE_MAX_BYTES = 96 * 1024

// ── Path resolution for the bundled mcp-memory entry ──

/** Three-candidate fallback for resolving the bundled `openclaude-memory`
 *  MCP server entry path. Both the chat-engine subprocessRunner and the codex
 *  runners need the *same* resolution to stay in sync — extracting it here is
 *  the only way to guarantee both paths agree on which `mcp-memory/src/index.ts`
 *  they point npx at.
 *
 *  Returns the first existing absolute path, or `null` if none exist (caller
 *  decides whether to log+skip or fall back to no MCP at all).
 *
 *  @param claudeCodePath Optional legacy install-root hint (the deprecated
 *    `auth.claudeCodePath`). Used to construct the third candidate
 *    (`<claudeCodePath>/../openclaude/packages/mcp-memory/...`), the layout used
 *    inside the v3 commercial container image. Normally `undefined`; the first
 *    two candidates resolve in standard installs. */
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

function findProjectRuleFiles(startDir: string | undefined): string[] {
  if (!startDir) return []
  let dir = resolve(startDir)
  const root = parse(dir).root
  const found: string[] = []
  while (true) {
    for (const name of PROJECT_RULE_FILENAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) found.push(candidate)
    }
    if (dir === root) break
    dir = dirname(dir)
  }
  return found
}

function readProjectRulesSlot(startDir: string | undefined): string {
  const files = findProjectRuleFiles(startDir)
  if (files.length === 0) return ''
  const blocks: string[] = []
  for (const file of files) {
    try {
      const raw = readFileSync(file, 'utf8')
      const bounded =
        Buffer.byteLength(raw, 'utf8') > PROJECT_RULE_MAX_BYTES
          ? `${raw.slice(0, PROJECT_RULE_MAX_BYTES)}\n\n[truncated by OpenClaude: project rule file exceeded ${PROJECT_RULE_MAX_BYTES} bytes]`
          : raw
      const trimmed = bounded.trim()
      if (trimmed) blocks.push(`## ${file}\n\n${trimmed}`)
    } catch {
      // Best-effort: project rules improve behaviour but must not prevent
      // Codex from starting.
    }
  }
  if (blocks.length === 0) return ''
  return [
    '# Project rule files loaded from working directory',
    '',
    'These repository-local rules are injected by OpenClaude because the codex app-server adapter does not reliably surface native AGENTS.md loading in the platform prompt. Follow them unless a higher-priority system/developer instruction conflicts.',
    '',
    ...blocks,
    '',
    '---',
    '',
  ].join('\n')
}

// ── Public API ──

export interface CodexLaunchOverridesContext {
  agentId: string
  /** Path to agent's CLAUDE.md / SOUL.md persona file (forwarded to
   *  buildPromptContext; unused for codex preamble itself). */
  persona?: string
  /** Effective provider — passed to buildPromptContext for provider-specific
   *  hints (e.g. minimax MCP tips). For codex-native agents this is usually
   *  'codex-native', but provider-specific slot logic is keyed on `'minimax'`
   *  etc., so codex gets a no-op pass-through. */
  provider?: string
  model?: string
  /** UI effort level passed through. For codex-backed agents, OpenClaude
   *  forwards low/medium/high/xhigh/max as codex's native
   *  `model_reasoning_effort`; other UI-only levels remain prompt-slot-only. */
  effortLevel?: string
  /** mkdtempSync'd directory the caller has prepared. We write the
   *  instructions file into this dir (no other side effects). */
  sessionDir: string
  /** Effective working directory for the codex process. Used to explicitly
   *  inject repository-local AGENTS.md / CLAUDE.md rule files because the
   *  OpenClaude codex app-server path should not rely on implicit CLI
   *  discovery. */
  cwd?: string
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
}

export interface CodexLaunchOverrides {
  /** Absolute path of the instructions file. Caller writes
   *  `instructionsContent` to this path before spawn. */
  instructionsFile: string
  /** Content the caller must writeFile to instructionsFile. */
  instructionsContent: string
  /** argv fragments to splice into the codex spawn args between the
   *  subcommand (`exec` / `app-server`) and the trailing positional
   *  (`-` / threadId / `--listen`).
   *
   *  Order is stable and deterministic for snapshot tests:
   *    1. model_instructions_file
   *    2. model_reasoning_effort (if low/medium/high/xhigh/max is selected)
   *    3. mcp_servers.openclaude_memory.command (if entry resolved)
   *    4. mcp_servers.openclaude_memory.args
   *    5. mcp_servers.openclaude_memory.env
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
  // Build the platform context (same 9-slot pipeline ccb uses), prepend the
  // codex-specific preamble. We do NOT add the preamble inside promptSlots
  // because that file is provider-agnostic and shouldn't carry adapter
  // concerns — keeping it here means promptSlots stays clean and the codex
  // adapter can evolve without touching the slot pipeline.
  const platformResult = await buildPromptContext({
    agentId: ctx.agentId,
    persona: ctx.persona,
    provider: ctx.provider,
    model: ctx.model,
    effortLevel: ctx.effortLevel,
  })
  const projectRules = readProjectRulesSlot(ctx.cwd)
  const instructionsContent = `${CODEX_PREAMBLE}${projectRules}${platformResult.content}`
  const instructionsFile = resolve(ctx.sessionDir, 'extra-prompt.md')

  const argvOverrides: string[] = ['-c', `model_instructions_file=${tomlValue(instructionsFile)}`]
  const reasoningEffort = codexReasoningEffortForModel(ctx.model, ctx.effortLevel)
  if (reasoningEffort) {
    argvOverrides.push('-c', `model_reasoning_effort=${tomlValue(reasoningEffort)}`)
  }

  // mcp-memory injection — best-effort. If the bundled entry can't be
  // resolved (corrupted install, hand-edited path), we still ship the
  // instructions file so the agent has identity/persona/skills metadata
  // even without the memory tool. Mirrors subprocessRunner's
  // `if (mcpEntry) {...}` else-warn behaviour.
  const mcpEntry = resolveMcpMemoryEntry(ctx.claudeCodePath)
  if (mcpEntry) {
    const mcpEnv: Record<string, string> = {
      OPENCLAUDE_AGENT_ID: ctx.agentId,
      OPENCLAUDE_HOME: ctx.openclaudeHome ?? process.env.OPENCLAUDE_HOME ?? '',
      OPENCLAUDE_GATEWAY_PORT: String(ctx.gatewayPort),
      OPENCLAUDE_GATEWAY_TOKEN: ctx.gatewayToken,
      OPENCLAUDE_DELEGATION_DEPTH: String(ctx.delegationDepth ?? 0),
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
    )
  }

  return { instructionsFile, instructionsContent, argvOverrides }
}

// Internal export for tests only — not part of the stable API.
export const _internals = { tomlValue, CODEX_PREAMBLE, readProjectRulesSlot }
