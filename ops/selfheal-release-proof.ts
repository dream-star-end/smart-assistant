/**
 * selfheal-release-proof — per-surface, READ-ONLY proof that a self-heal release
 * actually took effect on the production host (kl-mirror).
 *
 * TRUST MODEL — read carefully:
 *   - This is TRUSTED (TCB) code, run from the personal repo by the release lane
 *     AFTER `deploy-v5.sh` returns. It NEVER executes candidate-controlled code:
 *     every probe is a read-only remote command (curl a health/version endpoint,
 *     `jq`/`grep`/`readlink` on files the deploy already placed, a single
 *     read-only `SELECT` against deploy_state). It reads *effects*, it never runs
 *     the candidate's package.json scripts / hooks / binaries.
 *   - FAIL-CLOSED EVERYWHERE. Any probe error, garbage output, unset config, or
 *     indeterminate state degrades the affected face to `applied:'unknown'`,
 *     which forces the overall verdict to `deploy_unknown`. We only ever declare
 *     `deployed` when EVERY touched face is positively proven applied, and only
 *     ever declare `deploy_failed` when EVERY touched face is positively proven
 *     NOT-applied. When in doubt → `deploy_unknown` (the worker then engages the
 *     global fuse and waits for a human).
 *
 * SHA BINDING (batch1b §F1) — every face anchors on the CANDIDATE sha, never on
 * a "current active == target" self-proof:
 *   - master : /version.commit is a prefix of sha AND deploy_state.active_release
 *              dir VERSION.json.commit is a prefix of sha AND phase=stable;
 *   - web    : the active_release dir is bound to sha via its VERSION.json, and
 *              the live oc-build == that release dir's dist oc-build (closure);
 *   - egress : the unit is active, /proc/<pid>/cwd points at a release dir whose
 *              VERSION.json is bound to sha, and egress-health is 200;
 *   - runtime-source / platform-runtime : the live tuple env
 *              (OC_RUNTIME_RELEASE / OC_PLATFORM_BUNDLE) points at a release /
 *              bundle whose MANIFEST.json.sourceCommit == sha (full 40-hex —
 *              the field oc_hotcfg_build_manifest writes with --arg sourceCommit);
 *   - slot   : deploy_state.active_release agrees with the active symlink readback
 *              AND that release dir's VERSION.json is bound to sha.
 *   VERSION.json.commit is the SHORT sha `write_version` pins (a prefix of the
 *   full sha), so master/web/egress/slot compare by prefix; the runtime/platform
 *   MANIFEST.sourceCommit is the full 40-hex, compared for equality.
 *
 * SLOT face:
 *   The slot face proves deploy_state.active_release and the active symlink agree
 *   AND that release dir is bound to sha (VERSION.json). If the symlink resolves
 *   outside the releases root, or deploy_state and the symlink disagree, or the
 *   release is a DIFFERENT sha (rollback), slot is `unknown` (never a definitive
 *   `no` — the slot face alone can't prove a *clean* rollback). It is proven only
 *   for plans that stage a new release dir (web / runtime / platform / egress); a
 *   master-only backend release is fully covered by the master face, which keeps
 *   `deploy_failed` reachable for a rolled-back master-only release.
 *
 * All external commands go through an injectable {@link CommandRunner} so this
 * module is unit-testable without real ssh / curl / psql.
 */

import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// ── injectable command runner (mirrors selfheal/brokerActions.ts shape) ──────

/** Outcome of running an external command. */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Optional per-command execution controls. */
export interface RunOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** Injectable, shell-free command runner. Args MUST be passed as an array (no
 *  shell) — a security invariant. */
export type CommandRunner = (cmd: string, args: string[], opts?: RunOpts) => Promise<RunResult>

export interface ProofDeps {
  run: CommandRunner
}

/** Default shell-free runner (execFile — args as array, no shell). Any spawn
 *  error / timeout resolves to a nonzero code so callers fail closed. */
