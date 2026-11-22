/**
 * Connector RPC Action Policy Guard — evaluates `~/.openclaude/action-policy.yaml`
 * (or injected policy evaluator) before any connector/plugin write side-effect.
 *
 * Security invariants (B2 / B3):
 *   - Uses the exact `@openclaude/protocol` validator & matcher (`evaluateActionPolicyDocumentSync`).
 *   - Reads directly with `readFileSync`: ONLY `ENOENT` uses safe defaults; `EACCES`/`EISDIR`/empty/
 *     invalid YAML/invalid schema all fail closed (`configError: true`).
 *   - When an active policy file or injected evaluator requires `human_approval` / `ai_review` / `deny`,
 *     `blockPreapproval` is `true` regardless of rule id naming (forces ledger `status = 'pending'`
 *     BEFORE `proposeWrite`, never letting `account_preapproval` persist `approved`).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  DEFAULT_ACTION_POLICY,
  evaluateActionPolicyDocumentSync,
  mergeActionPolicyWithDefaults,
  validateActionPolicyDocument,
  type ActionPolicyEvaluation,
  type ActionPolicyRequest,
} from '@openclaude/protocol'
import { paths } from '@openclaude/storage'

export type ConnectorActionPolicyEvaluator = (
  req: ActionPolicyRequest,
) => Promise<ActionPolicyEvaluation> | ActionPolicyEvaluation

export function loadConnectorActionPolicy(policyPath?: string): {
  ok: boolean
  source: 'default' | 'file' | 'invalid'
  policy: typeof DEFAULT_ACTION_POLICY
  error?: string
} {
  const resolvedPath =
    policyPath?.trim() ||
    process.env.OPENCLAUDE_ACTION_POLICY_PATH?.trim() ||
    join(process.env.OPENCLAUDE_HOME?.trim() || paths.home, 'action-policy.yaml')

  let rawText: string
  try {
    rawText = readFileSync(resolvedPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: true, source: 'default', policy: DEFAULT_ACTION_POLICY }
    }
    return {
      ok: false,
      source: 'invalid',
      policy: DEFAULT_ACTION_POLICY,
      error: `unreadable action-policy (${(err as Error).message})`,
    }
  }

  if (!rawText.trim()) {
    return {
      ok: false,
      source: 'invalid',
      policy: DEFAULT_ACTION_POLICY,
      error: 'action-policy.yaml exists but is empty (fail-closed)',
    }
  }

  let parsed: unknown
  try {
    parsed = parseYaml(rawText)
  } catch (err) {
    return {
      ok: false,
      source: 'invalid',
      policy: DEFAULT_ACTION_POLICY,
      error: `invalid YAML in action-policy (${(err as Error).message})`,
    }
  }

  const validated = validateActionPolicyDocument(parsed)
  if (!validated.ok) {
    return {
      ok: false,
      source: 'invalid',
      policy: DEFAULT_ACTION_POLICY,
      error: `invalid action-policy schema: ${validated.errors.join('; ')}`,
    }
  }

  return { ok: true, source: 'file', policy: mergeActionPolicyWithDefaults(validated.policy) }
}

export function evaluateConnectorActionPolicyFromFile(
  req: ActionPolicyRequest,
  policyPath?: string,
): { evaluation: ActionPolicyEvaluation; source: 'default' | 'file' | 'invalid' } {
  const loaded = loadConnectorActionPolicy(policyPath)
  const { evaluation } = evaluateActionPolicyDocumentSync(req, loaded.policy)
  if (!loaded.ok) {
    const fallback = loaded.policy.onConfigError ?? 'human_approval'
    const tier = evaluation.tier === 'deny' ? 'deny' : fallback
    return {
      source: 'invalid',
      evaluation: {
        ...evaluation,
        tier,
        initialTier: tier,
        reason: `Action policy config invalid (${loaded.error}); failing closed to ${tier}.`,
        configError: true,
      },
    }
  }
  return { source: loaded.source, evaluation }
}

export async function evaluateConnectorWritePolicy(args: {
  provider: string
  action: string
  connectionId: string
  userId: number
  params?: Record<string, unknown>
  evaluator?: ConnectorActionPolicyEvaluator
  policyPath?: string
}): Promise<{
  evaluation: ActionPolicyEvaluation
  source: 'default' | 'file' | 'invalid' | 'custom_evaluator'
  denied: boolean
  blockPreapproval: boolean
}> {
  const req: ActionPolicyRequest = {
    toolName: 'oc-connect',
    category: 'connector_write',
    target: args.provider,
    command: `oc-connect ${args.provider} write ${args.action}`,
    args: {
      connectionId: args.connectionId,
      userId: args.userId,
      action: args.action,
      ...(args.params ?? {}),
    },
  }

  let evaluation: ActionPolicyEvaluation
  let source: 'default' | 'file' | 'invalid' | 'custom_evaluator'
  if (args.evaluator) {
    evaluation = await args.evaluator(req)
    source = 'custom_evaluator'
  } else {
    const res = evaluateConnectorActionPolicyFromFile(req, args.policyPath)
    evaluation = res.evaluation
    source = res.source
  }

  const denied = evaluation.tier === 'deny'
  // Block account_preapproval whenever policy is denied, config is broken, OR an explicit
  // policy file / custom evaluator does not allow unattended execution (regardless of rule id).
  const blockPreapproval =
    denied ||
    evaluation.configError === true ||
    ((source === 'file' || source === 'custom_evaluator') && evaluation.tier !== 'allow')

  return { evaluation, source, denied, blockPreapproval }
}
