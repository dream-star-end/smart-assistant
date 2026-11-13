import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import Database from 'better-sqlite3'
import type { GatewayContextAuthority } from '../contextEligibility.js'

const home = await mkdtemp(join(tmpdir(), 'oc-context-source-'))
process.env.OPENCLAUDE_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const { createAuthorityPaths } = await import('../authorityPaths.js')
const { MemoryDir, MEMDIR_INDEX_MARKER } = await import('../memoryDir.js')
const { readCoreContextSource, readFormalProjectContextSources } = await import('../contextSource.js')
const { resolveIdentityCompatAssets } = await import('../identityCompatAssets.js')
const { PROJECT_MEMORY_LEDGER_DDL } = await import('../projectMemoryLedger.js')
const { PROJECT_SKILL_LEDGER_DDL } = await import('../projectSkillLedger.js')
const { PROJECT_FORMAL_DB_APPLICATION_ID, PROJECT_FORMAL_DB_VERSION } = await import('../projectFormalLedger.js')
const projectId = 'd6100000-0000-4000-8000-000000000765'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const options = { enabled: true, today: '2026-08-18', now: () => 100 }
function authority(root: string, extra: Partial<GatewayContextAuthority> = {}): GatewayContextAuthority {
  return { runtime: 'gateway', domainId: 'synthetic-domain', effectiveAgentId: 'main', sessionId: 's1', turnId: 't1',
    boardProjectId: null, contextVersion: null, authorityEpoch: 'e1', mode: 'legacy', root,
    policyFingerprint: 'privacy-off:allow', memoryPolicy: { allowed: true, reason: 'explicit_continuity' },
    expiresAt: 200, revoked: false, ...extra }
}
async function snapshot(root: string): Promise<unknown[]> {
  const result: unknown[] = []
  async function walk(file: string) {
    const stat = await lstat(file)
    result.push([file, stat.size, stat.ino, stat.mtimeMs, stat.mode,
      stat.isFile() ? hash((await readFile(file)).toString('base64')) : null])
    if (stat.isDirectory()) for (const name of (await readdir(file)).sort()) await walk(join(file, name))
  }
  await walk(root)
  return result
}
async function core(name: string, index: string) {
  const root = join(home, name)
  const paths = createAuthorityPaths(root)
  await mkdir(paths.agentMemoryDir('main'), { recursive: true })
  await writeFile(paths.agentMemoryMd('main'), index)
  return { root, paths, reader: new MemoryDir('main', paths) }
}
async function formal(name: string, expires?: string) {
  const root = join(home, name)
  const paths = createAuthorityPaths(root)
  await mkdir(paths.projectMemoryDir(projectId), { recursive: true })
  await writeFile(paths.projectMeta(projectId), JSON.stringify({ schemaVersion: 1, version: 7, boardProjectId: projectId }))
  const content = `---\nname: ${name}\ndescription: synthetic\nexpires: 2026-08-18\n---\n${name} body`
  await writeFile(paths.projectMemoryFile(projectId, 'note.md'), content)
  await writeFile(paths.projectMemoryFile(projectId, 'ghost.md'), 'not in ledger')
  const db = new Database(paths.projectLedgerDb)
  db.pragma('journal_mode = DELETE')
  db.exec(PROJECT_MEMORY_LEDGER_DDL + PROJECT_SKILL_LEDGER_DDL)
  db.pragma(`application_id = ${PROJECT_FORMAL_DB_APPLICATION_ID}`)
  db.pragma(`user_version = ${PROJECT_FORMAL_DB_VERSION}`)
  db.prepare('INSERT INTO tb_project_memory_official(project_id,slug,content_sha256,file,event_id,updated_at,expires) VALUES(?,?,?,?,?,?,?)')
    .run(projectId, 'note.md', hash(content), 'note.md', randomUUID(), 1, expires ?? null)
  db.close()
  return { root, paths, content, auth: authority(root, { mode: 'formal', boardProjectId: projectId, contextVersion: 7 }) }
}

