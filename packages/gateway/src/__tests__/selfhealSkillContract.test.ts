import * as assert from 'node:assert/strict'
/**
 * v5-incident-repair SKILL ↔ oc-selfheal CLI ↔ repair prompt contract tests
 * (batch0 BLOCKER: the deployed SKILL taught `ack`/`progress`/`broker <action>`
 * — none of which the CLI has — because it had no in-repo canonical source).
 *
 * Three-way pin:
 *   1. every `oc-selfheal …` the SKILL shows parses under the REAL CLI binary
 *      (spawned against a mock broker socket — no broker code involved);
 *   2. legacy/fictional subcommands can never reappear in the SKILL;
 *   3. the session prompt (buildRepairPrompt) teaches exactly the same four
 *      subcommands, so the model never receives two conflicting contracts.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { buildRepairPrompt } from '../selfheal/executionLedger.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
const SKILL_PATH = join(REPO_ROOT, 'ops/selfheal/skills/v5-incident-repair/SKILL.md')
const CLI = join(REPO_ROOT, 'ops/oc-selfheal.mjs')

const CLI_SUBCOMMANDS = new Set(['context', 'verify', 'cutover', 'report'])
const REPORT_OUTCOMES = new Set(['progress', 'done', 'failed'])

const skill = readFileSync(SKILL_PATH, 'utf8')

/** Every `oc-selfheal <token>` occurrence in the SKILL (prose and fences). */
function skillInvocations(): string[][] {
  const out: string[][] = []
  const re = /oc-selfheal\s+([^\n`]*)/g
  for (const m of skill.matchAll(re)) {
    const tokens = m[1]!.trim().split(/\s+/).filter(Boolean)
    if (tokens.length > 0) out.push(tokens)
  }
  return out
}

describe('SKILL.md subcommand surface', () => {
  it('uses only the four real CLI subcommands', () => {
    const invocations = skillInvocations()
    assert.ok(invocations.length >= 4, 'the SKILL must actually show CLI usage')
    for (const tokens of invocations) {
      const sub = tokens[0]!
      assert.ok(
        CLI_SUBCOMMANDS.has(sub),
        `SKILL shows "oc-selfheal ${tokens.join(' ')}" — "${sub}" is not a CLI subcommand`,
      )
    }
  })

  it('report invocations use a valid outcome and lead with a repairId placeholder', () => {
    for (const tokens of skillInvocations()) {
      if (tokens[0] !== 'report') continue
      // Shape: report <repairId> <outcome> …  (the SKILL writes <repairId>).
      assert.match(tokens[1] ?? '', /^<repairId>$/, 'report must pass repairId explicitly')
      const outcome = (tokens[2] ?? '').replace(/[^a-z|]/g, '')
      const outcomes = outcome.split('|').filter(Boolean)
      assert.ok(outcomes.length > 0, 'report must name an outcome')
      for (const o of outcomes) {
        assert.ok(REPORT_OUTCOMES.has(o), `invalid report outcome "${o}" in SKILL`)
      }
    }
  })

  it('never resurrects the legacy fictional contract', () => {
    for (const forbidden of [
      /oc-selfheal\s+ack\b/,
      /oc-selfheal\s+broker\b/,
      /oc-selfheal\s+done\b/,
      /oc-selfheal\s+failed\b/,
      /oc-selfheal\s+progress\b/,
      /prepare_clone/,
    ]) {
      assert.doesNotMatch(skill, forbidden, `SKILL contains forbidden legacy form ${forbidden}`)
    }
  })

  it('grades the drill sub-branches: transport = context/report only, release = verify+cutover', () => {
    // Both drill keys must be documented.
    assert.match(skill, /selfheal\.drill:transport_v1/)
    assert.match(skill, /selfheal\.drill:release_v1/)

    // The drill section splits into a transport sub-branch then a release
    // sub-branch, both before `## 流程`. Anchor on the stable sub-headers.
    const drillStart = skill.indexOf('## 演练')
    const transportStart = skill.indexOf('### 传输演练')
    const releaseStart = skill.indexOf('### 放行演练')
    const drillEnd = skill.indexOf('## 流程')
    assert.ok(
      drillStart >= 0 &&
        transportStart > drillStart &&
        releaseStart > transportStart &&
        drillEnd > releaseStart,
      'drill section must carry a transport sub-branch then a release sub-branch, before ## 流程',
    )

    // Transport sub-branch: names its key and NEVER escalates to verify/cutover.
    const transport = skill.slice(transportStart, releaseStart)
    assert.match(transport, /selfheal\.drill:transport_v1/)
    assert.doesNotMatch(
      transport,
      /oc-selfheal\s+(verify|cutover)/,
      'transport drill must stay context/report only',
    )

    // Release sub-branch: names its key AND drives the full verify→cutover
    // release lane, appending to the release-drill ledger.
    const release = skill.slice(releaseStart, drillEnd)
    assert.match(release, /selfheal\.drill:release_v1/)
    assert.match(release, /oc-selfheal\s+verify/, 'release drill must verify the drill commit')
    assert.match(release, /oc-selfheal\s+cutover/, 'release drill must cutover the drill commit')
    assert.match(release, /RELEASE_DRILLS\.md/, 'release drill must append to the release-drill ledger')
  })
})

