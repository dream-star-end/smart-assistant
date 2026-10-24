import type { Dirent } from 'node:fs'
/** Synthetic explicit roots only. Pure views never operate on the process HOME or a product account. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { createAuthorityPaths } from '../authorityPaths.js'
import { CoreMemoryView, UserProfileView, createAuthoritySkillReadView } from '../authorityViews.js'
import { MEMDIR_INDEX_MARKER } from '../memoryDir.js'
const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
async function rootPair() {
  const base = await mkdtemp(join(tmpdir(), 'oc-authority-views-'))
  return { base, a: createAuthorityPaths(join(base, 'a')), b: createAuthorityPaths(join(base, 'b')) }
}
async function snapshot(root: string): Promise<unknown[]> {
  const files: unknown[] = []
  async function visit(dir: string) {
    let entries: Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { files.push([relative(root, path), 'dir']); await visit(path) }
      else if (entry.isFile()) { const st = await stat(path); files.push([relative(root, path), st.mtimeMs, sha(await readFile(path, 'utf8'))]) }
      else files.push([relative(root, path), 'other'])
    }
  }
  await visit(root)
  return files
}
test('authority paths require an explicit root, reject traversal, and contain no runtime locations', async () => {
  const { base, a } = await rootPair()
  assert(Object.isFrozen(a))
  assert.equal(a.agentMemoryMd('main'), join(base, 'a', 'agents/main/MEMORY.md'))
  for (const invalid of ['', '../main', '/main', 'a/b', 'a\\b']) assert.throws(() => a.agentDir(invalid))
  for (const invalid of ['..', '../x.md', 'x/y.md', 'x\\y.md']) assert.throws(() => a.agentMemoryFile('main', invalid))
  assert.throws(() => createAuthorityPaths('relative'))
  assert.throws(() => createAuthorityPaths('/'))
  assert.throws(() => createAuthorityPaths('/contains\0nul'))
  for (const forbidden of ['workspaceRoot', 'sessionsDb', 'taskboardDb', 'skillDraftsDir', 'logsDir', 'config']) assert.equal(forbidden in a, false)
  assert.deepEqual(await readdir(base), [])
})
test('missing formal roots stay missing after every pure read and do not fall back', async () => {
  const { base, a } = await rootPair()
  assert.deepEqual(await new UserProfileView(a).read(), { text: '', version: sha('') })
  const memory = new CoreMemoryView('main', a)
  assert.deepEqual(await memory.list(), [])
  assert.equal(await memory.read('note.md'), null)
  assert.equal(await memory.renderForInjection(1000), null)
  const skills = createAuthoritySkillReadView('main', a)
  assert.deepEqual(await skills.list(), [])
  assert.equal(await skills.view('missing'), null)
  assert.deepEqual(await readdir(base), [])
})
test('profile reads preserve legacy sections, normalize CRLF versions, and never migrate or create locks', async () => {
  const { a, b } = await rootPair()
  await mkdir(a.root, { recursive: true }); await mkdir(b.root, { recursive: true })
  const raw = 'Synthetic first\r\n§\r\nSynthetic second'
  await writeFile(a.sharedUserMd, raw); await writeFile(b.sharedUserMd, 'different-root')
  const before = await snapshot(a.root)
  const value = await new UserProfileView(a).read()
  assert.equal(value.text, raw.replaceAll('\r\n', '\n'))
  assert.equal(value.version, sha(value.text))
  assert.equal((await new UserProfileView(b).read()).text, 'different-root')
  assert.equal(await readFile(a.sharedUserMd, 'utf8'), raw)
  assert.deepEqual(await snapshot(a.root), before)
})
test('core pure reads use only their root and retain raw-file CAS versions', async () => {
  const { a, b } = await rootPair()
  await mkdir(a.agentMemoryDir('main'), { recursive: true }); await mkdir(b.agentMemoryDir('main'), { recursive: true })
  const raw = '---\nname: Synthetic note\ntype: reference\n---\nraw line\r\n'
  await writeFile(a.agentMemoryFile('main', 'note.md'), raw)
  await writeFile(b.agentMemoryFile('main', 'note.md'), 'other-root')
  const view = new CoreMemoryView('main', a)
  const before = await snapshot(a.root)
  assert.deepEqual(await view.read('note.md'), { content: raw, version: sha(raw) })
  assert.deepEqual((await view.list()).map(entry => entry.file), ['note.md'])
  assert.equal(await view.read('../note.md'), null)
  assert.equal((await new CoreMemoryView('main', b).read('note.md'))?.content, 'other-root')
  assert.deepEqual(await snapshot(a.root), before)
})
test('readonly injection retains existing TTL, scan and cap logic without repairing drift', async () => {
  const { a } = await rootPair()
  await mkdir(a.agentMemoryDir('main'), { recursive: true })
  await writeFile(a.agentMemoryFile('main', 'expired.md'), '---\nname: Expired\nexpires: 2020-01-01\n---\nexpired body')
  await writeFile(a.agentMemoryFile('main', 'orphan.md'), 'orphan-must-not-be-injected')
  const index = `${MEMDIR_INDEX_MARKER}\n- [Expired](memory/expired.md) — stale\n- [Missing](memory/missing.md) — drift tolerated\n`
  await writeFile(a.agentMemoryMd('main'), index)
  const before = await snapshot(a.root)
  const rendered = await new CoreMemoryView('main', a).renderForInjection(1000, 200, { today: '2026-10-24' })
  assert(rendered !== null)
  assert(rendered.includes('Missing'))
  assert.equal(rendered.includes('Expired'), false)
  assert.equal(rendered.includes('orphan-must-not-be-injected'), false)
  assert.deepEqual(await snapshot(a.root), before)
})
test('reading a legacy core index never migrates or recovers a pending batch', async () => {
  const { a } = await rootPair()
  await mkdir(a.agentDir('main'), { recursive: true })
  await writeFile(a.agentMemoryMd('main'), 'old section\n§\nold second')
  await writeFile(a.agentMemoryBatchJournal('main'), '{"synthetic":"must-not-recover"}')
  const before = await snapshot(a.root)
  const view = new CoreMemoryView('main', a)
  await view.list(); await view.renderForInjection(1000)
  assert.deepEqual(await snapshot(a.root), before)
})
async function skill(root: string, name: string, body: string) {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic explicit-root skill\n---\n${body}\n`)
}
test('skill facades retain layer parsing, mask writer metadata, and do not cross roots', async () => {
  const { a, b } = await rootPair()
  await skill(a.sharedSkillsDir, 'shared-note', 'root-a-content')
  await skill(a.agentSkillsDir('main'), 'private-note', 'private-a-content')
  await skill(b.sharedSkillsDir, 'other-note', 'root-b-content')
  const before = await snapshot(a.root)
  const view = createAuthoritySkillReadView('main', a, { scopeMode: 'management' })
  const listed = await view.list()
  assert.deepEqual(listed.map(entry => entry.name).sort(), ['private-note', 'shared-note'])
  assert(listed.every(entry => entry.writable === false))
  const content = await view.view('shared-note')
  assert(content && typeof content === 'object')
  assert(content.rawContent.includes('root-a-content'))
  assert.equal(content.writable, false)
  assert.equal(await view.view('other-note'), null)
  assert.equal('save' in view, false); assert.equal('delete' in view, false); assert.equal('history' in view, false)
  assert.deepEqual(await snapshot(a.root), before)
})
test('an invalid formal skill root fails rather than invoking a legacy fallback builder', async () => {
  const { base, a } = await rootPair()
  const outside = join(base, 'outside')
  await skill(outside, 'outside-skill', 'outside-marker')
  await mkdir(a.root, { recursive: true })
  await symlink(outside, a.sharedSkillsDir)
  assert.throws(() => createAuthoritySkillReadView('main', a), /within home/)
})
