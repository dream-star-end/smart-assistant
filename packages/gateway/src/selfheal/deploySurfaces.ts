/**
 * Self-heal deploy-surface classifier (batch1b §7 — core TCB module).
 *
 * Given a validated candidate `sha` and the canonical HEAD it will fast-forward
 * onto (`baseSha`), decide — FAIL-CLOSED — which production deploy surfaces the
 * change touches, the exact `deploy-v5.sh` argv, and whether any path must be
 * routed to a HUMAN offline deploy (`manual`). The decision is driven entirely
 * by a versioned, trusted manifest that lives in the canonical v5 repo; this
 * module reads the PRE-MERGE trusted copy (`git show <branch>:<path>`), never a
 * file from the candidate clone.
 *
 * Discipline (RFC §3 / §6):
 *  - NUL-separated raw diff (`--raw -z`), so mode/status are authoritative and a
 *    rename can never smuggle a manual-only path past a name-only glob.
 *  - rename/copy → BOTH paths, and the R/C status ITSELF is manual.
 *  - delete → classify the OLD path.
 *  - symlink (120000) / gitlink (160000) / typechange (T) / unmerged (U) /
 *    unknown (X) / malformed record / absolute path / `..` traversal → manual.
 *  - manual glob hit → manual; otherwise collect EVERY matching surface rule
 *    (no first-match); ZERO surface match → manual (`unmatched_path`).
 *  - ANY manual path → the whole plan is manual_required.
 *  - unknown manifest schema / version / shape → {@link ManifestInvalidError}
 *    (the caller treats a throw as a hard cutover refusal, fail-closed).
 *
 * The classifier is pure w.r.t. the filesystem except for the two injectable
 * git reads, so it is fully unit-testable with fixture strings.
 */

import { createHash } from 'node:crypto'
import type { CommandRunner } from './brokerActions.js'
import { DEFAULT_VERIFICATION_LAYERS, defaultCommandRunner, stableStringify } from './verifier.js'

/** Canonical location of the trusted manifest inside the v5 repo (owned by the
 *  V5-DEPLOY track; this module only READS the pre-merge blob). */
export const DEPLOY_SURFACES_MANIFEST_PATH = 'deploy/v5/selfheal-deploy-surfaces.json'

/** Manifest schema id + the manifest versions this classifier understands. An
 *  unknown version is fail-closed (throws) — a future manifest format must ship
 *  with the classifier that understands it, never be silently mis-read. */
export const DEPLOY_SURFACES_SCHEMA = 'selfheal-deploy-surfaces'
export const KNOWN_MANIFEST_VERSIONS = new Set<number>([1])

/** The only surface names the argv synthesizer knows how to deploy. A manifest
 *  that names any other surface is invalid (fail-closed). */
export const KNOWN_SURFACES = new Set<string>([
  'master',
  'web',
  'runtime-source',
  'platform-runtime',
  'egress',
])

/** Surfaces (other than `web`) whose presence forces `--with-dist` when `web`
 *  is also touched, and a plain `deploy-v5.sh` otherwise. */
const CODE_SURFACES = new Set<string>(['master', 'runtime-source', 'platform-runtime', 'egress'])

/** Default verify layers, always in the plan; surface-specific layers are added
 *  on top (union). Derived from the verifier so the two never drift. */
const DEFAULT_LAYER_NAMES = DEFAULT_VERIFICATION_LAYERS.map((l) => l.name)

/** Layer/script name shape — same allowlist the verifier's fail-closed extra
 *  layer gate uses. */
const LAYER_NAME_RE = /^[a-z0-9:_-]+$/
/** Full 40-char hex commit. */
const SHA_RE = /^[0-9a-f]{40}$/
/** A single raw-diff metadata line: `:oldmode newmode oldsha newsha STATUS[score]`. */
const RAW_META_RE = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d+)?$/
/** Defensive branch shape for the `git show` ref (config-sourced, not user input). */
const REF_RE = /^[A-Za-z0-9._/-]+$/

export class ManifestInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestInvalidError'
  }
}

export interface DeploySurfaceDef {
  /** Extra verify layers this surface pulls in beyond the defaults. */
  verifyLayers?: string[]
  /** Deploy axis this surface requires to be ENABLED on the remote before the
   *  release lane may cut over (batch1b §F4). `runtime-source`→'runtime-release',
   *  `platform-runtime`→'platform-bundle'; null/absent = no axis. Retained through
   *  parsing (never dropped) so the classifier can surface {@link Classification.requiredAxes}. */
  requiresAxis?: string
}