describe('SKILL examples parse under the real CLI (spawned)', () => {
  const SOCK = join(mkdtempSync(join(tmpdir(), 'oc-skill-')), 'broker.sock')
  let server: Server

  before(async () => {
    server = createServer((conn) => {
      let buf = ''
      conn.setEncoding('utf8')
      conn.on('data', (chunk: string) => {
        buf += chunk
        if (!buf.includes('\n')) return
        conn.write(`${JSON.stringify({ ok: true, status: 'ok' })}\n`)
        conn.end()
      })
    })
    await new Promise<void>((r) => server.listen(SOCK, r))
  })
  after(() => server.close())

  function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolveRun) => {
      execFile(
        process.execPath,
        [CLI, ...args],
        { env: { ...process.env, OC_SELFHEAL_BROKER_SOCK: SOCK, OC_SELFHEAL_CLI_TIMEOUT_MS: '5000' } },
        (err, _stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === 'number'
              ? ((err as { code?: number }).code ?? 1)
              : err ? 1 : 0
          resolveRun({ code, stderr: String(stderr) })
        },
      )
    })
  }

  it('every SKILL invocation, concretized, is accepted by the CLI parser', async () => {
    const SHA = 'a'.repeat(40)
    for (const tokens of skillInvocations()) {
      // Concretize the SKILL's placeholders the way a repair session would.
      const args = tokens.map((t) =>
        t
          .replace(/^<repairId>$/, 'r-contract-1')
          .replace(/^<你的\s?40\s?位 commit sha>$/u, SHA)
          .replace(/^<sha>$/, SHA)
          .replace(/^\[verificationRef\]$/, 'r-contract-1'),
      )
      // Multi-outcome usage line (`progress|done|failed`) expands to each.
      const variants =
        args[1] === 'r-contract-1' && (args[2] ?? '').includes('|')
          ? args[2]!.split('|').map((o) => [args[0]!, args[1]!, o, 'msg'])
          : [args.map((t) => t.replace(/^<message>.*$/, 'msg').replace(/^"<.*>"$/, 'msg'))]
      for (const v of variants) {
        const cleaned = v.map((t) => t.replace(/^"|"$/g, '')).filter((t) => !/^\[.*\]$/.test(t))
        const { code, stderr } = await runCli(cleaned)
        assert.notEqual(code, 2, `usage error for: oc-selfheal ${cleaned.join(' ')} — ${stderr}`)
      }
    }
  })
})

describe('repair prompt teaches the same contract', () => {
  it('prompt lists exactly the four subcommands and defers to the SKILL only for routing', () => {
    const prompt = buildRepairPrompt('r-prompt-1', '/home/ocheal/selfheal/r-prompt-1')
    for (const sub of CLI_SUBCOMMANDS) {
      assert.ok(prompt.includes(`oc-selfheal ${sub} r-prompt-1`), `prompt must teach "${sub}"`)
    }
    for (const forbidden of ['oc-selfheal ack', 'oc-selfheal broker', 'prepare_clone']) {
      assert.ok(!prompt.includes(forbidden), `prompt contains forbidden legacy form ${forbidden}`)
    }
    assert.match(prompt, /v5-incident-repair/)
    assert.match(prompt, /冲突/, 'prompt must tell the model how to handle a contract conflict')
  })
})
