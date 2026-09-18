import { mkdir, writeFile } from 'node:fs/promises'
import {
  AGENT_ID_RE,
  paths,
  readAgentsConfig,
  updateAgentsConfig,
  validateAgentPatch,
} from '@openclaude/storage'

export async function agentsList(): Promise<void> {
  const cfg = await readAgentsConfig()
  console.log(`Default: ${cfg.default}\n`)
  for (const a of cfg.agents) {
    console.log(`  ${a.id}${a.id === cfg.default ? ' *' : ''}`)
    if (a.model) console.log(`    model: ${a.model}`)
    if (a.persona) console.log(`    persona: ${a.persona}`)
  }
  console.log('\nRoutes:')
  for (const r of cfg.routes) {
    console.log(`  ${JSON.stringify(r.match)} → ${r.agent}`)
  }
}

/** CLI 与 POST /api/agents 共用同一套 id / 字段校验(CFG-14):`../x` 之类的 id 在这里就拒。 */
export function validateAgentsAddInput(
  id: string,
  opts: { model?: string },
): { ok: true } | { ok: false; error: string } {
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
    return { ok: false, error: `invalid agent id "${id}" (use only a-z 0-9 _ -)` }
  }
  const patch = validateAgentPatch({
    id,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  })
  return patch.ok ? { ok: true } : { ok: false, error: patch.error }
}

export async function agentsAdd(id: string, opts: { model?: string }): Promise<void> {
  const check = validateAgentsAddInput(id, opts)
  if (!check.ok) {
    console.error(`✗ ${check.error}`)
    process.exit(1)
  }
  const { result: added } = await updateAgentsConfig((cfg) => {
    if (cfg.agents.some((a) => a.id === id)) return false
    cfg.agents.push({ id, model: opts.model, persona: paths.agentClaudeMd(id) })
    return true
  })
  if (!added) {
    console.error(`agent ${id} already exists`)
    process.exit(1)
  }
  await mkdir(paths.agentSessionsDir(id), { recursive: true })
  await writeFile(paths.agentClaudeMd(id), `# Agent: ${id}\n\nYou are a helpful assistant.\n`, {
    flag: 'wx',
  }).catch(() => {})
  console.log(`✓ added agent ${id}`)
}
