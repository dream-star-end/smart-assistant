import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolatedBoxArgs } from './fixtures/isolatedBoxArgs.js'
test('fixture Python directory-fd walks and absolute paths address the same isolated inode', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-isolated-box-'))
  const home = join(root, 'box-config'); mkdirSync(home)
  const program = `import os\nfd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)\nfor name in ('home','box','.claude'):\n nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY,dir_fd=fd);os.close(fd);fd=nxt\nos.mkdir('projects',0o700,dir_fd=fd)\nos.close(fd)\nassert os.path.isdir('/home/box/.claude/projects')\n`
  const result = spawnSync('/usr/bin/python3', isolatedBoxArgs(['-I', '-c', program], home), { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(existsSync(join(home, 'projects')), true)
})
test('only guarded executable bytes are rewritten; hashed system/transcript payload is byte-identical', () => {
  const root = join(tmpdir(), 'synthetic-proof-config')
  const nested = "assert project.startswith('/home/box/.claude/projects/')"
  const payload = Buffer.from('system /home/box/.claude stays exact').toString('base64')
  const args = ['-I', '-c', "nonce,want,encoded,*argv=sys.argv[1:]\nfor name in ('home','box','.claude','projects'): pass", 'nonce', 'hash', Buffer.from(nested).toString('base64'), '/tmp/ocv5-289-run-nonce', '/home/box/.claude/projects/-tmp-run', payload]
  const mapped = isolatedBoxArgs(args, root)
  assert.equal(mapped[8], payload)
  assert.equal(Buffer.from(mapped[5] ?? '', 'base64').toString(), `assert project.startswith('${root}/projects/')`)
  assert.equal(mapped[7], `${root}/projects/-tmp-run`)
  assert.equal(mapped[2]?.includes("'home','box'"), false)
})

test('a real batch envelope recursively rewrites guarded programs without touching nested payloads', () => {
  const program = "nonce,want,encoded,*argv=sys.argv[1:]"
  const payload = Buffer.from('hashed transcript /home/box/.claude').toString('base64')
  const step = ['-I', '-c', program, 'nonce', 'hash', Buffer.from("project='/home/box/.claude/projects' ").toString('base64'), '/home/box/.claude/projects/-tmp-run', payload]
  const envelope = ['-I', '-c', "steps=json.loads(raw)\nsubprocess.run(['/usr/bin/python3',*argv])", Buffer.from(JSON.stringify([step, step])).toString('base64')]
  const mapped = isolatedBoxArgs(envelope, '/tmp/synthetic-config')
  const steps = JSON.parse(Buffer.from(mapped[3] ?? '', 'base64').toString()) as string[][]
  assert.equal(steps[0]?.[6], '/tmp/synthetic-config/projects/-tmp-run')
  assert.equal(steps[0]?.[7], payload)
  assert.equal(Buffer.from(steps[0]?.[5] ?? '', 'base64').toString().includes('/home/box/.claude'), false)
})
