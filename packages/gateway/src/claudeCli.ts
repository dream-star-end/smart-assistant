import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ───────────────────────────────────────────────
// claudeCli — single authority for "where is the official `claude` binary".
//
// Both the orchestrated chat engine (subprocessRunner) and the interactive
// PTY (claudeTerminal) resolve the binary through here so they can never drift
// onto different Claude Code installs.
// ───────────────────────────────────────────────

/**
 * Resolve the official Claude Code executable.
 *
 * Priority:
 *   1. OPENCLAUDE_OFFICIAL_CLAUDE_PATH env override (absolute path or command).
 *   2. ~/.local/bin/claude (the default local installer location).
 *   3. bare `claude` (resolved via PATH).
 */
export function resolveOfficialClaudePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAUDE_OFFICIAL_CLAUDE_PATH?.trim()
  if (configured) return configured
  const localClaude = join(homedir(), '.local/bin/claude')
  return existsSync(localClaude) ? localClaude : 'claude'
}
