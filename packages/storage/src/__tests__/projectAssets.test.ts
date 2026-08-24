/**
 * 聊天项目资产存储契约。
 *
 * 锁定:
 *   1. CRUD 按 user_id 隔离,他人读写 → not_found(不泄漏存在性);
 *   2. 软删只标 deleted_at,不删磁盘文件;
 *   3. 每项目(含未分组 NULL) 500 上限;
 *   4. 同 (user_id, project_id, source, digest) 未删行去重,digest 空则用 container_path;
 *   5. 恶意 url / containerPath 被拒。
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
  listProjectAssets,
  parseProjectAssetContainerPath,
  parseProjectAssetUrl,
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
