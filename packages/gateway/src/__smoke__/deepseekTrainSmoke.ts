/**
 * GATING SMOKE — does DeepSeek's Anthropic-compatible endpoint actually drive the
 * agentic skill-training loop? Production train default is now deepseek-v4-flash
 * (OpenCode Go), but this probe still hits api.deepseek.com with deepseek-v4-pro
 * to verify the upstream can run the real prompt + tool schemas. Not catalog-gated.
 *
 * Original P0 risk: the feature locks training to DeepSeek, so we must confirm it can, over multiple
 * turns, call the discovery tools (skill_list → session_search → skill_view) and then
 * emit a well-formed `skill_propose` — using the REAL training prompt + REAL tool
 * schemas, against the REAL DeepSeek Anthropic-compatible endpoint (mirrors prod:
 * Bearer auth, anthropic-version 2023-06-01, model sent verbatim, no proxy).
 *
 * This hits the network + spends a little quota → NOT part of the unit test glob.
 * Run (key injected at runtime, never hardcoded):
 *   DEEPSEEK_API_KEY=$(grep '^DEEPSEEK_API_KEY=' /etc/openclaude/secrets.env | cut -d= -f2-) \
 *     npx tsx packages/mcp-memory/src/__smoke__/deepseekTrainSmoke.ts
 */
import { buildSkillTrainPrompt, normalizeSkillTrainArgs } from '../skillTrain.js'

const ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages'
const MODEL = 'deepseek-v4-pro'
const ANTHROPIC_VERSION = '2023-06-01'

const KEY = (process.env.DEEPSEEK_API_KEY ?? '').trim()
if (!KEY) {
  console.error('DEEPSEEK_API_KEY not set — refusing to run.')
  process.exit(2)
}

// Anthropic tool schemas mirroring the real training tools (the ones the prompt names).
const TOOLS = [
  {
    name: 'skill_list',
    description: 'List the agent\'s skills (name, description, version, source, writable).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'session_search',
    description: 'Search recent work sessions for reusable patterns.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'skill_view',
    description: 'Load the full SKILL.md of a named skill.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'skill_propose',
    description:
      'Stage a candidate skill change for the current training run (draft only). op: create|update|delete.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        op: { type: 'string', enum: ['create', 'update', 'delete'] },
        description: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' },
      },
      required: ['name', 'op', 'rationale'],
    },
  },
]

// Canned tool results — a tiny library + sessions that clearly motivate ONE update:
// deploy-flow is missing the cache-bust step that two sessions show is required.
function cannedToolResult(name: string, input: any): string {
  if (name === 'skill_list') {
    return [
      '- deploy-flow (source=user, writable) v1.0.3 — How to deploy the web service',
      '- code-review-loop (source=user, writable) v1.0.1 — Codex double-review workflow',
      '- skill-management (source=platform, read-only) — platform baseline, RESERVED',
    ].join('\n')
  }
  if (name === 'session_search') {
    return [
      '[session 2026-06-17 "deploy hotfix"] 4 tool calls. Deploy failed: stale assets served',
      'because the asset version was not bumped before restart. Fixed by adding a cache-bust',
      'step (bump ?v= hash) BEFORE systemctl restart, then it worked.',
      '',
      '[session 2026-06-16 "ship v2"] Same failure mode: forgot cache-bust, users saw old JS;',
      'redoing with the version bump first resolved it. Repeated invariant: cache-bust precedes restart.',
    ].join('\n')
  }
  if (name === 'skill_view') {
    if (String(input?.name) === 'deploy-flow') {
      return [
        '[source: user]',
        '',
        '---',
        'name: deploy-flow',
        'description: How to deploy the web service',
        'version: 1.0.3',
        '---',
        '# Deploy flow',
        '1. Build the bundle.',
        '2. systemctl restart the service.',
        '(NOTE: no cache-bust step documented.)',
      ].join('\n')
    }
    return `[source: user]\nskill "${input?.name}" body…`
  }
  if (name === 'skill_propose') {
    return `Staged ${input?.op} draft for "${input?.name}". Awaiting user review.`
  }
  return 'ok'
}

