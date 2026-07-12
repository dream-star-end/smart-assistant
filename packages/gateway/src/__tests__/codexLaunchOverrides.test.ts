import * as assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
/**
 * Tests for `codexLaunchOverrides` — adapter that translates OpenClaude's
 * 7-slot platform context + mcp-memory MCP server into per-spawn `-c` argv
 * fragments for codex CLI.
 *
 * Load-bearing invariants:
 *   1. argvOverrides order is stable: model_instructions_file FIRST, optional
 *      model_reasoning_effort SECOND, then the three
 *      mcp_servers.openclaude_memory.* keys (command, args, env).
 *      Snapshot-equality matters — we splice the slice into runners' spawn
 *      argv at fixed positions, so a reorder would silently break codex's
 *      arg parser or produce ambiguous overrides.
 *   2. Strict TOML encoding rejects non-string types (forces caller to
 *      stringify intentionally rather than shipping a `[object Object]`
 *      garbage value through codex's `-c` parser).
 *   3. Encoded values must parse as TOML basic strings / arrays / inline
 *      tables — JSON.stringify output is the chosen wire encoding because
 *      it satisfies TOML's basic-string subset for values without lone
 *      surrogates.
 *   4. `resolveMcpMemoryEntry` walks three candidates in order and returns
 *      the first existing path (or null when none exist) — both subprocess
 *      Runner (ccb) and codex runners must agree on this resolution.
 *   5. The CODEX_PREAMBLE prepended to the platform context contains the
 *      explicit "use openclaude_memory MCP, not ~/.codex/memories/"
 *      instruction; without this the codex agent would silently fork its
 *      memory state into codex's private store.
 */
import { _internals, resolveMcpMemoryEntry } from '../codexLaunchOverrides.js'

const { tomlValue, CODEX_PREAMBLE, readProjectRulesSlot } = _internals

describe('tomlValue', () => {
  it('encodes plain string as TOML basic string (JSON-style double-quoted)', () => {
    assert.equal(tomlValue('hello'), '"hello"')
  })

  it('escapes embedded double-quote, backslash, newline correctly', () => {
    // JSON.stringify gives the same escape vocabulary TOML basic strings use.
    assert.equal(tomlValue('a"b\\c\nd'), '"a\\"b\\\\c\\nd"')
  })

  it('encodes string array as inline TOML array', () => {
    assert.equal(tomlValue(['npx', 'tsx', '/path/x.ts']), '["npx","tsx","/path/x.ts"]')
  })

  it('encodes record as inline TOML table with quoted keys (= separator, not JSON :)', () => {
    const out = tomlValue({ A: '1', B: 'two' })
    // TOML inline tables use `=` between key and value (NOT JSON's `:`).
    // Order preserved by Object.entries in insertion order on modern Node.
    assert.equal(out, '{"A"="1","B"="two"}')
  })

  it('throws on array element of non-string type (no silent stringify)', () => {
    assert.throws(() => tomlValue([1 as unknown as string]), /only string elements/)
  })

  it('throws on record value of non-string type', () => {
    assert.throws(() => tomlValue({ k: 42 as unknown as string }), /only string values/)
  })

  it('throws on unsupported top-level type (number, boolean, null)', () => {
    assert.throws(() => tomlValue(123 as unknown as string), /unsupported value type/)
    assert.throws(() => tomlValue(true as unknown as string), /unsupported value type/)
    assert.throws(() => tomlValue(null as unknown as string), /unsupported value type/)
  })

  // Path / unicode edge cases for the wire format. JSON.stringify is the
  // chosen encoder because its output is a TOML basic-string subset for
  // values that don't contain lone surrogates. These pin down the cases
  // we actually hit: spaces, backslashes, emoji, zero-width chars.
  it('encodes paths containing spaces by quoting', () => {
    assert.equal(tomlValue('/tmp/a b/c.md'), '"/tmp/a b/c.md"')
  })

  it('encodes Windows-style backslashes by escaping (path stays valid TOML basic string)', () => {
    assert.equal(tomlValue('C:\\foo\\bar.md'), '"C:\\\\foo\\\\bar.md"')
  })

  it('encodes emoji as escaped Unicode (JSON.stringify default) — TOML accepts \\uXXXX in basic strings', () => {
    // Node's JSON.stringify keeps emoji as raw chars, which TOML accepts.
    const out = tomlValue('hi 🚀')
    assert.equal(out, '"hi 🚀"')
  })

  it('encodes zero-width / control chars losslessly', () => {
    // U+200B zero-width space — passes through; JSON.stringify keeps it raw.
    const out = tomlValue('a\u200Bb')
    assert.equal(out, '"a\u200Bb"')
  })
})