export interface DeployRule {
  /** Prefix-anchored glob (`*` = one segment, `**` = across segments). */
  glob: string
  /** Surface this path maps to; must be a key of {@link TrustedManifest.surfaces}. */
  surface: string
}

export interface ManualGlob {
  glob: string
  /** Human note from the manifest (docs/playbook provenance); not used in matching. */
  note?: string
}

export interface TrustedManifest {
  schema: typeof DEPLOY_SURFACES_SCHEMA
  version: number
  surfaces: Record<string, DeploySurfaceDef>
  rules: DeployRule[]
  /** Manual-only globs (highest priority; a hit short-circuits to manual). */
  manual: ManualGlob[]
  /** sha256 (hex) of the raw manifest bytes — frozen into the deploy plan. */
  manifestHash: string
  /** Alias of `version`, surfaced in the classification for the plan hash. */
  manifestVersion: number
}

export interface ManualEntry {
  path: string
  reason: string
}

export interface Classification {
  /** Sorted, de-duplicated surfaces the change deploys to. */
  surfaces: string[]
  /** Exact `deploy-v5.sh` argv (empty when manual short-circuits). */
  deployArgs: string[]
  /** Non-empty ⇒ manual_required; lists every manual path + reason. */
  manual: ManualEntry[]
  /** DEFAULT ∪ hit-surface verify layers, sorted. */
  verifyLayers: string[]
  /** Deduped, sorted deploy axes the hit surfaces require enabled on the remote
   *  (batch1b §F4). The release lane refuses (manual, reason='axis_not_enabled')
   *  before merging if any axis is not enabled. Part of the plan hash. */
  requiredAxes: string[]
  /** Every changed path (both sides of a rename), capped for transport. */
  changedFiles: { paths: string[]; total: number }
  manifestVersion: number
  manifestHash: string
  /** sha256 over the order-stable plan (see {@link computeDeployPlanHash}). */
  deployPlanHash: string
}

/** Cap on the number of changed-file paths carried in the plan / callback. */
export const CHANGED_FILES_CAP = 500

// ── manifest loading + strict validation ─────────────────────────────────────

export interface ManifestLoadOpts {
  run?: CommandRunner
}

/**
 * Read + validate the trusted, pre-merge manifest from canonical. Throws
 * {@link ManifestInvalidError} on git failure OR any schema deviation (the
 * caller must treat that as a hard, fail-closed cutover refusal).
 */
export async function loadTrustedManifest(
  canonicalRepo: string,
  canonicalBranch: string,
  opts: ManifestLoadOpts = {},
): Promise<TrustedManifest> {
  const run = opts.run ?? defaultCommandRunner
  if (typeof canonicalRepo !== 'string' || canonicalRepo.length === 0) {
    throw new ManifestInvalidError('canonicalRepo is required')
  }
  if (typeof canonicalBranch !== 'string' || !REF_RE.test(canonicalBranch)) {
    throw new ManifestInvalidError('canonicalBranch has an illegal shape')
  }
  const show = await run('git', [
    '-C',
    canonicalRepo,
    'show',
    `${canonicalBranch}:${DEPLOY_SURFACES_MANIFEST_PATH}`,
  ])
  if (show.code !== 0) {
    throw new ManifestInvalidError(
      `git show ${DEPLOY_SURFACES_MANIFEST_PATH} failed (code ${show.code}): ${show.stderr.slice(0, 200)}`,
    )
  }
  return parseTrustedManifest(show.stdout)
}

/** Parse + strictly validate a manifest from its raw bytes. Exposed for tests
 *  and for callers that already hold the trusted blob. */
