import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { RemoteProbeSnapshot } from '@openclaude/protocol'
import { RemotePoolProbeHost, type RemotePoolProbeSpec } from '../remotePool/index.js'

const CONTROLLER_SHA = 'a'.repeat(64)
const DRIVER_SHA = 'b'.repeat(64)
const CORE_SHA = 'c'.repeat(64)

function createMockChild(stdoutText: string, exitCode = 0): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(emitter, { stdin, stdout, stderr, kill: () => true })
  stdin.on('finish', () => {
    setImmediate(() => {
      if (stdoutText) stdout.write(stdoutText)
      stdout.end()
      stderr.end()
      emitter.emit('close', exitCode)
    })
  })
  return emitter
}

test('RemotePoolProbeHost.forSshTarget pins probe-only role and exposes no execution methods', async () => {
  const dir = mkdtempSync('/tmp/oc-drvtest-probehost-')
  try {
    const keyPath = join(dir, 'v4_cc_id_ed25519')
    const knownHostsPath = join(dir, 'known_hosts')
    writeFileSync(keyPath, 'dummy-key')
    writeFileSync(knownHostsPath, 'example.com ssh-ed25519 AAAA\n')
    chmodSync(keyPath, 0o600)
    chmodSync(knownHostsPath, 0o644)

    const target = {
      host: 'node1.internal',
      port: 2222,
      user: 'agent',
      keyPath,
      knownHostsPath,
      controllerSha256: CONTROLLER_SHA,
      taskRootPrefix: '/home/agent/oc-remotedrv-',
      upstreamModel: 'claude-sonnet-5',
    }
    const spec: RemotePoolProbeSpec = {
      controllerPath: `/opt/openclaude/remote-driver/${CONTROLLER_SHA}/core/controller.py`,
      controllerSha256: CONTROLLER_SHA,
      driverId: 'cc',
      profileId: 'default',
      probeRoot: '/home/agent/oc-remotedrv-probe-cc-12345678',
    }

    assert.throws(
      () =>
        RemotePoolProbeHost.forSshTarget(target, {
          ...spec,
          probeRoot: '/home/agent/oc-remotedrv-cc-12345678',
        }),
      /REMOTE_PROBE_ROOT_INVALID/,
    )
    assert.throws(
      () =>
        RemotePoolProbeHost.forSshTarget(target, {
          ...spec,
          probeRoot: '/home/agent/oc-remoteprobe-cc-12345678',
        }),
      /REMOTE_PROBE_ROOT_INVALID/,
    )
    assert.throws(
      () => RemotePoolProbeHost.forSshTarget({ ...target, user: 'root' }, spec),
      /REMOTE_SSH_TARGET_OR_CONTROLLER_INVALID/,
    )

    chmodSync(keyPath, 0o644)
    assert.throws(
      () => RemotePoolProbeHost.forSshTarget(target, spec),
      /REMOTE_SSH_KEY_PERMISSIONS_UNSAFE/,
    )
    chmodSync(keyPath, 0o600)

    const linkKey = join(dir, 'symlink_key')
    symlinkSync(keyPath, linkKey)
    assert.throws(
      () => RemotePoolProbeHost.forSshTarget({ ...target, keyPath: linkKey }, spec),
      /REMOTE_SSH_KEY_OR_KNOWN_HOSTS_UNSAFE/,
    )

    let capturedArgs: string[] = []
    const hostObj = RemotePoolProbeHost.forSshTarget(target, spec, (args) => {
      capturedArgs = args
      const snapshot: RemoteProbeSnapshot = {
        schemaVersion: 4,
        driverId: 'cc',
        engineId: 'cc',
        driverVersion: '1.0.0',
        source: 'cc:live-probe',
        freshness: 'cli-observed',
        observedAt: '2026-11-11T04:00:00Z',
        authPresent: true,
        accountObserved: true,
        cliVersion: '2.1.0',
        cliSha256: 'd'.repeat(64),
        bridgeSha256: 'e'.repeat(64),
        models: [
          {
            upstreamModelId: 'claude-sonnet-5',
            displayName: 'Claude Sonnet 5',
            supportedEfforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
            supportsAdaptiveThinking: true,
            supportsVision: true,
          },
        ],
        rawResponseSha256: '0'.repeat(64),
      }
      const frame = {
        version: 4,
        kind: 'probe-result',
        snapshot,
        driverDigest: DRIVER_SHA,
        coreDigest: CORE_SHA,
        probeFingerprint: '1'.repeat(64),
      }
      return createMockChild(`${JSON.stringify(frame)}\n`)
    })

    // Probe-only transport must not expose lane execution or stop methods
    assert.equal('open' in hostObj, false)
    assert.equal('stop' in hostObj, false)
    assert.equal('verifiedProbe' in spec, false)

    const out = await hostObj.probe({ cliPath: '/usr/bin/claude' })
    assert.equal(out.snapshot.driverId, 'cc')
    assert.equal(out.driverDigest, DRIVER_SHA)
    assert.equal(out.coreDigest, CORE_SHA)
    const remoteCmd = capturedArgs.at(-1) ?? ''
    assert.ok(remoteCmd.includes("'probe'"), `expected probe role in SSH command: ${remoteCmd}`)
    assert.ok(
      remoteCmd.includes("'/home/agent/oc-remotedrv-probe-cc-12345678'"),
      `expected probeRoot in SSH command: ${remoteCmd}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RemotePoolProbeHost.forLocalSandbox executes probe against real controller with example_echo', async () => {
  const dir = mkdtempSync('/tmp/oc-drvtest-probe-local-')
  try {
    const repoRoot = join(fileURLToPath(new URL('../../../../', import.meta.url)))
    const controllerPath = join(repoRoot, 'scripts/agent-remote/core/controller.py')
    const spec: RemotePoolProbeSpec = {
      controllerPath,
      controllerSha256: CONTROLLER_SHA,
      driverId: 'example_echo',
      profileId: 'default',
      probeRoot: join(dir, 'run-probe-echo'),
    }
    assert.throws(
      () =>
        RemotePoolProbeHost.forLocalSandbox({
          ...spec,
          probeRoot: '/tmp/not-drvtest-probe',
        }),
      /REMOTE_LOCAL_SANDBOX_ROOT_FORBIDDEN/,
    )
    const resRoot = join(dir, 'res')
    const fakeSys = join(dir, 'sys')
    mkdirSync(resRoot, { recursive: true, mode: 0o700 })
    mkdirSync(fakeSys, { recursive: true, mode: 0o700 })
    const hostObj = RemotePoolProbeHost.forLocalSandbox(spec, {
      OC_REMOTE_RESOURCE_ROOT: resRoot,
      OC_REMOTE_TEST_FAKE_SYSTEMD_DIR: fakeSys,
      OC_REMOTE_NODE_MEMORY_BUDGET: String(4096 * 1024 * 1024),
      OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(4096 * 1024 * 1024),
    })
    const out = await hostObj.probe({ probeRoot: spec.probeRoot })
    assert.equal(out.snapshot.driverId, 'example_echo')
    assert.equal(out.snapshot.authPresent, true)
    assert.ok(out.snapshot.models.length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
