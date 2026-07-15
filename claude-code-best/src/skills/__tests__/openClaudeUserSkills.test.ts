import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearSkillCaches, getSkillDirCommands } from '../loadSkillsDir'

const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  OPENCLAUDE_USER_SKILLS_DIR: process.env.OPENCLAUDE_USER_SKILLS_DIR,
}
const roots: string[] = []

afterEach(async () => {
  clearSkillCaches()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(): Promise<{
  root: string
  cwd: string
  skills: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'ccb-openclaude-skills-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  const skills = join(root, 'openclaude-skills')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(skills, 'macro-investment-framework'), { recursive: true })
  await mkdir(join(root, 'claude-config'), { recursive: true })
  await writeFile(
    join(skills, 'macro-investment-framework', 'SKILL.md'),
    [
      '---',
      'name: macro-investment-framework',
      'description: User-created investment analysis workflow',
      '---',
      '',
      '# Macro investment framework',
      '',
      'Use the shared OpenClaude skill.',
    ].join('\n'),
  )
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config')
  return { root, cwd, skills }
}

describe('OPENCLAUDE_USER_SKILLS_DIR', () => {
  test('loads the explicit absolute OpenClaude shared skill directory', async () => {
    const { cwd, skills } = await fixture()
    process.env.OPENCLAUDE_USER_SKILLS_DIR = skills
    clearSkillCaches()

    const commands = await getSkillDirCommands(cwd)

    expect(
      commands.some(command => command.name === 'macro-investment-framework'),
    ).toBe(true)
  })

  test('ignores a relative overlay path', async () => {
    const { cwd } = await fixture()
    process.env.OPENCLAUDE_USER_SKILLS_DIR = 'openclaude-skills'
    clearSkillCaches()

    const commands = await getSkillDirCommands(cwd)

    expect(
      commands.some(command => command.name === 'macro-investment-framework'),
    ).toBe(false)
  })
})
