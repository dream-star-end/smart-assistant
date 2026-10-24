/** Synthetic explicit roots only; no product HOME, shared DB reset or real account content. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { createAuthorityPaths, type AuthorityPaths } from '../authorityPaths.js'
import { PROJECT_MEMORY_LEDGER_DDL } from '../projectMemoryLedger.js'
import { PROJECT_SKILL_LEDGER_DDL, ProjectSkillLedger, hashSkillTree } from '../projectSkillLedger.js'
import { openProjectFormalReadonly, PROJECT_FORMAL_DB_APPLICATION_ID, PROJECT_FORMAL_DB_VERSION } from '../projectFormalLedger.js'
import { loadProjectContextReadonly } from '../projectContext.js'
import { loadFrozenProjectContext } from '../projectContextFrozen.js'
const projectId = 'd6100000-0000-4000-8000-000000000765'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
async function authority() { return createAuthorityPaths(await mkdtemp(join(tmpdir(), 'oc-formal-project-'))) }
function createDb(a: AuthorityPaths) {
  const db = new Database(a.projectLedgerDb)
  db.pragma('journal_mode = DELETE')
  db.exec(PROJECT_MEMORY_LEDGER_DDL + PROJECT_SKILL_LEDGER_DDL)
  db.pragma(`application_id = ${PROJECT_FORMAL_DB_APPLICATION_ID}`)
  db.pragma(`user_version = ${PROJECT_FORMAL_DB_VERSION}`)
  return db
}
async function snapshot(root: string): Promise<unknown[]> {
  const out: unknown[] = []
  async function walk(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name)
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) { out.push([file, 'symlink']); continue }
      if (stat.isDirectory()) { out.push([file, 'directory']); await walk(file) }
      else out.push([file, hash((await readFile(file)).toString('base64'))])
    }
  }
  await walk(root)
  return out
}
async function seed(a: AuthorityPaths, label: string) {
  const db = createDb(a)
  const instructions = `Synthetic ${label} instructions`
  await mkdir(a.projectDir(projectId), { recursive: true })
  await writeFile(a.projectInstructionsFile(projectId), instructions)
  await writeFile(a.projectMeta(projectId), JSON.stringify({ schemaVersion: 1, version: 7, boardProjectId: projectId,
    instructionsSha256: hash(instructions), contentManifest: { schemaVersion: 1, projectMdSha256: hash(instructions), skills: [] } }))
  const skill = join(a.projectSkillsDir(projectId), 'synthetic-skill')
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), `---\nname: synthetic-skill\ndescription: Synthetic ${label} skill\n---\nSynthetic instructions`)
  const tree = hashSkillTree(skill); assert(tree.ok)
  new ProjectSkillLedger(db).replaceActive(projectId, [{ name: 'synthetic-skill', ...tree }], 'synthetic-fixture')
  const memory = `---\nname: Synthetic ${label} memory\ndescription: Synthetic only\n---\nSynthetic ${label} body`
  await mkdir(a.projectMemoryDir(projectId), { recursive: true })
  await writeFile(a.projectMemoryFile(projectId, 'synthetic.md'), memory)
  db.prepare(`INSERT INTO tb_project_memory_official(project_id,slug,content_sha256,file,event_id,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(projectId, 'synthetic.md', hash(memory), 'synthetic.md', randomUUID(), 1)
  return { db, instructions, memory }
}
test('explicit project paths validate IDs and filenames without creating the missing authority root', async () => {
  const root = join((await authority()).root, 'missing')
  const a = createAuthorityPaths(root)
  assert.throws(() => a.projectDir('../escape'))
  assert.throws(() => a.projectMemoryFile(projectId, '../escape.md'))
  assert.equal(a.projectCandidatesIndex(projectId), join(a.projectDir(projectId), 'CANDIDATES.md'))
  assert.throws(() => openProjectFormalReadonly(a))
  const result = await loadProjectContextReadonly(projectId, a)
  assert.equal(result.instructions, null)
  await assert.rejects(lstat(root), { code: 'ENOENT' })
})
test('readonly facade and frozen context use one explicit formal root without exposing writers or legacy fallback', async t => {
  const a = await authority(), b = await authority()
  const first = await seed(a, 'A'), second = await seed(b, 'B')
  first.db.close(); second.db.close()
  const before = await snapshot(b.root)
  const ledger = openProjectFormalReadonly(b); t.after(() => ledger.close())
  assert.deepEqual(Object.keys(ledger).sort(), ['close','listCandidates','snapshot'])
  const legacyDecoy = new Database(a.projectLedgerDb, { readonly: true }); t.after(() => legacyDecoy.close())
  const result = await loadFrozenProjectContext({ boardProjectId: projectId, db: legacyDecoy, formal: { paths: b, ledger } })
  assert.equal(result.instructions, second.instructions)
  assert.equal(result.contextVersion, 7)
  assert.equal(result.skills.length, 1)
  assert(result.skills[0]?.description.includes('B'))
  assert.equal(result.officialMemory[0]?.content, second.memory)
  assert.deepEqual(await snapshot(b.root), before)
  assert.throws(() => legacyDecoy.prepare('DELETE FROM tb_project_skill').run(), /readonly/i)
  ledger.close(); ledger.close()
  assert.throws(() => ledger.snapshot(projectId))
})
test('hash drift remains untrusted without read-time repair, conflict backups or locks', async t => {
  const a = await authority(); const seeded = await seed(a, 'original'); seeded.db.close()
  await writeFile(a.projectInstructionsFile(projectId), 'Synthetic changed PROJECT')
  await writeFile(join(a.projectSkillsDir(projectId), 'synthetic-skill', 'SKILL.md'), 'Synthetic changed skill')
  await writeFile(a.projectMemoryFile(projectId, 'synthetic.md'), 'Synthetic changed memory')
  const before = await snapshot(a.root)
  const ledger = openProjectFormalReadonly(a); t.after(() => ledger.close())
  const context = await loadProjectContextReadonly(projectId, a)
  assert.equal(context.instructionsFileStatus, 'mismatch')
  const frozen = await loadFrozenProjectContext({ boardProjectId: projectId, formal: { paths: a, ledger } })
  assert.equal(frozen.instructions, null)
  assert.deepEqual(frozen.skills, [])
  assert.equal(frozen.officialMemory[0]?.content, null)
  assert.deepEqual(await snapshot(a.root), before)
})
test('formal metadata I/O failures propagate instead of becoming a missing-file or legacy result', async () => {
  const a = await authority()
  await mkdir(a.projectMeta(projectId), { recursive: true })
  await assert.rejects(loadProjectContextReadonly(projectId, a), { code: 'EISDIR' })
})
test('bad version and missing formal tables fail closed without migration or database changes', async () => {
  const a = await authority(); const db = createDb(a)
  db.pragma('user_version = 99'); db.close()
  const before = await snapshot(a.root)
  assert.throws(() => openProjectFormalReadonly(a), /schema/)
  assert.deepEqual(await snapshot(a.root), before)
  const repair = new Database(a.projectLedgerDb)
  repair.pragma(`user_version = ${PROJECT_FORMAL_DB_VERSION}`)
  repair.exec('DROP TABLE tb_project_skill'); repair.close()
  const missing = await snapshot(a.root)
  assert.throws(() => openProjectFormalReadonly(a), /schema/)
  assert.deepEqual(await snapshot(a.root), missing)
})
test('WAL format is rejected before readonly open can create shared-memory sidecars', async t => {
  const a = await authority(); const db = createDb(a); t.after(() => db.close())
  db.pragma('journal_mode = WAL')
  const before = await snapshot(a.root)
  assert.throws(() => openProjectFormalReadonly(a), /rollback-journal/)
  assert.deepEqual(await snapshot(a.root), before)
})
test('symlink ancestors and hardlink aliases are rejected rather than treated as independent formal storage', async () => {
  const a = await authority(), b = await authority(); createDb(a).close()
  const alias = join(b.root, 'alias')
  await symlink(a.root, alias)
  assert.throws(() => openProjectFormalReadonly(createAuthorityPaths(alias)), /symlink/)
  await link(a.projectLedgerDb, b.projectLedgerDb)
  assert.throws(() => openProjectFormalReadonly(b), /independent/)
})
