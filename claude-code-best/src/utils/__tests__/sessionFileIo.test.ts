import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, link, copyFile, stat, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendSessionFile, replaceSessionFile, readSessionFile, withSessionFile, flushSessionFileIo, type SessionFileScope } from '../sessionFileIo.js'

let dir: string
let projects: string
const sid = '60700000-0000-4000-8000-000000000001'
const scope = (): SessionFileScope => ({ projectsDir: projects, sessionId: sid, requireKernelLock: true })
const file = (): string => join(projects, 'cwd-a', `${sid}.jsonl`)
const digest = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'g607-session-io-')); projects = join(dir, 'projects'); await mkdir(projects, { mode: 0o700 }) })
afterEach(async () => { await flushSessionFileIo(); await rm(dir, { recursive: true, force: true }) })

test('inherited FD keeps the actual transcript inode locked after the acquire child exits', async () => {
  await appendSessionFile(file(), 'original\n', scope())
  const alias = join(projects, 'alias.jsonl')
  await link(file(), alias)
  await withSessionFile(file(), scope(), false, async () => {
    const probe = spawnSync('/usr/bin/flock', ['-n', alias, '/usr/bin/true'])
    expect(probe.status).toBe(1)
  })
  expect(spawnSync('/usr/bin/flock', ['-n', alias, '/usr/bin/true']).status).toBe(0)
})

test('rewrite and later append remain visible through every existing hard link', async () => {
  await appendSessionFile(file(), 'original\n', scope())
  const alias = join(projects, 'cwd-b', `${sid}.jsonl`)
  await mkdir(join(projects, 'cwd-b'), { mode: 0o700 })
  await link(file(), alias)
  const inode = (await stat(file())).ino
  const target = Buffer.from(`recovered\n${'X'.repeat(640 * 1024)}\n`)
  await replaceSessionFile(alias, target, scope())
  await appendSessionFile(alias, 'new-user-and-assistant\n', scope())
  expect((await readSessionFile(file(), scope())).equals(Buffer.concat([target, Buffer.from('new-user-and-assistant\n')]))).toBe(true)
  expect((await stat(file())).ino).toBe(inode)
  expect((await stat(alias)).ino).toBe(inode)
})

test('concurrent appends preserve admission order without partial JSONL rows', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => `${JSON.stringify({ i, text: `synthetic-${i}` })}\n`)
  await Promise.all(rows.map(row => appendSessionFile(file(), row, scope())))
  expect((await readSessionFile(file(), scope())).toString()).toBe(rows.join(''))
  expect((await readSessionFile(file(), scope())).toString().trim().split('\n').map(x => JSON.parse(x).i)).toEqual(rows.map((_, i) => i))
})

test('a different SID proceeds while the first SID transaction is held', async () => {
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>(r => { entered = r })
  const held = new Promise<void>(r => { release = r })
  const first = withSessionFile(file(), scope(), true, async () => { entered(); await held })
  await ready
  const otherScope = { ...scope(), sessionId: '60700000-0000-4000-8000-000000000002' }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      appendSessionFile(join(projects, 'cwd-a', `${otherScope.sessionId}.jsonl`), 'independent\n', otherScope),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DIFFERENT_SID_WAS_BLOCKED')), 1000) }),
    ])
  } finally { if (timer) clearTimeout(timer); release(); await first }
})

test('uncommitted in-place rewrite resumes from its durable target and preserves aliases', async () => {
  const original = Buffer.from('old-complete-transcript\n')
  const target = Buffer.from('new-complete-transcript\n')
  await appendSessionFile(file(), original.toString(), scope())
  const alias = join(projects, 'alias.jsonl'); await link(file(), alias)
  const inode = (await stat(file())).ino
  const scopes = await readdir(join(projects, '.oc-transcript-integrity'))
  expect(scopes.length).toBe(1)
  const tx = join(projects, '.oc-transcript-integrity', scopes[0]!)
  // Same on-disk durable intent as a process that died after ftruncate.
  const originalSha = digest(original); const targetSha = digest(target)
  await writeFile(join(tx, `source-${originalSha}.blob`), original, { mode: 0o600 })
  await writeFile(join(tx, `target-${targetSha}.blob`), target, { mode: 0o600 })
  const identity = await stat(file())
  await writeFile(join(tx, 'intent.json'), JSON.stringify({ schema: 1, dev: identity.dev, ino: identity.ino, offset: 0, sourceBytes: original.length, sourceSha256: originalSha, targetBytes: target.length, targetSha256: targetSha }), { mode: 0o600 })
  await writeFile(file(), target.subarray(0, 7))
  expect((await readSessionFile(alias, scope())).equals(target)).toBe(true)
  expect((await stat(file())).ino).toBe(inode)
  expect((await stat(alias)).ino).toBe(inode)
  expect((await readFile(join(tx, `source-${originalSha}.blob`))).equals(original)).toBe(true)
  expect((await readdir(tx)).includes('intent.json')).toBe(false)
})