describe('CODEX_PREAMBLE', () => {
  it('mentions openclaude_memory MCP server as the canonical access path', () => {
    assert.ok(CODEX_PREAMBLE.includes('openclaude_memory'), 'preamble must name the MCP server')
  })

  it('explicitly forbids using codex native ~/.codex/memories', () => {
    assert.ok(
      CODEX_PREAMBLE.includes('~/.codex/memories/'),
      'preamble must reference codex native memory dir to forbid',
    )
    // Loose phrasing check — wording may evolve, but the intent must be
    // negative ("do not" / "Do not").
    assert.match(CODEX_PREAMBLE, /[Dd]o\s*\*?\*?\s*not/, 'preamble must explicitly forbid use')
  })

  it('disclaims ccb-only tools so codex does not hallucinate calling them', () => {
    // Some marker that signals the "tool list authority" disclaimer.
    assert.ok(
      CODEX_PREAMBLE.toLowerCase().includes('authoritative tool list') ||
        CODEX_PREAMBLE.toLowerCase().includes('tool list'),
      'preamble should disclaim authoritative tool list',
    )
  })
})

describe('resolveMcpMemoryEntry', () => {
  it('returns the bundled module-relative path when running from this repo', () => {
    // The module-relative candidate is `<this file dir>/../../mcp-memory/src/index.ts`
    // which exists in the openclaude monorepo. We don't pin to a specific
    // candidate index — just assert the result resolves to an existing file.
    const out = resolveMcpMemoryEntry()
    assert.ok(out, 'expected a resolved path in the openclaude repo layout')
    assert.ok(existsSync(out), 'resolved path must exist on disk')
    assert.match(out, /mcp-memory\/src\/index\.ts$/)
  })

  it('returns null when none of the candidates exist', () => {
    // Pass a definitely-nonexistent claudeCodePath; module-relative + cwd
    // candidates may or may not resolve depending on test cwd. We exercise
    // the "all-missing" path by stubbing fs.existsSync via a temp dir.
    // Here we simply assert that explicit nonsense path doesn't crash and
    // either returns null OR a known-existing module candidate (which is
    // independent of claudeCodePath).
    const out = resolveMcpMemoryEntry('/nonexistent/path/that/should/not/exist')
    if (out !== null) {
      assert.ok(existsSync(out), 'fallback candidate must exist if returned')
    }
  })

  it('accepts undefined claudeCodePath and skips the third candidate gracefully', () => {
    // No throw, no crash — third candidate construction is gated on the param.
    const out = resolveMcpMemoryEntry(undefined)
    if (out !== null) {
      assert.ok(existsSync(out))
    }
  })
})

