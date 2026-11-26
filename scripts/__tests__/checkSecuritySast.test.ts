import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_REL_PATH,
  discoverProductionFiles,
  main as runSastMain,
  scanAstSecurityAntipatterns,
  scanSecretsInText,
} from '../check-security-sast.ts'
import { discoverProductionFiles as discoverComplexityFiles } from '../check-complexity-ratchet.ts'
import { discoverProductionFiles as discoverClonesFiles } from '../check-clones-ratchet.ts'
import { collectProductionFiles as discoverAiSmellsFiles } from '../check-ai-smells-ratchet.ts'
import { listIntegFilesOnDisk } from '../check-integ-tiers.ts'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-security-sast.ts',
)

function runInProc(args: string[]): { status: number; stdout: string; stderr: string } {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a: unknown[]) => out.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => err.push(a.map(String).join(' '))
  try {
    return { status: runSastMain(args), stdout: out.join('\n'), stderr: err.join('\n') }
  } finally {
    console.log = origLog
    console.error = origErr
  }
}

function runCliSubprocess(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    encoding: 'utf8',
  })
}

describe('check-security-sast secret & credential detectors', () => {
  test('detects AWS, GitHub PAT, OpenAI, Anthropic, PEM private keys, and hardcoded JWT secrets while redacting raw values', () => {
    // Build realistic token shapes dynamically so the test source itself stays clean of literal scanner hits
    const awsKey = `AKIA${'9Q2Z7M4X8K1L5P3R'}`
    const ghPat = `ghp_${'a9B8c7D6e5F4g3H2i1J0k9L8m7N6o5P4q3R2s1'}`
    const oaiKey = `sk-proj-${'Z1x2C3v4B5n6M7a8S9d0F1g2H3j4K5l6Q7w8E9r0'}`
    const antKey = `sk-ant-api03-${'T9y8U7i6O5p4A3s2D1f0G9h8J7k6L5z4X3c2V1b0'}`
    const pemHeader = `-----BEGIN ${'RSA PRIVATE'} KEY-----`
    const pemBody = 'MIIEpAIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9OiZ1P5q8L2vK9wN4xR7tY6uI0oP'

    const text = [
      `const a = "${awsKey}"`,
      `const b = "${ghPat}"`,
      `const c = "${oaiKey}"`,
      `const d = "${antKey}"`,
      `const pem = \`${pemHeader}\n${pemBody}\``,
      'const jwtSecret = "prod-signing-key-987654321"',
      // Allowed test fixture via inline marker:
      `const fixturePat = "${ghPat}" // gitleaks:allow`,
      // Allowed env key constant (not a secret value):
      'const JWT_SECRET = "OC_MASTER_JWT_SECRET"',
    ].join('\n')

    const hits = scanSecretsInText('packages/demo/src/config.ts', text)
    const rules = hits.map((h) => h.ruleId)
    assert.ok(rules.includes('SEC-SECRET-AWS-ACCESS-KEY'))
    assert.ok(rules.includes('SEC-SECRET-GITHUB-PAT'))
    assert.ok(rules.includes('SEC-SECRET-OPENAI-KEY'))
    assert.ok(rules.includes('SEC-SECRET-ANTHROPIC-KEY'))
    assert.ok(rules.includes('SEC-SECRET-PRIVATE-KEY-PEM'))
    assert.ok(rules.includes('SEC-SECRET-JWT-SECRET'))
    // Inline `gitleaks:allow` line must not produce a second GitHub PAT hit
    assert.equal(rules.filter((r) => r === 'SEC-SECRET-GITHUB-PAT').length, 1)
    // Raw secret must be redacted in findings
    for (const h of hits) {
      assert.equal(h.detail.includes(ghPat), false)
      assert.equal(h.detail.includes(oaiKey), false)
    }
  })
})

