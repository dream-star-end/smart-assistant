/**
 * Architecture Steward Contract Entrypoint & Deterministic 6-Rule Risk Evaluator (OCV5-905).
 *
 * Replaces subjective T0/T1/T2 self-classification with mechanical structural risk evaluation:
 *   1. APPEND_MAGNET_GROWTH          — touches a Top-20 append magnet (`arch/append-magnets.json`)
 *                                      and is NOT a pure deletion or net-shrinking refactor.
 *   2. NET_PROD_LOC_OVER_400         — net added production code > 400 lines.
 *   3. MULTI_MODULE_SPAN             — production changes span >= 2 modules in `arch/modules.json`.
 *   4. FUNCTION_COMPLEXITY_THRESHOLD — any added/modified function exceeds 100 lines or CC_direct > 20.
 *   5. GATE_COUPLING_TOUCHED         — touches `arch/gate-couplings.json`, modifies a coupled gate,
 *                                      deletes/renames a coupled path, or introduces new gate couplings.
 *   6. CLONE_OR_T2_CORE_PATH         — triggers a 12-logical-line clone alert OR touches a T2 core path
 *                                      (gateway / protocol / storage / billing / migrations / deploy).
 */
import {
  buildModuleResolver,
  loadAppendMagnets,
  loadGateCouplings,
  loadModulesDef,
} from './archStewardGitDiff.js'
import {
  type ChangedFileStat,
  DEFAULT_MAX_FN_CC_DIRECT,
  DEFAULT_MAX_FN_LINES,
  DEFAULT_MAX_NET_PROD_LOC,
  DEFAULT_MIN_MULTI_MODULE_SPAN,
  DEFAULT_T2_CORE_PATH_PATTERNS,
  type DiffSummary,
  type EvaluateStructuralRiskOptions,
  type StructuralRiskHit,
  type StructuralRiskReport,
  isProductionCodePath,
  isT2CorePath,
  normalizeRepoPath,
} from './archStewardTypes.js'

export * from './archStewardTypes.js'
export * from './archStewardGitDiff.js'
export * from './archStewardReceipt.js'

function buildCoupledTargetIndex(byGate: Record<string, string[]>): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const [gate, paths] of Object.entries(byGate)) {
    for (const target of paths) {
      const normTarget = normalizeRepoPath(target)
      const list = index.get(normTarget) ?? []
      list.push(gate)
      index.set(normTarget, list)
    }
  }
  return index
}

function collectGateCouplingHitsForFile(
  rawFile: ChangedFileStat,
  filePath: string,
  byGate: Record<string, string[]>,
  coupledTargetToGates: ReadonlyMap<string, string[]>,
): string[] {
  const hits: string[] = []
  if (filePath === 'arch/gate-couplings.json') {
    hits.push('modified arch/gate-couplings.json')
  } else if (Object.prototype.hasOwnProperty.call(byGate, filePath)) {
    hits.push(`modified coupled gate ${filePath} (${byGate[filePath]!.length} coupled path(s))`)
  }
  if (rawFile.status === 'deleted' || rawFile.status === 'renamed') {
    const vanished = rawFile.oldPath ? normalizeRepoPath(rawFile.oldPath) : filePath
    for (const [target, gates] of coupledTargetToGates.entries()) {
      if (vanished === target || vanished.startsWith(`${target}/`)) {
        hits.push(
          `${rawFile.status} coupled path ${vanished} (referenced by ${gates.slice(0, 3).join(', ')})`,
        )
      }
    }
  }
  return hits
}