export function parseTrustedManifest(raw: string): TrustedManifest {
  // Hash the raw bytes BEFORE parsing so the frozen hash is over exactly what
  // canonical served (whitespace/newline included).
  const manifestHash = createHash('sha256').update(raw, 'utf8').digest('hex')
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new ManifestInvalidError('manifest is not valid JSON')
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new ManifestInvalidError('manifest must be a JSON object')
  }
  const m = doc as Record<string, unknown>
  // `_comment` is the v5-side manifest's provenance header (docs only, never matched).
  for (const k of Object.keys(m)) {
    if (!['schema', 'version', '_comment', 'surfaces', 'rules', 'manual'].includes(k)) {
      throw new ManifestInvalidError(`manifest has unexpected key "${k}"`)
    }
  }
  if (m._comment !== undefined && typeof m._comment !== 'string') {
    throw new ManifestInvalidError('manifest._comment must be a string when present')
  }
  if (m.schema !== DEPLOY_SURFACES_SCHEMA) {
    throw new ManifestInvalidError(`unknown manifest schema "${String(m.schema)}"`)
  }
  if (typeof m.version !== 'number' || !KNOWN_MANIFEST_VERSIONS.has(m.version)) {
    throw new ManifestInvalidError(`unknown manifest version ${String(m.version)}`)
  }

  // surfaces
  if (typeof m.surfaces !== 'object' || m.surfaces === null || Array.isArray(m.surfaces)) {
    throw new ManifestInvalidError('manifest.surfaces must be an object')
  }
  const surfaces: Record<string, DeploySurfaceDef> = {}
  for (const [name, rawDef] of Object.entries(m.surfaces as Record<string, unknown>)) {
    if (!KNOWN_SURFACES.has(name)) {
      throw new ManifestInvalidError(`manifest.surfaces has unknown surface "${name}"`)
    }
    if (typeof rawDef !== 'object' || rawDef === null || Array.isArray(rawDef)) {
      throw new ManifestInvalidError(`surface "${name}" must be an object`)
    }
    const def = rawDef as Record<string, unknown>
    // label/deployAction/note feed the v5-side playbook §4.1 generator; requiresAxis is
    // consumed by the release lane's pre-deploy axis assertion. All are docs/plan data —
    // matching correctness only ever depends on rules/manual + verifyLayers.
    for (const k of Object.keys(def)) {
      if (!['verifyLayers', 'label', 'deployAction', 'requiresAxis', 'note'].includes(k)) {
        throw new ManifestInvalidError(`surface "${name}" has unexpected key "${k}"`)
      }
    }
    for (const docKey of ['label', 'deployAction', 'note'] as const) {
      if (def[docKey] !== undefined && typeof def[docKey] !== 'string') {
        throw new ManifestInvalidError(`surface "${name}".${docKey} must be a string when present`)
      }
    }
    if (def.requiresAxis !== undefined && def.requiresAxis !== null && typeof def.requiresAxis !== 'string') {
      throw new ManifestInvalidError(`surface "${name}".requiresAxis must be a string or null`)
    }
    let verifyLayers: string[] | undefined
    if (def.verifyLayers !== undefined) {
      if (
        !Array.isArray(def.verifyLayers) ||
        !def.verifyLayers.every((x) => typeof x === 'string' && LAYER_NAME_RE.test(x))
      ) {
        throw new ManifestInvalidError(
          `surface "${name}".verifyLayers must be an array of [a-z0-9:_-] layer names`,
        )
      }
      verifyLayers = def.verifyLayers as string[]
    }
    const surfaceDef: DeploySurfaceDef = {}
    if (verifyLayers) surfaceDef.verifyLayers = verifyLayers
    // Retain a non-null requiresAxis (null = "no axis" → omit). This feeds the
    // classifier's requiredAxes, which the release lane's pre-deploy axis gate reads.
    if (typeof def.requiresAxis === 'string') surfaceDef.requiresAxis = def.requiresAxis
    surfaces[name] = surfaceDef
  }

  // rules
  if (!Array.isArray(m.rules)) {
    throw new ManifestInvalidError('manifest.rules must be an array')
  }
  const rules: DeployRule[] = []
  for (const rawRule of m.rules) {
    if (typeof rawRule !== 'object' || rawRule === null || Array.isArray(rawRule)) {
      throw new ManifestInvalidError('each manifest.rules entry must be an object')
    }
    const r = rawRule as Record<string, unknown>
    for (const k of Object.keys(r)) {
      if (k !== 'glob' && k !== 'surface' && k !== 'note') {
        throw new ManifestInvalidError(`rule has unexpected key "${k}"`)
      }
    }
    if (r.note !== undefined && typeof r.note !== 'string') {
      throw new ManifestInvalidError('rule.note must be a string when present')
    }
    if (typeof r.glob !== 'string' || r.glob.length === 0) {
      throw new ManifestInvalidError('rule.glob must be a non-empty string')
    }
    if (typeof r.surface !== 'string' || !surfaces[r.surface]) {
      throw new ManifestInvalidError(
        `rule.surface "${String(r.surface)}" is not a declared surface`,
      )
    }
    rules.push({ glob: r.glob, surface: r.surface })
  }

  // manual — array of { glob, note? } objects (the v5-side manifest carries a
  // provenance note per entry; matching only ever uses the glob).
  if (!Array.isArray(m.manual)) {
    throw new ManifestInvalidError('manifest.manual must be an array')
  }
  const manual: ManualGlob[] = []
  for (const rawEntry of m.manual) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new ManifestInvalidError('each manifest.manual entry must be an object')
    }
    const e = rawEntry as Record<string, unknown>
    for (const k of Object.keys(e)) {
      if (k !== 'glob' && k !== 'note') {
        throw new ManifestInvalidError(`manual entry has unexpected key "${k}"`)
      }
    }
    if (typeof e.glob !== 'string' || e.glob.length === 0) {
      throw new ManifestInvalidError('manual entry.glob must be a non-empty string')
    }
    if (e.note !== undefined && typeof e.note !== 'string') {
      throw new ManifestInvalidError('manual entry.note must be a string when present')
    }
    manual.push(e.note === undefined ? { glob: e.glob } : { glob: e.glob, note: e.note })
  }

  return {
    schema: DEPLOY_SURFACES_SCHEMA,
    version: m.version,
    surfaces,
    rules,
    manual,
    manifestHash,
    manifestVersion: m.version,
  }
}

