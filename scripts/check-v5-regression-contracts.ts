#!/usr/bin/env tsx
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Locks incident regression contracts and proves their assertions are live.
 *
 * Structural mode verifies exact file hashes and mutation anchors. In CI it
 * also compares every contract from the trusted base ref byte-for-byte, so a
 * PR cannot weaken/delete a locked test by updating the manifest alongside it.
 *
 * --prove runs the clean contract (must pass), disables its key production
 * safeguard in an isolated snapshot, and runs the same contract again (must
 * fail with the same named assertion).
 */
const ROOT = resolve(import.meta.dirname, '..')
const MANIFEST_PATH = 'e2e/session-display/regression-contract-locks.json'
const MANIFEST = join(ROOT, MANIFEST_PATH)
const INCIDENTS = join(ROOT, 'e2e/session-display/incidents.json')

type NegativeControl = {
  path: string
  from: string
  to: string
}

type Contract = {
  id: string
  incident: string
  path: string
  assertion: string
  sha256: string
  negativeControl: NegativeControl
}

type Manifest = {
  schema: number
  contracts: Contract[]
}

function fail(message: string): never {
  throw new Error(`[regression-contracts] ${message}`)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function safePath(path: string, label: string): void {
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    fail(`${label}: unsafe path ${JSON.stringify(path)}`)
  }
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }
  return count
}

function readManifestAt(ref: string): Manifest | null {
  const commit = spawnSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (commit.status !== 0) fail(`trusted base ref is not a commit: ${ref}`)

  const path = spawnSync('git', ['cat-file', '-e', `${ref}:${MANIFEST_PATH}`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (path.status !== 0) return null

  const result = spawnSync('git', ['show', `${ref}:${MANIFEST_PATH}`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) fail(`cannot read lock manifest from trusted base ${ref}`)
  try {
    return JSON.parse(result.stdout) as Manifest
  } catch {
    fail(`trusted base ${ref} contains an invalid lock manifest`)
  }
}

function readFileAt(ref: string, path: string): string {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd: ROOT, encoding: 'utf8' })
  } catch {
    fail(`trusted base ${ref} is missing locked artifact ${path}`)
  }
}

function parseBaseRef(argv: string[]): string | null {
  const index = argv.indexOf('--base')
  if (index !== -1) {
    const value = argv[index + 1]?.trim()
    if (!value) fail('--base requires a git ref')
    return value
  }
  return process.env.REGRESSION_CONTRACT_BASE_REF?.trim() || null
}

function validateCurrent(manifest: Manifest): void {
  if (manifest.schema !== 1) fail('manifest schema must be 1')
  if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
    fail('manifest must register at least one contract')
  }

  const ids = new Set<string>()
  const incidentIds = new Set(
    (
      JSON.parse(readFileSync(INCIDENTS, 'utf8')) as { incidents?: Array<{ id?: string }> }
    ).incidents
      ?.map((incident) => incident.id)
      .filter((id): id is string => typeof id === 'string') ?? [],
  )
  for (const contract of manifest.contracts) {
    if (!/^REG-[0-9]{8}-[A-Z0-9-]{3,64}$/.test(contract.id)) {
      fail(`invalid contract id ${contract.id}`)
    }
    if (!/^INC-[0-9]{8}-[A-Z0-9-]{3,40}$/.test(contract.incident)) {
      fail(`${contract.id}: invalid incident id ${contract.incident}`)
    }
    if (!incidentIds.has(contract.incident)) {
      fail(`${contract.id}: incident ${contract.incident} is not registered in incidents.json`)
    }
    if (ids.has(contract.id)) fail(`duplicate contract id ${contract.id}`)
    ids.add(contract.id)

    safePath(contract.path, contract.id)
    safePath(contract.negativeControl.path, `${contract.id} negativeControl`)
    const artifactPath = join(ROOT, contract.path)
    const sourcePath = join(ROOT, contract.negativeControl.path)
    if (!existsSync(artifactPath)) fail(`${contract.id}: missing ${contract.path}`)
    if (!existsSync(sourcePath)) {
      fail(`${contract.id}: missing mutation target ${contract.negativeControl.path}`)
    }

    const artifact = readFileSync(artifactPath, 'utf8')
    const actualHash = sha256(artifact)
    if (actualHash !== contract.sha256) {
      fail(
        `${contract.id}: locked bytes changed for ${contract.path} (expected ${contract.sha256}, got ${actualHash})`,
      )
    }
    if (!artifact.includes(contract.assertion)) {
      fail(`${contract.id}: assertion anchor missing: ${contract.assertion}`)
    }

    const source = readFileSync(sourcePath, 'utf8')
    const found = occurrences(source, contract.negativeControl.from)
    if (found !== 1) {
      fail(
        `${contract.id}: negative-control anchor must occur exactly once in ${contract.negativeControl.path}, got ${found}`,
      )
    }
    if (
      !contract.negativeControl.to ||
      contract.negativeControl.to === contract.negativeControl.from
    ) {
      fail(`${contract.id}: negative control must materially change production code`)
    }
  }
}