test('V01 default off is zero-read even with missing roots or a throwing reader', async () => {
  const auth = authority(join(home, 'never-created'), { mode: 'formal', boardProjectId: projectId, contextVersion: 7 })
  const source = { get reader(): InstanceType<typeof MemoryDir> { throw new Error('source accessed') } }
  assert.deepEqual(await readCoreContextSource(auth, { today: options.today }, source), { status: 'unavailable', reason: 'disabled' })
  assert.deepEqual(await readFormalProjectContextSources(auth, { today: options.today }), { status: 'unavailable', reason: 'disabled' })
  await assert.rejects(lstat(auth.root), { code: 'ENOENT' })
})

test('V01 readonly Core preserves bytes/hash/mtime, orphan/dead-link semantics and isolated sidecar', async () => {
  const f = await core('core', `${MEMDIR_INDEX_MARKER}\n- [known](memory/known.md)\n- [dead](memory/dead.md)\n`)
  await writeFile(f.paths.agentMemoryFile('main', 'known.md'), '---\nname: known\n---\nknown body')
  await writeFile(f.paths.agentMemoryFile('main', 'orphan.md'), 'orphan body')
  await mkdir(join(f.root, '.context-derived/v1'), { recursive: true })
  await writeFile(join(f.root, '.context-derived/v1/cache'), 'DERIVED CANARY')
  const before = await snapshot(f.root)
  const expected = await f.reader.renderForInjectionReadonly(25 * 1024, 200, { today: options.today })
  const result = await readCoreContextSource(authority(f.root), options, f)
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.sources[0]?.content, expected)
  assert.match(result.sources[0].content, /dead/)
  assert.doesNotMatch(result.sources[0].content, /orphan|DERIVED/)
  assert(Object.isFrozen(result.sources[0]))
  assert.deepEqual(await snapshot(f.root), before)
})

test('V01 legacy blob, marker below heading and missing index never migrate or create source directories', async () => {
  for (const [name, index] of [['blob', '# Memory\n§ legacy entry'], ['marker', `# heading\n${MEMDIR_INDEX_MARKER}\n- manual hook`]]) {
    const f = await core(name, index)
    const before = await snapshot(f.root)
    await readCoreContextSource(authority(f.root), options, f)
    assert.deepEqual(await snapshot(f.root), before)
  }
  const paths = createAuthorityPaths(join(home, 'missing-core'))
  assert.deepEqual(await readCoreContextSource(authority(paths.root), options, { reader: new MemoryDir('main', paths) }), { status: 'ready', sources: [] })
  await assert.rejects(lstat(paths.root), { code: 'ENOENT' })
})

test('V04/V17 explicit formal B ignores A/legacy decoys, ghost files and sidecar; no disk writes', async () => {
  const a = await formal('A')
  const b = await formal('B')
  await mkdir(join(b.root, '.context-derived/v1'), { recursive: true })
  await writeFile(join(b.root, '.context-derived/v1/cache'), a.content)
  const before = await snapshot(home)
  const result = await readFormalProjectContextSources(b.auth, options)
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].content, b.content)
  assert.equal(result.sources[0].locator, `project:${projectId}/memory/note.md`)
  assert.deepEqual(await snapshot(home), before)
  assert.deepEqual(await readFormalProjectContextSources({ ...b.auth, contextVersion: 8 }, options), { status: 'unavailable', reason: 'source_changed' })
  const other = await readFormalProjectContextSources({ ...b.auth, boardProjectId: 'd6100000-0000-4000-8000-000000000766' }, options)
  assert.notDeepEqual(other, result)
})

test('V04 formal hash drift/deprecation and V06 ledger/content TTL reject entries without repair', async () => {
  const f = await formal('drift')
  await writeFile(f.paths.projectMemoryFile(projectId, 'note.md'), 'tampered')
  const before = await snapshot(f.root)
  assert.deepEqual(await readFormalProjectContextSources(f.auth, options), { status: 'ready', sources: [] })
  assert.deepEqual(await snapshot(f.root), before)
  const deprecated = await formal('deprecated')
  const db = new Database(deprecated.paths.projectLedgerDb)
  db.prepare('UPDATE tb_project_memory_official SET deprecated=1').run(); db.close()
  assert.deepEqual(await readFormalProjectContextSources(deprecated.auth, options), { status: 'ready', sources: [] })
  const expired = await formal('ledger-expired', '2026-08-17')
  assert.deepEqual(await readFormalProjectContextSources(expired.auth, options), { status: 'ready', sources: [] })
  const today = await formal('today')
  const result = await readFormalProjectContextSources(today.auth, options)
  assert.equal(result.status === 'ready' && result.sources.length, 1)
  assert.deepEqual(await readFormalProjectContextSources(today.auth, { ...options, today: '2026-08-19' }), { status: 'ready', sources: [] })
})