test('a wrong target digest never overwrites a partial original or accepts partial context', async () => {
  const original = Buffer.from('original-intact\n'); await appendSessionFile(file(), original.toString(), scope())
  const scopes = await readdir(join(projects, '.oc-transcript-integrity')); const tx = join(projects, '.oc-transcript-integrity', scopes[0]!)
  const identity = await stat(file()); const originalSha = digest(original); const targetSha = digest(Buffer.from('expected'))
  await writeFile(join(tx, `source-${originalSha}.blob`), original, { mode: 0o600 })
  await writeFile(join(tx, `target-${targetSha}.blob`), 'tampered', { mode: 0o600 })
  await writeFile(join(tx, 'intent.json'), JSON.stringify({ schema: 1, dev: identity.dev, ino: identity.ino, offset: 0, sourceBytes: original.length, sourceSha256: originalSha, targetBytes: 8, targetSha256: targetSha }), { mode: 0o600 })
  await expect(readSessionFile(file(), scope())).rejects.toMatchObject({ code: 'CCB_TRANSCRIPT_STAGE_INVALID' })
  expect((await readFile(file())).equals(original)).toBe(true)
})

for (const mode of ['replace', 'append'] as const) {
for (const crashAt of ['before-truncate', 'after-truncate', 'during-write', 'after-data-sync', 'after-commit'] as const) {
  test(`a real ${mode} writer killed ${crashAt} releases its lock and both aliases recover the complete target`, async () => {
    const original = Buffer.from(`original\n${'O'.repeat(900000)}\n`)
    const tail = Buffer.from(`recovered\n${'T'.repeat(740000)}\n`)
    const target = mode === 'append' ? Buffer.concat([original, tail]) : tail
    await appendSessionFile(file(), original.toString(), scope())
    const alias = join(projects, 'cwd-b', `${sid}.jsonl`)
    await mkdir(join(projects, 'cwd-b'), { mode: 0o700 }); await link(file(), alias)
    const inode = (await stat(file())).ino
    const workerPath = join(dir, 'crash-worker.mjs')
    // Only the worker's filesystem boundary is instrumented. Production code
    // has no crash flag, signal handler, or alternate transaction algorithm.
    await writeFile(workerPath, `
import { mock } from 'bun:test';
import * as actual from 'node:fs/promises';
const [dataPath, projectsDir, sid, crashAt, core, mode] = process.argv.slice(2);
let fired = false;
const stop = async point => {
  if (point !== crashAt || fired) return;
  fired = true; process.stdout.write('CRASH_POINT:'+point+'\\n');
  await new Promise(() => {});
};
const originalOpen = actual.open, originalUnlink = actual.unlink;
mock.module('node:fs/promises', () => ({ ...actual,
  open: async (...args) => {
    const fh = await originalOpen(...args);
    if (args[0] !== dataPath) return fh;
    return new Proxy(fh, { get(obj, key) {
      if (key === 'truncate') return async (...xs) => { await stop('before-truncate'); const v=await obj.truncate(...xs); await stop('after-truncate'); return v; };
      if (key === 'write') return async (...xs) => { const v=await obj.write(...xs); await stop('during-write'); return v; };
      if (key === 'sync') return async (...xs) => { const v=await obj.sync(...xs); await stop('after-data-sync'); return v; };
      const value=Reflect.get(obj,key,obj); return typeof value==='function' ? value.bind(obj) : value;
    }});
  },
  unlink: async path => { const v=await originalUnlink(path); if (String(path).endsWith('/intent.json')) await stop('after-commit'); return v; },
}));
const { replaceSessionFile, appendSessionFile } = await import(core);
const target = Buffer.from('recovered\\n'+'T'.repeat(740000)+'\\n');
if (mode === 'append') await appendSessionFile(dataPath, target.toString(), { projectsDir, sessionId:sid, requireKernelLock:true });
else await replaceSessionFile(dataPath, target, { projectsDir, sessionId:sid, requireKernelLock:true });
throw new Error('CRASH_POINT_NOT_REACHED');
`, { mode: 0o600 })
    const { spawn } = await import('node:child_process')
    const worker = spawn(process.execPath, [workerPath, alias, projects, sid, crashAt, new URL('../../../../packages/storage/src/sessionFileIo.ts', import.meta.url).href, mode], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { worker.once('error', reject); worker.once('exit', (code, signal) => resolve({ code, signal })) })
    let output = ''; let errors = ''; let timer: ReturnType<typeof setTimeout> | undefined
    worker.stderr.on('data', b => { errors += b.toString() })
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CRASH_POINT_TIMEOUT')), 4000)
        worker.stdout.on('data', b => { output += b.toString(); if (output.includes(`CRASH_POINT:${crashAt}\n`)) resolve() })
        void exited.then(() => reject(new Error(`CRASH_WORKER_EXITED:${errors.slice(0, 200)}`)), reject)
      })
      expect(worker.pid).toBeGreaterThan(0)
      expect(worker.kill('SIGKILL')).toBe(true) // Only this exact owned child PID.
      expect((await exited).signal).toBe('SIGKILL')
      expect((await readSessionFile(file(), scope())).equals(target)).toBe(true)
      expect((await readSessionFile(alias, scope())).equals(target)).toBe(true)
      expect((await stat(file())).ino).toBe(inode)
      expect((await stat(alias)).ino).toBe(inode)
      const scopes = await readdir(join(projects, '.oc-transcript-integrity'))
      const tx = join(projects, '.oc-transcript-integrity', scopes[0]!)
      const backedUp = mode === 'append' ? Buffer.alloc(0) : original
      expect((await readFile(join(tx, `source-${digest(backedUp)}.blob`))).equals(backedUp)).toBe(true)
      expect((await readdir(tx)).includes('intent.json')).toBe(false)
    } finally {
      if (timer) clearTimeout(timer)
      if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await exited }
    }
  })
}

}


