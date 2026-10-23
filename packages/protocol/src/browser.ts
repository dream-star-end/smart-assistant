/**
 * @openclaude/protocol/browser: the protocol entry for the browser (web-react) and any other
 * non-Node consumer (phase 3 plan v3.6 §3.6, OCV5-558). Everything here is free of `node:*` in its
 * whole import graph; scripts/__tests__/protocolBrowserEntry.test.ts enforces that transitively and
 * that every node-free module of the root entry is also exported here.
 *
 * The root entry (`@openclaude/protocol`) stays the complete entry for Node (master, gateway,
 * egress, scripts); it additionally exports the modules that need node:crypto: traceId (id
 * generation), modelAuthority / dispatchAuthority (signature verification) and losslessTurnTape.
 */
export * from './frames.js'
export * from './liveUnits.js'
export * from './timelineLifecycle.js'
export * from './goalState.js'
export * from './events.js'
export * from './teamCards.js'
export * from './engineModels.js'
export * from './serviceTiers.js'
export * from './boxApiModels.js'
export * from './boxGptWebModels.js'
export * from './modelCostIndex.js'
export * from './computeCost.js'
export * from './sessionKey.js'
export * from './staticKeyProviders.js'
export * from './research.js'
export * from './agentVisibility.js'
export * from './collaboration.js'
export * from './marketplaceTaxonomy.js'
export * from './pluginManifest.js'
export * from './pluginUi.js'
export * from './marketplaceBundle.js'
export * from './containerPreview.js'
export * from './chatgptProxy.js'
export * from './internalRoutes.js'
export * from './toolFailureAudit.js'
export * from './turnErrorTaxonomy.js'
export * from './marketplaceArtifact.js'
export * from './activeContent.js'
export * from './modelHistory.js'
export * from './messageReply.js'
export * from './mediaGeneration.js'
export * from './tutorialSnapshot.js'
export * from './delegation.js'
export * from './cursorSessionAuth.js'
export * from './runCost.js'
export * from './identityCompat.js'
export * from './serverFeatures.js'
export { measureLogWrite, takeLogWriteTimingSnapshot } from './logWriteTiming.js'
export * from './upstreamRetryHint.js'

export * from './systemActions.js'

export type { ModelSwitchCostRequest, ModelSwitchCostQuote, ModelSwitchCostRange } from './modelSwitchCost.js'
