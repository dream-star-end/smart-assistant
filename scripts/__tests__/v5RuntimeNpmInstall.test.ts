import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// Test-only exact-parent injection; never consumed by the release library.
const lib = process.env.OCV5_NPM_PROOF_LIB ?? path.resolve(here, '../v5-runtime-release-lib.sh')
const npmLookup = spawnSync('which', ['npm'], { encoding: 'utf8' })
assert.equal(npmLookup.status, 0, npmLookup.stderr)
const npmCli = realpathSync(npmLookup.stdout.trim())
type Mode =
  | 'success'
  | 'reset-once'
  | 'reset-always'
  | 'invalid-lock'
  | 'script-failure'
  | 'lock-change'

async function install(mode: Mode) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-npm-test-'))
  const build = path.join(root, 'build')
  const bin = path.join(root, 'bin')
  const packageDir = path.join(root, 'package')
  const attemptsFile = path.join(root, 'attempts')
  for (const dir of [build, bin, packageDir]) mkdirSync(dir)
  writeFileSync(attemptsFile, '')
  const attempts = () =>
    readFileSync(attemptsFile, 'utf8').trim().split('\n').filter(Boolean).length
  writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'oc-runtime-npm-fixture',
      version: '1.0.0',
      main: 'index.js',
    }),
  )
  writeFileSync(
    path.join(packageDir, 'index.js'),
    'module.exports = { installed: "exact-locked-package" }\n',
  )
  writeFileSync(path.join(packageDir, 'payload.bin'), randomBytes(8192))
  const tarball = path.join(root, 'package.tgz')
  const packed = spawnSync('tar', ['-czf', tarball, '-C', root, 'package'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  const bytes = readFileSync(tarball)
  let requests = 0
  const server = createServer((req, res) => {
    if (req.url !== '/package.tgz') {
      res.writeHead(404).end('fixture has no other packages')
      return
    }
    requests++
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': bytes.length,
    })
    if (mode === 'reset-always' || (mode === 'reset-once' && attempts() === 1)) {
      // Headers and part of the real locked tarball have already arrived:
      // this is response-body ECONNRESET, not a synthetic npm exit code.
      res.write(bytes.subarray(0, 128))
      setTimeout(() => res.destroy(), 25)
    } else {
      res.end(bytes)
    }
  })
  let child: ReturnType<typeof spawn> | undefined
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    const registry = `http://127.0.0.1:${addr.port}`
    const pkg: Record<string, unknown> = {
      name: 'runtime-install-fixture',
      version: '1.0.0',
      dependencies: { 'oc-runtime-npm-fixture': '1.0.0' },
    }
    if (mode === 'script-failure') {
      pkg.scripts = { postinstall: 'node -e "process.exit(7)"' }
    } else if (mode === 'lock-change') {
      pkg.scripts = {
        postinstall: "node -e \"require('fs').appendFileSync('package-lock.json', ' ')\"",
      }
    }
    const lock =
      mode === 'invalid-lock'
        ? '{invalid-json'
        : `${JSON.stringify({
            name: pkg.name,
            version: pkg.version,
            lockfileVersion: 3,
            requires: true,
            packages: {
              '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
              'node_modules/oc-runtime-npm-fixture': {
                version: '1.0.0',
                resolved: `${registry}/package.tgz`,
                integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
              },
            },
          })}\n`
    writeFileSync(path.join(build, 'package.json'), JSON.stringify(pkg))
    writeFileSync(path.join(build, 'package-lock.json'), lock)
    writeFileSync(path.join(root, 'npm-global-config'), '')
    // Record invocations, but execute the installed real npm CLI, its real
    // fetch/extract/lifecycle code, and the actual generated container shell.
    const npmWrapper = `#!${process.execPath}\nconst fs = require("node:fs"), cp = require("node:child_process");\nfs.appendFileSync(${JSON.stringify(attemptsFile)}, "ci\\n");\nconst r = cp.spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(npmCli)}, ...process.argv.slice(2)], {stdio:"inherit",env:process.env});\nprocess.exit(r.status === null ? 1 : r.status);\n`
    writeFileSync(path.join(bin, 'npm'), npmWrapper, { mode: 0o755 })
    const docker = path.join(bin, 'docker-harness')
    const dockerHarness = `#!${process.execPath}\nconst assert=require("node:assert/strict"),cp=require("node:child_process");\nconst a=process.argv.slice(2);assert.deepEqual(a.slice(0,10),${JSON.stringify(
      [
        'run',
        '--rm',
        '--network=host',
        '--entrypoint',
        '/bin/sh',
        '--user',
        '0:0',
        '-v',
        `${build}:/build`,
        '-w',
      ],
    )});assert.equal(a[10],"/build");assert.equal(a[11],"sha256:npm-fixture");assert.equal(a[12],"-c");assert.equal(a.length,14);\nconst r=cp.spawnSync("/bin/sh",["-c",a[13]],{cwd:${JSON.stringify(build)},env:process.env,stdio:"inherit"});process.exit(r.status===null?1:r.status);\n`
    writeFileSync(docker, dockerHarness, { mode: 0o755 })
    const output: Buffer[] = []
    child = spawn(
      'bash',
      [
        '-c',
        'source "$1"; oc_hotcfg_install_deps_in_image "$2" sha256:npm-fixture',
        'npm-fixture',
        lib,
        build,
      ],
      {
        detached: true,
        env: {
          ...process.env,
          OC_DOCKER_BIN: docker,
          PATH: `${bin}:${process.env.PATH}`,
          npm_config_cache: path.join(root, 'npm-cache'),
          npm_config_userconfig: '/dev/null',
          npm_config_globalconfig: path.join(root, 'npm-global-config'),
          npm_config_registry: registry,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          http_proxy: '',
          https_proxy: '',
          all_proxy: '',
          NO_PROXY: '127.0.0.1,localhost',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk))
    const [status, signal] = await once(child, 'close')
    const text = Buffer.concat(output).toString('utf8')
    assert.equal(signal, null, text)
    const installed = spawnSync(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify(require("./node_modules/oc-runtime-npm-fixture")))',
      ],
      { cwd: build, encoding: 'utf8' },
    )
    return {
      status,
      output: text,
      attempts: attempts(),
      requests,
      lockUnchanged: readFileSync(path.join(build, 'package-lock.json'), 'utf8') === lock,
      installed: installed.status === 0 ? JSON.parse(installed.stdout) : null,
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already exited */
      }
    }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}