export function evaluateStructuralRisk(
  diffSummary: DiffSummary,
  options: EvaluateStructuralRiskOptions = {},
): StructuralRiskReport {
  const root = options.root
  const maxNetProdLoc = options.maxNetProdLoc ?? DEFAULT_MAX_NET_PROD_LOC
  const minModules = options.minModules ?? DEFAULT_MIN_MULTI_MODULE_SPAN
  const maxFnLines = options.maxFnLines ?? DEFAULT_MAX_FN_LINES
  const maxFnCcDirect = options.maxFnCcDirect ?? DEFAULT_MAX_FN_CC_DIRECT
  const t2Patterns = options.t2CorePathPatterns ?? DEFAULT_T2_CORE_PATH_PATTERNS

  const appendMagnets: ReadonlySet<string> =
    options.appendMagnets instanceof Set
      ? options.appendMagnets
      : Array.isArray(options.appendMagnets)
        ? new Set(options.appendMagnets.map(normalizeRepoPath))
        : root
          ? loadAppendMagnets(root)
          : new Set()

  const modulesDef =
    options.modulesDef !== undefined ? options.modulesDef : root ? loadModulesDef(root) : null
  const moduleOf = buildModuleResolver(modulesDef)

  const gateCouplings =
    options.gateCouplings !== undefined
      ? options.gateCouplings
      : root
        ? loadGateCouplings(root)
        : null
  const byGate = gateCouplings?.byGate ?? {}
  const coupledTargetToGates = buildCoupledTargetIndex(byGate)

  const prodFiles: ChangedFileStat[] = []
  const appendMagnetsTouched: string[] = []
  const touchedModulesSet = new Set<string>()
  const gateCouplingHits: string[] = []
  const t2CorePathsTouched: string[] = []
  let netProdLines = 0

  for (const rawFile of diffSummary.files) {
    const filePath = normalizeRepoPath(rawFile.path)
    if (isProductionCodePath(filePath)) {
      prodFiles.push(rawFile)
      netProdLines += rawFile.added - rawFile.deleted
      const mod = moduleOf(filePath)
      if (mod) touchedModulesSet.add(mod)
    }

    if (appendMagnets.has(filePath)) {
      const isPureDeletionOrShrink =
        rawFile.status === 'deleted' || rawFile.added === 0 || rawFile.deleted > rawFile.added
      if (!isPureDeletionOrShrink) {
        const net = rawFile.added - rawFile.deleted
        appendMagnetsTouched.push(
          `${filePath} (+${rawFile.added}/-${rawFile.deleted}, net ${net >= 0 ? `+${net}` : net})`,
        )
      }
    }

    gateCouplingHits.push(
      ...collectGateCouplingHitsForFile(rawFile, filePath, byGate, coupledTargetToGates),
    )

    if (isT2CorePath(filePath, t2Patterns)) t2CorePathsTouched.push(filePath)
  }

  for (const delta of diffSummary.newGateCouplings ?? []) {
    gateCouplingHits.push(
      `new gate coupling ${normalizeRepoPath(delta.gate)} -> ${normalizeRepoPath(delta.path)}`,
    )
  }

  const hits: StructuralRiskHit[] = []
  if (appendMagnetsTouched.length > 0) {
    hits.push({
      code: 'APPEND_MAGNET_GROWTH',
      summary: `Touched ${appendMagnetsTouched.length} Top-20 append-magnet file(s) without net line reduction`,
      evidence: appendMagnetsTouched,
    })
  }
  if (netProdLines > maxNetProdLoc) {
    hits.push({
      code: 'NET_PROD_LOC_OVER_400',
      summary: `Net production code growth +${netProdLines} lines exceeds threshold (> ${maxNetProdLoc})`,
      evidence: [
        `netProdLines=${netProdLines}`,
        `threshold=${maxNetProdLoc}`,
        `productionFiles=${prodFiles.length}`,
      ],
    })
  }
  const touchedModules = [...touchedModulesSet].sort()
  if (touchedModules.length >= minModules) {
    hits.push({
      code: 'MULTI_MODULE_SPAN',
      summary: `Production diff spans ${touchedModules.length} architecture modules (>= ${minModules})`,
      evidence: touchedModules,
    })
  }
  const complexFunctions = (diffSummary.changedFunctions ?? []).filter(
    (fn) => fn.lines > maxFnLines || fn.ccDirect > maxFnCcDirect,
  )
  if (complexFunctions.length > 0) {
    hits.push({
      code: 'FUNCTION_COMPLEXITY_THRESHOLD',
      summary: `${complexFunctions.length} added/modified function(s) exceed limits (lines > ${maxFnLines} or CC_direct > ${maxFnCcDirect})`,
      evidence: complexFunctions.map(
        (fn) => `${fn.file}::${fn.name} (lines=${fn.lines}, CC_direct=${fn.ccDirect})`,
      ),
    })
  }
  const uniqueGateHits = [...new Set(gateCouplingHits)]
  if (uniqueGateHits.length > 0) {
    hits.push({
      code: 'GATE_COUPLING_TOUCHED',
      summary: `Touched ${uniqueGateHits.length} gate-coupling surface(s)`,
      evidence: uniqueGateHits,
    })
  }
  const cloneAlerts = diffSummary.cloneAlerts ?? []
  const uniqueT2Paths = [...new Set(t2CorePathsTouched)].sort()
  const rule6Evidence = [
    ...cloneAlerts.map(
      (c) =>
        `clone(${c.lines}L): ${c.file}:${c.line} <-> ${c.matchedFile}${c.matchedLine ? `:${c.matchedLine}` : ''}`,
    ),
    ...uniqueT2Paths.map((p) => `t2-core-path: ${p}`),
  ]
  if (rule6Evidence.length > 0) {
    const parts: string[] = []
    if (cloneAlerts.length > 0) parts.push(`${cloneAlerts.length} 12-line clone alert(s)`)
    if (uniqueT2Paths.length > 0) parts.push(`${uniqueT2Paths.length} T2 core path(s)`)
    hits.push({
      code: 'CLONE_OR_T2_CORE_PATH',
      summary: `Triggered by ${parts.join(' and ')}`,
      evidence: rule6Evidence,
    })
  }

  return {
    requiresSteward: hits.length > 0,
    triggers: hits.map((h) => h.code),
    hits,
    stats: {
      changedFiles: diffSummary.files.length,
      productionFiles: prodFiles.length,
      netProdLines,
      touchedModules,
      appendMagnetsTouched,
      complexFunctions,
      gateCouplingHits: uniqueGateHits,
      cloneAlertCount: cloneAlerts.length,
      t2CorePathsTouched: uniqueT2Paths,
    },
  }
}
