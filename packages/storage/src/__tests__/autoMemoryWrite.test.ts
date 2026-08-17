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