export const defaultCommandRunner: CommandRunner = (cmd, args, opts) =>
  new Promise<RunResult>((resolve) => {
    execFile(
      cmd,
      args,
      {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 25 * 1000,
        cwd: opts?.cwd,
        env: opts?.env,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((err as unknown as { code: number }).code as number)
            : err
              ? 1
              : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })

// ── config & args ────────────────────────────────────────────────────────────

export interface ProofConfig {
  klHost: string
  /** Remote env file (holds DATABASE_URL + OC_RUNTIME_RELEASE/OC_PLATFORM_BUNDLE).
   *  '' when unset → deploy_state / tuple probes are unknown (fail-closed). */
  v5Env: string
  /** Active release symlink on the remote host. */
  remoteSrc: string
  /** Service port for /version and / (dist). '' when unset → master/web unknown. */
  v5Port: string
  releasesRoot: string
  egressHealthUrl: string
  egressUnit: string
}

export interface ProveArgs {
  sha: string
  /** Touched surfaces from proofPlan.surfaces. */
  surfaces: string[]
  cfg: ProofConfig
}

export type Applied = 'yes' | 'no' | 'unknown'

export interface FaceResult {
  ok: boolean
  detail: string
  applied: Applied
}

export type Verdict = 'deployed' | 'deploy_failed' | 'deploy_unknown'

export interface ProofOutput {
  faces: Record<string, { ok: boolean; detail: string }>
  allOk: boolean
  verdict: Verdict
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProofConfig {
  return {
    klHost: env.KL_HOST || 'kl-mirror',
    v5Env: (env.OC_SELFHEAL_V5_ENV || '').trim(),
    remoteSrc: (env.OC_SELFHEAL_V5_REMOTE_SRC || '/opt/openclaude/openclaude-v5').trim(),
    v5Port: (env.OC_SELFHEAL_V5_PORT || '').trim(),
    releasesRoot: (env.OC_SELFHEAL_V5_RELEASES_ROOT || '/opt/openclaude/openclaude-v5-releases').trim(),
    egressHealthUrl:
      (env.OC_SELFHEAL_V5_EGRESS_HEALTH_URL || 'http://172.31.0.1:18892/internal/v5/egress-health').trim(),
    egressUnit: (env.OC_SELFHEAL_V5_EGRESS_UNIT || 'openclaude-v5-egress.service').trim(),
  }
}

// ── small parse helpers ──────────────────────────────────────────────────────

const COMMIT_RE = /^[0-9a-f]{7,40}$/
const OC_BUILD_RE = /name="oc-build"\s+content="([0-9a-f]{8,32})"/

function shaHasPrefix(sha: string, commit: string): boolean {
  return COMMIT_RE.test(commit) && sha.startsWith(commit)
}

function extractOcBuild(html: string): string | null {
  const m = OC_BUILD_RE.exec(html)
  return m ? m[1] : null
}

function firstJsonCommit(raw: string): string | null {
  try {
    const v = JSON.parse(raw)
    if (v && typeof v.commit === 'string' && COMMIT_RE.test(v.commit)) return v.commit
  } catch {
    /* fall through */
  }
  return null
}

/** Run a remote read-only command via `ssh <host> <script>`. */
async function ssh(deps: ProofDeps, cfg: ProofConfig, script: string): Promise<RunResult> {
  return deps.run('ssh', [cfg.klHost, script])
}

// ── deploy_state (read-only SELECT; shared by master + slot) ─────────────────

interface DeployState {
  phase: string
  activeSlot: string
  candidateSlot: string
  activeRelease: string
  candidateRelease: string
}

async function loadDeployState(deps: ProofDeps, cfg: ProofConfig): Promise<DeployState | null> {
  if (!cfg.v5Env) return null
  const sql =
    "SELECT phase ||'|'|| active_slot ||'|'|| coalesce(candidate_slot,'') ||'|'|| " +
    "coalesce(active_release,'') ||'|'|| coalesce(candidate_release,'') " +
    'FROM deploy_state ORDER BY generation DESC LIMIT 1;'
  const script =
    `set -a; . '${cfg.v5Env}' 2>/dev/null; ` +
    `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c "${sql}"`
  const r = await ssh(deps, cfg, script)
  if (r.code !== 0) return null
  const row = r.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!row || !row.includes('|')) return null
  const parts = row.split('|')
  if (parts.length < 5) return null
  return {
    phase: parts[0],
    activeSlot: parts[1],
    candidateSlot: parts[2],
    activeRelease: parts[3],
    candidateRelease: parts[4],
  }
}

/** Normalize deploy_state.active_release to an absolute release dir (it is
 *  usually absolute; a relative value is resolved under the releases root, the
 *  same fallback deploy-v5.sh applies). '' when the state has no active release. */
function activeReleaseDir(cfg: ProofConfig, ds: DeployState): string {
  const ar = ds.activeRelease.trim()
  if (!ar) return ''
  return ar.startsWith('/') ? ar : `${cfg.releasesRoot}/${ar}`
}

/** Read `<dir>/VERSION.json`.commit (the SHORT sha `write_version` pins). Returns
 *  the commit string, or null on any probe error / non-commit output. */
async function readReleaseCommit(
  deps: ProofDeps,
  cfg: ProofConfig,
  dir: string,
): Promise<string | null> {
  if (!dir) return null
  const r = await ssh(deps, cfg, `jq -er '.commit' '${dir}/VERSION.json'`)
  if (r.code !== 0) return null
  const commit = r.stdout.trim()
  return COMMIT_RE.test(commit) ? commit : null
}

// ── face probes (all read-only, all fail-closed) ─────────────────────────────

async function proveMaster(
  deps: ProofDeps,
  cfg: ProofConfig,
  sha: string,
  ds: DeployState | null,
): Promise<FaceResult> {
  if (!cfg.v5Port) return { ok: false, detail: 'v5_port_unset', applied: 'unknown' }
  if (!ds) return { ok: false, detail: 'deploy_state_unreadable', applied: 'unknown' }
  const dir = activeReleaseDir(cfg, ds)
  if (!dir) return { ok: false, detail: 'active_release_unset', applied: 'unknown' }

  const vres = await ssh(deps, cfg, `curl -fsS http://127.0.0.1:${cfg.v5Port}/version`)
  if (vres.code !== 0) return { ok: false, detail: 'version_probe_error', applied: 'unknown' }
  const liveCommit = firstJsonCommit(vres.stdout)

  // Bind to sha via the ACTIVE RELEASE dir's VERSION.json (authoritative from
  // deploy_state.active_release), not the ambient symlink.
  const relCommit = await readReleaseCommit(deps, cfg, dir)
  if (!liveCommit || !relCommit) {
    return { ok: false, detail: 'commit_indeterminate', applied: 'unknown' }
  }
  const phaseStable = ds.phase === 'stable'
  const liveMatch = shaHasPrefix(sha, liveCommit)
  const relMatch = shaHasPrefix(sha, relCommit)

  if (liveMatch && relMatch && phaseStable) {
    return { ok: true, detail: `commit=${liveCommit} phase=stable`, applied: 'yes' }
  }
  // Definitive not-applied: /version and the active release VERSION.json agree on
  // the same *different* commit and the host is settled (phase=stable) → a clean
  // rollback to another commit.
  if (phaseStable && liveCommit === relCommit && !liveMatch) {
    return { ok: false, detail: `rolled_back commit=${liveCommit} != sha`, applied: 'no' }
  }
  return {
    ok: false,
    detail: `indeterminate live=${liveCommit} rel=${relCommit} phase=${ds.phase}`,
    applied: 'unknown',
  }
}

async function proveWeb(
  deps: ProofDeps,
  cfg: ProofConfig,
  sha: string,
  ds: DeployState | null,
): Promise<FaceResult> {
  if (!cfg.v5Port) return { ok: false, detail: 'v5_port_unset', applied: 'unknown' }
  if (!ds) return { ok: false, detail: 'deploy_state_unreadable', applied: 'unknown' }
  const dir = activeReleaseDir(cfg, ds)
  if (!dir) return { ok: false, detail: 'active_release_unset', applied: 'unknown' }

  // Anchor: the active release dir MUST be bound to sha (VERSION.json). Once it
  // is, comparing the live oc-build to THAT dir's dist oc-build closes on sha —
  // a rollback to an old release fails this bind and is never 'deployed'.
  const relCommit = await readReleaseCommit(deps, cfg, dir)
  if (!relCommit) return { ok: false, detail: 'web_release_version_unreadable', applied: 'unknown' }
  if (!shaHasPrefix(sha, relCommit)) {
    return { ok: false, detail: `web_release_not_sha commit=${relCommit}`, applied: 'unknown' }
  }

  const live = await ssh(deps, cfg, `curl -fsS http://127.0.0.1:${cfg.v5Port}/`)
  if (live.code !== 0) return { ok: false, detail: 'web_live_probe_error', applied: 'unknown' }
  const liveId = extractOcBuild(live.stdout)
  if (!liveId) return { ok: false, detail: 'web_live_build_unreadable', applied: 'unknown' }

  const target = await ssh(
    deps,
    cfg,
    `grep -o 'name="oc-build" content="[0-9a-f]\\{8,32\\}"' ` +
      `'${dir}/packages/web-react/dist/index.html'`,
  )
  if (target.code !== 0) return { ok: false, detail: 'web_target_probe_error', applied: 'unknown' }
  const targetId = extractOcBuild(target.stdout)
  if (!targetId) return { ok: false, detail: 'web_target_build_unreadable', applied: 'unknown' }

  // Web cannot prove a clean rollback, so a mismatch is indeterminate, never `no`.
  if (liveId === targetId) return { ok: true, detail: `oc-build=${liveId} @sha`, applied: 'yes' }
  return { ok: false, detail: `web_build_mismatch live=${liveId} target=${targetId}`, applied: 'unknown' }
}

async function proveEgress(deps: ProofDeps, cfg: ProofConfig, sha: string): Promise<FaceResult> {
  // Combined single-round probe (mirrors deploy-v5.sh egress_release_ready_once):
  // line0=is-active, line1=MainPID, line2=/proc/<pid>/cwd, line3=<cwd>/VERSION.json
  // .commit (sha binding), line4=base64(health JSON).
  const script =
    `state=$(systemctl is-active ${cfg.egressUnit} 2>/dev/null||true); ` +
    `pid=$(systemctl show -p MainPID --value ${cfg.egressUnit} 2>/dev/null||true); ` +
    `cwd=''; [[ $pid =~ ^[1-9][0-9]*$ ]] && cwd=$(readlink -f /proc/$pid/cwd 2>/dev/null||true); ` +
    `rel=''; [[ -n $cwd ]] && rel=$(jq -er '.commit' "$cwd/VERSION.json" 2>/dev/null||true); ` +
    `hz=$(curl -fsS --max-time 8 ${cfg.egressHealthUrl} 2>/dev/null||true); ` +
    `printf '%s\\n%s\\n%s\\n%s\\n' "$state" "$pid" "$cwd" "$rel"; printf '%s' "$hz" | base64 -w0`
  const r = await ssh(deps, cfg, script)
  if (r.code !== 0) return { ok: false, detail: 'egress_probe_error', applied: 'unknown' }
  const lines = r.stdout.split('\n')
  const state = (lines[0] ?? '').trim()
  const cwd = (lines[2] ?? '').trim()
  const relCommit = (lines[3] ?? '').trim()
  const b64 = (lines[4] ?? '').trim()
  if (state !== 'active') return { ok: false, detail: `egress_unit_${state || 'unknown'}`, applied: 'unknown' }
  if (!cwd || !cwd.startsWith(cfg.releasesRoot + '/')) {
    return { ok: false, detail: 'egress_cwd_off_release', applied: 'unknown' }
  }
  // sha binding: the release the egress process runs from must be sha's release.
  if (!COMMIT_RE.test(relCommit)) {
    return { ok: false, detail: 'egress_release_version_unreadable', applied: 'unknown' }
  }
  if (!shaHasPrefix(sha, relCommit)) {
    return { ok: false, detail: `egress_release_not_sha commit=${relCommit}`, applied: 'unknown' }
  }
  let health: unknown
  try {
    health = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  } catch {
    return { ok: false, detail: 'egress_health_unreadable', applied: 'unknown' }
  }
  const h = health as { ok?: unknown; role?: unknown } | null
  if (!h || h.ok !== true || h.role !== 'egress') {
    return { ok: false, detail: 'egress_health_not_ok', applied: 'unknown' }
  }
  return { ok: true, detail: `active cwd=${cwd} @sha`, applied: 'yes' }
}

async function proveTuple(
  deps: ProofDeps,
  cfg: ProofConfig,
  sha: string,
  which: 'runtime' | 'platform',
): Promise<FaceResult> {
  if (!cfg.v5Env) return { ok: false, detail: 'v5_env_unset', applied: 'unknown' }
  const key = which === 'runtime' ? 'OC_RUNTIME_RELEASE' : 'OC_PLATFORM_BUNDLE'
  // Read the live tuple env value (the release/bundle DIR), then bind it to sha
  // via that dir's MANIFEST.json.sourceCommit (full 40-hex — the field
  // oc_hotcfg_build_manifest writes). No caller-supplied "expected digest".
  const script =
    `v=$(grep -E '^[[:space:]]*${key}=' '${cfg.v5Env}' 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]'); ` +
    `printf '%s\\n' "$v"; ` +
    `[ -n "$v" ] && jq -er '.sourceCommit' "$v/MANIFEST.json" 2>/dev/null || true`
  const r = await ssh(deps, cfg, script)
  if (r.code !== 0) return { ok: false, detail: `${key}_probe_error`, applied: 'unknown' }
  const lines = r.stdout.split('\n')
  const live = (lines[0] ?? '').trim().replace(/^["']|["']$/g, '').trim()
  const sourceCommit = (lines[1] ?? '').trim()
  if (!live) return { ok: false, detail: `${key}_live_empty`, applied: 'unknown' }
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    return { ok: false, detail: `${key}_manifest_unreadable`, applied: 'unknown' }
  }
  if (sourceCommit === sha) return { ok: true, detail: `${key} sourceCommit@sha`, applied: 'yes' }
  // A concrete, readable manifest bound to a DIFFERENT full sha → a clean other
  // release is live → definitively not-applied.
  return { ok: false, detail: `${key}_source_mismatch ${sourceCommit}`, applied: 'no' }
}

async function proveSlot(
  deps: ProofDeps,
  cfg: ProofConfig,
  sha: string,
  ds: DeployState | null,
): Promise<FaceResult> {
  if (!ds) return { ok: false, detail: 'deploy_state_unreadable', applied: 'unknown' }
  if (ds.activeSlot !== 'A' && ds.activeSlot !== 'B') {
    return { ok: false, detail: `active_slot_${ds.activeSlot || 'unset'}`, applied: 'unknown' }
  }
  const dir = activeReleaseDir(cfg, ds)
  if (!dir) return { ok: false, detail: 'active_release_unset', applied: 'unknown' }
  const r = await ssh(
    deps,
    cfg,
    `test -L '${cfg.remoteSrc}' && readlink -f '${cfg.remoteSrc}' || true`,
  )
  if (r.code !== 0) return { ok: false, detail: 'slot_symlink_probe_error', applied: 'unknown' }
  const target = r.stdout.trim()
  if (!target) return { ok: false, detail: 'slot_symlink_missing', applied: 'unknown' }
  if (!target.startsWith(cfg.releasesRoot + '/')) {
    // Symlink resolves outside the releases root → broken/ambiguous → unknown.
    return { ok: false, detail: `slot_off_release ${target}`, applied: 'unknown' }
  }
  // deploy_state.active_release must AGREE with the live symlink readback.
  if (target !== dir) {
    return { ok: false, detail: `slot_state_symlink_disagree state=${dir} link=${target}`, applied: 'unknown' }
  }
  // …and that agreed release dir must be bound to sha.
  const relCommit = await readReleaseCommit(deps, cfg, dir)
  if (!relCommit) return { ok: false, detail: 'slot_release_version_unreadable', applied: 'unknown' }
  if (shaHasPrefix(sha, relCommit)) {
    return { ok: true, detail: `slot=${ds.activeSlot} → ${target} @sha`, applied: 'yes' }
  }
  // A different release is active (rollback) — slot can't prove a *clean* rollback
  // on its own → unknown (never `no`).
  return { ok: false, detail: `slot_release_not_sha commit=${relCommit}`, applied: 'unknown' }
}

// ── orchestration ────────────────────────────────────────────────────────────

const STAGING_SURFACES = ['web', 'runtime-source', 'platform-runtime', 'egress']

function computeVerdict(faces: FaceResult[]): { allOk: boolean; verdict: Verdict } {
  const allOk = faces.length > 0 && faces.every((f) => f.ok === true)
  let verdict: Verdict
  if (faces.length === 0) verdict = 'deploy_unknown'
  else if (faces.some((f) => f.applied === 'unknown')) verdict = 'deploy_unknown'
  else if (faces.some((f) => f.ok === false && f.applied !== 'no')) verdict = 'deploy_unknown'
  else if (faces.every((f) => f.ok === true)) verdict = 'deployed'
  else if (faces.every((f) => f.applied === 'no')) verdict = 'deploy_failed'
  else verdict = 'deploy_unknown'
  return { allOk, verdict }
}

export async function proveSurfaces(args: ProveArgs, deps: ProofDeps): Promise<ProofOutput> {
  const { sha, surfaces, cfg } = args
  const set = new Set(surfaces)
  const faces: Record<string, FaceResult> = {}
  const ds = await loadDeployState(deps, cfg)

  if (set.has('master')) faces.master = await proveMaster(deps, cfg, sha, ds)
  if (set.has('web')) faces.web = await proveWeb(deps, cfg, sha, ds)
  if (set.has('egress')) faces.egress = await proveEgress(deps, cfg, sha)
  if (set.has('runtime-source')) faces.runtime = await proveTuple(deps, cfg, sha, 'runtime')
  if (set.has('platform-runtime')) faces.platform = await proveTuple(deps, cfg, sha, 'platform')

  // Slot is proven only for plans that stage a new release dir (see file header).
  if (STAGING_SURFACES.some((s) => set.has(s))) {
    faces.slot = await proveSlot(deps, cfg, sha, ds)
  }

  const list = Object.values(faces)
  const { allOk, verdict } = computeVerdict(list)

  const out: Record<string, { ok: boolean; detail: string }> = {}
  for (const [k, v] of Object.entries(faces)) out[k] = { ok: v.ok, detail: v.detail }
  return { faces: out, allOk, verdict }
}

// ── main (fail-closed CLI wrapper — never crashes the lane) ──────────────────

const FAIL_CLOSED: ProofOutput = { faces: {}, allOk: false, verdict: 'deploy_unknown' }

function printUsage(): void {
  process.stdout.write(
    [
      'usage: selfheal-release-proof.ts <argsFile>',
      '',
      'Reads argsFile (JSON: {sha, proofPlan:{surfaces:[…]}}), runs READ-ONLY',
      'per-surface proofs against the production host, and prints a single JSON',
      'object: {"faces":{…},"allOk":bool,"verdict":"deployed|deploy_failed|deploy_unknown"}.',
      'Always exits 0; any error prints the fail-closed deploy_unknown object.',
      '',
      'Config env: KL_HOST, OC_SELFHEAL_V5_ENV, OC_SELFHEAL_V5_REMOTE_SRC,',
      '  OC_SELFHEAL_V5_PORT, OC_SELFHEAL_V5_RELEASES_ROOT,',
      '  OC_SELFHEAL_V5_EGRESS_HEALTH_URL, OC_SELFHEAL_V5_EGRESS_UNIT.',
      '',
    ].join('\n'),
  )
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    process.exit(0)
  }
  const emit = (out: ProofOutput): never => {
    process.stdout.write(JSON.stringify(out) + '\n')
    process.exit(0)
  }
  const argsFile = argv[0]
  if (!argsFile) return emit(FAIL_CLOSED)

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(argsFile, 'utf8'))
  } catch {
    return emit(FAIL_CLOSED)
  }
  const obj = parsed as { sha?: unknown; proofPlan?: { surfaces?: unknown } } | null
  const sha = obj?.sha
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return emit(FAIL_CLOSED)
  const surfaces = obj?.proofPlan?.surfaces
  if (!Array.isArray(surfaces) || !surfaces.every((s) => typeof s === 'string')) {
    return emit(FAIL_CLOSED)
  }

  const cfg = configFromEnv()
  try {
    const out = await proveSurfaces({ sha, surfaces: surfaces as string[], cfg }, { run: defaultCommandRunner })
    return emit(out)
  } catch {
    return emit(FAIL_CLOSED)
  }
}

// Run main() only when invoked directly (not when imported by a test).
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  void main()
}