describe('check-security-sast AST high-risk security & hot-path detectors', () => {
  test('flags interpolated SQL, shell command injection, and unbounded loop awaits while allowing safe parameterized/bounded patterns', () => {
    const code = `
import { exec, execFileSync } from 'node:child_process'

export async function unsafeHandler(pool: { query: (s: string, p?: unknown[]) => Promise<unknown> }, userId: string, urls: string[]) {
  // 1. Unsafe SQL template interpolation -> FLAG
  await pool.query(\`SELECT * FROM users WHERE id = '\${userId}'\`)
  // Safe parameterized SQL -> OK
  await pool.query('SELECT * FROM users WHERE id = $1', [userId])

  // 2. Unsafe shell interpolation -> FLAG
  exec(\`tar -czf /tmp/out.tgz \${userId}\`)
  // Safe argument array -> OK
  execFileSync('tar', ['-czf', '/tmp/out.tgz', userId])

  // 3. Unbounded loop await fetch -> FLAG
  for (const u of urls) {
    await fetch(u)
  }

  // Bounded retry loop (<= 10) -> OK
  for (let attempt = 0; attempt < 3; attempt++) {
    await fetch('https://example.com/healthz')
  }

  // RegExp.exec must NEVER be confused with SQL or shell exec -> OK
  const re = /select/i
  re.exec(\`SELECT \${userId} FROM dual\`)
}
`
    const findings = scanAstSecurityAntipatterns('packages/demo/src/handler.ts', code)
    assert.deepEqual(
      findings.map((f) => f.ruleId),
      [
        'SEC-SAST-SQL-INTERPOLATION',
        'SEC-SAST-SHELL-INJECTION',
        'SEC-SAST-UNBOUNDED-LOOP-AWAIT',
      ],
    )
  })
})

