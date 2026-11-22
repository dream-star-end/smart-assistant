/**
 * Run: npx tsx --test packages/gateway/src/__tests__/actionPolicyEngine.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-action-policy-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
const SRC_DIR = dirname(fileURLToPath(new URL('../efficiencyHookConfig.ts', import.meta.url)))
const RUNNER = join(SRC_DIR, 'efficiencyHookRunner.cjs')

const {
  createActionPolicyEngine,
  evaluateActionPolicy,
  isVerifiedStrongReviewModel,
  isWeakModelId,
  loadActionPolicy,
} = await import('../actionPolicyEngine.js')
const { handlePreToolHookInput } = await import('../efficiencyPreToolHook.js')

describe('actionPolicyEngine — default policy, compound commands & strict YAML loading (B2)', () => {
  it('uses DEFAULT_ACTION_POLICY when action-policy.yaml does not exist', async () => {
    const missingPath = join(TEST_HOME, 'nonexistent-action-policy.yaml')
    const loaded = loadActionPolicy({ policyPath: missingPath })
    assert.equal(loaded.ok, true)
    assert.equal(loaded.source, 'default')

    assert.equal(
      (await evaluateActionPolicy({ toolName: 'Bash', command: 'rm -rf /' }, { loaded })).tier,
      'deny',
    )
    assert.equal(
      (await evaluateActionPolicy({ toolName: 'Bash', command: 'git push origin main --force' }, { loaded })).tier,
      'human_approval',
    )
    assert.equal(
      (await evaluateActionPolicy({ toolName: 'Bash', command: 'oc-connect feishu send --to bob --text hi' }, { loaded })).tier,
      'human_approval',
    )
    assert.equal(
      (await evaluateActionPolicy({ toolName: 'Bash', command: 'oc-site delete prod-docs' }, { loaded })).tier,
      'human_approval',
    )
    assert.equal(
      (await evaluateActionPolicy({ toolName: 'Bash', command: 'oc-browser login https://bank.example' }, { loaded })).tier,
      'human_approval',
    )
    assert.equal(
      (await evaluateActionPolicy({ toolName: 'Bash', command: 'git status' }, { loaded })).tier,
      'allow',
    )
  })

  it('evaluates compound commands per segment and takes the STRICTEST tier', async () => {
    const missingPath = join(TEST_HOME, 'missing-compound.yaml')
    const loaded = loadActionPolicy({ policyPath: missingPath })

    // site_publish (ai_review) + connector_write (human_approval) -> human_approval
    const pubAndWrite = await evaluateActionPolicy(
      {
        toolName: 'Bash',
        command: 'oc-site publish docs && oc-connect feishu send --msg hi',
      },
      { loaded },
    )
    assert.equal(pubAndWrite.tier, 'human_approval')
    assert.equal(pubAndWrite.category, 'connector_write')

    // site_publish (ai_review) + rm -rf / (deny) -> deny
    const pubAndWipe = await evaluateActionPolicy(
      {
        toolName: 'Bash',
        command: 'oc-site publish docs ; rm -rf /',
      },
      { loaded },
    )
    assert.equal(pubAndWipe.tier, 'deny')
  })

  it('loads custom target-restricted YAML rules and fails closed on empty/broken/unknown-key configs', async () => {
    const yamlPath = join(TEST_HOME, 'custom-target-policy.yaml')
    writeFileSync(
      yamlPath,
      [
        'version: 1',
        'extendsDefaults: true',
        'rules:',
        '  - id: block-feishu-writes',
        '    tier: deny',
        '    priority: 950',
        '    match:',
        '      category: connector_write',
        '      target: feishu',
        '    reason: Feishu writes blocked by user policy',
      ].join('\n'),
    )
    const engine = createActionPolicyEngine({ policyPath: yamlPath })
    // Target is automatically extracted from Bash command `oc-connect feishu send ...`
    const feishuRes = await engine.evaluate({
      toolName: 'Bash',
      command: 'oc-connect feishu send --msg hi',
    })
    assert.equal(feishuRes.tier, 'deny')
    assert.equal(feishuRes.matchedRuleId, 'block-feishu-writes')

    // Existing empty file MUST fail closed (not treated as missing file)
    const emptyPath = join(TEST_HOME, 'empty-policy.yaml')
    writeFileSync(emptyPath, '   \n')
    const emptyLoaded = loadActionPolicy({ policyPath: emptyPath })
    assert.equal(emptyLoaded.ok, false)
    assert.equal(emptyLoaded.source, 'invalid')
    const emptyEval = await evaluateActionPolicy(
      { toolName: 'Bash', command: 'echo ok' },
      { loaded: emptyLoaded },
    )
    assert.equal(emptyEval.tier, 'human_approval')
    assert.equal(emptyEval.configError, true)

    // Unknown restriction field inside match MUST fail closed
    const unknownKeyPath = join(TEST_HOME, 'unknown-match-key.yaml')
    writeFileSync(
      unknownKeyPath,
      [
        'version: 1',
        'rules:',
        '  - id: bad-rule',
        '    tier: allow',
        '    match:',
        '      tool: Bash',
        '      nonexistentRestriction: prod',
      ].join('\n'),
    )
    const unknownLoaded = loadActionPolicy({ policyPath: unknownKeyPath })
    assert.equal(unknownLoaded.ok, false)
    assert.equal(
      (await evaluateActionPolicy({ toolName: 'Bash', command: 'echo ok' }, { loaded: unknownLoaded })).tier,
      'human_approval',
    )
  })
})

describe('actionPolicyEngine — verified strong-model read-only ai_review & AbortController timeout (B3)', () => {
  it('allows only verified strong models and rejects both weak and unknown model identifiers', () => {
    assert.equal(isWeakModelId('claude-3-5-haiku'), true)
    assert.equal(isWeakModelId('gpt-4o-mini'), true)
    assert.equal(isVerifiedStrongReviewModel('claude-opus-4-6'), true)
    assert.equal(isVerifiedStrongReviewModel('gpt-5.4'), true)
    assert.equal(isVerifiedStrongReviewModel('claude-sonnet-4-6'), true)
    assert.equal(isVerifiedStrongReviewModel('mystery-unverified-model'), false)
    assert.equal(isVerifiedStrongReviewModel('mystery-unverified-model', ['mystery-unverified-model']), true)
    assert.equal(isVerifiedStrongReviewModel('gpt-4o-mini', ['gpt-4o-mini']), false)
  })

  it('requires verified strong model, readOnlyEnforced=true, matching modelUsed, and numeric confidence', async () => {
    const missing = join(TEST_HOME, 'missing-ai-review.yaml')

    // Valid strong-model read-only review -> allow
    const allowed = await evaluateActionPolicy(
      { toolName: 'Bash', command: 'oc-site publish my-docs', mainModel: 'claude-opus-4-6' },
      {
        policyPath: missing,
        aiReviewHook: async (ctx) => {
          assert.equal(ctx.readOnly, true)
          assert.equal(ctx.reviewerModel, 'claude-opus-4-6')
          assert.equal(ctx.signal.aborted, false)
          return {
            verdict: 'allow',
            confidence: 0.94,
            modelUsed: 'claude-opus-4-6',
            readOnlyEnforced: true,
            reason: 'Read-only check passed',
          }
        },
      },
    )
    assert.equal(allowed.tier, 'allow')

    // Missing confidence on allow -> escalates to human_approval
    const noConf = await evaluateActionPolicy(
      { toolName: 'Bash', command: 'oc-site publish my-docs', mainModel: 'claude-opus-4-6' },
      {
        policyPath: missing,
        aiReviewHook: async () => ({
          verdict: 'allow',
          modelUsed: 'claude-opus-4-6',
          readOnlyEnforced: true,
          reason: 'no confidence',
        }),
      },
    )
    assert.equal(noConf.tier, 'human_approval')

    // Missing readOnlyEnforced attestation -> escalates to human_approval
    const noRo = await evaluateActionPolicy(
      { toolName: 'Bash', command: 'oc-site publish my-docs', mainModel: 'claude-opus-4-6' },
      {
        policyPath: missing,
        aiReviewHook: async () => ({
          verdict: 'allow',
          confidence: 0.99,
          modelUsed: 'claude-opus-4-6',
          reason: 'forgot readOnlyEnforced',
        }),
      },
    )
    assert.equal(noRo.tier, 'human_approval')

    // Mismatched/unverified modelUsed -> escalates to human_approval
    const mismatch = await evaluateActionPolicy(
      { toolName: 'Bash', command: 'oc-site publish my-docs', mainModel: 'claude-opus-4-6' },
      {
        policyPath: missing,
        aiReviewHook: async () => ({
          verdict: 'allow',
          confidence: 0.99,
          modelUsed: 'unknown-alias',
          readOnlyEnforced: true,
          reason: 'swapped model',
        }),
      },
    )
    assert.equal(mismatch.tier, 'human_approval')

    // Real timeout cancels AbortSignal and escalates to human_approval
    const timeoutPolicyPath = join(TEST_HOME, 'short-timeout.yaml')
    writeFileSync(
      timeoutPolicyPath,
      ['version: 1', 'aiReview:', '  model: claude-opus-4-6', '  timeoutMs: 500', 'rules: []'].join('\n'),
    )
    let signalAborted = false
    const timedOut = await evaluateActionPolicy(
      { toolName: 'Bash', command: 'oc-site publish my-docs' },
      {
        policyPath: timeoutPolicyPath,
        aiReviewHook: async (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              signalAborted = true
            })
            const t = setTimeout(
              () =>
                resolve({
                  verdict: 'allow',
                  confidence: 0.99,
                  modelUsed: 'claude-opus-4-6',
                  readOnlyEnforced: true,
                  reason: 'too late',
                }),
              5000,
            )
            t.unref?.()
          }),
      },
    )
    assert.equal(timedOut.tier, 'human_approval')
    assert.equal(timedOut.aiReview?.escalatedFromError, true)
    assert.equal(signalAborted, true)
  })
})

describe('B1 — Cursor fail-closed & stricter merge + real efficiencyHookRunner.cjs process tests', () => {
  it('merges efficiency deny over action-policy ask (never downgrades deny to ask)', async () => {
    const missing = join(TEST_HOME, 'missing-merge.yaml')
    const mergedCcb = await handlePreToolHookInput(
      {
        tool_name: 'Bash',
        tool_input: { command: 'sleep 600 && git push origin main --force' },
      },
      'ccb',
      'deny',
      { policyPath: missing },
    )
    assert.equal(
      (mergedCcb.hookSpecificOutput as { permissionDecision: string }).permissionDecision,
      'deny',
    )

    // Cursor human_approval returns `deny` (never `ask`)
    const cursorApproval = await handlePreToolHookInput(
      { command: 'git push origin main --force' },
      'cursor',
      'warn',
      { policyPath: missing },
    )
    assert.equal(cursorApproval.permission, 'deny')
    assert.equal(cursorApproval.requiresHumanApproval, true)
  })

  it('real efficiencyHookRunner.cjs normalizes Cursor ask -> deny fail-closed (never fail-open allow)', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-runner-b1-'))
    // 1. Direct inner script returning `{ permission: "ask" }` for Cursor -> runner upgrades to deny
    const askScript = join(home, 'cursor-ask.cjs')
    writeFileSync(
      askScript,
      'process.stdout.write(JSON.stringify({ permission: "ask", user_message: "need human" }) + "\\n")\n',
    )
    const askRun = spawnSync(
      process.execPath,
      [RUNNER, '--protocol=cursor', '--mode=warn', `--script=${askScript}`],
      {
        encoding: 'utf8',
        input: '{"command":"git push --force"}\n',
        timeout: 8000,
        env: { ...process.env, OPENCLAUDE_HOME: home },
      },
    )
    assert.equal(askRun.status, 0)
    const parsedAsk = JSON.parse(askRun.stdout.trim())
    assert.equal(parsedAsk.permission, 'deny')
    assert.equal(parsedAsk.requiresHumanApproval, true)
    const auditFile = join(home, '.efficiency-guard', 'audit.jsonl')
    assert.equal(existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '', '')

    // 2. Real efficiencyPreToolHook through runner on Cursor with `git push origin main --force`
    const distRunner = join(SRC_DIR, '../dist/efficiencyHookRunner.cjs')
    const realRunner = existsSync(distRunner) ? distRunner : RUNNER
    const realCursor = spawnSync(
      process.execPath,
      [realRunner, '--protocol=cursor', '--mode=deny'],
      {
        encoding: 'utf8',
        input: '{"command":"git push origin main --force"}\n',
        timeout: 8000,
        env: {
          ...process.env,
          OPENCLAUDE_HOME: home,
          OPENCLAUDE_EFFICIENCY_HOOK_TIMEOUT_MS: '5000',
        },
      },
    )
    assert.equal(realCursor.status, 0, realCursor.stderr)
    const parsedRealCursor = JSON.parse(realCursor.stdout.trim())
    assert.equal(parsedRealCursor.permission, 'deny', `stderr=${realCursor.stderr}`)
    assert.equal(parsedRealCursor.requiresHumanApproval, true)

    // 3. Real efficiencyPreToolHook through runner on CCB with `sleep 600 && git push --force` under deny mode
    const realCcb = spawnSync(
      process.execPath,
      [realRunner, '--protocol=ccb', '--mode=deny'],
      {
        encoding: 'utf8',
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600 && git push origin main --force' },
        }),
        timeout: 8000,
        env: {
          ...process.env,
          OPENCLAUDE_HOME: home,
          OPENCLAUDE_EFFICIENCY_HOOK_TIMEOUT_MS: '5000',
        },
      },
    )
    assert.equal(realCcb.status, 0, realCcb.stderr)
    const parsedRealCcb = JSON.parse(realCcb.stdout.trim())
    assert.equal(parsedRealCcb.hookSpecificOutput.permissionDecision, 'deny', `stderr=${realCcb.stderr}`)
  })
})