// ── glob engine (no third-party dependency) ──────────────────────────────────

/**
 * Compile a manifest glob to a prefix-anchored, fully-anchored RegExp:
 *   `*`   → one path segment (never crosses `/`)
 *   `**`  → any characters INCLUDING `/`
 *   `**​/` → zero or more leading segments (so `**​/package.json` also matches a
 *           top-level `package.json`)
 * Every other char is matched literally.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '^'
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i += 1
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }
  re += '$'
  return new RegExp(re)
}

// ── raw -z parsing ───────────────────────────────────────────────────────────

interface RawRecord {
  oldMode: string
  newMode: string
  /** Single status letter (A/M/D/T/U/X/R/C). */
  status: string
  /** 1 path (A/M/D/T/U/X) or 2 (R/C: src, dst). */
  paths: string[]
  malformed: boolean
  /** Raw metadata token (for a malformed record's manual reason). */
  meta: string
}

/** Parse `git diff --raw -z` output into records. Each record is
 *  `<meta>\0<path>\0[<path2>\0]`; R/C carry two paths. */
export function parseRawZ(out: string): RawRecord[] {
  const tokens = out.split('\0')
  // Drop the single trailing '' produced by the final NUL terminator.
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop()
  const records: RawRecord[] = []
  let i = 0
  while (i < tokens.length) {
    const meta = tokens[i]
    const mm = RAW_META_RE.exec(meta)
    if (!meta.startsWith(':') || !mm) {
      records.push({ oldMode: '', newMode: '', status: '?', paths: [], malformed: true, meta })
      i += 1
      continue
    }
    const status = mm[5]
    const isRC = status === 'R' || status === 'C'
    const need = isRC ? 2 : 1
    const paths: string[] = []
    let ok = true
    for (let p = 0; p < need; p++) {
      const t = tokens[i + 1 + p]
      if (t === undefined) {
        ok = false
        break
      }
      paths.push(t)
    }
    records.push({
      oldMode: mm[1],
      newMode: mm[2],
      status,
      paths,
      malformed: !ok,
      meta,
    })
    if (!ok) break
    i += 1 + need
  }
  return records
}

function isSymlinkOrGitlink(mode: string): boolean {
  return mode === '120000' || mode === '160000'
}

function hasTraversal(path: string): boolean {
  return path.split('/').includes('..')
}

// ── classification ───────────────────────────────────────────────────────────

export interface ClassifyOpts {
  run?: CommandRunner
}

/**
 * Classify the diff `baseSha..sha` (in `repo`) against a trusted manifest.
 * Runs `git diff --raw -z --find-renames --find-copies` (shell-free). Rename /
 * copy detection is forced ON so R/C records surface and are marked manual —
 * over-conservative (more manual) is the intended fail-closed direction.
 */
