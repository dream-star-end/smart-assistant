// S-01 乐观并发 + S-06 saveAuxFile 守卫的回归用例(阶段 B)。
//
// 用 dynamic import:paths.ts 在模块求值时冻结 HOME,必须先设 OPENCLAUDE_HOME 再 import
// 才能落到临时目录(避免污染真实 ~/.openclaude,也让 Windows 下 realpath 容器化通过)。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'oc-skillconc-'))
process.env.OPENCLAUDE_HOME = home
const { buildUserSkillStore } = await import('../skillStore.js')

after(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('SkillStore.save · S-01 乐观并发(expectedVersion)', () => {
  const store = buildUserSkillStore('main')

  before(async () => {
    await store.save({ name: 'conc', description: 'seed' }, 'ORIGINAL')
  })

  it('省略 expectedVersion 时保持旧行为(后写者胜,不报冲突)', async () => {
    const r = await store.save({ name: 'legacy-skill', description: 'x' }, 'A')
    assert.equal(r.ok, true)
    const r2 = await store.save({ name: 'legacy-skill', description: 'x' }, 'B')
    assert.equal(r2.ok, true)
    assert.equal(r2.conflict, undefined)
  })

  it('load→edit→save 的陈旧写被拒,且不覆盖并发已写入的正文(真实场景)', async () => {
    // 两个客户端都在 1.0.0 打开。A 先存(带 expectedVersion 1.0.0)→ 1.0.1。
    const seeded = await store.view('conc', undefined, { includePlatform: false })
    const base = (seeded as { version?: string }).version
    assert.equal(base, '1.0.0')

    const ra = await store.save({ name: 'conc', description: 'seed' }, 'A WINS', {
      expectedVersion: base,
    })
    assert.equal(ra.ok, true)

    // B 仍拿着 1.0.0 存 → 冲突,回当前权威版本 1.0.1,且**不**覆盖 A 的正文。
    const rb = await store.save({ name: 'conc', description: 'seed' }, 'B STALE', {
      expectedVersion: base,
    })
    assert.equal(rb.ok, false)
    assert.deepEqual(rb.conflict, { currentVersion: '1.0.1' })

    const after = await store.view('conc', undefined, { includePlatform: false })
    assert.match((after as { body: string }).body, /A WINS/)
    assert.doesNotMatch((after as { body: string }).body, /B STALE/)
    assert.equal((after as { version?: string }).version, '1.0.1')
  })

  it('技能已不存在时 pin expectedVersion → 冲突 currentVersion:null', async () => {
    const r = await store.save({ name: 'ghost', description: 'x' }, 'body', {
      expectedVersion: '1.0.0',
    })
    assert.equal(r.ok, false)
    assert.deepEqual(r.conflict, { currentVersion: null })
  })

  it('带正确 expectedVersion 可继续保存(不误伤正常编辑)', async () => {
    const cur = await store.view('conc', undefined, { includePlatform: false })
    const r = await store.save({ name: 'conc', description: 'seed' }, 'A AGAIN', {
      expectedVersion: (cur as { version?: string }).version,
    })
    assert.equal(r.ok, true)
  })
})

describe('SkillStore.saveAuxFile · S-06 守卫', () => {
  const store = buildUserSkillStore('main')

  before(async () => {
    await store.save({ name: 'aux-skill', description: 'x' }, 'body')
  })

  it('拒绝把 SKILL.md 当辅助文件写入(绕过版本快照)', async () => {
    const r = await store.saveAuxFile('aux-skill', 'SKILL.md', 'HIJACK')
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /SKILL\.md/)
  })

  it('拒绝写入 history/ 快照区', async () => {
    const r = await store.saveAuxFile('aux-skill', 'history/1.0.0.md', 'HIJACK')
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /history/)
  })

  it('evals/ 等白名单辅助文件仍可写', async () => {
    const r = await store.saveAuxFile('aux-skill', 'evals/note.txt', 'ok')
    assert.equal(r.ok, true)
  })
})
