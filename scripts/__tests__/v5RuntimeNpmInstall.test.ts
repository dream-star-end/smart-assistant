import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
  | 'onnx-cuda-skip'

async function install(mode: Mode, opts?: { onnxCudaPolicy?: string }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-npm-test-'))
  const build = path.join(root, 'build')
  const bin = path.join(root, 'bin')
  const packageDir = path.join(root, 'package')
  const attemptsFile = path.join(root, 'attempts')
  for (const dir of [build, bin, packageDir]) mkdirSync(dir)
  writeFileSync(attemptsFile, '')
  const attempts = () =>
    readFileSync(attemptsFile, 'utf8').trim().split('\n').filter(Boolean).length
  const fixturePkg: Record<string, unknown> = {
    name: 'oc-runtime-npm-fixture',
    version: '1.0.0',
    main: 'index.js',
  }
  if (mode === 'onnx-cuda-skip') {
    // Mirror onnxruntime-node/script/install.js: unless skip is set, request the CUDA tarball.
    fixturePkg.scripts = { install: 'node ./install.js' }
    writeFileSync(
      path.join(packageDir, 'install.js'),
      [
        "const fs = require('node:fs');",
        "const http = require('node:http');",
        'const flag = process.env.ONNXRUNTIME_NODE_INSTALL_CUDA || process.env.npm_config_onnxruntime_node_install_cuda;',
        "if (flag === 'skip') {",
        "  fs.writeFileSync('install-cuda-skipped.marker', flag);",
        '  process.exit(0);',
        '}',
        'const base = process.env.npm_config_registry;',
        "http.get(base + '/onnxruntime-linux-x64-gpu-1.21.0.tgz', (res) => {",
        '  res.resume();',
        '  if (res.statusCode !== 200) {',
        "    console.error('Failed to download the binaries: ' + res.statusCode + ' Not Found.');",
        '    process.exit(1);',
        '  }',
        "}).on('error', (err) => { console.error(err); process.exit(1); });",
      ].join('\n'),
    )
  }
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(fixturePkg))
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
  let cudaAssetRequests = 0
  const server = createServer((req, res) => {
    if (req.url === '/onnxruntime-linux-x64-gpu-1.21.0.tgz') {
      cudaAssetRequests++
      res.writeHead(404).end('Not Found')
      return
    }
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
                ...(mode === 'onnx-cuda-skip' ? { hasInstallScript: true } : {}),
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
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) =>
                k !== 'OC_HOTCFG_ONNXRUNTIME_INSTALL_CUDA' &&
                k !== 'ONNXRUNTIME_NODE_INSTALL_CUDA' &&
                k !== 'npm_config_onnxruntime_node_install_cuda',
            ),
          ),
          ...(opts?.onnxCudaPolicy !== undefined
            ? { OC_HOTCFG_ONNXRUNTIME_INSTALL_CUDA: opts.onnxCudaPolicy }
            : {}),
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
      cudaAssetRequests,
      cudaSkipMarker: existsSync(
        path.join(build, 'node_modules/oc-runtime-npm-fixture/install-cuda-skipped.marker'),
      ),
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

test('runtime npm: selfhost opt-in skips onnxruntime CUDA download and proves install script ran', async () => {
  const r = await install('onnx-cuda-skip', { onnxCudaPolicy: 'skip' })
  assert.equal(r.status, 0, r.output)
  assert.equal(r.attempts, 1)
  assert.equal(r.requests, 1)
  assert.equal(r.cudaAssetRequests, 0)
  assert.equal(r.cudaSkipMarker, true)
  assert.equal(r.lockUnchanged, true)
  assert.deepEqual(r.installed, { installed: 'exact-locked-package' })
})

test('runtime npm: callers without selfhost opt-in preserve default CUDA install attempt', async () => {
  const r = await install('onnx-cuda-skip')
  assert.notEqual(r.status, 0, r.output)
  assert.equal(r.attempts, 1)
  assert.equal(r.requests, 1)
  assert.equal(r.cudaAssetRequests, 1)
  assert.equal(r.cudaSkipMarker, false)
  assert.equal(r.lockUnchanged, true)
  assert.match(r.output, /Failed to download the binaries: 404 Not Found\./)
})

test('runtime npm: deps cache key isolates selfhost skip policy while keeping default key unchanged', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-cache-key-'))
  try {
    writeFileSync(path.join(root, 'package-lock.json'), '{"name":"x","lockfileVersion":3}\n')
    const runKey = (extraEnv: NodeJS.ProcessEnv) =>
      spawnSync(
        'bash',
        ['-c', 'source "$1"; oc_hotcfg_deps_cache_key "$2" sha256:img-1', 'key', lib, root],
        {
          encoding: 'utf8',
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([k]) => k !== 'OC_HOTCFG_ONNXRUNTIME_INSTALL_CUDA',
              ),
            ),
            ...extraEnv,
          },
        },
      )
    const defUnset = runKey({})
    const defEmpty = runKey({ OC_HOTCFG_ONNXRUNTIME_INSTALL_CUDA: '' })
    const selfhostSkip = runKey({ OC_HOTCFG_ONNXRUNTIME_INSTALL_CUDA: 'skip' })
    const invalid = runKey({ OC_HOTCFG_ONNXRUNTIME_INSTALL_CUDA: 'bogus' })
    assert.equal(defUnset.status, 0, defUnset.stderr)
    assert.equal(defEmpty.status, 0, defEmpty.stderr)
    assert.equal(selfhostSkip.status, 0, selfhostSkip.stderr)
    assert.match(defUnset.stdout.trim(), /^[0-9a-f]{64}$/)
    assert.equal(defUnset.stdout.trim(), defEmpty.stdout.trim())
    assert.match(selfhostSkip.stdout.trim(), /^[0-9a-f]{64}$/)
    assert.notEqual(selfhostSkip.stdout.trim(), defUnset.stdout.trim())
    assert.notEqual(invalid.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
