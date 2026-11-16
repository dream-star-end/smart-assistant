/**
 * Candidate-bound, Master-staging-safe end-to-end incident proof for
 * `INC-20261117-CC5-BASH-TIMEOUT-PS-ENOENT` (`OCV5-777`).
 *
 * Why this builds inside an isolated `os.tmpdir()` workspace:
 * - `deploy-v5-selfhost.sh` runs `scripts/check-v5-master-incident-proofs.ts` inside a read-only
 *   `git archive` Master `$staging` directory where `claude-code-best/dist/cli-node.js` is not
 *   yet built and `$staging` inodes must remain untouched for `snapshot_tree()` digest integrity.
 * - Building the candidate's own `claude-code-best` + `Cc5ToolHost` in an isolated `tmpdir()`
 *   sandbox proves the candidate's real `ShellCommand.ts` -> `killProcessTree.ts` -> `BashTool`
 *   -> `Cc5ToolHost` end-to-end timeout chain without mutating `$staging`:
 *   reverting `ShellCommand.ts` to pre-fix `tree-kill` fails this gate (`CC5_TOOLHOST_EXECUTION_UNKNOWN`).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Cc5ToolHost as Cc5ToolHostType } from '../cc5ToolHost.js'
import { cc5ToolHostChildEnv } from '../cc5ToolHost.js'

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const NATIVE_SESSION = 'd71e4679-e7df-482a-a129-a998a8f51f7e'

function resolveBunBinary(): string {
  const candidates = [
    process.env.OC_BUN_BIN,
    process.env.BUN_BIN,
    ...(process.env.PATH ?? '')
      .split(':')
      .filter(Boolean)
      .map((dir) => join(dir, 'bun')),
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    join(homedir(), '.local/bin/bun'),
    join(homedir(), '.bun/bin/bun'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error('bun binary required to build candidate claude-code-best toolhost bundle')
}

async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test(
  'candidate Cc5ToolHost + ShellCommand Bash timeout without ps in PATH returns timed-out tool result, reaps setsid descendants, keeps host alive, and defaults to 600000ms (INC-20261117-CC5-BASH-TIMEOUT-PS-ENOENT)',
  { timeout: 210_000 },
  async () => {
    // 1. Unit-verify `cc5ToolHostChildEnv` contract (default 600000ms, override, NODE_OPTIONS strip).
    const defaultEnv = cc5ToolHostChildEnv({
      HOME: '/tmp/cc5-proof-home',
      NODE_OPTIONS: '--inspect=9229',
    })
    assert.equal(defaultEnv.BASH_DEFAULT_TIMEOUT_MS, '600000')
    assert.equal(defaultEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
    assert.equal(defaultEnv.NODE_OPTIONS, undefined)
    assert.equal(
      cc5ToolHostChildEnv({ BASH_DEFAULT_TIMEOUT_MS: '45000' }).BASH_DEFAULT_TIMEOUT_MS,
      '45000',
    )

    // 2. Stage an isolated copy of the candidate's `claude-code-best`, `scripts/agent-remote`,
    //    and `packages/gateway/src/cc5ToolHost.ts` in `tmpdir()` so Master `$staging` stays 100% read-only.
    const bunBin = resolveBunBinary()
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'cc5-candidate-proof-')))
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc5-no-ps-runtime-')))
    let host: Cc5ToolHostType | undefined
    try {
      const repoScripts = join(REPO_ROOT, 'scripts')
      const sandboxScripts = join(sandbox, 'scripts')
      mkdirSync(join(sandboxScripts, 'agent-remote'), { recursive: true })
      for (const entry of readdirSync(repoScripts)) {
        if (entry !== 'agent-remote') {
          symlinkSync(join(repoScripts, entry), join(sandboxScripts, entry))
        }
      }
      for (const entry of readdirSync(join(repoScripts, 'agent-remote'))) {
        const from = join(repoScripts, 'agent-remote', entry)
        const to = join(sandboxScripts, 'agent-remote', entry)
        if (entry === 'cc5-toolhost-supervisor.py') {
          cpSync(from, to)
        } else {
          symlinkSync(from, to)
        }
      }

      const sandboxPackages = join(sandbox, 'packages')
      mkdirSync(sandboxPackages, { recursive: true })
      for (const pkg of readdirSync(join(REPO_ROOT, 'packages'))) {
        if (pkg !== 'gateway') {
          symlinkSync(join(REPO_ROOT, 'packages', pkg), join(sandboxPackages, pkg))
        }
      }

      const gatewayDir = join(REPO_ROOT, 'packages/gateway')
      const sandboxGateway = join(sandboxPackages, 'gateway')
      const gatewaySrcDir = join(gatewayDir, 'src')
      const sandboxGatewaySrc = join(sandboxGateway, 'src')
      mkdirSync(sandboxGatewaySrc, { recursive: true })
      for (const entry of readdirSync(gatewayDir)) {
        if (entry !== 'src') {
          symlinkSync(join(gatewayDir, entry), join(sandboxGateway, entry))
        }
      }
      for (const entry of readdirSync(gatewaySrcDir)) {
        const from = join(gatewaySrcDir, entry)
        const to = join(sandboxGatewaySrc, entry)
        if (entry === 'cc5ToolHost.ts') {
          cpSync(from, to)
        } else {
          symlinkSync(from, to)
        }
      }
      if (existsSync(join(REPO_ROOT, 'node_modules'))) {
        symlinkSync(join(REPO_ROOT, 'node_modules'), join(sandbox, 'node_modules'))
      }

      const ccbSrc = join(REPO_ROOT, 'claude-code-best')
      const ccbDst = join(sandbox, 'claude-code-best')
      cpSync(ccbSrc, ccbDst, {
        recursive: true,
        filter: (src) => {
          const name = basename(src)
          if (src === join(ccbSrc, 'dist') || src === join(ccbSrc, 'node_modules')) {
            return false
          }
          return name !== '.git'
        },
      })

      const bunEnv: NodeJS.ProcessEnv = existsSync(join(homedir(), '.bun'))
        ? process.env
        : { ...process.env, HOME: sandbox, BUN_INSTALL_CACHE_DIR: join(sandbox, '.bun-cache') }
      const existingCcbModules = join(ccbSrc, 'node_modules')
      if (existsSync(existingCcbModules)) {
        symlinkSync(existingCcbModules, join(ccbDst, 'node_modules'))
      } else {
        const install = spawnSync(bunBin, ['install', '--frozen-lockfile', '--ignore-scripts'], {
          cwd: ccbDst,
          env: bunEnv,
          encoding: 'utf8',
          timeout: 120_000,
        })
        assert.equal(
          install.status,
          0,
          `bun install failed (${install.status}): ${install.stderr || install.stdout}`,
        )
      }

      const build = spawnSync(bunBin, ['run', 'build'], {
        cwd: ccbDst,
        env: bunEnv,
        encoding: 'utf8',
        timeout: 120_000,
      })
      assert.equal(
        build.status,
        0,
        `bun run build failed (${build.status}): ${build.stderr || build.stdout}`,
      )
      assert.equal(existsSync(join(ccbDst, 'dist/cli-node.js')), true)

      const { Cc5ToolHost } = (await import(
        new URL(`file://${join(sandboxGatewaySrc, 'cc5ToolHost.ts')}`).href
      )) as { Cc5ToolHost: typeof Cc5ToolHostType }

      // 3. Run real candidate `Cc5ToolHost` with `PATH` strictly omitting `ps` (matching `oc-v5-u*`).
      const cwd = join(root, 'cwd')
      const home = join(root, 'home')
      const noPsBin = join(root, 'bin')
      mkdirSync(cwd)
      mkdirSync(home)
      mkdirSync(noPsBin)

      for (const cmd of ['bash', 'sh', 'sleep', 'python3', 'env']) {
        for (const dir of ['/usr/local/bin', '/usr/bin', '/bin']) {
          const candidate = join(dir, cmd)
          if (existsSync(candidate)) {
            symlinkSync(candidate, join(noPsBin, cmd))
            break
          }
        }
      }
      assert.equal(existsSync(join(noPsBin, 'ps')), false, 'test PATH must not contain ps')

      host = new Cc5ToolHost(
        root,
        randomUUID(),
        { cwd, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
        undefined,
        {
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          PATH: noPsBin,
          LANG: 'C.UTF-8',
          CI: 'true',
        },
      )

      const tools = await within(host.tools(), 60_000, 'tools/list')
      const bashSpec = tools.find((tool) => tool.name === 'Bash')
      assert.ok(bashSpec, 'Bash tool must be exposed by Cc5ToolHost')
      assert.match(
        bashSpec.description,
        /600000ms|10 minutes/,
        `Bash tool default timeout description should reflect 600000ms, got: ${bashSpec.description.slice(0, 300)}`,
      )

      const grandchildPidFile = join(cwd, 'setsid-grandchild.pid')
      const pyScript = [
        'import os, time',
        'os.setsid()',
        `open(${JSON.stringify(grandchildPidFile)}, 'w').write(str(os.getpid()))`,
        'time.sleep(30)',
      ].join('; ')

      const timedOut = await within(
        host.execute(
          'Bash',
          {
            command: `echo BEFORE_TIMEOUT_OK && python3 -c ${JSON.stringify(pyScript)} & sleep 10`,
            timeout: 1200,
          },
          {
            nativeSessionId: NATIVE_SESSION,
            turnKey: 'turn-one',
            toolUseId: 'toolu_timeout_no_ps',
          },
        ),
        20_000,
        'Bash timeout without ps',
      )

      const outText = JSON.stringify(timedOut.content)
      assert.match(outText, /Command timed out after/, `expected timeout message, got: ${outText}`)
      assert.match(outText, /BEFORE_TIMEOUT_OK/, `expected pre-timeout stdout, got: ${outText}`)

      const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, 'utf8').trim(), 10)
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1)

      let grandchildDeadOrZombie = false
      for (let i = 0; i < 40; i++) {
        try {
          const statRaw = readFileSync(`/proc/${grandchildPid}/stat`, 'utf8')
          const stateField = statRaw
            .slice(statRaw.lastIndexOf(')') + 1)
            .trimStart()
            .split(/\s+/)[0]
          if (stateField === 'Z' || stateField === 'X') {
            grandchildDeadOrZombie = true
            break
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            grandchildDeadOrZombie = true
            break
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.equal(
        grandchildDeadOrZombie,
        true,
        `setsid grandchild pid ${grandchildPid} must be terminated on timeout`,
      )

      // Prove the SAME Cc5ToolHost subprocess survived timeout cleanup and still executes tools!
      const followUp = await within(
        host.execute(
          'Bash',
          { command: 'echo HOST_STILL_ALIVE' },
          {
            nativeSessionId: NATIVE_SESSION,
            turnKey: 'turn-one',
            toolUseId: 'toolu_after_timeout',
          },
        ),
        15_000,
        'Bash follow-up after timeout',
      )
      assert.equal(followUp.isError, false)
      assert.match(JSON.stringify(followUp.content), /HOST_STILL_ALIVE/)

      await host.close()
      host = undefined

      let reapedAfterClose = false
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(grandchildPid, 0)
          await new Promise((resolve) => setTimeout(resolve, 50))
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
            reapedAfterClose = true
            break
          }
        }
      }
      assert.equal(reapedAfterClose, true)
    } finally {
      await host?.close().catch(() => {})
      rmSync(root, { recursive: true, force: true })
      rmSync(sandbox, { recursive: true, force: true })
    }
  },
)