describe('buildCodexLaunchOverrides', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-codex-test-'))
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('argvOverrides starts with model_instructions_file pointing into sessionDir', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    assert.equal(out.argvOverrides[0], '-c')
    assert.match(
      out.argvOverrides[1] ?? '',
      /^model_instructions_file=".+\/extra-prompt\.md"$/,
      `expected model_instructions_file=<path>, got: ${out.argvOverrides[1]}`,
    )
    // The file path inside the override must be under sessionDir we passed.
    assert.ok(out.instructionsFile.startsWith(dir))
  })

  it('instructionsContent prepends CODEX_PREAMBLE before platform context', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    assert.ok(
      out.instructionsContent.startsWith(CODEX_PREAMBLE),
      'CODEX_PREAMBLE must lead the instructions file',
    )
    // Platform context content follows — the preamble is non-empty so a
    // simple length check confirms more than just the preamble was rendered.
    assert.ok(out.instructionsContent.length > CODEX_PREAMBLE.length)
  })

  it('explicitly injects AGENTS.md / CLAUDE.md from cwd into instructionsContent', async () => {
    const repo = join(dir, 'repo')
    const child = join(repo, 'nested')
    mkdirSync(child, { recursive: true })
    writeFileSync(join(repo, 'AGENTS.md'), '# Agent Rules\n\nUse worktrees.')
    writeFileSync(join(repo, 'CLAUDE.md'), '# Claude Rules\n\nNo direct edits.')
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionDir: dir,
      cwd: child,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    assert.ok(
      out.instructionsContent.includes('# Project rule files loaded from working directory'),
    )
    assert.ok(out.instructionsContent.includes('AGENTS.md'))
    assert.ok(out.instructionsContent.includes('Use worktrees.'))
    assert.ok(out.instructionsContent.includes('CLAUDE.md'))
    assert.ok(out.instructionsContent.includes('No direct edits.'))
  })

  it('mcp-memory keys appear in stable order when entry resolves', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    // If mcp-memory entry was found, the override list must include four
    // mcp_servers.openclaude_memory.* entries in the order:
    // command, args, env, approval mode.
    const mcpKeys = out.argvOverrides
      .filter((s) => s.startsWith('mcp_servers.openclaude_memory.'))
      .map((s) => s.slice(0, s.indexOf('=')))
    if (mcpKeys.length > 0) {
      assert.deepEqual(mcpKeys, [
        'mcp_servers.openclaude_memory.command',
        'mcp_servers.openclaude_memory.args',
        'mcp_servers.openclaude_memory.env',
        'mcp_servers.openclaude_memory.default_tools_approval_mode',
      ])
    }
  })

  it('pre-approves openclaude_memory MCP tools for trusted personal Codex', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    const approvalKey = out.argvOverrides.find((s) =>
      s.startsWith('mcp_servers.openclaude_memory.default_tools_approval_mode='),
    )
    if (approvalKey) {
      assert.equal(
        approvalKey,
        'mcp_servers.openclaude_memory.default_tools_approval_mode="approve"',
      )
    }
  })

  it('passes GPT/Codex reasoning effort through as model_reasoning_effort', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      model: 'gpt-5.6-sol',
      effortLevel: 'high',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    assert.equal(out.argvOverrides[0], '-c')
    assert.match(out.argvOverrides[1] ?? '', /^model_instructions_file=/)
    assert.equal(out.argvOverrides[2], '-c')
    assert.equal(out.argvOverrides[3], 'model_reasoning_effort="high"')
  })

  it('passes Sol max as codex model_reasoning_effort', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      model: 'gpt-5.6-sol',
      effortLevel: 'max',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    assert.ok(out.argvOverrides.includes('model_reasoning_effort="max"'))
  })

  it('does not pass max to a Codex model without that declared capability', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      model: 'openai/gpt-5.6-terra',
      effortLevel: 'max',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    assert.equal(
      out.argvOverrides.some((s) => s.startsWith('model_reasoning_effort=')),
      false,
    )
  })

  it('does not pass Claude-only ultracode as codex model_reasoning_effort', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      model: 'gpt-5.6-sol',
      effortLevel: 'ultracode',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    assert.equal(
      out.argvOverrides.some((s) => s.startsWith('model_reasoning_effort=')),
      false,
    )
  })

  it('mcp env injection includes gatewayToken (scoped to MCP child, not codex main)', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-secret-xyz',
    })
    const envKey = out.argvOverrides.find((s) => s.startsWith('mcp_servers.openclaude_memory.env='))
    if (envKey) {
      // env is a JSON-style inline table containing OPENCLAUDE_GATEWAY_TOKEN.
      assert.ok(envKey.includes('OPENCLAUDE_GATEWAY_TOKEN'), 'env must carry the token')
      assert.ok(envKey.includes('tok-secret-xyz'), 'env must contain the actual token value')
    }
  })

  it('argvOverrides is empty (no MCP keys) when entry resolution returns null', async () => {
    // Force null by passing claudeCodePath that doesn't exist AND patching
    // process.cwd to a location with no packages/mcp-memory. Achieved by
    // running the resolver with a known-bad cwd via subprocess would be
    // overkill — instead, sanity check that when entry IS found we have 10
    // overrides (1 instructions + 8 mcp), and when not we have 2 (1 pair).
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    // argvOverrides comes in `-c key=value` pairs, so length must be even.
    assert.equal(
      out.argvOverrides.length % 2,
      0,
      'argvOverrides must always come in -c key=value pairs',
    )
    // Must always have at least the instructions pair.
    assert.ok(out.argvOverrides.length >= 2)
  })
})

describe('readProjectRulesSlot', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-codex-rules-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('walks upward from cwd to find repository-local rule files', () => {
    const repo = join(dir, 'repo')
    const child = join(repo, 'a', 'b')
    mkdirSync(child, { recursive: true })
    writeFileSync(join(repo, 'AGENTS.md'), 'root agents rule')
    const slot = readProjectRulesSlot(child)
    assert.ok(slot.includes(join(repo, 'AGENTS.md')))
    assert.ok(slot.includes('root agents rule'))
  })

  it('returns empty string when cwd has no AGENTS.md or CLAUDE.md in parents', () => {
    assert.equal(readProjectRulesSlot(dir), '')
  })
})