async function callDeepSeek(messages: any[]): Promise<any> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system:
        'You are an automated skill-training agent. Use the provided tools. Follow the run instructions exactly.',
      messages,
      tools: TOOLS,
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  return JSON.parse(text)
}

async function main() {
  const opts = normalizeSkillTrainArgs(
    { runId: 'smoke-run-1', targetSkill: 'deploy-flow', maxProposals: 2 },
    'main',
  )
  const prompt = buildSkillTrainPrompt(opts)

  const messages: any[] = [{ role: 'user', content: prompt }]
  const toolsSeen = new Set<string>()
  let proposeCall: any = null
  let proposedAgainstPlatform = false
  let stopReason = ''

  const MAX_TURNS = 14
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await callDeepSeek(messages)
    stopReason = resp.stop_reason ?? ''
    const content = Array.isArray(resp.content) ? resp.content : []
    // Echo assistant turn back into history (preserve thinking + tool_use ordering).
    messages.push({ role: 'assistant', content })

    const toolUses = content.filter((b: any) => b?.type === 'tool_use')
    if (toolUses.length === 0) {
      // No tool calls this turn → model is done (or just talking).
      const textBlocks = content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join(' ')
      console.log(`  turn ${turn}: no tool_use (stop=${stopReason}). text: ${textBlocks.slice(0, 160)}`)
      break
    }

    const toolResults: any[] = []
    for (const tu of toolUses) {
      toolsSeen.add(tu.name)
      console.log(`  turn ${turn}: tool_use → ${tu.name}(${JSON.stringify(tu.input).slice(0, 120)})`)
      if (tu.name === 'skill_propose') {
        proposeCall = tu.input
        if (String(tu.input?.name) === 'skill-management') proposedAgainstPlatform = true
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: cannedToolResult(tu.name, tu.input),
      })
    }
    messages.push({ role: 'user', content: toolResults })

    // Once it has proposed at least one change, one more turn lets it wrap up.
    if (proposeCall) {
      const final = await callDeepSeek(messages)
      console.log(`  final stop_reason=${final.stop_reason}`)
      break
    }
  }

  // ── Verdict ───────────────────────────────────────────────
  const calledDiscovery =
    toolsSeen.has('skill_list') && toolsSeen.has('session_search') && toolsSeen.has('skill_view')
  const proposeValid =
    !!proposeCall &&
    typeof proposeCall.name === 'string' &&
    ['create', 'update', 'delete'].includes(proposeCall.op) &&
    typeof proposeCall.rationale === 'string' &&
    proposeCall.rationale.trim().length > 0 &&
    (proposeCall.op === 'delete' ||
      (typeof proposeCall.description === 'string' &&
        typeof proposeCall.body === 'string' &&
        proposeCall.body.trim().length > 0))

  console.log('\n──────── VERDICT ────────')
  console.log(`tools exercised:        ${[...toolsSeen].join(', ') || '(none)'}`)
  console.log(`called all discovery:   ${calledDiscovery}`)
  console.log(`skill_propose emitted:  ${!!proposeCall}`)
  console.log(`skill_propose valid:    ${proposeValid}`)
  console.log(`avoided platform skill: ${!proposedAgainstPlatform}`)
  if (proposeCall) {
    console.log(
      `proposal: op=${proposeCall.op} name=${proposeCall.name} bodyLen=${(proposeCall.body ?? '').length} rationaleLen=${(proposeCall.rationale ?? '').length}`,
    )
  }
  const pass = calledDiscovery && proposeValid && !proposedAgainstPlatform
  console.log(`\nRESULT: ${pass ? 'PASS ✅ — DeepSeek can drive the agentic training loop' : 'FAIL ❌'}`)
  process.exit(pass ? 0 : 1)
}

main().catch((err) => {
  console.error('SMOKE ERROR:', err?.message ?? err)
  process.exit(3)
})
