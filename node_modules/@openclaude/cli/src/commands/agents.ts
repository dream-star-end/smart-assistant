import { mkdir, writeFile } from 'node:fs/promises'
import { paths, readAgentsConfig, writeAgentsConfig } from '@openclaude/storage'

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

export async function agentsAdd(id: string, opts: { model?: string }): Promise<void> {
  const cfg = await readAgentsConfig()
  if (cfg.agents.find((a) => a.id === id)) {
    console.error(`agent ${id} already exists`)
    process.exit(1)
  }
  cfg.agents.push({ id, model: opts.model, persona: paths.agentClaudeMd(id) })
  await writeAgentsConfig(cfg)
  await mkdir(paths.agentSessionsDir(id), { recursive: true })
  await writeFile(
    paths.agentClaudeMd(id),
    `# Agent: ${id}\n\nYou are a helpful assistant.\n`,
    { flag: 'wx' },
  ).catch(() => {})
  console.log(`✓ added agent ${id}`)
}
