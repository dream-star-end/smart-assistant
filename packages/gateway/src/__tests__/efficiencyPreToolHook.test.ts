/**
 * Run: npx tsx --test packages/gateway/src/__tests__/efficiencyPreToolHook.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-eff-hook-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
delete process.env.OPENCLAUDE_EFFICIENCY_GUARD

const {
  handlePreToolHookInput,
  extractShellCommand,
  parseHookProtocol,
  formatCcbHookResponse,
  formatCursorHookResponse,
} = await import('../efficiencyPreToolHook.js')
const {
  buildCcbEfficiencySettings,
  buildCursorEfficiencyHooks,
  resolveEfficiencyHookCommand,
} = await import('../efficiencyHookConfig.js')
const { evaluateShellForHook, EFFICIENCY_ESCAPE_TOKEN } = await import('../agentEfficiencyGuard.js')

describe('pre-exec hook protocol', () => {
  it('CCB deny returns permissionDecision deny plus a concrete alternative', async () => {
    const out = await handlePreToolHookInput(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sleep 600' } },
      'ccb',
      'deny',
    )
    const spec = out.hookSpecificOutput as Record<string, unknown>
    assert.equal(spec.hookEventName, 'PreToolUse')
    assert.equal(spec.permissionDecision, 'deny')
    assert.match(String(spec.permissionDecisionReason), /nohup/)
    assert.match(String(spec.permissionDecisionReason), /oc-job\.log/)
    assert.match(String(spec.permissionDecisionReason), /OC_EFFICIENCY_ALLOW/)
  })

  it('Cursor deny returns permission deny with agent_message alternative', async () => {
    const out = await handlePreToolHookInput(
      { command: 'gh pr checks --watch' },
      'cursor',
      'deny',
    )
    assert.equal(out.permission, 'deny')
    assert.match(String(out.agent_message), /替代: `gh pr checks`/)
    assert.match(String(out.agent_message), /不要 --watch/)
  })

  it('warn mode allows the command but still returns the alternative', async () => {
    const ccb = await handlePreToolHookInput(
      { tool_name: 'Bash', tool_input: { command: 'cat packages/gateway/src/foo.ts' } },
      'ccb',
      'warn',
    )
    const spec = ccb.hookSpecificOutput as Record<string, unknown>
    assert.equal(spec.permissionDecision, 'allow')
    assert.match(String(spec.additionalContext), /Read\/Grep\/Glob/)
  })

  it('off / empty / non-shell tools allow', async () => {
    const off = await handlePreToolHookInput(
      { tool_name: 'Bash', tool_input: { command: 'sleep 600' } },
      'ccb',
      'off',
    )
    assert.equal((off.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'allow')
    const read = await handlePreToolHookInput({ tool_name: 'Read', tool_input: {} }, 'ccb', 'deny')
    assert.equal((read.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'allow')
  })

  it('escape token allows a would-be-denied command and writes an audit line', async () => {
    const cmd = `sleep 600 # ${EFFICIENCY_ESCAPE_TOKEN}`
    const decided = evaluateShellForHook(cmd, 'deny')
    assert.equal(decided.decision, 'allow')
    assert.equal(decided.escaped, true)
    const out = await handlePreToolHookInput(
      { tool_name: 'Bash', tool_input: { command: cmd } },
      'ccb',
      'deny',
    )
    assert.equal((out.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'allow')
    const audit = readFileSync(join(TEST_HOME, '.efficiency-guard', 'audit.jsonl'), 'utf8')
    assert.match(audit, /efficiency_escape/)
    assert.match(audit, /sleep 600/)
  })

  it('extracts CCB tool_input.command and Cursor command', () => {
    assert.equal(
      extractShellCommand({ tool_input: { command: 'true' } }),
      'true',
    )
    assert.equal(extractShellCommand({ command: 'ls' }), 'ls')
    assert.equal(parseHookProtocol(['--protocol=cursor']), 'cursor')
    assert.equal(parseHookProtocol([]), 'ccb')
  })
})

describe('hook config injection (single policy source)', () => {
  it('off emits no settings / no hooks.json', () => {
    assert.equal(buildCcbEfficiencySettings('off'), null)
    assert.equal(buildCursorEfficiencyHooks('off'), null)
    assert.equal(resolveEfficiencyHookCommand('ccb', 'off'), null)
  })

  it('CCB settings.json points at the shared hook script, not a copied regex', () => {
    const settings = buildCcbEfficiencySettings('deny')
    const pre = (settings as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } })
      .hooks.PreToolUse[0]
    assert.equal(pre.matcher, 'Bash|Shell')
    assert.match(pre.hooks[0].command, /efficiencyPreToolHook\.ts/)
    assert.match(pre.hooks[0].command, /--protocol=ccb/)
    assert.match(pre.hooks[0].command, /--mode=deny/)
    assert.doesNotMatch(pre.hooks[0].command, /sleep_ge_60|while true/)
  })

  it('Cursor hooks.json uses beforeShellExecution against the same script', () => {
    const hooks = buildCursorEfficiencyHooks('deny') as {
      version: number
      hooks: { beforeShellExecution: Array<{ command: string }> }
    }
    assert.equal(hooks.version, 1)
    assert.match(hooks.hooks.beforeShellExecution[0].command, /efficiencyPreToolHook\.ts/)
    assert.match(hooks.hooks.beforeShellExecution[0].command, /--protocol=cursor/)
  })
})

describe('response helpers', () => {
  it('formatters stay protocol-shaped', () => {
    const deny = {
      decision: 'deny' as const,
      escaped: false,
      hits: [],
      message: 'nope',
    }
    assert.equal(
      (formatCcbHookResponse(deny).hookSpecificOutput as { permissionDecision: string }).permissionDecision,
      'deny',
    )
    assert.equal(formatCursorHookResponse(deny).permission, 'deny')
  })
})