function validateTrustedBase(current: Manifest, baseRef: string | null): void {
  if (!baseRef) {
    process.stdout.write(
      '[regression-contracts] no trusted base ref; exact current hashes verified, immutable diff check skipped\n',
    )
    return
  }

  const base = readManifestAt(baseRef)
  if (base === null) {
    process.stdout.write(
      '[regression-contracts] trusted base has no lock manifest; treating current contracts as initial registration\n',
    )
    return
  }

  const currentById = new Map(current.contracts.map((contract) => [contract.id, contract]))
  for (const locked of base.contracts) {
    const now = currentById.get(locked.id)
    if (!now) fail(`${locked.id}: locked contract was deleted`)
    if (JSON.stringify(now) !== JSON.stringify(locked)) {
      fail(
        `${locked.id}: locked manifest entry changed; replacement requires an explicit approved unlock outside this gate`,
      )
    }

    const baseBytes = readFileAt(baseRef, locked.path)
    const currentBytes = readFileSync(join(ROOT, locked.path), 'utf8')
    if (currentBytes !== baseBytes) {
      fail(`${locked.id}: locked artifact ${locked.path} differs from trusted base ${baseRef}`)
    }
  }
}

function runContract(snapshot: string, contract: Contract): ReturnType<typeof spawnSync> {
  const runner = join(snapshot, 'node_modules/.bin/tsx')
  const lockedRunner = `
lock=/var/lock/oc-test-commercial.lock
if exec 9>"$lock" 2>/dev/null; then
  flock -w 1800 9 || exit 3
fi
exec setsid "$1" --test "$2"
`
  return spawnSync(
    'bash',
    ['-c', lockedRunner, 'regression-contract-proof', runner, contract.path],
    {
      cwd: snapshot,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, CI: 'true' },
    },
  )
}

function outputOf(result: ReturnType<typeof spawnSync>): string {
  return String(result.stdout ?? '') + String(result.stderr ?? '')
}

function copyIntoSnapshot(snapshot: string, path: string): void {
  const destination = join(snapshot, path)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(join(ROOT, path), destination)
}

function prove(contract: Contract): void {
  const snapshot = mkdtempSync(join(tmpdir(), 'oc-regression-contract-'))
  const archive = join(snapshot, 'head.tar')
  try {
    execFileSync('git', ['archive', '--format=tar', '-o', archive, 'HEAD'], {
      cwd: ROOT,
      stdio: 'inherit',
    })
    execFileSync('tar', ['-xf', archive, '-C', snapshot], { stdio: 'inherit' })
    rmSync(archive, { force: true })
    symlinkSync(join(ROOT, 'node_modules'), join(snapshot, 'node_modules'), 'dir')

    copyIntoSnapshot(snapshot, contract.path)
    copyIntoSnapshot(snapshot, contract.negativeControl.path)

    const green = runContract(snapshot, contract)
    const greenOutput = outputOf(green)
    if (green.status !== 0 || !greenOutput.includes(contract.assertion)) {
      fail(
        `${contract.id}: positive control did not pass with named assertion\n${greenOutput.slice(-8_000)}`,
      )
    }

    const target = join(snapshot, contract.negativeControl.path)
    const source = readFileSync(target, 'utf8')
    const count = occurrences(source, contract.negativeControl.from)
    if (count !== 1) fail(`${contract.id}: mutation anchor drifted during proof`)
    writeFileSync(
      target,
      source.replace(contract.negativeControl.from, contract.negativeControl.to),
      'utf8',
    )

    const red = runContract(snapshot, contract)
    const redOutput = outputOf(red)
    if (red.status === 0) {
      fail(`${contract.id}: negative control stayed green; the contract is vacuous`)
    }
    if (!redOutput.includes(contract.assertion)) {
      fail(
        `${contract.id}: negative control failed for an unrelated reason\n${redOutput.slice(-8_000)}`,
      )
    }

    process.stdout.write(
      `[regression-contracts] red→green proof PASS ${contract.id} (clean exit=0, safeguard-disabled exit=${String(red.status)})\n`,
    )
  } finally {
    rmSync(snapshot, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const proveEnabled = argv.includes('--prove')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest
validateCurrent(manifest)
validateTrustedBase(manifest, parseBaseRef(argv))

if (proveEnabled) {
  for (const contract of manifest.contracts) prove(contract)
}

process.stdout.write(
  `[regression-contracts] PASS: ${manifest.contracts.length} immutable contract(s)${proveEnabled ? ' with red→green proofs' : ''}\n`,
)
