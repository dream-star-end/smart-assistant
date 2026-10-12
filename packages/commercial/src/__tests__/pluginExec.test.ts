/**
 * plugin-exec（OCV5-383）：本机插件命令的平台启动器。
 *
 * 用真实脚本 + 临时插件目录 + 本地假 master（/v3/plugins/state）跑：启用 → 执行插件入口；
 * 停用 → 退出码 3 + 中文提示；master 不可达 → 照常执行（开关是偏好不是安全边界）；
 * --help 不查网络；entry 越界 / 解释器不在白名单 / 名字不符 → 退出码 2，不执行任何东西。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/pluginExec.test.ts
 */
import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const EXEC = resolve(here, '../../agent-sandbox/platform-runtime/bin/plugin-exec.py')
const REAL_SKILLS = resolve(here, '../../agent-sandbox/ccb-baseline/skills')

type Run = { code: number | null; stdout: string; stderr: string }

function run(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done, reject) => {
    const child = spawn('python3', ['-I', EXEC, ...args], { env: { PATH: process.env.PATH, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += String(c)))
    child.stderr.on('data', (c) => (stderr += String(c)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

function plugin(root: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(root, String(manifest.name))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
}

const demoManifest = (over: Record<string, unknown> = {}) => ({
  schema: 'openclaude-plugin/1',
  name: 'demo',
  displayName: '演示插件',
  components: { bin: [{ name: 'demo', entry: 'scripts/demo.py', interpreter: 'python3' }] },
  ...over,
})
const DEMO_PY = 'import sys, json\nprint(json.dumps({"argv": sys.argv[1:]}))\n'

describe('plugin-exec', () => {
  let tmp: string
  let skills: string
  let server: Server
  let base: string
  let enabled = true
  const hits: { auth?: string; body: string }[] = []

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'plugin-exec-'))
    skills = join(tmp, 'skills')
    plugin(skills, demoManifest(), { 'scripts/demo.py': DEMO_PY })
    plugin(skills, demoManifest({ name: 'escape', components: { bin: [{ name: 'escape', entry: 'scripts/../../x.py', interpreter: 'python3' }] } }))
    plugin(skills, demoManifest({ name: 'bash', components: { bin: [{ name: 'bash', entry: 'scripts/x.sh', interpreter: 'bash' }] } }), { 'scripts/x.sh': 'echo hi' })
    // 目录叫 mismatch，清单里却写 demo：启动器按目录找插件，名字对不上必须拒绝。
    mkdirSync(join(skills, 'mismatch', 'scripts'), { recursive: true })
    writeFileSync(join(skills, 'mismatch', 'plugin.json'), JSON.stringify(demoManifest()))
    writeFileSync(join(skills, 'mismatch', 'scripts', 'demo.py'), DEMO_PY)
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += String(c)))
      req.on('end', () => {
        hits.push({ auth: req.headers.authorization, body })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ kind: 'state', slug: JSON.parse(body).slug, enabled }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    server.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const env = (home: string, over: NodeJS.ProcessEnv = {}) => ({
    OC_PLUGIN_SKILLS_ROOT: skills,
    HOME: home,
    OPENCLAUDE_V3_MASTER_BASE_URL: base,
    OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
    ...over,
  })
  const freshHome = () => mkdtempSync(join(tmp, 'home-'))

  it('启用：带容器身份问 master，然后执行插件入口并原样传参', async () => {
    enabled = true
    hits.length = 0
    const r = await run(['demo', 'demo', 'quote', '600519', '--ui'], env(freshHome()))
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { argv: ['quote', '600519', '--ui'] })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].auth, 'Bearer container-token')
    assert.deepEqual(JSON.parse(hits[0].body), { slug: 'demo' })
  })

  it('停用：退出码 3，stderr 一行中文提示去哪里打开，不执行插件', async () => {
    enabled = false
    const r = await run(['demo', 'demo', 'quote'], env(freshHome()))
    assert.equal(r.code, 3)
    assert.equal(r.stdout, '')
    assert.match(JSON.parse(r.stderr.trim()).error, /插件「演示插件」已停用，请在 管理中心 → 插件 里打开/)
    enabled = true
  })

  it('状态缓存 15 秒：同一 HOME 连续调用只问一次 master', async () => {
    enabled = true
    hits.length = 0
    const home = freshHome()
    assert.equal((await run(['demo', 'demo'], env(home))).code, 0)
    assert.equal((await run(['demo', 'demo'], env(home))).code, 0)
    assert.equal(hits.length, 1)
  })

  it('master 不可达 / 没有容器身份：按启用处理，照常执行', async () => {
    const down = await run(['demo', 'demo', 'x'], env(freshHome(), { OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:9' }))
    assert.equal(down.code, 0, down.stderr)
    const noIdentity = await run(['demo', 'demo', 'x'], {
      OC_PLUGIN_SKILLS_ROOT: skills,
      HOME: freshHome(),
    })
    assert.equal(noIdentity.code, 0, noIdentity.stderr)
  })

  it('--help 不查网络', async () => {
    enabled = false
    hits.length = 0
    const r = await run(['demo', 'demo', '--help'], env(freshHome()))
    assert.equal(r.code, 0)
    assert.equal(hits.length, 0)
    enabled = true
  })

  it('entry 越界、解释器不在白名单、清单名字不符、命令未声明：退出码 2，不执行', async () => {
    for (const [p, b, re] of [
      ['escape', 'escape', /声明不合法/],
      ['bash', 'bash', /声明不合法/],
      ['mismatch', 'demo', /名字不符/],
      ['demo', 'other', /没有声明命令 other/],
      ['../etc', 'x', /非法的插件或命令名/],
    ] as const) {
      const r = await run([p, b], env(freshHome()))
      assert.equal(r.code, 2, `${p}/${b}: ${r.stderr}`)
      assert.match(r.stderr, re)
      assert.equal(r.stdout, '')
    }
  })

  it('真实的同花顺插件：--help 经启动器跑到 ths.py（不联网）', async () => {
    const r = await run(['ths', 'ths', '--help'], { OC_PLUGIN_SKILLS_ROOT: REAL_SKILLS, HOME: freshHome() })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /同花顺 CLI/)
    assert.match(r.stdout, /--ui/)
  })
})
