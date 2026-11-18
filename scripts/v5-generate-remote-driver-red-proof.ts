#!/usr/bin/env npx tsx
/**
 * Generate deterministic sandbox negative-control proof artifact for `remote-driver-v4` (`OCV5-749`, R12).
 *
 * Executes `scripts/agent-remote/conformance/runner.ts --mode sandbox` for `codex` and `cc`,
 * verifies all 8 red controls caught across groups 1..7, strips volatile timestamps/durations/paths,
 * and writes `scripts/agent-remote/conformance/sandbox-red-proof.json`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { remoteCanonicalSha256 } from '@openclaude/protocol'
import {
  computeProductionConformanceSuiteDigest,
  loadRemoteDriverRegistry,
} from '../packages/commercial/src/account-pool/remotePool/index.js'

const EXPECTED_REQUIREMENTS = ['R1', 'R2', 'R3', 'R4a', 'R4b', 'R5', 'R6', 'R7'] as const
const ALL_GROUPS = [1, 2, 3, 4, 5, 6, 7] as const
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RUNNER_PATH = join(REPO_ROOT, 'scripts/agent-remote/conformance/runner.ts')
const OUTPUT_PATH = join(REPO_ROOT, 'scripts/agent-remote/conformance/sandbox-red-proof.json')

interface RawRequirement {
  requirementId: string
  redEnvironment: string
  redControlCaught: boolean
  status?: string
  greenPassed?: boolean
  redDetails?: Record<string, unknown>
}

interface RawGroup {
  group: number
  passed: boolean
  status: string
  requirements: RawRequirement[]
}

interface RawSummary {
  driverId: string
  engineId: string
  driverDigest: string
  coreDigest: string
  controllerSha256: string
  policySha256: string
  overallPassed: boolean
  allRedControlsCaught: boolean
  groups: RawGroup[]
}

function normalizeDriverEvidence(evidenceDir: string, driverId: string) {
  const summaryPath = join(evidenceDir, 'summary.json')
  if (!existsSync(summaryPath)) {
    throw new Error(`Missing summary.json in ${evidenceDir}`)
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as RawSummary
  if (summary.driverId !== driverId || !summary.overallPassed || !summary.allRedControlsCaught) {
    throw new Error(`Summary validation failed for ${driverId}`)
  }

  const allGroups: RawGroup[] = []
  for (const g of ALL_GROUPS) {
    const groupPath = join(evidenceDir, `group-${g}.json`)
    if (!existsSync(groupPath)) {
      throw new Error(`Missing ${groupPath} for ${driverId}`)
    }
    const grp = JSON.parse(readFileSync(groupPath, 'utf8')) as RawGroup
    if (!grp.passed || grp.status !== 'PASS') {
      throw new Error(`Group ${g} did not pass for ${driverId}`)
    }
    allGroups.push(grp)
  }

  const reqs = allGroups.flatMap((g) => g.requirements)
  const byId = new Map(reqs.map((r) => [r.requirementId, r]))
  if (byId.size !== EXPECTED_REQUIREMENTS.length) {
    throw new Error(
      `Expected ${EXPECTED_REQUIREMENTS.length} requirements for ${driverId}, got ${byId.size}`,
    )
  }

  const normalizedReqs = EXPECTED_REQUIREMENTS.map((reqId) => {
    const r = byId.get(reqId)
    if (!r || r.redControlCaught !== true || r.greenPassed === false) {
      throw new Error(`Red/green control not verified for ${driverId} requirement ${reqId}`)
    }
    const injectedFault =
      typeof r.redDetails?.injectedFault === 'string' && r.redDetails.injectedFault.length > 0
        ? r.redDetails.injectedFault
        : `${driverId}_${reqId}_fault`
    return {
      requirementId: r.requirementId,
      redEnvironment: 'local-sandbox-fault-injection' as const,
      redControlCaught: true as const,
      injectedFault,
    }
  })

  return {
    driverId: summary.driverId,
    engineId: summary.engineId,
    driverDigest: summary.driverDigest,
    coreDigest: summary.coreDigest,
    controllerSha256: summary.controllerSha256,
    policySha256: summary.policySha256,
    requirements: normalizedReqs,
  }
}

const ALL_DRIVERS = ['codex', 'cc', 'antigravity'] as const
type ProofDriverId = (typeof ALL_DRIVERS)[number]

function runSandboxForDriver(
  driverId: ProofDriverId,
  suiteDigest: string,
  workDir: string,
  groups = '1,2,3,4,5,6,7',
) {
  const evidenceDir = join(workDir, driverId)
  execFileSync(
    'npx',
    [
      'tsx',
      RUNNER_PATH,
      '--driver',
      driverId,
      '--mode',
      'sandbox',
      '--evidence',
      evidenceDir,
      '--groups',
      groups,
      '--suite-digest',
      suiteDigest,
    ],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: process.env,
    },
  )
}

function parseCli(argv: string[]) {
  let driver: ProofDriverId | undefined
  let cacheDir: string | undefined
  let groups = '1,2,3,4,5,6,7'
  let assembleOnly = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--driver' && argv[i + 1]) {
      const d = argv[++i]!
      if (d !== 'codex' && d !== 'cc' && d !== 'antigravity') throw new Error(`Unsupported driver: ${d}`)
      driver = d
    } else if (a === '--cache-dir' && argv[i + 1]) {
      cacheDir = resolve(argv[++i]!)
    } else if (a === '--groups' && argv[i + 1]) {
      groups = argv[++i]!
    } else if (a === '--assemble-only') {
      assembleOnly = true
    }
  }
  return { driver, cacheDir, groups, assembleOnly }
}

function main() {
  const args = parseCli(process.argv.slice(2))
  const suiteDigest = computeProductionConformanceSuiteDigest()
  const regMap = loadRemoteDriverRegistry()
  const tempRoot = args.cacheDir ?? mkdtempSync(join(tmpdir(), 'oc-r12-red-proof-'))
  mkdirSync(tempRoot, { recursive: true })
  try {
    if (!args.assembleOnly) {
      for (const drv of ALL_DRIVERS) {
        if (!args.driver || args.driver === drv) {
          runSandboxForDriver(drv, suiteDigest, tempRoot, args.groups)
        }
      }
    }

    const readyAll = ALL_DRIVERS.every(
      (d) =>
        ALL_GROUPS.every((g) => existsSync(join(tempRoot, d, `group-${g}.json`))) &&
        existsSync(join(tempRoot, d, 'summary.json')),
    )
    if (!readyAll) {
      if (args.driver && !args.assembleOnly) {
        process.stdout.write(`Completed ${args.driver} groups=${args.groups} into ${tempRoot}\n`)
        return
      }
      throw new Error(`Missing driver group/summary files in ${tempRoot}`)
    }

    const codex = normalizeDriverEvidence(join(tempRoot, 'codex'), 'codex')
    const cc = normalizeDriverEvidence(join(tempRoot, 'cc'), 'cc')
    const antigravity = normalizeDriverEvidence(join(tempRoot, 'antigravity'), 'antigravity')

    for (const entry of [codex, cc, antigravity]) {
      const reg = regMap.get(entry.driverId)
      if (!reg || reg.driverDigest !== entry.driverDigest || reg.coreDigest !== entry.coreDigest) {
        throw new Error(`Registry digest mismatch for ${entry.driverId}`)
      }
    }

    const payloadWithoutSha = {
      schemaVersion: 1 as const,
      suiteDigest,
      drivers: {
        codex,
        cc,
        antigravity,
      },
    }
    const proofSha256 = remoteCanonicalSha256(payloadWithoutSha)
    const artifact = {
      ...payloadWithoutSha,
      proofSha256,
    }
    writeFileSync(
      OUTPUT_PATH,
      `${JSON.stringify(artifact, null, 2)}
`,
      'utf8',
    )
    process.stdout.write(`Wrote ${OUTPUT_PATH} (proofSha256=${proofSha256})
`)
  } finally {
    if (!args.cacheDir) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }
}

main()
