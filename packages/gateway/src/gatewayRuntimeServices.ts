import { renewTurnLease } from './masterTurnLease.js'
/** First runtime composition increment: real catalog and rolling lease services.
 * This is not a complete Worker runtime: models/persistence/content/Box and the
 * separate credential-free Worker bootstrap must be supplied before activation.
 */
import { type ModelCatalogClient, getModelCatalogClient } from './modelCatalogClient.js'

export type CatalogRuntimePort = Pick<
  ModelCatalogClient,
  | 'configured'
  | 'getView'
  | 'getRoutingView'
  | 'getToken'
  | 'lookupAgentCostMultiplier'
  | 'peekView'
>
export interface GatewayRuntimeServices {
  readonly catalog: CatalogRuntimePort
  readonly turnLease: { readonly renew: typeof renewTurnLease }
}
/** Lazy local compatibility keeps the existing singleton/cache and does not read
 * container identity earlier than the original first catalog request. */
const localCatalog: CatalogRuntimePort = {
  get configured() {
    return getModelCatalogClient().configured
  },
  getView: () => getModelCatalogClient().getView(),
  getRoutingView: () => getModelCatalogClient().getRoutingView(),
  getToken: () => getModelCatalogClient().getToken(),
  lookupAgentCostMultiplier: (id) => getModelCatalogClient().lookupAgentCostMultiplier(id),
  peekView: () => getModelCatalogClient().peekView(),
}
export function createGatewayRuntimeServices(
  input: GatewayRuntimeServices = { catalog: localCatalog, turnLease: { renew: renewTurnLease } },
): GatewayRuntimeServices {
  const catalog = input.catalog
  if (
    !catalog ||
    typeof catalog.getView !== 'function' ||
    typeof catalog.getRoutingView !== 'function' ||
    typeof catalog.getToken !== 'function' ||
    typeof catalog.lookupAgentCostMultiplier !== 'function' ||
    typeof catalog.peekView !== 'function' ||
    typeof input.turnLease?.renew !== 'function'
  )
    throw new Error('gateway-runtime-services-required')
  // Preserve callback receiver, snapshot callable references and freeze the port
  // shape; per-request state and the catalog's singleflight remain on the owner.
  return Object.freeze({
    catalog: Object.freeze({
      get configured() {
        return catalog.configured
      },
      getView: catalog.getView.bind(catalog),
      getRoutingView: catalog.getRoutingView.bind(catalog),
      getToken: catalog.getToken.bind(catalog),
      lookupAgentCostMultiplier: catalog.lookupAgentCostMultiplier.bind(catalog),
      peekView: catalog.peekView.bind(catalog),
    }),
    turnLease: Object.freeze({ renew: input.turnLease.renew.bind(input.turnLease) }),
  })
}
