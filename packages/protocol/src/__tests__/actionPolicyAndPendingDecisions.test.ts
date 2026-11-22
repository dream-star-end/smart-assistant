import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_ACTION_POLICY,
  classifyActionCategories,
  classifyActionCategory,
  encodePendingDecisionId,
  evaluateActionPolicyDocumentSync,
  extractCommandTarget,
  parsePendingDecisionId,
  splitShellCommandSegments,
  validateActionPolicyDocument,
} from '../index.js'

describe('actionPolicy protocol schema (B2 compound commands & strict validation)', () => {
  it('validates DEFAULT_ACTION_POLICY cleanly and covers all Stage-4 categories', () => {
    const res = validateActionPolicyDocument(DEFAULT_ACTION_POLICY)
    assert.equal(res.ok, true)
    if (res.ok) {
      const ids = new Set(res.policy.rules.map((r) => r.id))
      assert.ok(ids.has('default-destructive-shell-catastrophic'))
      assert.ok(ids.has('default-destructive-shell-approval'))
      assert.ok(ids.has('default-connector-plugin-write'))
      assert.ok(ids.has('default-site-delete'))
      assert.ok(ids.has('default-site-publish'))
      assert.ok(ids.has('default-browser-login-handoff'))
      assert.ok(ids.has('default-browser-form-submit'))
    }
  })

  it('splits compound commands & subshells, extracts targets, and evaluates strictest tier', () => {
    const segs = splitShellCommandSegments(
      'echo "a && b" && oc-site publish docs; oc-connect feishu send --msg "$(rm -rf /)"',
    )
    assert.ok(segs.length >= 4)
    assert.ok(segs.some((s) => s.includes('rm -rf /')))

    assert.equal(extractCommandTarget('oc-connect feishu send --msg hi'), 'feishu')
    // Real oc-site CLI: positional arg to `publish` is local path, slug comes ONLY from `--slug`!
    assert.equal(extractCommandTarget('oc-site publish ./dist'), undefined)
    assert.equal(extractCommandTarget('oc-site publish ./dist --slug prod-docs'), 'prod-docs')
    assert.equal(extractCommandTarget('oc-site publish ./dist --slug=prod-docs'), 'prod-docs')
    assert.equal(extractCommandTarget('oc-site delete prod-docs'), 'prod-docs')
    assert.equal(
      extractCommandTarget('oc-browser login https://bank.example/signin'),
      'https://bank.example/signin',
    )

    // Compound command combining ai_review (site_publish) + human_approval (connector_write) -> human_approval!
    const compoundCats = classifyActionCategories({
      toolName: 'Bash',
      command: 'oc-site publish my-blog && oc-connect feishu send --msg hello',
    })
    assert.deepEqual(compoundCats, ['connector_write', 'site_publish'])
    assert.equal(
      classifyActionCategory({
        toolName: 'Bash',
        command: 'oc-site publish my-blog && oc-connect feishu send --msg hello',
      }),
      'connector_write',
    )

    const evalCompound = evaluateActionPolicyDocumentSync(
      {
        toolName: 'Bash',
        command: 'oc-site publish my-blog && oc-connect feishu send --msg hello',
      },
      DEFAULT_ACTION_POLICY,
    )
    assert.equal(evalCompound.evaluation.tier, 'human_approval')

    // Compound command hiding catastrophic rm -rf / inside subshell -> deny!
    const evalSubshellDeny = evaluateActionPolicyDocumentSync(
      {
        toolName: 'Bash',
        command: 'oc-site publish my-blog && echo $(rm -rf /)',
      },
      DEFAULT_ACTION_POLICY,
    )
    assert.equal(evalSubshellDeny.evaluation.tier, 'deny')

    // Equivalent flag form `rm -r -f ./build` -> destructive_shell
    assert.equal(
      classifyActionCategory({ toolName: 'Bash', command: 'rm -r -f ./build' }),
      'destructive_shell',
    )
  })

  it('strictly rejects unknown keys, missing/null rules, bad tiers, and bad regexes', () => {
    assert.equal(
      validateActionPolicyDocument({
        version: 1,
        unknownTopKey: true,
        rules: [],
      }).ok,
      false,
    )
    assert.equal(validateActionPolicyDocument({ version: 1 }).ok, false)
    assert.equal(validateActionPolicyDocument({ version: 1, rules: null }).ok, false)
    assert.equal(
      validateActionPolicyDocument({
        version: 1,
        rules: [
          {
            id: 'r-unknown-match',
            tier: 'allow',
            match: { tool: 'Bash', unknownRestriction: 'foo' },
          },
        ],
      }).ok,
      false,
    )
    assert.equal(
      validateActionPolicyDocument({
        version: 1,
        rules: [{ id: 'r1', tier: 'yolo', match: { tool: 'Bash' } }],
      }).ok,
      false,
    )
    assert.equal(
      validateActionPolicyDocument({
        version: 1,
        rules: [{ id: 'r2', tier: 'deny', match: { commandPattern: '[unclosed(' } }],
      }).ok,
      false,
    )
  })
})

describe('pendingDecisions protocol id helpers', () => {
  it('round-trips composite ids including sourceIds containing colons', () => {
    const encoded = encodePendingDecisionId('turn_permission', 'ask-user:abc-123')
    assert.equal(encoded, 'turn_permission:ask-user:abc-123')
    assert.deepEqual(parsePendingDecisionId(encoded), {
      source: 'turn_permission',
      sourceId: 'ask-user:abc-123',
    })
  })

  it('rejects unknown sources and control chars', () => {
    assert.equal(parsePendingDecisionId('unknown:123'), null)
    assert.equal(parsePendingDecisionId('taskboard:'), null)
    assert.equal(parsePendingDecisionId('no-colon'), null)
    assert.throws(() => encodePendingDecisionId('taskboard', 'bad\nid'))
  })
})