describe('check-security-sast CLI baseline & zero-tolerance incremental enforcement', () => {
  test('freezes legacy SAST count, blocks new SAST or secret leak, and blocks baseline inflation via --base', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oc-sast-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const put = (rel: string, content: string) => {
      const abs = path.join(dir, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

    put(
      'packages/demo/src/legacyDb.ts',
      'export async function legacyQuery(db: { query: (q: string) => Promise<void> }, tbl: string) {\n  await db.query(`DELETE FROM ${tbl} WHERE expired = true`)\n}\n',
    )

    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@openclaude.local')
    git('config', 'user.name', 'Test')
    git('add', '-A')
    git('commit', '-qm', 'initial')

    // 1. Freeze legacy SAST finding (real CLI subprocess smoke test)
    const wb = runCliSubprocess(['--root', dir, '--write-baseline'])
    assert.equal(wb.status, 0, wb.stderr)
    git('add', '-A')
    git('commit', '-qm', 'chore: add security sast baseline')
    git('tag', 'base-sast')

    // 2. Enforce against base passes (zero false alarm on baselined legacy entry)
    const ok = runInProc(['--root', dir, '--enforce', '--base', 'base-sast'])
    assert.equal(ok.status, 0, ok.stderr)

    // 3. Adding a new SAST violation -> BLOCKED
    put(
      'packages/demo/src/newRoute.ts',
      "import { execSync } from 'node:child_process'\nexport function runBad(input: string) { return execSync(`ls ${input}`) }\n",
    )
    const redSast = runInProc(['--root', dir, '--enforce', '--base', 'base-sast'])
    assert.equal(redSast.status, 1)
    assert.match(redSast.stderr, /SEC-SAST-SHELL-INJECTION/)

    // 4. Adding a secret leak -> BLOCKED & --write-baseline refuses to baseline secrets!
    const fakeLeak = `ghp_${'z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6l5K4j3I2h1'}`
    put('packages/demo/src/newRoute.ts', `export const token = "${fakeLeak}"\n`)
    const redSecret = runInProc(['--root', dir, '--enforce'])
    assert.equal(redSecret.status, 1)
    assert.match(redSecret.stderr, /SEC-SECRET-GITHUB-PAT/)

    const refuseWb = runInProc(['--root', dir, '--write-baseline'])
    assert.equal(refuseWb.status, 1)
    assert.match(refuseWb.stderr, /REFUSING --write-baseline/)

    // 5. Tampering with baseline count -> BLOCKED by --base
    put('packages/demo/src/newRoute.ts', 'export const clean = true\n')
    writeFileSync(
      path.join(dir, BASELINE_REL_PATH),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          summary: { totalEntries: 1, totalCount: 5, byRule: { 'SEC-SAST-SQL-INTERPOLATION': 5 } },
          entries: { 'packages/demo/src/legacyDb.ts|SEC-SAST-SQL-INTERPOLATION': 5 },
        },
        null,
        2,
      )}\n`,
    )
    const redTamper = runInProc(['--root', dir, '--enforce', '--base', 'base-sast'])
    assert.equal(redTamper.status, 1)
    assert.match(redTamper.stderr, /baseline-raised/)
  })

  test('B4 external referee --root & symlink coverage parity: all 6 scanners scan identical files (gateway > 0) and fail-closed on empty gateway', async (t) => {
    // 1. Build a simulated symlinked referee view of the real repository (like master_referee_build_exec_view)
    const symView = mkdtempSync(path.join(tmpdir(), 'oc-b4-symview-'))
    const extRef = mkdtempSync(path.join(tmpdir(), 'oc-b4-extref-'))
    const emptyGw = mkdtempSync(path.join(tmpdir(), 'oc-b4-emptygw-'))
    t.after(() => {
      rmSync(symView, { recursive: true, force: true })
      rmSync(extRef, { recursive: true, force: true })
      rmSync(emptyGw, { recursive: true, force: true })
    })

    mkdirSync(path.join(symView, 'packages'), { recursive: true })
    symlinkSync(path.join(REPO_ROOT, 'packages/gateway'), path.join(symView, 'packages/gateway'))
    symlinkSync(path.join(REPO_ROOT, 'packages/protocol'), path.join(symView, 'packages/protocol'))
    symlinkSync(path.join(REPO_ROOT, 'packages/commercial'), path.join(symView, 'packages/commercial'))

    // Real repo discovery vs symlinked view discovery for gateway MUST be 100% identical and > 0!
    const directSast = discoverProductionFiles(REPO_ROOT)
    const directGw = directSast.filter((f) => f.startsWith('packages/gateway/src/'))
    const symGw = discoverProductionFiles(symView).filter((f) => f.startsWith('packages/gateway/src/'))
    assert.ok(directGw.length > 100, `expected >100 gateway files in repo, got ${directGw.length}`)
    assert.deepEqual(symGw, directGw, 'symlinked referee view must discover 100% identical gateway files')

    // Complexity, clones, and ai-smells also discover identical gateway files through symlinks
    assert.deepEqual(
      discoverComplexityFiles(symView).filter((f) => f.startsWith('packages/gateway/src/')),
      discoverComplexityFiles(REPO_ROOT).filter((f) => f.startsWith('packages/gateway/src/')),
    )
    assert.deepEqual(
      discoverClonesFiles(symView).filter((f) => f.startsWith('packages/gateway/src/')),
      discoverClonesFiles(REPO_ROOT).filter((f) => f.startsWith('packages/gateway/src/')),
    )
    assert.deepEqual(
      discoverAiSmellsFiles(symView).filter((f) => f.startsWith('packages/gateway/src/')),
      discoverAiSmellsFiles(REPO_ROOT).filter((f) => f.startsWith('packages/gateway/src/')),
    )
    assert.deepEqual(
      listIntegFilesOnDisk(symView).filter((f) => f.startsWith('packages/gateway/')),
      listIntegFilesOnDisk(REPO_ROOT).filter((f) => f.startsWith('packages/gateway/')),
    )

    // 2. Copy all 6 scanner scripts + libs + .github/scripts into an EXTERNAL temp referee dir (NO candidate packages inside!)
    mkdirSync(path.join(extRef, 'scripts/lib'), { recursive: true })
    mkdirSync(path.join(extRef, '.github/scripts'), { recursive: true })
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(extRef, 'node_modules'))
    for (const rel of [
      'scripts/lib/prodFileDiscovery.ts',
      'scripts/lib/restContractLoader.ts',
      'scripts/check-security-sast.ts',
      'scripts/check-complexity-ratchet.ts',
      'scripts/check-clones-ratchet.ts',
      'scripts/check-ai-smells-ratchet.ts',
      'scripts/check-integ-tiers.ts',
      'scripts/check-rest-contract-compat.ts',
      '.github/scripts/integ-shard-budget.ts',
    ]) {
      copyFileSync(path.join(REPO_ROOT, rel), path.join(extRef, rel))
    }

    const tsxCli = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
    const runExt = (scriptRel: string, args: string[]) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [tsxCli, path.join(extRef, scriptRel), ...args], {
          cwd: extRef,
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => {
          stdout += String(d)
        })
        child.stderr.on('data', (d) => {
          stderr += String(d)
        })
        child.on('error', reject)
        child.on('close', (status) => resolve({ status, stdout, stderr }))
      })

    const [extSast, extComp, extClones, extSmells, extInteg, extRest] = await Promise.all([
      runExt('scripts/check-security-sast.ts', ['--root', REPO_ROOT, '--enforce', '--json']),
      runExt('scripts/check-complexity-ratchet.ts', ['--root', REPO_ROOT, '--enforce', '--json']),
      runExt('scripts/check-clones-ratchet.ts', ['--root', REPO_ROOT, '--enforce', '--json']),
      runExt('scripts/check-ai-smells-ratchet.ts', ['--root', REPO_ROOT, '--enforce', '--json']),
      runExt('scripts/check-integ-tiers.ts', ['--root', REPO_ROOT]),
      runExt('scripts/check-rest-contract-compat.ts', ['--root', REPO_ROOT]),
    ])

    // SAST from external referee with --root <repo> matches direct file count identically
    assert.equal(extSast.status, 0, extSast.stderr)
    assert.equal(JSON.parse(extSast.stdout).scannedFiles, directSast.length)

    // Complexity from external referee with --root <repo>
    assert.equal(extComp.status, 0, extComp.stderr)
    assert.equal(JSON.parse(extComp.stdout).scannedFiles, directSast.length)

    // Clones from external referee with --root <repo>
    assert.equal(extClones.status, 0, extClones.stderr)
    assert.equal(JSON.parse(extClones.stdout).scannedFiles, discoverClonesFiles(REPO_ROOT).length)

    // AI smells from external referee with --root <repo>
    assert.equal(extSmells.status, 0, extSmells.stderr)
    assert.equal(JSON.parse(extSmells.stdout).scannedFiles, discoverAiSmellsFiles(REPO_ROOT).length)

    // Integ-tiers from external referee with --root <repo>
    assert.equal(extInteg.status, 0, extInteg.stderr)
    assert.match(extInteg.stdout, /✓ check-integ-tiers:/)

    // REST contract compat from external referee with --root <repo> (zero packages/ inside extRef!)
    assert.equal(extRest.status, 0, extRest.stderr)
    assert.match(extRest.stdout, /\[rest-contract-compat\] ok:/)

    // 3. Fail-closed coverage assertion: if packages/gateway/src exists but yields 0 files -> exit 1!
    mkdirSync(path.join(emptyGw, 'packages/gateway/src'), { recursive: true })
    mkdirSync(path.join(emptyGw, 'arch'), { recursive: true })
    writeFileSync(
      path.join(emptyGw, 'arch/security-sast-baseline.json'),
      JSON.stringify({ schemaVersion: 1, summary: { totalEntries: 0, totalCount: 0, byRule: {} }, entries: {} }),
    )
    const rZeroGw = runInProc(['--root', emptyGw, '--enforce'])
    assert.equal(rZeroGw.status, 1)
    assert.match(rZeroGw.stderr, /coverage-zero/)
  })
})
