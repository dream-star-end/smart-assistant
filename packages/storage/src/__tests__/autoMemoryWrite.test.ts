/**
 * ADD-only auto memory writes: create-only, append index, refuse user.md.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/autoMemoryWrite.test.ts
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-auto-mem-'))
process.env.OPENCLAUDE_HOME = testHome

const { MemoryDir, MEMDIR_INDEX_MARKER } = await import('../memoryDir.js')
const {
  isForbiddenAutoMemoryTarget,
  stampAutoMemoryFrontmatter,
  existingIndexLinesPreserved,
} = await import('../autoMemoryWrite.js')
const { findStrongLexicalMemory } = await import('../memoryDedup.js')
const { paths } = await import('../paths.js')

const FM = (name: string, desc: string, body: string) =>
  `---\nname: ${name}\ndescription: ${desc}\ntype: project\n---\n${body}\n`

describe('auto memory ADD-only', () => {
  it('refuses user.md targets', () => {
    assert.equal(isForbiddenAutoMemoryTarget('user.md'), true)
    assert.equal(isForbiddenAutoMemoryTarget('USER.md'), true)
    assert.equal(isForbiddenAutoMemoryTarget('note.md'), false)
  })

  it('stamps source: auto and expires = today + 30', () => {
    const stamped = stampAutoMemoryFrontmatter(FM('n', 'd', 'body'), '2026-08-18')
    assert.match(stamped, /source: auto/)
    assert.match(stamped, /expires: 2026-09-17/)
  })

  it('keeps a valid expires and forces source: auto even if another source is set', () => {
    const raw =
      '---\nname: n\ndescription: d\ntype: project\nsource: manual\nexpires: 2026-12-01\n---\nbody\n'
    const stamped = stampAutoMemoryFrontmatter(raw, '2026-08-18')
    assert.match(stamped, /source: auto/)
    assert.doesNotMatch(stamped, /source: manual/)
    assert.match(stamped, /expires: 2026-12-01/)
    assert.doesNotMatch(stamped, /expires: 2026-09-17/)
  })

  it('replaces illegal expires with today+30 and warns (write-side tighten)', () => {
    const warns: string[] = []
    const stamped = stampAutoMemoryFrontmatter(
      '---\nname: n\ndescription: d\ntype: project\nexpires: not-a-date\n---\nbody\n',
      '2026-08-18',
      { warn: (m) => warns.push(m), context: 'bad.md' },
    )
    assert.match(stamped, /expires: 2026-09-17/)
    assert.match(stamped, /source: auto/)
    assert.ok(warns.some((m) => m.includes('not-a-date') && m.includes('replacing')))
    assert.ok(warns.some((m) => m.includes('write side tightens')))
  })

  it('stamps body-only content with a fallback name', () => {
    const stamped = stampAutoMemoryFrontmatter('just a body', '2026-08-18', {
      fallbackName: 'brandnew',
    })
    assert.match(stamped, /name: brandnew/)
    assert.match(stamped, /source: auto/)
    assert.match(stamped, /expires: 2026-09-17/)
    assert.match(stamped, /just a body/)
  })

  it('creates a new file and appends an index line', async () => {
    const agentId = 'add-ok'
    await mkdir(paths.agentDir(agentId), { recursive: true })
    await writeFile(
      paths.agentMemoryMd(agentId),
      `${MEMDIR_INDEX_MARKER}\n- [kept](memory/kept.md) — 人写钩子\n`,
    )
    await mkdir(paths.agentMemoryDir(agentId), { recursive: true })
    await writeFile(paths.agentMemoryFile(agentId, 'kept.md'), FM('kept', '人写钩子', '旧'))

    const md = new MemoryDir(agentId)
    const result = await md.applyAutoAdds({
      creates: [
        {
          file: 'fresh.md',
          content: stampAutoMemoryFrontmatter(FM('fresh', '新钩子', '新正文'), '2026-08-18'),
        },
      ],
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.created, ['fresh.md'])
    const index = await readFile(paths.agentMemoryMd(agentId), 'utf8')
    assert.match(index, /人写钩子/)
    assert.match(index, /fresh\.md/)
    assert.match(await readFile(paths.agentMemoryFile(agentId, 'fresh.md'), 'utf8'), /source: auto/)
  })

  it('applyAutoAdds stamps missing source/expires even when the caller did not', async () => {
    const agentId = 'add-unstamped'
    const md = new MemoryDir(agentId)
    const result = await md.applyAutoAdds({
      today: '2026-08-18',
      creates: [
        {
          file: 'brandnew.md',
          content: FM('brandnew', 'auto brandnew', 'body'),
        },
      ],
    })
    assert.equal(result.ok, true)
    const raw = await readFile(paths.agentMemoryFile(agentId, 'brandnew.md'), 'utf8')
    assert.match(raw, /^---\nname: brandnew\n/)
    assert.match(raw, /source: auto/)
    assert.match(raw, /expires: 2026-09-17/)
  })

  it('applyAutoAdds keeps a caller-supplied valid expires and replaces an illegal one', async () => {
    const agentId = 'add-expires-keep'
    const md = new MemoryDir(agentId)
    const keep = await md.applyAutoAdds({
      today: '2026-08-18',
      creates: [
        {
          file: 'kept-exp.md',
          content:
            '---\nname: kept\ndescription: d\ntype: project\nexpires: 2026-10-01\n---\nbody\n',
        },
      ],
    })
    assert.equal(keep.ok, true)
    assert.match(
      await readFile(paths.agentMemoryFile(agentId, 'kept-exp.md'), 'utf8'),
      /expires: 2026-10-01/,
    )

    const replaced = await md.applyAutoAdds({
      today: '2026-08-18',
      creates: [
        {
          file: 'bad-exp.md',
          content:
            '---\nname: bad\ndescription: d\ntype: project\nexpires: 2026-13-40\n---\nbody\n',
        },
      ],
    })
    assert.equal(replaced.ok, true)
    assert.match(
      await readFile(paths.agentMemoryFile(agentId, 'bad-exp.md'), 'utf8'),
      /expires: 2026-09-17/,
    )
  })

  it('refuses to overwrite an existing file and leaves it unchanged', async () => {
    const agentId = 'add-exists'
    await mkdir(paths.agentMemoryDir(agentId), { recursive: true })
    await writeFile(paths.agentMemoryFile(agentId, 'kept.md'), FM('kept', '原钩子', '原正文'))
    await writeFile(
      paths.agentMemoryMd(agentId),
      `${MEMDIR_INDEX_MARKER}\n- [kept](memory/kept.md) — 原钩子\n`,
    )
    const md = new MemoryDir(agentId)
    const result = await md.applyAutoAdds({
      creates: [{ file: 'kept.md', content: FM('kept', '覆盖', '不该出现') }],
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'exists')
    assert.match(await readFile(paths.agentMemoryFile(agentId, 'kept.md'), 'utf8'), /原正文/)
    assert.doesNotMatch(await readFile(paths.agentMemoryFile(agentId, 'kept.md'), 'utf8'), /不该出现/)
  })

  it('refuses user.md as a create target', async () => {
    const agentId = 'add-user'
    const md = new MemoryDir(agentId)
    const result = await md.applyAutoAdds({
      creates: [{ file: 'user.md', content: FM('user', '画像', '<!-- oc-user-always:start -->x') }],
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'forbidden')
  })

  it('rolls back when existing index lines would be lost', () => {
    assert.equal(
      existingIndexLinesPreserved(
        ['- [kept](memory/kept.md) — 人写钩子'],
        ['- [fresh](memory/fresh.md) — 新'],
      ),
      false,
    )
    assert.equal(
      existingIndexLinesPreserved(
        ['- [kept](memory/kept.md) — 人写钩子'],
        ['- [kept](memory/kept.md) — 人写钩子', '- [fresh](memory/fresh.md) — 新'],
      ),
      true,
    )
  })

  it('dedup probe hits live memories and ignores expired ones', async () => {
    const agentId = 'add-dedup'
    await mkdir(paths.agentMemoryDir(agentId), { recursive: true })
    await writeFile(
      paths.agentMemoryFile(agentId, 'old.md'),
      '---\nname: old\ndescription: 过期鼻炎笔记\ntype: project\nexpires: 2026-08-17\n---\n过期鼻炎笔记\n',
    )
    const expired = await findStrongLexicalMemory({
      agentId,
      query: '鼻炎笔记',
      today: '2026-08-18',
    })
    assert.equal(expired.hit, false)

    await writeFile(
      paths.agentMemoryFile(agentId, 'live.md'),
      '---\nname: live\ndescription: 有效鼻炎笔记\ntype: project\n---\n有效鼻炎笔记\n',
    )
    const live = await findStrongLexicalMemory({
      agentId,
      query: '鼻炎笔记',
      today: '2026-08-18',
    })
    assert.equal(live.hit, true)
    if (live.hit) assert.match(live.path, /live\.md/)
  })
})