export async function classifyDiff(
  repo: string,
  baseSha: string,
  sha: string,
  manifest: TrustedManifest,
  opts: ClassifyOpts = {},
): Promise<Classification> {
  const run = opts.run ?? defaultCommandRunner
  if (typeof repo !== 'string' || repo.length === 0) throw new Error('repo is required')
  if (!SHA_RE.test(baseSha)) throw new Error('baseSha must be a full 40-char hex commit')
  if (!SHA_RE.test(sha)) throw new Error('sha must be a full 40-char hex commit')

  const res = await run('git', [
    '-C',
    repo,
    'diff',
    '--raw',
    '-z',
    '--find-renames',
    '--find-copies',
    `${baseSha}..${sha}`,
  ])
  if (res.code !== 0) {
    throw new Error(`git diff --raw failed (code ${res.code}): ${res.stderr.slice(0, 200)}`)
  }

  const manualGlobs = manifest.manual.map((g) => ({ glob: g.glob, re: globToRegExp(g.glob) }))
  const ruleGlobs = manifest.rules.map((r) => ({ ...r, re: globToRegExp(r.glob) }))

  const manual: ManualEntry[] = []
  const surfaces = new Set<string>()
  const changed = new Set<string>()

  const addManual = (path: string, reason: string): void => {
    manual.push({ path, reason })
  }

  const classifyPath = (path: string): void => {
    if (typeof path !== 'string' || path.length === 0) {
      addManual(path ?? '', 'malformed_path')
      return
    }
    if (path.startsWith('/')) {
      addManual(path, 'absolute_path')
      return
    }
    if (hasTraversal(path)) {
      addManual(path, 'path_traversal')
      return
    }
    const manualHit = manualGlobs.find((g) => g.re.test(path))
    if (manualHit) {
      addManual(path, `manual_glob:${manualHit.glob}`)
      return
    }
    let matched = false
    for (const rule of ruleGlobs) {
      if (rule.re.test(path)) {
        surfaces.add(rule.surface)
        matched = true
      }
    }
    if (!matched) addManual(path, 'unmatched_path')
  }

  const records = parseRawZ(res.stdout)
  // Fail-closed at the classifier layer (batch1b §F10): a candidate that produces
  // ZERO raw-diff records against its base is never machine-deployable — an empty
  // diff means nothing to ship (or a broken/misresolved base). The classifier owns
  // this refusal rather than relying on a downstream worker re-check.
  if (records.length === 0) addManual('', 'empty_diff')
  for (const rec of records) {
    for (const p of rec.paths) changed.add(p)
    if (rec.malformed) {
      addManual(rec.paths[0] ?? rec.meta.slice(0, 120), 'malformed_diff_record')
      continue
    }
    // Mode-level manual (symlink/gitlink) wins regardless of status.
    if (isSymlinkOrGitlink(rec.oldMode) || isSymlinkOrGitlink(rec.newMode)) {
      const reason = rec.oldMode === '120000' || rec.newMode === '120000' ? 'symlink' : 'gitlink'
      for (const p of rec.paths) addManual(p, reason)
      continue
    }
    switch (rec.status) {
      case 'R':
      case 'C':
        // Both sides manual — a rename can never launder a manual-only path.
        for (const p of rec.paths) addManual(p, 'rename_copy')
        break
      case 'T':
        addManual(rec.paths[0], 'typechange')
        break
      case 'U':
        addManual(rec.paths[0], 'unmerged')
        break
      case 'A':
      case 'M':
      case 'D':
        // D's single path IS the old path — classify it.
        classifyPath(rec.paths[0])
        break
      default:
        addManual(rec.paths[0] ?? rec.meta.slice(0, 120), 'unknown_status')
    }
  }

  const surfacesArr = [...surfaces].sort()
  const deployArgs = manual.length > 0 ? [] : synthesizeDeployArgs(surfaces)
  const verifyLayers = computeVerifyLayers(surfaces, manifest)
  const requiredAxes = computeRequiredAxes(surfaces, manifest)
  const changedArr = [...changed]
  const changedFiles = { paths: changedArr.slice(0, CHANGED_FILES_CAP), total: changedArr.length }
  const deployPlanHash = computeDeployPlanHash({
    baseSha,
    sha,
    manifestVersion: manifest.manifestVersion,
    manifestHash: manifest.manifestHash,
    surfaces: surfacesArr,
    deployArgs,
    manual,
    verifyLayers,
    requiredAxes,
  })

  return {
    surfaces: surfacesArr,
    deployArgs,
    manual,
    verifyLayers,
    requiredAxes,
    changedFiles,
    manifestVersion: manifest.manifestVersion,
    manifestHash: manifest.manifestHash,
    deployPlanHash,
  }
}