test('V17 missing/unknown-schema formal roots fail closed, no legacy fallback or new files', async () => {
  const auth = authority(join(home, 'missing-formal'), { mode: 'formal', boardProjectId: projectId, contextVersion: 7 })
  await assert.rejects(readFormalProjectContextSources(auth, options))
  await assert.rejects(lstat(auth.root), { code: 'ENOENT' })
  const f = await formal('schema')
  const db = new Database(f.paths.projectLedgerDb); db.pragma('user_version = 99'); db.close()
  const before = await snapshot(f.root)
  await assert.rejects(readFormalProjectContextSources(f.auth, options), /schema/)
  assert.deepEqual(await snapshot(f.root), before)
  assert.deepEqual(await readFormalProjectContextSources({ ...f.auth, mode: 'legacy' }, options), { status: 'unavailable', reason: 'source_unavailable' })
})

test('V09 registered identity shares Core only through canonical execution; no alias expansion', async () => {
  const p = createAuthorityPaths(home)
  await mkdir(p.agentMemoryDir('main'), { recursive: true })
  await writeFile(p.agentMemoryMd('main'), `${MEMDIR_INDEX_MARKER}\n- shared synthetic hook`)
  for (const id of ['butler', 'personal-butler']) {
    await mkdir(p.agentDir(id), { recursive: true })
    await writeFile(join(p.agentDir(id), 'CLAUDE.md'), `# ${id}`)
    await symlink('../main/memory', p.agentMemoryDir(id))
    await symlink('../main/MEMORY.md', p.agentMemoryMd(id))
  }
  await writeFile(join(home, 'agents.yaml'), 'agents:\n  - id: butler\n  - id: personal-butler\nroutes: []\ndefault: personal-butler\n')
  await writeFile(join(home, 'openclaude.json'), JSON.stringify({ defaults: {} }))
  const identityCompat = await resolveIdentityCompatAssets({ profile: {
    profileId: 'synthetic', legacyAgentId: 'butler', canonicalAgentId: 'personal-butler',
    localPersonaPath: 'agents/butler/CLAUDE.md', localSkillStorageId: 'butler',
  } })
  const source = { reader: new MemoryDir('personal-butler', p), identityCompat }
  const before = await snapshot(home)
  const result = await readCoreContextSource(authority(home, { effectiveAgentId: 'personal-butler' }), options, source)
  assert.equal(result.status === 'ready' && result.sources.length, 1)
  await assert.rejects(readCoreContextSource(authority(home, { effectiveAgentId: 'butler' }), options, source), /execution/)
  assert.deepEqual(await snapshot(home), before)
})

test('V06/V16 deny and all CLI lease claims reject before source reads; expiry after await rejects', async () => {
  const source = { get reader(): InstanceType<typeof MemoryDir> { throw new Error('must not read') } }
  const deny = authority(home, { memoryPolicy: { allowed: false, reason: 'explicit_ignore' } })
  assert.deepEqual(await readCoreContextSource(deny, options, source), { status: 'unavailable', reason: 'policy_denied' })
  for (const runtime of ['cli-managed', 'cli-unmanaged'] as const) {
    for (const lease of [undefined, { mode: 0o600, allowed: true }, { expiresAt: 99 }, { sessionId: 'other', root: '/fake', signature: 'forged' }]) {
      assert.deepEqual(await readCoreContextSource({ runtime, lease }, options, source), { status: 'unavailable', reason: 'cli_lease_blocked' })
      assert.deepEqual(await readFormalProjectContextSources({ runtime, lease }, options), { status: 'unavailable', reason: 'cli_lease_blocked' })
    }
  }
  let now = 100
  const result = await readCoreContextSource(authority(home), { ...options, now: () => now }, {
    reader: { async renderForInjectionReadonly() { now = 201; return 'late'; } },
  })
  assert.deepEqual(result, { status: 'unavailable', reason: 'authority_unavailable' })
})