test('runtime npm: first success installs the exact locked package once', async () => {
  const r = await install('success')
  assert.equal(r.status, 0, r.output)
  assert.equal(r.attempts, 1)
  assert.equal(r.requests, 1)
  assert.equal(r.lockUnchanged, true)
  assert.deepEqual(r.installed, { installed: 'exact-locked-package' })
})

test('runtime npm: response reset retries once and really installs the locked package', async () => {
  const r = await install('reset-once')
  assert.equal(r.status, 0, r.output)
  assert.equal(r.attempts, 2)
  assert.match(r.output, /^npm error code ECONNRESET$/m)
  assert.match(r.output, /^npm error network aborted$/m)
  assert.equal(r.lockUnchanged, true)
  assert.deepEqual(r.installed, { installed: 'exact-locked-package' })
})

test('runtime npm: permanent response reset fails after exactly two attempts', async () => {
  const r = await install('reset-always')
  assert.notEqual(r.status, 0, r.output)
  assert.equal(r.attempts, 2)
  assert.equal(r.lockUnchanged, true)
  assert.equal(r.installed, null)
})

test('runtime npm: malformed lock is not a retryable network failure', async () => {
  const r = await install('invalid-lock')
  assert.notEqual(r.status, 0, r.output)
  assert.equal(r.attempts, 1)
  assert.equal(r.requests, 0)
  assert.equal(r.lockUnchanged, true)
  assert.equal(r.installed, null)
})

test('runtime npm: lifecycle failure is not retried or accepted', async () => {
  const r = await install('script-failure')
  assert.notEqual(r.status, 0, r.output)
  assert.equal(r.attempts, 1)
  assert.equal(r.lockUnchanged, true)
  assert.match(r.output, /npm error code 7/)
})

test('runtime npm: a successful lifecycle cannot silently rewrite the lock', async () => {
  const r = await install('lock-change')
  assert.notEqual(r.status, 0, r.output)
  assert.equal(r.attempts, 1)
  assert.equal(r.lockUnchanged, false)
  assert.match(r.output, /npm ci lock changed/)
})
