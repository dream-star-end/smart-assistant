/**
 * 产出物路径扫描:只收 generated 绝对路径,拒绝 .. 与越界。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/projectAssetCollector.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { extractGeneratedOutputPaths, resolveUploadExcerptPath } = await import('../projectAssetCollector.js')

describe('extractGeneratedOutputPaths', () => {
  it('从助手正文抽出 generated 路径,最多 5 条且去重', () => {
    const text = [
      '完成了',
      '/home/agent/.openclaude/generated/a.pdf',
      '以及 `/home/agent/.openclaude/generated/b.docx`',
      '/home/agent/.openclaude/generated/a.pdf',
      '/home/agent/.openclaude/generated/c.png',
      '/home/agent/.openclaude/generated/d.txt',
      '/home/agent/.openclaude/generated/e.csv',
      '/home/agent/.openclaude/generated/f.json',
    ].join('\n')
    assert.deepEqual(extractGeneratedOutputPaths(text), [
      '/home/agent/.openclaude/generated/a.pdf',
      '/home/agent/.openclaude/generated/b.docx',
      '/home/agent/.openclaude/generated/c.png',
      '/home/agent/.openclaude/generated/d.txt',
      '/home/agent/.openclaude/generated/e.csv',
    ])
  })

  it('拒绝 .. 与非 generated 路径', () => {
    const text = [
      '/home/agent/.openclaude/generated/../uploads/x.pdf',
      '/home/agent/.openclaude/uploads/ab.pdf',
      '/root/.openclaude/generated/x.pdf',
      '/etc/passwd',
      '/home/agent/.openclaude/generated/ok.pdf.',
    ].join('\n')
    assert.deepEqual(extractGeneratedOutputPaths(text), [
      '/home/agent/.openclaude/generated/ok.pdf',
    ])
  })
})

describe('resolveUploadExcerptPath', () => {
  it('url 映射到 uploads 内容寻址路径', () => {
    const digest = 'a'.repeat(64)
    assert.equal(
      resolveUploadExcerptPath(`/api/media/${digest}.pdf`, null),
      `/home/agent/.openclaude/uploads/${digest}.pdf`,
    )
    assert.equal(resolveUploadExcerptPath('/api/media/nope.pdf', null), null)
  })
})

import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  promoteSessionWorkspaceOutputs,
  sessionWorkspaceContainerDir,
} = await import('../projectAssetCollector.js')

describe('sessionWorkspaceContainerDir', () => {
  it('accepts webchat session ids', () => {
    assert.equal(
      sessionWorkspaceContainerDir('webmvosf7p0p5zx6p'),
      '/home/agent/.openclaude/workspace/sessions/webmvosf7p0p5zx6p',
    )
  })
  it('rejects path-like ids', () => {
    assert.equal(sessionWorkspaceContainerDir('../etc'), null)
    assert.equal(sessionWorkspaceContainerDir('a/b'), null)
    assert.equal(sessionWorkspaceContainerDir('short'), null)
  })
})

describe('promoteSessionWorkspaceOutputs', () => {
  it('copies top-level workspace files into generated/session-ws/<id>/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-ws-out-'))
    const generated = join(root, 'generated')
    const workspaceSessions = join(root, 'sessions')
    const sid = 'webmvosf7p0p5zx6p'
    await mkdir(join(workspaceSessions, sid), { recursive: true })
    await mkdir(generated, { recursive: true })
    await writeFile(join(workspaceSessions, sid, 'hello.txt'), 'hello regress 1026')
    await writeFile(join(workspaceSessions, sid, '.hidden'), 'nope')
    await mkdir(join(workspaceSessions, sid, 'subdir'))
    await writeFile(join(workspaceSessions, sid, 'subdir', 'nested.txt'), 'skip')
    await symlink(join(workspaceSessions, sid, 'hello.txt'), join(workspaceSessions, sid, 'link.txt'))

    const paths = await promoteSessionWorkspaceOutputs(sid, { generated, cas: join(root, 'cas'), workspaceSessions })
    assert.deepEqual(paths, [
      `/home/agent/.openclaude/generated/session-ws/${sid}/hello.txt`,
    ])
    const promoted = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(generated, 'session-ws', sid, 'hello.txt'), 'utf8'),
    )
    assert.equal(promoted, 'hello regress 1026')
    await rm(root, { recursive: true, force: true })
  })


  it('does not follow dest symlink when refreshing promoted copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'promote-symlink-'))
    const sid = 'webmvosf7p0p5zx6p'
    const generated = join(root, 'generated')
    const workspaceSessions = join(root, 'sessions')
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'SECRET-OUTSIDE')
    await mkdir(join(workspaceSessions, sid), { recursive: true })
    await mkdir(join(generated, 'session-ws', sid), { recursive: true })
    await writeFile(join(workspaceSessions, sid, 'report.txt'), 'workspace-report')
    await symlink(outside, join(generated, 'session-ws', sid, 'report.txt'))

    const paths = await promoteSessionWorkspaceOutputs(sid, {
      generated,
      cas: join(root, 'cas'),
      workspaceSessions,
    })
    assert.deepEqual(paths, [`/home/agent/.openclaude/generated/session-ws/${sid}/report.txt`])
    assert.equal(await readFile(outside, 'utf8'), 'SECRET-OUTSIDE')
    const destSt = await lstat(join(generated, 'session-ws', sid, 'report.txt'))
    assert.equal(destSt.isSymbolicLink(), false)
    assert.equal(await readFile(join(generated, 'session-ws', sid, 'report.txt'), 'utf8'), 'workspace-report')
    await rm(root, { recursive: true, force: true })
  })

  it('prefers not-yet-promoted files so later turns can register new outputs under the cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'promote-cap-'))
    const sid = 'webmvosf7p0p5zx6p'
    const generated = join(root, 'generated')
    const workspaceSessions = join(root, 'sessions')
    await mkdir(join(workspaceSessions, sid), { recursive: true })
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      await writeFile(join(workspaceSessions, sid, name), name)
    }
    const roots = { generated, cas: join(root, 'cas'), workspaceSessions }
    const first = await promoteSessionWorkspaceOutputs(sid, roots, { max: 5 })
    assert.equal(first.length, 5)
    await writeFile(join(workspaceSessions, sid, 'f.txt'), 'f-new')
    const second = await promoteSessionWorkspaceOutputs(sid, roots, { max: 5 })
    assert.ok(second.includes(`/home/agent/.openclaude/generated/session-ws/${sid}/f.txt`))
    assert.equal(await readFile(join(generated, 'session-ws', sid, 'f.txt'), 'utf8'), 'f-new')
    await rm(root, { recursive: true, force: true })
  })

  it('returns [] when session cwd missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-ws-miss-'))
    const paths = await promoteSessionWorkspaceOutputs('webmissing0000001', {
      generated: join(root, 'generated'),
      cas: join(root, 'cas'),
      workspaceSessions: join(root, 'sessions'),
    })
    assert.deepEqual(paths, [])
    await rm(root, { recursive: true, force: true })
  })
})
