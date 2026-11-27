/**
 * Hard out-of-process read-only sandbox verification for local Antigravity CLI
 * turns (OCV5-893).
 *
 * Run: npx tsx --test packages/gateway/src/engine/__tests__/antigravityReadOnly.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { paths, type OpenClaudeConfig } from '@openclaude/storage'

import {
  ANTIGRAVITY_PREAMBLE,
  type AntigravityPlatformInput,
  _antigravityPlatformInternals,
  antigravityRoot,
  antigravitySessionBrainDir,
  cleanupAntigravityLaunch,
  projectAntigravityPlatform,
} from '../antigravityPlatform.js'
import {
  ANTIGRAVITY_READ_ONLY_DIRECT_MCP_TOOLS,
  ANTIGRAVITY_READ_ONLY_EAGER_MCP_TOOLS,
  ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE,
  ANTIGRAVITY_READ_ONLY_HOOK_GROUP,
  ANTIGRAVITY_READ_ONLY_MCP_TOOLS,
  ANTIGRAVITY_READ_ONLY_NATIVE_TOOLS,
  _readOnlyGuardInternals,
  installAntigravityReadOnlyGuard,
} from '../antigravityReadOnlyGuard.js'
import { AntigravityAdapter } from '../antigravityAdapter.js'
import type { EngineCreateOpts } from '../registry.js'

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function runGuardHook(
  pythonBin: string,
  scriptPath: string,
  stdinPayload: string,
): { decision: string; reason?: string } {
  const res = spawnSync(pythonBin, ['-I', '-B', scriptPath], {
    input: stdinPayload,
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(res.status, 0, `hook exited non-zero (${res.status}): stderr=${res.stderr}`)
  assert.equal(res.stderr, '', `hook wrote unexpected stderr: ${res.stderr}`)
  return JSON.parse(res.stdout.trim()) as { decision: string; reason?: string }
}

function makePlatformInput(overrides: Partial<AntigravityPlatformInput> = {}): AntigravityPlatformInput {
  return {
    credential: {
      accessToken: 'limited-test-token',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    agentId: 'main',
    sessionKey: 'agent:main:webchat:dm:agy-readonly-test',
    traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    gatewayPort: 18789,
    gatewayToken: 'test-gateway-token',
    delegationDepth: 0,
    hostBin: null,
    ...overrides,
  }
}

async function withIsolatedHome(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-agy-ro-guard-'))
  const oldHome = process.env.OPENCLAUDE_HOME
  const oldStorageHome = paths.home
  process.env.OPENCLAUDE_HOME = join(dir, 'openclaude-home')
  paths.home = join(dir, 'storage-home')
  try {
    await fn(dir)
  } finally {
    _readOnlyGuardInternals.setPythonCandidatesOverride(null)
    _antigravityPlatformInternals.setLaunchOwnerWriterForTests(null)
    if (oldHome === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = oldHome
    paths.home = oldStorageHome
    await rm(dir, { recursive: true, force: true })
  }
}

test('readonly_guard.py real python3 subprocess enforces fail-closed allowlist for native, direct MCP, call_mcp_tool, forbidden tools, and invalid payloads', async () => {
  await withIsolatedHome(async (dir) => {
    const launchHome = join(dir, 'launch')
    const configDir = join(launchHome, '.gemini', 'config')
    mkdirSync(configDir, { recursive: true, mode: 0o700 })

    const guard = installAntigravityReadOnlyGuard({ launchHome, configDir })
    assert.equal(statSync(guard.guardScriptPath).mode & 0o777, 0o400)
    assert.equal(statSync(guard.hooksConfigPath).mode & 0o777, 0o400)
    assert.equal(sha256(readFileSync(guard.guardScriptPath)), guard.guardScriptSha256)
    assert.equal(sha256(readFileSync(guard.hooksConfigPath)), guard.hooksConfigSha256)

    // Verify hooks.json matches Antigravity CLI 1.5.15 PreToolUse contract
    const hooksObj = JSON.parse(readFileSync(guard.hooksConfigPath, 'utf8')) as Record<string, any>
    assert.deepEqual(Object.keys(hooksObj), [ANTIGRAVITY_READ_ONLY_HOOK_GROUP])
    const preTool = hooksObj[ANTIGRAVITY_READ_ONLY_HOOK_GROUP].PreToolUse
    assert.equal(Array.isArray(preTool), true)
    assert.equal(preTool.length, 1)
    assert.equal(preTool[0].matcher, '.*')
    assert.deepEqual(preTool[0].hooks, [
      {
        type: 'command',
        command: `${guard.pythonBin} -I -B ${guard.guardScriptPath}`,
        timeout: 5,
      },
    ])

    // 1) Allowed native read-only tools across payload shapes
    for (const tool of ANTIGRAVITY_READ_ONLY_NATIVE_TOOLS) {
      assert.deepEqual(
        runGuardHook(guard.pythonBin, guard.guardScriptPath, JSON.stringify({ toolCall: { name: tool } })),
        { decision: 'allow' },
        `native allow failed for ${tool}`,
      )
      assert.deepEqual(
        runGuardHook(guard.pythonBin, guard.guardScriptPath, JSON.stringify({ tool_call: { name: tool } })),
        { decision: 'allow' },
      )
      assert.deepEqual(
        runGuardHook(guard.pythonBin, guard.guardScriptPath, JSON.stringify({ tool_name: tool })),
        { decision: 'allow' },
      )
    }

    // 2) Allowed direct openclaude-memory MCP tools
    for (const tool of ANTIGRAVITY_READ_ONLY_DIRECT_MCP_TOOLS) {
      assert.deepEqual(
        runGuardHook(guard.pythonBin, guard.guardScriptPath, JSON.stringify({ toolCall: { name: tool } })),
        { decision: 'allow' },
        `direct MCP allow failed for ${tool}`,
      )
    }

    // 3) Allowed call_mcp_tool on ServerName="openclaude-memory"
    for (const toolName of ANTIGRAVITY_READ_ONLY_MCP_TOOLS) {
      assert.deepEqual(
        runGuardHook(
          guard.pythonBin,
          guard.guardScriptPath,
          JSON.stringify({
            toolCall: {
              name: 'call_mcp_tool',
              args: { ServerName: 'openclaude-memory', ToolName: toolName, Arguments: {} },
            },
          }),
        ),
        { decision: 'allow' },
        `call_mcp_tool allow failed for ${toolName}`,
      )
    }

    // 4) Forbidden native / execution / delegation / swarm / write MCP tools
    const forbiddenTools = [
      'write_file',
      'edit_file',
      'run_command',
      'manage_task',
      'invoke_subagent',
      'define_subagent',
      'manage_subagents',
      'send_message',
      'schedule',
      'run_workflow',
      'swarm',
      'post_message',
      'read_board',
      'swarm_wait',
      'mcp_openclaude-memory_oc_bash',
      'mcp_openclaude-memory_delegate_task',
      'mcp_openclaude-memory_task_create',
      'mcp_other-server_oc_grep',
      'unknown_future_tool',
    ]
    for (const tool of forbiddenTools) {
      const out = runGuardHook(guard.pythonBin, guard.guardScriptPath, JSON.stringify({ toolCall: { name: tool } }))
      assert.deepEqual(
        out,
        { decision: 'deny', reason: `readonly_turn_forbidden:${tool}` },
        `expected deny for ${tool}`,
      )
    }

    // 5) Forbidden call_mcp_tool invocations
    const forbiddenMcpTools = [
      'oc_bash',
      'delegate_task',
      'delegate_tasks',
      'task_create',
      'task_update',
      'task_approve',
      'skill_save',
      'skill_delete',
      'create_reminder',
      'update_reminder',
      'delete_reminder',
      'send_to_agent',
      'consult_advisor',
    ]
    for (const toolName of forbiddenMcpTools) {
      const out = runGuardHook(
        guard.pythonBin,
        guard.guardScriptPath,
        JSON.stringify({
          toolCall: {
            name: 'call_mcp_tool',
            args: { ServerName: 'openclaude-memory', ToolName: toolName, Arguments: {} },
          },
        }),
      )
      assert.equal(out.decision, 'deny', `call_mcp_tool(${toolName}) must be denied`)
      assert.equal(out.reason, `readonly_turn_forbidden:call_mcp_tool:${toolName}`)
    }

    // Wrong server name, missing args, and dual-key smuggling must all deny
    const badCallMcpPayloads = [
      { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'evil-server', ToolName: 'oc_grep' } } },
      { toolCall: { name: 'call_mcp_tool' } },
      {
        toolCall: {
          name: 'call_mcp_tool',
          args: { ServerName: 'openclaude-memory', server_name: 'evil', ToolName: 'oc_grep' },
        },
      },
      {
        toolCall: {
          name: 'call_mcp_tool',
          args: { ServerName: 'openclaude-memory', ToolName: 'oc_grep', tool_name: 'oc_bash' },
        },
      },
    ]
    for (const payload of badCallMcpPayloads) {
      const out = runGuardHook(guard.pythonBin, guard.guardScriptPath, JSON.stringify(payload))
      assert.equal(out.decision, 'deny', `expected deny for ${JSON.stringify(payload)}`)
      assert.ok(out.reason?.startsWith('readonly_turn_forbidden:call_mcp_tool'))
    }

    // 6) Invalid / malformed / ambiguous payloads fail closed with readonly_hook_invalid_payload
    const invalidPayloads = [
      '',
      '   ',
      '{not-json',
      '[]',
      '"read_file"',
      '{}',
      JSON.stringify({ toolCall: { name: '' } }),
      JSON.stringify({ toolCall: { name: '   ' } }),
      JSON.stringify({ toolCall: { name: ' read_file' } }),
      JSON.stringify({ toolCall: { name: 42 } }),
      JSON.stringify({ toolCall: { name: ['read_file'] } }),
      JSON.stringify({ toolCall: 'not-a-dict', tool_name: 'read_file' }),
      JSON.stringify({ toolCall: { name: 'read_file' }, tool_name: 'write_file' }),
    ]
    for (const raw of invalidPayloads) {
      assert.deepEqual(
        runGuardHook(guard.pythonBin, guard.guardScriptPath, raw),
        { decision: 'deny', reason: 'readonly_hook_invalid_payload' },
        `invalid payload must fail closed: ${raw}`,
      )
    }
  })
})

test('projectAntigravityPlatform isolates readOnly turns from concurrent normal turns, narrows MCP, scrubs stale hooks, and fails closed if python3 is unavailable', async () => {
  await withIsolatedHome(async (dir) => {
    const fakeHostBin = join(dir, 'host-wrapper')
    await writeFile(fakeHostBin, '#!/bin/sh\nexit 0\n')
    await chmod(fakeHostBin, 0o755)

    // Seed a stale read-only hook under shared home/.gemini/config to ensure normal turns scrub it
    const staleSharedConfig = join(process.env.OPENCLAUDE_HOME!, 'antigravity-cli', 'home', '.gemini', 'config')
    mkdirSync(staleSharedConfig, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(staleSharedConfig, 'hooks.json'),
      JSON.stringify({ [ANTIGRAVITY_READ_ONLY_HOOK_GROUP]: { PreToolUse: [] } }),
      { mode: 0o400 },
    )

    const normalProj = projectAntigravityPlatform(
      makePlatformInput({ readOnly: false, hostBin: fakeHostBin, claudeCodePath: dir }),
    )
    const roProj = projectAntigravityPlatform(
      makePlatformInput({
        readOnly: true,
        hostBin: fakeHostBin,
        claudeCodePath: dir,
        traceId: '11223344556677889900aabbccddeeff',
      }),
    )
    try {
      // Concurrency isolation: different buckets and launchHomes
      assert.ok(normalProj.launchHome.startsWith(join(normalProj.root, 'launch') + '/'))
      assert.ok(roProj.launchHome.startsWith(join(roProj.root, 'readonly-turns') + '/'))
      assert.notEqual(normalProj.launchHome, roProj.launchHome)
      assert.equal(roProj.readOnly, true)
      assert.ok(roProj.readOnlyGuard)
      assert.equal(roProj.hostPathDir, null, 'read-only turn must not expose host wrapper on PATH')
      assert.ok(normalProj.hostPathDir, 'normal turn retains host wrapper')
      assert.ok(
        roProj.sessionBrainDir.startsWith(roProj.launchHome + '/'),
        'read-only turn must isolate its CLI brain dir inside readonly-turns/ro-* instead of symlinking shared sessionBrainDir',
      )
      assert.equal(lstatSync(roProj.sessionBrainDir).isSymbolicLink(), false)
      assert.notEqual(roProj.sessionBrainDir, normalProj.sessionBrainDir)

      // Normal turn has NO read-only hook (and stale shared hook was scrubbed)
      assert.equal(existsSync(join(normalProj.launchHome, '.gemini', 'config', 'hooks.json')), false)
      assert.equal(existsSync(join(staleSharedConfig, 'hooks.json')), false)

      // Read-only turn has 0400 hooks.json and readonly_guard.py
      assert.equal(lstatSync(roProj.readOnlyGuard.hooksConfigPath).mode & 0o777, 0o400)
      assert.equal(lstatSync(roProj.readOnlyGuard.guardScriptPath).mode & 0o777, 0o400)

      // MCP config in read-only turn sets OC_READ_ONLY_TURN=1 + OPENCLAUDE_ADVISOR_READ_ONLY=1 and restricts eager/advertised tools
      const roMcpCfg = JSON.parse(
        readFileSync(join(roProj.launchHome, '.gemini', 'config', 'mcp_config.json'), 'utf8'),
      ) as { mcpServers: Record<string, { env: Record<string, string>; tools: Record<string, unknown> }> }
      const roServer = roMcpCfg.mcpServers['openclaude-memory']
      assert.ok(roServer)
      assert.equal(roServer.env.OC_READ_ONLY_TURN, '1')
      assert.equal(roServer.env.OPENCLAUDE_ADVISOR_READ_ONLY, '1')
      assert.deepEqual(Object.keys(roServer.tools).sort(), [...ANTIGRAVITY_READ_ONLY_EAGER_MCP_TOOLS].sort())
      assert.deepEqual([...roProj.advertisedMcpTools].sort(), [...ANTIGRAVITY_READ_ONLY_MCP_TOOLS].sort())
      assert.equal(roProj.advertisedMcpTools.includes('delegate_task'), false)
      assert.equal(roProj.advertisedMcpTools.includes('task_create'), false)

      // Normal turn MCP config does NOT set OC_READ_ONLY_TURN
      const normalMcpCfg = JSON.parse(
        readFileSync(join(normalProj.launchHome, '.gemini', 'config', 'mcp_config.json'), 'utf8'),
      ) as { mcpServers: Record<string, { env: Record<string, string>; tools: Record<string, unknown> }> }
      const normalServer = normalMcpCfg.mcpServers['openclaude-memory']
      assert.ok(normalServer)
      assert.equal(normalServer.env.OC_READ_ONLY_TURN, undefined)
      assert.equal('oc_bash' in normalServer.tools, true)

      // Cleanup read-only turn leaves normal turn intact
      cleanupAntigravityLaunch(roProj)
      assert.equal(existsSync(roProj.launchHome), false)
      assert.equal(existsSync(normalProj.launchHome), true)
    } finally {
      cleanupAntigravityLaunch(roProj)
      cleanupAntigravityLaunch(normalProj)
    }
    assert.equal(existsSync(normalProj.launchHome), false)

    // Fail-closed when python3 is unavailable (and leaves no orphaned readonly-turns dir)
    _readOnlyGuardInternals.setPythonCandidatesOverride(['/nonexistent/bin/python3'])
    assert.throws(
      () => projectAntigravityPlatform(makePlatformInput({ readOnly: true, claudeCodePath: dir })),
      new RegExp(ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE),
    )
    const roRoot = join(normalProj.root, 'readonly-turns')
    assert.deepEqual(existsSync(roRoot) ? readdirSync(roRoot) : [], [])
  })
})

test('AntigravityAdapter runs local readOnly turns with isolated PreToolUse guard, disables elision, cleans up, and fails closed without python3', { timeout: 60_000 }, async () => {
  await withIsolatedHome(async (dir) => {
    const captureFile = join(dir, 'capture.json')
    const fakeBin = join(dir, 'fake-antigravity.cjs')
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const readline = require('node:readline');
const home = process.env.HOME;
const hooksPath = path.join(home, '.gemini', 'config', 'hooks.json');
const guardPath = path.join(home, 'readonly_guard.py');
const hooksRaw = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, 'utf8') : null;
let allowCheck = null;
let denyCheck = null;
if (hooksRaw) {
  const hooks = JSON.parse(hooksRaw);
  const cmd = hooks['openclaude-local-readonly'].PreToolUse[0].hooks[0].command;
  allowCheck = JSON.parse(cp.execSync(cmd, { input: JSON.stringify({ toolCall: { name: 'read_file' } }), encoding: 'utf8' }));
  denyCheck = JSON.parse(cp.execSync(cmd, { input: JSON.stringify({ toolCall: { name: 'write_file' } }), encoding: 'utf8' }));
}
fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  home,
  ocReadOnly: process.env.OC_READ_ONLY_TURN ?? null,
  hooksExists: fs.existsSync(hooksPath),
  guardExists: fs.existsSync(guardPath),
  allowCheck,
  denyCheck,
}));
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', () => {
  console.log(JSON.stringify({ event: 'init', conversation_id: '22222222-2222-4222-8222-222222222222', model: 'gemini-4-carbon-medium' }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: '22222222-2222-4222-8222-222222222222', status: 'SUCCESS', response: 'readonly review complete' } }));
  process.exit(0);
});
`,
    )
    await chmod(fakeBin, 0o755)

    const oldBin = process.env.OC_ANTIGRAVITY_CLI_BIN
    process.env.OC_ANTIGRAVITY_CLI_BIN = fakeBin
    const adapter = new AntigravityAdapter({
      agentId: 'main',
      agentBaseDir: dir,
      sessionKey: 'agent:main:webchat:dm:agy-adapter-ro',
      model: 'antigravity-gemini-4-carbon',
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'test-token' },
        auth: { mode: 'api_key', claudeCodePath: dir },
        defaults: { model: 'antigravity-gemini-4-carbon' },
      } as OpenClaudeConfig,
    } as EngineCreateOpts)
    adapter.on('error', () => {})
    adapter.setAntigravityRoute({
      routeToken: 'c'.repeat(64),
      baseUrl: `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${'c'.repeat(64)}`,
      accessToken: 'test-access-token',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })

    try {
      const run = adapter.submitTurn({
        input: '只读审阅仓库',
        readOnly: true,
        traceId: 'fedcba9876543210fedcba9876543210',
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(summary?.isError, false, JSON.stringify(summary))
      assert.equal(summary?.assistantText, 'readonly review complete')

      const captured = JSON.parse(readFileSync(captureFile, 'utf8')) as {
        home: string
        ocReadOnly: string | null
        hooksExists: boolean
        guardExists: boolean
        allowCheck: { decision: string }
        denyCheck: { decision: string; reason: string }
      }
      assert.match(captured.home, /\/readonly-turns\/ro-fedcba9876543210fedcba9876543210-[0-9a-f]+$/)
      assert.equal(captured.ocReadOnly, '1')
      assert.equal(captured.hooksExists, true)
      assert.equal(captured.guardExists, true)
      assert.deepEqual(captured.allowCheck, { decision: 'allow' })
      assert.deepEqual(captured.denyCheck, { decision: 'deny', reason: 'readonly_turn_forbidden:write_file' })
      assert.equal(existsSync(captured.home), false, 'isolated readonly-turns launchHome must be cleaned after turn')

      // Fail-closed if python3 disappears before next read-only turn
      await rm(captureFile, { force: true })
      _readOnlyGuardInternals.setPythonCandidatesOverride(['/nonexistent/python3'])
      const failRun = adapter.submitTurn({
        input: '只读审阅应 fail-closed',
        readOnly: true,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 1 },
        toolUseIdToName: new Map(),
      })
      await assert.rejects(() => failRun.submitted, new RegExp(ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE))
      const failSummary = await failRun.summary
      assert.equal(failSummary?.isError, true)
      assert.equal(existsSync(captureFile), false, 'CLI must NOT spawn when read-only guard cannot be installed')
    } finally {
      await adapter.shutdown()
      if (oldBin === undefined) delete process.env.OC_ANTIGRAVITY_CLI_BIN
      else process.env.OC_ANTIGRAVITY_CLI_BIN = oldBin
    }
  })
})

test('ANTIGRAVITY_PREAMBLE aligns remote swarm model policy with Swarm directive', () => {
  assert.ok(
    ANTIGRAVITY_PREAMBLE.includes(
      "(both local native swarm and remote swarm allow choosing authorized models from the turn's Swarm directive when helpful)",
    ),
  )
  assert.equal(ANTIGRAVITY_PREAMBLE.includes('remote swarm keeps'), false)
})

test('B5: local readOnly turn exit never runs cleanupKilledNativeSwarmWorktrees or mutates Git worktrees/branches, while normal turn still cleans them', { timeout: 60_000 }, async () => {
  await withIsolatedHome(async (dir) => {
    const repoDir = join(dir, 'repo')
    mkdirSync(repoDir, { recursive: true })
    const git = (args: string[], cwd = repoDir) => {
      const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 })
      assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`)
      return res.stdout.trim()
    }

    git(['init'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test User'])
    await writeFile(join(repoDir, 'README.md'), 'initial-content\n')
    git(['add', 'README.md'])
    git(['commit', '-m', 'init'])

    const convId = '33333333-3333-4333-8333-333333333333'
    const convPrefix = convId.slice(0, 8)
    const branchName = `swarm/${convPrefix}-worker-a`
    const worktreePath = join(repoDir, '.oc-swarm-worktrees', `${convPrefix}-worker-a`)
    mkdirSync(join(repoDir, '.oc-swarm-worktrees'), { recursive: true })
    git(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])

    const sessionKey = 'agent:main:webchat:dm:agy-b5-git-worktree'
    const sharedBrainDir = antigravitySessionBrainDir(antigravityRoot(), sessionKey)
    const swarmDir = join(sharedBrainDir, convId, '.system_generated', 'swarm')
    mkdirSync(swarmDir, { recursive: true, mode: 0o700 })
    const rosterPath = join(swarmDir, 'members.json')
    writeFileSync(
      rosterPath,
      JSON.stringify({
        members: {
          'worker-a': {
            killed: true,
            workspace_mode: 'branch',
            workspace: worktreePath,
          },
        },
      }),
      { mode: 0o600 },
    )

    const spawnHomesFile = join(dir, 'spawn-homes.jsonl')
    const fakeBin = join(dir, 'fake-antigravity-b5.cjs')
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(${JSON.stringify(spawnHomesFile)}, JSON.stringify({ home: process.env.HOME }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', () => {
  console.log(JSON.stringify({ event: 'init', conversation_id: ${JSON.stringify(convId)}, model: 'gemini-4-carbon-medium' }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: ${JSON.stringify(convId)}, status: 'SUCCESS', response: 'b5 check ok' } }));
  process.exit(0);
});
`,
    )
    await chmod(fakeBin, 0o755)

    const oldBin = process.env.OC_ANTIGRAVITY_CLI_BIN
    process.env.OC_ANTIGRAVITY_CLI_BIN = fakeBin
    const makeAdapter = () => {
      const adapter = new AntigravityAdapter({
        agentId: 'main',
        agentBaseDir: repoDir,
        sessionKey,
        model: 'antigravity-gemini-4-carbon',
        config: {
          version: 1,
          gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'test-token' },
          auth: { mode: 'api_key', claudeCodePath: dir },
          defaults: { model: 'antigravity-gemini-4-carbon' },
        } as OpenClaudeConfig,
      } as EngineCreateOpts)
      adapter.on('error', () => {})
      adapter.setAntigravityRoute({
        routeToken: 'd'.repeat(64),
        baseUrl: `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${'d'.repeat(64)}`,
        accessToken: 'test-access-token',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
      return adapter
    }

    const roAdapter = makeAdapter()
    const normalAdapter = makeAdapter()
    try {
      // 1) Read-only turn MUST leave Git worktree, branch, workspace content, and shared roster 100% untouched
      const roRun = roAdapter.submitTurn({
        input: '只读审阅仓库，禁止触碰 git worktree 与分支',
        readOnly: true,
        traceId: 'b5000000000000000000000000000001',
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await roRun.submitted
      const roSummary = await roRun.summary
      await roAdapter.waitForOutputDrain()
      assert.equal(roSummary?.isError, false, JSON.stringify(roSummary))

      assert.equal(existsSync(worktreePath), true, 'readOnly turn must NOT remove existing git worktree')
      assert.equal(readFileSync(join(worktreePath, 'README.md'), 'utf8'), 'initial-content\n')
      assert.equal(readFileSync(join(repoDir, 'README.md'), 'utf8'), 'initial-content\n')
      assert.ok(git(['branch', '--list', branchName]).includes(branchName), 'readOnly turn must NOT delete swarm branch')
      assert.ok(git(['worktree', 'list', '--porcelain']).includes(worktreePath), 'worktree must remain registered')
      assert.equal(existsSync(rosterPath), true, 'shared swarm roster must remain intact')

      const [{ home: roHome }] = readFileSync(spawnHomesFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { home: string })
      assert.match(roHome, /\/readonly-turns\/ro-b5000000000000000000000000000001-[0-9a-f]+$/)
      assert.equal(existsSync(roHome), false, 'readonly-turns/ro-* temp dir must be thoroughly cleaned up')

      // 2) Contrast: normal non-readOnly turn on the same repo + killed roster still cleans up the killed worktree & branch
      const normalRun = normalAdapter.submitTurn({
        input: '普通回合完成后可正常清理已 killed 的历史蜂群 worktree',
        readOnly: false,
        traceId: 'b5000000000000000000000000000002',
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 1 },
        toolUseIdToName: new Map(),
      })
      await normalRun.submitted
      const normalSummary = await normalRun.summary
      await normalAdapter.waitForOutputDrain()
      assert.equal(normalSummary?.isError, false, JSON.stringify(normalSummary))

      assert.equal(existsSync(worktreePath), false, 'normal turn should clean up killed merged swarm worktree')
      assert.equal(git(['branch', '--list', branchName]), '', 'normal turn should delete merged killed swarm branch')
    } finally {
      await roAdapter.shutdown()
      await normalAdapter.shutdown()
      if (oldBin === undefined) delete process.env.OC_ANTIGRAVITY_CLI_BIN
      else process.env.OC_ANTIGRAVITY_CLI_BIN = oldBin
    }
  })
})

test('W6: readOnly projection fails closed and removes newly created readonly-turns dir when owner record write fails', async () => {
  await withIsolatedHome(async (dir) => {
    const root = antigravityRoot()
    const roRoot = join(root, 'readonly-turns')

    // Case 1: owner record writer throws (e.g. ENOSPC / EACCES)
    _antigravityPlatformInternals.setLaunchOwnerWriterForTests(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    assert.throws(
      () => projectAntigravityPlatform(makePlatformInput({ readOnly: true, claudeCodePath: dir })),
      new RegExp(ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE),
    )
    assert.deepEqual(existsSync(roRoot) ? readdirSync(roRoot) : [], [], 'no leaked dir after owner write throw')

    // Case 2: owner record writer silently fails to materialize the owner file
    _antigravityPlatformInternals.setLaunchOwnerWriterForTests(() => {
      // no-op: simulate missing owner file on disk
    })
    assert.throws(
      () => projectAntigravityPlatform(makePlatformInput({ readOnly: true, claudeCodePath: dir })),
      new RegExp(ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE),
    )
    assert.deepEqual(existsSync(roRoot) ? readdirSync(roRoot) : [], [], 'no leaked dir when owner record missing')
  })
})