test('a different-inode alias can never silently replace the logical artifact authority', async () => {
  await appendSessionFile(file(), 'original-authority\n', scope())
  const alias = join(projects, 'cwd-fork', `${sid}.jsonl`)
  await mkdir(join(projects, 'cwd-fork'), { mode: 0o700 })
  await copyFile(file(), alias)
  await expect(readSessionFile(alias, scope())).rejects.toMatchObject({ code: 'CCB_TRANSCRIPT_ALIAS_DIVERGED' })
  expect((await readFile(file())).toString()).toBe('original-authority\n')
  expect((await readFile(alias)).toString()).toBe('original-authority\n')
})

test('committed staging stays bounded while preserving the first complete original backup', async () => {
  const original = Buffer.from('original-context-before-rewrite\n')
  await appendSessionFile(file(), original.toString(), scope())
  for (let n = 0; n < 4; n++) await replaceSessionFile(file(), Buffer.from(`new-context-${n}\n`), scope())
  const scopes = await readdir(join(projects, '.oc-transcript-integrity'))
  const tx = join(projects, '.oc-transcript-integrity', scopes[0]!)
  expect((await readdir(tx)).filter(name => /^source-.*\.blob$/.test(name)).length).toBeLessThanOrEqual(2)
  expect((await readFile(join(tx, `source-${digest(original)}.blob`))).equals(original)).toBe(true)
  expect((await readSessionFile(file(), scope())).toString()).toBe('new-context-3\n')
})

test('a recovery receipt verifies both byte owners and retains its source after subsequent appends', async () => {
  const original = Buffer.from('original-corrupt-byte-owner\n')
  const target = Buffer.from('complete-restored-byte-owner\n')
  await appendSessionFile(file(), original.toString(), scope())
  const receipt = { schema: 1 as const, sourceSha256: digest(original), targetSha256: digest(target), archiveSha256: digest(Buffer.from('synthetic-authority')),
    sourceBytes: original.length, targetBytes: target.length, verifiedReadCount: 2, fragmentCount: 4, fragmentManifestSha256: digest(Buffer.from('synthetic-partition')) }
  await withSessionFile(file(), scope(), false, async (_file, patch, recordReceipt) => { await patch(0, target); await recordReceipt(receipt) })
  for (let n = 0; n < 3; n++) await appendSessionFile(file(), `later-${n}\n`, scope())
  const scopes = await readdir(join(projects, '.oc-transcript-integrity'))
  const tx = join(projects, '.oc-transcript-integrity', scopes[0]!)
  expect(JSON.parse(await readFile(join(tx, 'restore-receipt.json'), 'utf8'))).toEqual(receipt)
  expect((await readFile(join(tx, `source-${receipt.sourceSha256}.blob`))).equals(original)).toBe(true)
  expect((await stat(join(tx, 'restore-receipt.json'))).mode & 0o777).toBe(0o600)
  await expect(withSessionFile(file(), scope(), false, async (_file, _patch, save) => { await save({ ...receipt, targetSha256: '0'.repeat(64) }) })).rejects.toMatchObject({ code: 'CCB_TRANSCRIPT_RECEIPT_INVALID' })
})

test('forgotten awaits cannot close the lease before a complete mutation or hide a mutation failure', async () => {
  await appendSessionFile(file(), 'old\n', scope())
  await withSessionFile(file(), scope(), false, async (_file, patch) => { void patch(0, Buffer.from('new-complete\n')) })
  expect((await readSessionFile(file(), scope())).toString()).toBe('new-complete\n')
  await expect(withSessionFile(file(), scope(), false, async (_file, patch) => { void patch(-1, Buffer.from('invalid')).catch(() => {}) })).rejects.toMatchObject({ code: 'CCB_TRANSCRIPT_PATCH_INVALID' })
  expect((await readSessionFile(file(), scope())).toString()).toBe('new-complete\n')
})

test('concurrent mutation capabilities fail the lease rather than interleave two WAL transactions', async () => {
  await appendSessionFile(file(), 'old\n', scope())
  await expect(withSessionFile(file(), scope(), false, async (_file, patch) => {
    const first = patch(0, Buffer.from('first-complete\n'))
    const second = patch(0, Buffer.from('second-must-not-write\n'))
    await Promise.allSettled([first, second])
  })).rejects.toMatchObject({ code: 'CCB_TRANSCRIPT_CONCURRENT_MUTATION' })
  expect((await readSessionFile(file(), scope())).toString()).toBe('first-complete\n')
})
