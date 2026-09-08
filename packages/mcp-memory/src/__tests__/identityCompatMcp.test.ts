import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const profile = { profileId: 'uid3-butler-unification', legacyAgentId: 'butler', canonicalAgentId: 'personal-butler', localPersonaPath: 'agents/butler/CLAUDE.md', localSkillStorageId: 'butler' }

for (const project of [false, true]) {
  test(`OCV5-179 real MCP list/search/view/save share the registered private store (project=${project})`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-id-mcp-'))
    const skillDir = join(home, 'agents/butler/skills/existing-evidence')
    await mkdir(skillDir, {recursive: true})
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: existing-evidence\ndescription: unique registered evidence\n---\nOriginal private evidence.\n')
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string] => typeof e[1] === 'string'))
    Object.assign(env, { HOME: home, OPENCLAUDE_HOME: home, OPENCLAUDE_AGENT_ID: 'personal-butler', OC_USER_ID: '3', OC_IDENTITY_COMPAT_PROFILE: JSON.stringify(profile), OPENCLAUDE_GATEWAY_PORT: '9' })
    for (const key of ['OPENCLAUDE_PROJECT_ID','OPENCLAUDE_BASELINE_SKILLS_DIR','OPENCLAUDE_SKILL_EVAL_MODE','OPENCLAUDE_SKILL_EVAL_EXCLUDE','OPENCLAUDE_SKILL_EVAL_DRAFT_NAME','OC_V3_MASTER_URL','OC_INTERNAL_TOKEN']) delete env[key]
    if (project) env.OPENCLAUDE_PROJECT_ID = '55555555-5555-4555-8555-555555555555'
    const transport = new StdioClientTransport({command: join(root,'node_modules/.bin/tsx'), args:['packages/mcp-memory/src/index.ts'], cwd:root, env, stderr:'pipe'})
    const client = new Client({name:'identity-compat-test',version:'1.0.0'},{capabilities:{}})
    try {
      await client.connect(transport)
      for (const [name, args] of [['skill_list',{}],['skill_search',{query:'registered evidence'}],['skill_view',{name:'existing-evidence'}]] as const) {
        const result = await client.callTool({name,arguments:args})
        assert.notEqual(result.isError, true, JSON.stringify(result))
        assert.match(JSON.stringify(result), name === 'skill_view' ? /Original private evidence/ : /existing-evidence/)
      }
      const saved = await client.callTool({name:'skill_save',arguments:{name:'new-evidence',description:'saved through canonical MCP',body:'Unique saved body.'}})
      assert.notEqual(saved.isError, true, JSON.stringify(saved))
      assert.match(await readFile(join(home,'agents/butler/skills/new-evidence/SKILL.md'),'utf8'), /Unique saved body/)
      await assert.rejects(access(join(home,'agents/personal-butler/skills/new-evidence/SKILL.md')))
      const viewed = await client.callTool({name:'skill_view',arguments:{name:'new-evidence'}})
      assert.match(JSON.stringify(viewed), /Unique saved body/)
    } finally { await client.close(); await rm(home,{recursive:true,force:true}) }
  })
}


test('OCV5-179 MCP rejects malformed or mismatched derived context instead of falling back to another store', async () => {
  const { buildMcpSkillStore } = await import('../skillStoreContext.js')
  const base = {OPENCLAUDE_AGENT_ID:'personal-butler', OC_USER_ID:'3'}
  for (const raw of ['{bad', '{}', JSON.stringify({...profile,localSkillStorageId:'../main'}), JSON.stringify({...profile,localPersonaPath:'agents/../main/CLAUDE.md'})]) {
    assert.throws(()=>buildMcpSkillStore({...base,OC_IDENTITY_COMPAT_PROFILE:raw}), /identity compatibility|identity profile/)
  }
  assert.throws(()=>buildMcpSkillStore({...base,OPENCLAUDE_AGENT_ID:'main',OC_IDENTITY_COMPAT_PROFILE:JSON.stringify(profile)}), /does not match/)
  assert.throws(()=>buildMcpSkillStore({...base,OC_USER_ID:'',OC_IDENTITY_COMPAT_PROFILE:JSON.stringify(profile)}), /identity compatibility/)
})
