#!/usr/bin/env -S npx tsx
/**
 * Read-only offline reuse of the production shadow rankers against baseline
 * skill eval prompts. The parent skill directory is the gold skill.
 * No model/API/DB call is made.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type SkillMetadata, parseFrontmatter } from '@openclaude/storage'

import {
  SKILL_SHADOW_ROUTES,
  runSkillShadowRankers,
  scoreSkillShadowRecall,
} from '../packages/gateway/src/skillRetrievalShadow.js'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const skillsRoot = join(repoRoot, 'packages/commercial/agent-sandbox/ccb-baseline/skills')

interface EvalFile {
  cases?: Array<{ id?: string; prompt?: string }>
}

async function loadCatalog(): Promise<SkillMetadata[]> {
  const dirs = await readdir(skillsRoot, { withFileTypes: true })
  const catalog: SkillMetadata[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    try {
      const raw = await readFile(join(skillsRoot, dir.name, 'SKILL.md'), 'utf8')
      const { meta } = parseFrontmatter(raw)
      if (!meta.name || !meta.description) continue
      catalog.push({
        ...meta,
        name: meta.name,
        description: meta.description,
        path: join(skillsRoot, dir.name),
        source: 'platform',
        layer: 'platform',
        writable: false,
        agentIds: ['main'],
      })
    } catch {
      // A malformed/non-skill directory is outside the eval corpus.
    }
  }
  return catalog.sort((a, b) => a.name.localeCompare(b.name))
}

async function main(): Promise<void> {
  const catalog = await loadCatalog()
  const totals = Object.fromEntries(
    SKILL_SHADOW_ROUTES.map((route) => [route, { gold: 0, top3: 0, top5: 0 }]),
  ) as Record<(typeof SKILL_SHADOW_ROUTES)[number], { gold: number; top3: number; top5: number }>
  let skillsWithEvals = 0
  let cases = 0

  for (const skill of catalog) {
    let evalFile: EvalFile
    try {
      evalFile = JSON.parse(
        await readFile(join(skill.path, 'evals/evals.json'), 'utf8'),
      ) as EvalFile
    } catch {
      continue
    }
    const validCases = (evalFile.cases ?? []).filter(
      (item): item is { id?: string; prompt: string } =>
        typeof item.prompt === 'string' && item.prompt.trim().length > 0,
    )
    if (validCases.length === 0) continue
    skillsWithEvals += 1
    for (const item of validCases) {
      cases += 1
      const metric = scoreSkillShadowRecall(runSkillShadowRankers(catalog, item.prompt), [
        skill.name,
      ])
      for (const route of SKILL_SHADOW_ROUTES) {
        totals[route].gold += metric[route].actualCount
        totals[route].top3 += metric[route].hitsAt3
        totals[route].top5 += metric[route].hitsAt5
      }
    }
  }

  const routes = Object.fromEntries(
    SKILL_SHADOW_ROUTES.map((route) => {
      const recallAt3 = totals[route].gold === 0 ? 0 : totals[route].top3 / totals[route].gold
      const recallAt5 = totals[route].gold === 0 ? 0 : totals[route].top5 / totals[route].gold
      return [
        route,
        {
          hitsAt3: totals[route].top3,
          hitsAt5: totals[route].top5,
          recallAt3,
          recallAt5,
          meetsTop3RecallGate: recallAt3 >= 0.9,
        },
      ]
    }),
  )

  process.stdout.write(
    `${JSON.stringify(
      {
        dataset: { skillsWithEvals, cases, catalogSize: catalog.length },
        routes,
      },
      null,
      2,
    )}\n`,
  )
}

await main()
