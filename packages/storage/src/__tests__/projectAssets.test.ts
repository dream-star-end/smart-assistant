/**
 * 聊天项目资产存储契约。
 *
 * 锁定:
 *   1. CRUD 按 user_id 隔离,他人读写 → not_found(不泄漏存在性);
 *   2. 软删只标 deleted_at,不删磁盘文件;
 *   3. 每项目(含未分组 NULL) 500 上限;
 *   4. 同 (user_id, project_id, source, digest) 未删行去重,digest 空则用 container_path;
 *   5. 恶意 url / containerPath 被拒;
 *   6. 跨项目搜索(Cmd+K):name/excerpt 子串,按用户隔离,LIKE 通配符转义。
 *   7. 带字节副本的产出按源路径出版本:同内容不出新版本,内容变了出新版本,
 *      list 每个源路径只回最新版本并带 versionCount,listProjectAssetVersions 列全部版本。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/projectAssets.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-proj-assets-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  PROJECT_ASSET_PER_PROJECT_LIMIT,
  createChatProject,
  createProjectAsset,
  deleteProjectAsset,
  getSessionsDb,
  listPinnedProjectAssetsForChatProject,
  listPinnedProjectAssetsForSession,
  patchClientSessionMeta,
  listProjectAssetVersions,
  listProjectAssets,
  parseProjectAssetContainerPath,
  parseProjectAssetUrl,
  searchProjectAssets,
  updateProjectAsset,
  upsertClientSession,
} = await import('../sessionsDb.js')

const USER = 'c:asset-user'
const OTHER = 'c:other-user'
const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const MEDIA_URL = (digest: string, ext = 'pdf') => `/api/media/${digest}.${ext}`

async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec('DELETE FROM project_assets')
  db.exec('DELETE FROM client_sessions')
  db.exec('DELETE FROM chat_projects')
}

function baseSession(id: string, userId = USER) {
  const now = Date.now()
  return {
    id,
    userId,
    agentId: 'main',
    title: '测试会话',
    pinned: false,
    createdAt: now,
    lastAt: now,
    messages: [] as unknown[],
    updatedAt: now,
  }
}

describe('project_assets CRUD', () => {
  beforeEach(clearTables)

  it('POST 校验:trim 名称、长度、控制字符', async () => {
    const empty = await createProjectAsset(USER, {
      source: 'upload',
      name: '   ',
      url: MEDIA_URL(DIGEST_A),
    })
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.equal(empty.error, 'invalid_name')

    const long = await createProjectAsset(USER, {
      source: 'upload',
      name: 'x'.repeat(201),
      url: MEDIA_URL(DIGEST_A),
    })
    assert.equal(long.ok, false)

    const dirty = await createProjectAsset(USER, {
      source: 'upload',
      name: '  报\u0000告\u0007.pdf  ',
      url: MEDIA_URL(DIGEST_A),
    })
    assert.equal(dirty.ok, true)
    if (!dirty.ok) return
    assert.equal(dirty.asset.name, '报告.pdf')
    assert.equal(dirty.asset.source, 'upload')
    assert.equal(dirty.asset.pinned, false)
    assert.equal(dirty.asset.projectId, null)
    assert.ok(dirty.asset.id.length >= 8)
  })

  it('恶意 url / containerPath 被拒', async () => {
    const badUrls = [
      'https://evil.example/x.pdf',
      '/api/media/../secret',
      '/api/media/' + 'g'.repeat(64) + '.pdf',
      '/api/file?path=/etc/passwd',
      '/api/media/' + DIGEST_A + '.pdf/../../etc/passwd',
    ]
    for (const url of badUrls) {
      const r = await createProjectAsset(USER, { source: 'upload', name: 'x', url })
      assert.equal(r.ok, false, url)
      if (!r.ok) assert.equal(r.error, 'invalid_url')
      const parsed = parseProjectAssetUrl(url)
      assert.equal('invalid' in parsed || parsed.present === false, true, url)
    }

    const badPaths = [
      '/etc/passwd',
      '/home/agent/.openclaude/generated/../uploads/x',
      '/home/agent/.openclaude/generated/foo/../../etc/passwd',
      '/root/.openclaude/generated/x.pdf',
      '/home/agent/.openclaude/research/x.pdf',
      '/home/agent/.openclaude/generated/',
      '/home/agent/.openclaude/uploads/foo\n/etc/passwd',
    ]
    for (const containerPath of badPaths) {
      const r = await createProjectAsset(USER, { source: 'output', name: 'x', containerPath })
      assert.equal(r.ok, false, containerPath)
      if (!r.ok) assert.equal(r.error, 'invalid_container_path')
      assert.equal(parseProjectAssetContainerPath(containerPath), null, containerPath)
    }

    const missing = await createProjectAsset(USER, { source: 'upload', name: 'x' })
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.error, 'invalid_locator')
  })

  it('合法 url 与 generated/uploads 路径可登记', async () => {
    const urlOk = await createProjectAsset(USER, {
      source: 'upload',
      name: 'a.pdf',
      url: MEDIA_URL(DIGEST_A),
      digest: DIGEST_A,
      mime: 'application/pdf',
      size: 12,
    })
    assert.equal(urlOk.ok, true)
    if (!urlOk.ok) return
    assert.equal(urlOk.asset.url, MEDIA_URL(DIGEST_A))
    assert.equal(urlOk.asset.digest, DIGEST_A)
    assert.equal(urlOk.asset.sizeBytes, 12)

    const gen = await createProjectAsset(USER, {
      source: 'output',
      name: 'out.pdf',
      containerPath: '/home/agent/.openclaude/generated/out.pdf',
    })
    assert.equal(gen.ok, true)

    const up = await createProjectAsset(USER, {
      source: 'upload',
      name: 'in.txt',
      containerPath: `/home/agent/.openclaude/uploads/${DIGEST_B}.txt`,
      url: MEDIA_URL(DIGEST_B, 'txt'),
    })
    assert.equal(up.ok, true)
  })

  it('list 按 created_at DESC;跨用户隔离;未分组 vs 项目', async () => {
    const proj = await createChatProject(USER, { name: 'P' })
    assert.equal(proj.ok, true)
    if (!proj.ok) return
    await createProjectAsset(USER, { source: 'upload', name: 'ungrouped', url: MEDIA_URL(DIGEST_A) })
    await createProjectAsset(USER, {
      source: 'upload',
      name: 'in-proj',
      url: MEDIA_URL(DIGEST_B),
      projectId: proj.project.id,
    })
    const ungrouped = await listProjectAssets(USER, { projectId: null })
    assert.deepEqual(ungrouped.map((a) => a.name), ['ungrouped'])
    const grouped = await listProjectAssets(USER, { projectId: proj.project.id })
    assert.deepEqual(grouped.map((a) => a.name), ['in-proj'])
    assert.equal((await listProjectAssets(OTHER, { projectId: null })).length, 0)
    assert.equal((await listProjectAssets(OTHER, { projectId: proj.project.id })).length, 0)
  })

  it('他人 PATCH/DELETE → not_found,不误写', async () => {
    const created = await createProjectAsset(USER, {
      source: 'upload',
      name: '私有',
      url: MEDIA_URL(DIGEST_A),
    })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const patched = await updateProjectAsset(OTHER, created.asset.id, { name: '劫持' })
    assert.equal(patched.ok, false)
    if (!patched.ok) assert.equal(patched.error, 'not_found')
    const deleted = await deleteProjectAsset(OTHER, created.asset.id)
    assert.equal(deleted.ok, false)
    const still = await listProjectAssets(USER, { projectId: null })
    assert.equal(still[0]?.name, '私有')
  })

  it('软删后 list 不可见,同 digest 可再插入;磁盘不在本层删除', async () => {
    const created = await createProjectAsset(USER, {
      source: 'upload',
      name: '将删',
      url: MEDIA_URL(DIGEST_A),
      digest: DIGEST_A,
    })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const del = await deleteProjectAsset(USER, created.asset.id)
    assert.equal(del.ok, true)
    assert.equal((await listProjectAssets(USER, { projectId: null })).length, 0)
    const again = await createProjectAsset(USER, {
      source: 'upload',
      name: '再来',
      url: MEDIA_URL(DIGEST_A),
      digest: DIGEST_A,
    })
    assert.equal(again.ok, true)
    if (!again.ok) return
    assert.notEqual(again.asset.id, created.asset.id)
  })

  it('去重:同 user/project/source/digest 返回既有行', async () => {
    const first = await createProjectAsset(USER, {
      source: 'upload',
      name: '一',
      url: MEDIA_URL(DIGEST_A),
      digest: DIGEST_A,
    })
    const second = await createProjectAsset(USER, {
      source: 'upload',
      name: '二',
      url: MEDIA_URL(DIGEST_A),
      digest: DIGEST_A,
    })
    assert.equal(first.ok && second.ok, true)
    if (!first.ok || !second.ok) return
    assert.equal(second.asset.id, first.asset.id)
    assert.equal(second.asset.name, '一')
    assert.equal((await listProjectAssets(USER, { projectId: null })).length, 1)

    const pathA = await createProjectAsset(USER, {
      source: 'output',
      name: 'out',
      containerPath: '/home/agent/.openclaude/generated/same.pdf',
    })
    const pathB = await createProjectAsset(USER, {
      source: 'output',
      name: 'out2',
      containerPath: '/home/agent/.openclaude/generated/same.pdf',
    })
    assert.equal(pathA.ok && pathB.ok, true)
    if (!pathA.ok || !pathB.ok) return
    assert.equal(pathB.asset.id, pathA.asset.id)
  })

  it('每项目上限 500;去重命中不占新名额', async () => {
    const first = await createProjectAsset(USER, {
      source: 'upload',
      name: 'p0',
      url: MEDIA_URL(DIGEST_A),
      digest: DIGEST_A,
    })
    assert.equal(first.ok, true)
    for (let i = 1; i < PROJECT_ASSET_PER_PROJECT_LIMIT; i++) {
      const digest = i.toString(16).padStart(64, '0')
      const r = await createProjectAsset(USER, {
        source: 'upload',
        name: `p${i}`,
        url: MEDIA_URL(digest),
        digest,
      })
      assert.equal(r.ok, true, `create #${i + 1}`)
    }
    const overflow = await createProjectAsset(USER, {
      source: 'upload',
      name: 'overflow',
      url: MEDIA_URL(DIGEST_B),
      digest: DIGEST_B,
    })
    assert.equal(overflow.ok, false)
    if (!overflow.ok) assert.equal(overflow.error, 'limit_exceeded')
    const dupAtCap = await createProjectAsset(USER, {
      source: 'upload',
      name: 'again',
      url: MEDIA_URL(DIGEST_A),
      digest: DIGEST_A,
    })
    assert.equal(dupAtCap.ok, true)
    assert.equal((await createProjectAsset(OTHER, {
      source: 'upload',
      name: '别人不受影响',
      url: MEDIA_URL(DIGEST_A),
      digest: DIGEST_A,
    })).ok, true)
  })

  it('pinned 查询:只返回所属项目(含 NULL 未分组)下 pinned 未删资产,最多 20', async () => {
    const proj = await createChatProject(USER, { name: 'P' })
    assert.equal(proj.ok, true)
    if (!proj.ok) return
    await upsertClientSession(baseSession('sess-in-p'))
    const { patchClientSessionMeta } = await import('../sessionsDb.js')
    await patchClientSessionMeta('sess-in-p', USER, { projectId: proj.project.id })
    await upsertClientSession(baseSession('sess-none'))

    const pinnedIn = await createProjectAsset(USER, {
      source: 'upload',
      name: 'pin-in',
      url: MEDIA_URL(DIGEST_A),
      projectId: proj.project.id,
    })
    const unpinned = await createProjectAsset(USER, {
      source: 'upload',
      name: 'no-pin',
      url: MEDIA_URL(DIGEST_B),
      projectId: proj.project.id,
    })
    const otherGroup = await createProjectAsset(USER, {
      source: 'output',
      name: 'ungroup-pin',
      containerPath: '/home/agent/.openclaude/generated/u.pdf',
    })
    assert.equal(pinnedIn.ok && unpinned.ok && otherGroup.ok, true)
    if (!pinnedIn.ok || !unpinned.ok || !otherGroup.ok) return
    await updateProjectAsset(USER, pinnedIn.asset.id, { pinned: true })
    await updateProjectAsset(USER, otherGroup.asset.id, { pinned: true })

    const forProj = await listPinnedProjectAssetsForSession('sess-in-p')
    assert.deepEqual(forProj.map((a) => a.name), ['pin-in'])
    const forNone = await listPinnedProjectAssetsForSession('sess-none')
    assert.deepEqual(forNone.map((a) => a.name), ['ungroup-pin'])
    assert.equal((await listPinnedProjectAssetsForSession('missing-session')).length, 0)

    await deleteProjectAsset(USER, pinnedIn.asset.id)
    assert.equal((await listPinnedProjectAssetsForSession('sess-in-p')).length, 0)
  })

  it('pin/unpin 立刻反映在 listPinnedProjectAssetsForChatProject 与 revision', async () => {
    const proj = await createChatProject(USER, { name: 'LivePins' })
    assert.equal(proj.ok, true)
    if (!proj.ok) return
    const created = await createProjectAsset(USER, {
      source: 'upload',
      name: 'live.md',
      url: MEDIA_URL(DIGEST_A),
      projectId: proj.project.id,
    })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const before = await listPinnedProjectAssetsForChatProject(USER, proj.project.id)
    assert.equal(before.assets.length, 0)
    await updateProjectAsset(USER, created.asset.id, { pinned: true })
    const pinned = await listPinnedProjectAssetsForChatProject(USER, proj.project.id)
    assert.equal(pinned.assets.length, 1)
    assert.equal(pinned.assets[0]?.name, 'live.md')
    assert.ok(pinned.revision >= pinned.assets[0]!.updatedAt)
    await updateProjectAsset(USER, created.asset.id, { pinned: false })
    const after = await listPinnedProjectAssetsForChatProject(USER, proj.project.id)
    assert.equal(after.assets.length, 0)
  })

  it('不存在的项目 id 拒绝;可改名/钉选/移动', async () => {
    const proj = await createChatProject(USER, { name: 'P' })
    assert.equal(proj.ok, true)
    if (!proj.ok) return
    const bad = await createProjectAsset(USER, {
      source: 'upload',
      name: 'x',
      url: MEDIA_URL(DIGEST_A),
      projectId: 'nope-nope-nope',
    })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.error, 'project_not_found')

    const created = await createProjectAsset(USER, {
      source: 'upload',
      name: 'old',
      url: MEDIA_URL(DIGEST_A),
    })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const renamed = await updateProjectAsset(USER, created.asset.id, {
      name: 'new',
      pinned: true,
      projectId: proj.project.id,
    })
    assert.equal(renamed.ok, true)
    if (!renamed.ok) return
    assert.equal(renamed.asset.name, 'new')
    assert.equal(renamed.asset.pinned, true)
    assert.equal(renamed.asset.projectId, proj.project.id)
  })
})

describe('searchProjectAssets (Cmd+K cross-project search)', () => {
  beforeEach(clearTables)

  const digest = (c: string) => c.repeat(64)

  it('searches name and excerpt across all projects and ungrouped, newest first', async () => {
    const p1 = await createChatProject(USER, { name: 'P1' })
    const p2 = await createChatProject(USER, { name: 'P2' })
    assert.ok(p1.ok && p2.ok)
    if (!p1.ok || !p2.ok) return
    const db = await getSessionsDb()
    const mk = async (name: string, d: string, projectId: string | null, extra: Record<string, unknown> = {}) => {
      const r = await createProjectAsset(USER, { source: 'upload', name, url: MEDIA_URL(digest(d)), projectId, ...extra })
      assert.equal(r.ok, true)
      return r.ok ? r.asset : null
    }
    const a = await mk('Weekly-Report.md', 'a', p1.project.id)
    const b = await mk('9月周报.xlsx', 'b', p2.project.id)
    const c = await mk('notes.txt', 'c', null, { excerpt: '这是本周 WEEKLY 汇总' })
    await mk('unrelated.pdf', 'd', null)
    // Deterministic ordering: a oldest, c newest.
    db.prepare('UPDATE project_assets SET created_at = ? WHERE id = ?').run(1000, a!.id)
    db.prepare('UPDATE project_assets SET created_at = ? WHERE id = ?').run(2000, b!.id)
    db.prepare('UPDATE project_assets SET created_at = ? WHERE id = ?').run(3000, c!.id)

    const weekly = await searchProjectAssets(USER, { q: 'weekly' })
    assert.deepEqual(weekly.map((x) => x.name), ['notes.txt', 'Weekly-Report.md'], 'case-insensitive, name or excerpt')
    assert.deepEqual((await searchProjectAssets(USER, { q: '周报' })).map((x) => x.projectId), [p2.project.id])
    assert.deepEqual(await searchProjectAssets(USER, { q: '   ' }), [])
    assert.equal((await searchProjectAssets(USER, { q: '.', limit: 2 })).length, 2)
    assert.equal((await searchProjectAssets(USER, { q: '.', limit: 999 })).length, 4)
  })

  it('is isolated per user and skips soft-deleted rows', async () => {
    const mine = await createProjectAsset(USER, { source: 'upload', name: 'secret-plan.md', url: MEDIA_URL(DIGEST_A) })
    const gone = await createProjectAsset(USER, { source: 'upload', name: 'secret-old.md', url: MEDIA_URL(DIGEST_B) })
    assert.ok(mine.ok && gone.ok)
    if (!gone.ok) return
    await deleteProjectAsset(USER, gone.asset.id)
    assert.deepEqual((await searchProjectAssets(USER, { q: 'secret' })).map((x) => x.name), ['secret-plan.md'])
    assert.deepEqual(await searchProjectAssets(OTHER, { q: 'secret' }), [])
  })

  it('escapes LIKE wildcards % _ and backslash', async () => {
    await createProjectAsset(USER, { source: 'upload', name: '100%_done.md', url: MEDIA_URL(DIGEST_A) })
    await createProjectAsset(USER, { source: 'upload', name: '100xxdone.md', url: MEDIA_URL(DIGEST_B) })
    await createProjectAsset(USER, { source: 'upload', name: 'a\\b.txt', url: MEDIA_URL('c'.repeat(64)) })
    assert.deepEqual((await searchProjectAssets(USER, { q: '%_' })).map((x) => x.name), ['100%_done.md'])
    assert.deepEqual((await searchProjectAssets(USER, { q: '0_d' })).map((x) => x.name), [])
    assert.deepEqual((await searchProjectAssets(USER, { q: '%' })).map((x) => x.name), ['100%_done.md'])
    assert.deepEqual((await searchProjectAssets(USER, { q: 'a\\b' })).map((x) => x.name), ['a\\b.txt'])
  })

  it('filters by source', async () => {
    await createProjectAsset(USER, { source: 'upload', name: 'report-in.md', url: MEDIA_URL(DIGEST_A) })
    await createProjectAsset(USER, {
      source: 'output',
      name: 'report-out.md',
      containerPath: '/home/agent/.openclaude/generated/report-out.md',
    })
    assert.deepEqual((await searchProjectAssets(USER, { q: 'report', source: 'output' })).map((x) => x.name), ['report-out.md'])
    assert.deepEqual((await searchProjectAssets(USER, { q: 'report', source: 'upload' })).map((x) => x.name), ['report-in.md'])
    assert.equal((await searchProjectAssets(USER, { q: 'report' })).length, 2)
  })
})

describe('project_assets 产出物版本', () => {
  beforeEach(clearTables)

  const REPORT = '/home/agent/.openclaude/generated/report.md'
  const output = (digest: string | null, extra: Record<string, unknown> = {}) => ({
    source: 'output',
    name: 'report.md',
    containerPath: REPORT,
    ...(digest ? { digest, url: MEDIA_URL(digest, 'md') } : {}),
    ...extra,
  })

  it('同源路径:同内容复用,内容变了出新版本,两版都可下载', async () => {
    const v1 = await createProjectAsset(USER, output(DIGEST_A))
    const again = await createProjectAsset(USER, output(DIGEST_A))
    const v2 = await createProjectAsset(USER, output(DIGEST_B))
    assert.equal(v1.ok && again.ok && v2.ok, true)
    if (!v1.ok || !again.ok || !v2.ok) return
    assert.equal(again.created, false)
    assert.equal(again.asset.id, v1.asset.id)
    assert.equal(v2.created, true)
    assert.notEqual(v2.asset.id, v1.asset.id)
    assert.ok(v2.asset.createdAt > v1.asset.createdAt, '新版本严格晚于旧版本')
    assert.equal(v2.asset.containerPath, REPORT)
    assert.equal(v2.asset.url, MEDIA_URL(DIGEST_B, 'md'))

    const listed = await listProjectAssets(USER, { projectId: null })
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.id, v2.asset.id)
    assert.equal(listed[0]?.versionCount, 2)

    const versions = await listProjectAssetVersions(USER, v1.asset.id)
    assert.deepEqual(versions?.map((a) => a.digest), [DIGEST_B, DIGEST_A])
    assert.deepEqual(versions?.map((a) => a.url), [MEDIA_URL(DIGEST_B, 'md'), MEDIA_URL(DIGEST_A, 'md')])
  })

  it('A→B→A 出第三个版本;用旧版本再登记一次 = 恢复为最新', async () => {
    const v1 = await createProjectAsset(USER, output(DIGEST_A))
    const v2 = await createProjectAsset(USER, output(DIGEST_B))
    const v3 = await createProjectAsset(USER, output(DIGEST_A))
    assert.equal(v1.ok && v2.ok && v3.ok, true)
    if (!v1.ok || !v2.ok || !v3.ok) return
    assert.equal(v3.created, true)
    assert.notEqual(v3.asset.id, v1.asset.id)
    const listed = await listProjectAssets(USER, { projectId: null })
    assert.equal(listed[0]?.id, v3.asset.id)
    assert.equal(listed[0]?.versionCount, 3)
    // 再登记一次最新的内容不再出版本。
    const same = await createProjectAsset(USER, output(DIGEST_A))
    assert.equal(same.ok && same.created, false)
  })

  it('旧容器只报路径:与以前一样按 container_path 复用', async () => {
    const legacy = await createProjectAsset(USER, output(null))
    const legacyAgain = await createProjectAsset(USER, output(null))
    assert.equal(legacy.ok && legacyAgain.ok, true)
    if (!legacy.ok || !legacyAgain.ok) return
    assert.equal(legacyAgain.asset.id, legacy.asset.id)
    assert.equal(legacy.asset.digest, null)
    // 之后的新容器带字节副本:无 digest 的旧行算 v1,新内容是 v2。
    const v2 = await createProjectAsset(USER, output(DIGEST_A))
    assert.equal(v2.ok && v2.created, true)
    // 旧容器再报一次同路径:仍复用,不出版本。
    const legacyLater = await createProjectAsset(USER, output(null))
    assert.equal(legacyLater.ok && legacyLater.created, false)
    const listed = await listProjectAssets(USER, { projectId: null })
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.versionCount, 2)
  })

  it('上传去重不变:同 digest 不同名仍复用;上传不按路径折叠', async () => {
    const a = await createProjectAsset(USER, { source: 'upload', name: 'a.md', url: MEDIA_URL(DIGEST_A, 'md') })
    const b = await createProjectAsset(USER, { source: 'upload', name: 'b.md', url: MEDIA_URL(DIGEST_A, 'md') })
    const c = await createProjectAsset(USER, { source: 'upload', name: 'c.md', url: MEDIA_URL(DIGEST_B, 'md') })
    assert.equal(a.ok && b.ok && c.ok, true)
    if (!a.ok || !b.ok || !c.ok) return
    assert.equal(b.asset.id, a.asset.id)
    const listed = await listProjectAssets(USER, { projectId: null })
    assert.equal(listed.length, 2)
    assert.ok(listed.every((x) => x.versionCount === undefined))
    // 产出与上传同 digest 互不复用。
    const out = await createProjectAsset(USER, output(DIGEST_A))
    assert.equal(out.ok && out.created, true)
  })

  it('版本按项目与租户隔离;删掉最新版后上一版成为列表里的那一条', async () => {
    const proj = await createChatProject(USER, { name: 'V' })
    assert.equal(proj.ok, true)
    if (!proj.ok) return
    const inProj = await createProjectAsset(USER, output(DIGEST_A, { projectId: proj.project.id }))
    const ungrouped = await createProjectAsset(USER, output(DIGEST_B))
    const other = await createProjectAsset(OTHER, output(DIGEST_B))
    assert.equal(inProj.ok && ungrouped.ok && other.ok, true)
    if (!inProj.ok || !ungrouped.ok || !other.ok) return
    assert.equal(inProj.created && ungrouped.created && other.created, true)
    assert.equal((await listProjectAssetVersions(USER, inProj.asset.id))?.length, 1)
    assert.equal(await listProjectAssetVersions(USER, other.asset.id), null)
    assert.equal(await listProjectAssetVersions(OTHER, inProj.asset.id), null)

    const v2 = await createProjectAsset(USER, output(DIGEST_B, { projectId: proj.project.id }))
    assert.equal(v2.ok && v2.created, true)
    if (!v2.ok) return
    await deleteProjectAsset(USER, v2.asset.id)
    const listed = await listProjectAssets(USER, { projectId: proj.project.id })
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.id, inProj.asset.id)
    assert.equal(listed[0]?.versionCount, undefined)
  })

  it('重放:旧登记(capturedAt 不晚于最新版本)返回已有旧版本,不出假版本', async () => {
    const v1 = await createProjectAsset(USER, output(DIGEST_A, { capturedAt: 1_000 }))
    const v2 = await createProjectAsset(USER, output(DIGEST_B, { capturedAt: Date.now() }))
    assert.equal(v1.ok && v2.ok && v2.created, true)
    if (!v1.ok || !v2.ok) return
    // A 的响应丢了,队列补发同一份登记。
    const replay = await createProjectAsset(USER, output(DIGEST_A, { capturedAt: 1_000 }))
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.created, false)
    assert.equal(replay.asset.id, v1.asset.id)
    const listed = await listProjectAssets(USER, { projectId: null })
    assert.equal(listed[0]?.id, v2.asset.id)
    assert.equal(listed[0]?.versionCount, 2)
  })

  it('真的写回旧内容(capturedAt 晚于最新版本)仍出新版本;不带 capturedAt 只比最新版本', async () => {
    const v1 = await createProjectAsset(USER, output(DIGEST_A, { capturedAt: 1_000 }))
    const v2 = await createProjectAsset(USER, output(DIGEST_B, { capturedAt: 2_000 }))
    assert.equal(v1.ok && v2.ok, true)
    if (!v1.ok || !v2.ok) return
    const rewrite = await createProjectAsset(USER, output(DIGEST_A, { capturedAt: v2.asset.createdAt + 5_000 }))
    assert.equal(rewrite.ok && rewrite.created, true)
    const v4 = await createProjectAsset(USER, output(DIGEST_B))
    assert.equal(v4.ok && v4.created, true, '旧容器/恢复:没有 capturedAt,只比最新版本')
    assert.equal((await listProjectAssets(USER, { projectId: null }))[0]?.versionCount, 4)
    const bad = await createProjectAsset(USER, output(DIGEST_A, { capturedAt: -1 }))
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.error, 'invalid_captured_at')
  })

  it('补发队列晚到的登记不会把之后真实写回的旧内容判成重放(版本按文件写成的时间记)', async () => {
    // A 写于 1000 并登记;B 写于 2000 但登记失败进了补发队列;3000 又真实写回 A。
    // 下一次归集先补发 B,再登记当前的 A:A 必须是新的最新版本。
    const a1 = await createProjectAsset(USER, output(DIGEST_A, { capturedAt: 1_000 }))
    const b = await createProjectAsset(USER, output(DIGEST_B, { capturedAt: 2_000 }))
    assert.equal(a1.ok && b.ok && b.created, true)
    if (!b.ok) return
    assert.equal(b.asset.createdAt, 2_000, '版本时间是文件写成的时间,不是登记时间')
    const a2 = await createProjectAsset(USER, output(DIGEST_A, { capturedAt: 3_000 }))
    assert.equal(a2.ok && a2.created, true)
    const listed = await listProjectAssets(USER, { projectId: null })
    assert.equal(listed[0]?.digest, DIGEST_A)
    assert.equal(listed[0]?.versionCount, 3)
    // capturedAt 在未来的被压到现在,不会排到真正更新的版本之后去。
    const future = await createProjectAsset(USER, output(DIGEST_B, { capturedAt: Date.now() + 86_400_000 }))
    assert.equal(future.ok && future.created, true)
    if (future.ok) assert.ok(future.asset.createdAt <= Date.now())
  })

  it('常用只挂在最新版本:新版本继承 pinned,旧版本取消;恢复同样继承', async () => {
    const proj = await createChatProject(USER, { name: 'Pins' })
    assert.equal(proj.ok, true)
    if (!proj.ok) return
    const pid = proj.project.id
    const v1 = await createProjectAsset(USER, output(DIGEST_A, { projectId: pid }))
    assert.equal(v1.ok, true)
    if (!v1.ok) return
    await updateProjectAsset(USER, v1.asset.id, { pinned: true })
    const v2 = await createProjectAsset(USER, output(DIGEST_B, { projectId: pid }))
    assert.equal(v2.ok, true)
    if (!v2.ok) return
    assert.equal(v2.asset.pinned, true)
    const versions = await listProjectAssetVersions(USER, v2.asset.id)
    assert.deepEqual(versions?.map((v) => v.pinned), [true, false])
    const pinned = await listPinnedProjectAssetsForChatProject(USER, pid)
    assert.deepEqual(pinned.assets.map((a) => a.id), [v2.asset.id])
    // 恢复 = 用旧 digest 再登记(不带 capturedAt):也继承常用。
    const restored = await createProjectAsset(USER, output(DIGEST_A, { projectId: pid }))
    assert.equal(restored.ok && restored.created && restored.asset.pinned, true)
    if (!restored.ok) return
    assert.deepEqual((await listPinnedProjectAssetsForChatProject(USER, pid)).assets.map((a) => a.id), [restored.asset.id])
  })

  it('旧数据里旧版本仍 pinned、最新版本未 pinned:注入查询不注入旧版本', async () => {
    const proj = await createChatProject(USER, { name: 'Stale' })
    assert.equal(proj.ok, true)
    if (!proj.ok) return
    const pid = proj.project.id
    await upsertClientSession(baseSession('sess-stale'))
    await patchClientSessionMeta('sess-stale', USER, { projectId: pid })
    const v1 = await createProjectAsset(USER, output(DIGEST_A, { projectId: pid }))
    const v2 = await createProjectAsset(USER, output(DIGEST_B, { projectId: pid }))
    const up = await createProjectAsset(USER, { source: 'upload', name: 'u.md', url: MEDIA_URL(DIGEST_A, 'md'), projectId: pid })
    assert.equal(v1.ok && v2.ok && up.ok, true)
    if (!v1.ok || !v2.ok || !up.ok) return
    const db = await getSessionsDb()
    db.prepare('UPDATE project_assets SET pinned = 1 WHERE id IN (?, ?)').run(v1.asset.id, up.asset.id)
    assert.deepEqual((await listPinnedProjectAssetsForChatProject(USER, pid)).assets.map((a) => a.id), [up.asset.id])
    assert.deepEqual((await listPinnedProjectAssetsForSession('sess-stale')).map((a) => a.id), [up.asset.id])
    await updateProjectAsset(USER, v2.asset.id, { pinned: true })
    const ids = (await listPinnedProjectAssetsForChatProject(USER, pid)).assets.map((a) => a.id).sort()
    assert.deepEqual(ids, [up.asset.id, v2.asset.id].sort())
  })
})
