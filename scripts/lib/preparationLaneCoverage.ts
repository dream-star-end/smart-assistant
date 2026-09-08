import ts from 'typescript'

const engineMarkers = [
  ['cursor', 'cursorTurnIdentity'],
  ['zcode', 'zcodeTurnIdentity'],
  ['annotated', 'dispatchRecordA'],
  ['codex-grok', 'dispatchRecordB'],
  ['ccb', 'dispatchRecordC'],
] as const

function fail(reason: string): never {
  throw new Error(`[preparation-lane-coverage] ${reason}`)
}

function isNamed(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name
}

/** Source regression guard, not a substitute for the bridge's runtime proofs. */
export function assertPreparationLaneCoverage(source: string): void {
  const file = ts.createSourceFile('userChatBridge.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (!Array.isArray(diagnostics) || diagnostics.length !== 0) fail('bridge must parse without syntax errors')

  const calls: ts.CallExpression[] = []
  function collect(node: ts.Node): void {
    if (ts.isCallExpression(node) && isNamed(node.expression, 'trackPreparation')) calls.push(node)
    ts.forEachChild(node, collect)
  }
  collect(file)
  if (calls.length !== 6) fail(`expected six tracked preparation lanes, found ${calls.length}`)

  const seen = new Set<string>()
  for (const call of calls) {
    const fn = call.arguments[0]
    if (call.arguments.length !== 1 || !fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))
      || !ts.isBlock(fn.body) || !fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      fail('each trackPreparation call must own exactly one async callback block')
    }
    const identifiers = new Set<string>()
    let awaitsIdentityWork = false
    let releasesIdentityBytes = false
    let deletesIdentityPeer = false
    function inspect(node: ts.Node): void {
      // A callback declaration is not execution of its body; don't count hidden work.
      if (ts.isFunctionLike(node)) return
      if (ts.isIdentifier(node)) identifiers.add(node.text)
      if (ts.isAwaitExpression(node) && isNamed(node.expression, 'work')) awaitsIdentityWork = true
      if (ts.isBinaryExpression(node) && isNamed(node.left, 'identityPreparationBytes')
        && node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken && isNamed(node.right, 'len')) {
        releasesIdentityBytes = true
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && isNamed(node.expression.expression, 'identityPreparations') && node.expression.name.text === 'delete'
        && node.arguments.length === 1 && isNamed(node.arguments[0]!, 'peerKey')) {
        deletesIdentityPeer = true
      }
      ts.forEachChild(node, inspect)
    }
    inspect(fn.body)
    const lanes: string[] = engineMarkers.filter(([, marker]) => identifiers.has(marker)).map(([lane]) => lane)
    if (awaitsIdentityWork && releasesIdentityBytes && deletesIdentityPeer) lanes.push('identity')
    if (lanes.length !== 1) fail(`callback must cover one distinct lane; found ${lanes.join(', ') || 'none'}`)
    const lane = lanes[0]!
    if (seen.has(lane)) fail(`duplicate ${lane} tracking cannot replace a missing lane`)
    seen.add(lane)
  }
  for (const lane of [...engineMarkers.map(([name]) => name), 'identity']) {
    if (!seen.has(lane)) fail(`missing tracked ${lane} preparation`)
  }
}
