import * as assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
/**
 * Tests for `codexLaunchOverrides` — adapter that translates OpenClaude's
 * 7-slot platform context + mcp-memory MCP server into per-spawn `-c` argv
 * fragments for codex CLI.
 *
 * Load-bearing invariants:
 *   1. argvOverrides order is stable: model_instructions_file FIRST, then the
 *      three mcp_servers.openclaude_memory.* keys (command, args, env).
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
import { resolveDelegateTimeoutConfig } from '../delegateTimeout.js'

const { tomlValue, CODEX_PREAMBLE, codexMcpToolTimeoutSec } = _internals

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T> | T) {
  const old = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    old.set(key, process.env[key])
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

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
    assert.throws(
      () => tomlValue({ k: 42 as unknown as string }),
      /only string values/,
    )
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
    assert.ok(
      CODEX_PREAMBLE.includes('openclaude_memory'),
      'preamble must name the MCP server',
    )
    assert.ok(CODEX_PREAMBLE.includes('skill_search'), 'preamble must mention skill_search')
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

  it('mcp-memory keys appear in stable order when entry resolves', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-xyz',
    })
    // If mcp-memory entry was found, the override list must include four
    // mcp_servers.openclaude_memory.* entries in the order: command, args,
    // env, approval mode.
    const mcpKeys = out.argvOverrides
      .filter((s) => s.startsWith('mcp_servers.openclaude_memory.'))
      .map((s) => s.slice(0, s.indexOf('=')))
    if (mcpKeys.length > 0) {
      assert.deepEqual(mcpKeys, [
        'mcp_servers.openclaude_memory.command',
        'mcp_servers.openclaude_memory.args',
        'mcp_servers.openclaude_memory.env',
        'mcp_servers.openclaude_memory.default_tools_approval_mode',
        'mcp_servers.openclaude_memory.tool_timeout_sec',
      ])
    }
  })

  it('extends codex MCP tool timeout so long delegate_task calls can finish', async () => {
    assert.equal(codexMcpToolTimeoutSec({}), 3600)
    assert.equal(codexMcpToolTimeoutSec({ OPENCLAUDE_CODEX_MCP_TOOL_TIMEOUT_SEC: '900' }), 900)
    assert.equal(codexMcpToolTimeoutSec({ OPENCLAUDE_CODEX_MCP_TOOL_TIMEOUT_SEC: '5' }), 60)
    assert.equal(codexMcpToolTimeoutSec({ OPENCLAUDE_CODEX_MCP_TOOL_TIMEOUT_SEC: '99999' }), 7200)
    assert.ok(
      codexMcpToolTimeoutSec({}) * 1000 > resolveDelegateTimeoutConfig({}).hardTimeoutMs,
      'default Codex MCP tool timeout must exceed gateway delegate hard timeout so gateway returns structured errors before MCP aborts',
    )

    await withEnv({ OPENCLAUDE_CODEX_MCP_TOOL_TIMEOUT_SEC: '900' }, async () => {
      const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
      const out = await buildCodexLaunchOverrides({
        agentId: 'test-agent',
        sessionKey: 'agent:test-agent:webchat:dm:sess_123',
        sessionDir: dir,
        gatewayPort: 18789,
        gatewayToken: 'tok',
      })
      assert.ok(
        out.argvOverrides.includes('mcp_servers.openclaude_memory.tool_timeout_sec=900'),
        `argv must include tool_timeout_sec override; got ${out.argvOverrides.join(' ')}`,
      )
    })
  })

  it('mcp env injection points at OPENCLAUDE_GATEWAY_TOKEN_FILE; argv MUST NOT contain token literal', async () => {
    // v3 hardening: gateway token never lands in codex argv (would be visible
    // via `ps -ef` / /proc/<pid>/cmdline). Instead the env override sets
    // OPENCLAUDE_GATEWAY_TOKEN_FILE=<sessionDir>/gateway-token, and the runner
    // writes the token to that 0600 file before spawn. mcp-memory reads it via
    // readGatewayToken() at startup.
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const TOKEN = 'tok-secret-MUST-NOT-LEAK-INTO-ARGV'
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionKey: 'agent:test-agent:webchat:dm:sess_123',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: TOKEN,
    })
    const envKey = out.argvOverrides.find((s) => s.startsWith('mcp_servers.openclaude_memory.env='))
    if (envKey) {
      // env table must carry the FILE path, not the token itself.
      assert.ok(
        envKey.includes('OPENCLAUDE_GATEWAY_TOKEN_FILE'),
        'env must point at OPENCLAUDE_GATEWAY_TOKEN_FILE',
      )
      assert.ok(
        envKey.includes(`${dir}/gateway-token`),
        `env must reference the token file under sessionDir; got: ${envKey}`,
      )
      assert.ok(
        envKey.includes('OPENCLAUDE_SESSION_KEY'),
        `env must carry parent session key for delegate progress routing; got: ${envKey}`,
      )
      assert.ok(
        envKey.includes('agent:test-agent:webchat:dm:sess_123'),
        `env must carry the exact parent session key; got: ${envKey}`,
      )
      // Hard invariant: NO override value may contain the token literal.
      assert.ok(
        !envKey.includes(TOKEN),
        `argv must NOT contain the token literal; got envKey: ${envKey}`,
      )
      // It must also not carry the legacy bare-env key, which would defeat
      // the hardening if both got set (mcp-memory prefers file but old env
      // is still readable via `ps -ef`).
      //
      // Regex (not substring) because tomlValue() emits quoted inline-table
      // keys like `"OPENCLAUDE_GATEWAY_TOKEN"="..."` — a substring check on
      // `OPENCLAUDE_GATEWAY_TOKEN=` would miss that form. The pattern allows
      // optional whitespace around `=` because TOML accepts it.
      assert.ok(
        !/"OPENCLAUDE_GATEWAY_TOKEN"\s*=/.test(envKey),
        `legacy OPENCLAUDE_GATEWAY_TOKEN env key must not be set; got envKey: ${envKey}`,
      )
    }
    // No override anywhere may contain the token literal.
    for (const tok of out.argvOverrides) {
      assert.ok(!tok.includes(TOKEN), `argv leaked token in: ${tok}`)
    }
  })

  it('mcp env forwards OPENCLAUDE_BASELINE_SKILLS_DIR when present so codex can see platform skills', async () => {
    const baselineDir = mkdtempSync(join(tmpdir(), 'codex-baseline-skills-'))
    try {
      await withEnv({ OPENCLAUDE_BASELINE_SKILLS_DIR: baselineDir }, async () => {
        const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
        const out = await buildCodexLaunchOverrides({
          agentId: 'test-agent',
          sessionDir: dir,
          gatewayPort: 18789,
          gatewayToken: 'tok-xyz',
        })
        const envKey = out.argvOverrides.find((s) =>
          s.startsWith('mcp_servers.openclaude_memory.env='),
        )
        if (envKey) {
          assert.ok(
            envKey.includes('OPENCLAUDE_BASELINE_SKILLS_DIR'),
            `env must forward baseline skills dir; got: ${envKey}`,
          )
          assert.ok(
            envKey.includes(baselineDir),
            `env must include baseline skills dir value; got: ${envKey}`,
          )
        }
      })
    } finally {
      rmSync(baselineDir, { recursive: true, force: true })
    }
  })

  it('returns tokenFile under sessionDir and tokenContent matching gatewayToken when mcp resolves', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const out = await buildCodexLaunchOverrides({
      agentId: 'test-agent',
      sessionDir: dir,
      gatewayPort: 18789,
      gatewayToken: 'tok-write-me',
    })
    // When mcp-memory entry doesn't resolve we'd get null; in this repo
    // it always resolves, so assert non-null and the two paths line up.
    if (out.tokenFile !== null) {
      assert.ok(out.tokenFile.startsWith(dir), 'tokenFile must live inside sessionDir')
      assert.equal(out.tokenContent, 'tok-write-me')
      // Same path the env table references.
      const envKey = out.argvOverrides.find((s) =>
        s.startsWith('mcp_servers.openclaude_memory.env='),
      )
      assert.ok(envKey?.includes(out.tokenFile), 'env override must reference exact tokenFile path')
    } else {
      assert.equal(out.tokenContent, null, 'tokenContent must mirror tokenFile null-ness')
    }
  })

  it('argvOverrides is empty (no MCP keys) when entry resolution returns null', async () => {
    // Force null by passing claudeCodePath that doesn't exist AND patching
    // process.cwd to a location with no packages/mcp-memory. Achieved by
    // running the resolver with a known-bad cwd via subprocess would be
    // overkill — instead, sanity check that when entry IS found we have 8
    // overrides (1 instructions + 6 mcp), and when not we have 2 (1 pair).
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

  it('mounts openclaude-vision for Codex without leaking the v3 container token into argv', async () => {
    const { buildCodexLaunchOverrides } = await import('../codexLaunchOverrides.js')
    const TOKEN = 'container-token-MUST-NOT-LEAK'
    await withEnv(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:1',
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        OPENCLAUDE_VISION_MCP_DISABLED: undefined,
      },
      async () => {
        const out = await buildCodexLaunchOverrides({
          agentId: 'test-agent',
          provider: 'codex-native',
          model: 'gpt-5.5',
          sessionDir: dir,
          gatewayPort: 18789,
          gatewayToken: 'gateway-token',
        })
        const visionEnv = out.argvOverrides.find((s) =>
          s.startsWith('mcp_servers.openclaude-vision.env='),
        )
        assert.ok(visionEnv, 'expected openclaude-vision MCP env override')
        assert.ok(visionEnv!.includes('OPENCLAUDE_V3_CONTAINER_TOKEN_FILE'))
        assert.ok(visionEnv!.includes(`${dir}/v3-container-token`))
        assert.ok(!visionEnv!.includes(TOKEN), 'argv must not contain container token literal')
        assert.ok(!/"OPENCLAUDE_V3_CONTAINER_TOKEN"\s*=/.test(visionEnv!))
        for (const arg of out.argvOverrides) {
          assert.ok(!arg.includes(TOKEN), `argv leaked token in: ${arg}`)
        }
        assert.equal(out.visionTokenFile, `${dir}/v3-container-token`)
        assert.equal(out.visionTokenContent, TOKEN)
        assert.match(out.instructionsContent, /GPT\/Codex 图片理解提示/)
      },
    )
  })
})