/** master→[]; web-only→--dist; web+code→--with-dist; egress→append --egress. */
function synthesizeDeployArgs(surfaces: Set<string>): string[] {
  const hasWeb = surfaces.has('web')
  const hasCode = [...surfaces].some((s) => CODE_SURFACES.has(s))
  let args: string[]
  if (hasWeb && hasCode) args = ['--with-dist']
  else if (hasWeb) args = ['--dist']
  else args = []
  if (surfaces.has('egress')) args.push('--egress')
  return args
}

function computeVerifyLayers(surfaces: Set<string>, manifest: TrustedManifest): string[] {
  const layers = new Set<string>(DEFAULT_LAYER_NAMES)
  for (const s of surfaces) {
    const def = manifest.surfaces[s]
    if (def?.verifyLayers) for (const l of def.verifyLayers) layers.add(l)
  }
  return [...layers].sort()
}

/** Deduped, sorted axes the hit surfaces require enabled on the remote (§F4).
 *  A surface with no requiresAxis contributes nothing. */
function computeRequiredAxes(surfaces: Set<string>, manifest: TrustedManifest): string[] {
  const axes = new Set<string>()
  for (const s of surfaces) {
    const axis = manifest.surfaces[s]?.requiresAxis
    if (typeof axis === 'string' && axis.length > 0) axes.add(axis)
  }
  return [...axes].sort()
}

/**
 * Order-stable deploy plan hash (§7). Every list is sorted so the hash is
 * independent of diff order / property insertion order; `deployArgs` is already
 * deterministic from {@link synthesizeDeployArgs}. Uses the verifier's
 * {@link stableStringify} (single authority for canonical JSON).
 */
export function computeDeployPlanHash(input: {
  baseSha: string
  sha: string
  manifestVersion: number
  manifestHash: string
  surfaces: string[]
  deployArgs: string[]
  manual: ManualEntry[]
  verifyLayers: string[]
  requiredAxes: string[]
}): string {
  const manualReasons = input.manual.map((m) => `${m.path} ${m.reason}`).sort()
  const planObj = {
    schema: 1,
    baseSha: input.baseSha,
    sha: input.sha,
    manifestVersion: input.manifestVersion,
    manifestHash: input.manifestHash,
    surfaces: [...input.surfaces].sort(),
    deployArgs: input.deployArgs,
    manualReasons,
    verifyLayers: [...input.verifyLayers].sort(),
    requiredAxes: [...input.requiredAxes].sort(),
  }
  return createHash('sha256').update(stableStringify(planObj)).digest('hex')
}

// ── cutover-time convenience wrapper ─────────────────────────────────────────

export interface CutoverClassifyResult {
  classification: Classification
  /** Canonical HEAD the ff-merge lands on (the diff base). */
  baseSha: string
}

/**
 * Resolve the canonical HEAD (the ff-merge landing point / diff base), load the
 * trusted manifest, and classify `baseSha..sha`. Throws (fail-closed) on any
 * git failure or invalid manifest. Reused by the broker's cutover path and, in
 * a later wave, the auto/break-glass enqueue path.
 */
export async function classifyForCutover(input: {
  canonicalRepo: string
  canonicalBranch: string
  sha: string
  run?: CommandRunner
}): Promise<CutoverClassifyResult> {
  const run = input.run ?? defaultCommandRunner
  const head = await run('git', ['-C', input.canonicalRepo, 'rev-parse', 'HEAD'])
  const baseSha = head.stdout.trim()
  if (head.code !== 0 || !SHA_RE.test(baseSha)) {
    throw new Error(`canonical HEAD resolution failed (code ${head.code})`)
  }
  const manifest = await loadTrustedManifest(input.canonicalRepo, input.canonicalBranch, { run })
  const classification = await classifyDiff(input.canonicalRepo, baseSha, input.sha, manifest, {
    run,
  })
  return { classification, baseSha }
}
