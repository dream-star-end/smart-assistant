import { notificationOperations } from './notificationOperations.js'
import { systemReadOperations } from './readOperations.js'
/** Host-only composition. Enabled solely by the verified personal deployment. */
import type { ContainerIdentityRepo } from '../auth/containerIdentity.js'
import type { QueryRunner } from '../db/queries.js'
import { makeInternalSystemActionsHandler } from './internalHttp.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemActor } from './operations.js'
import { preferenceOperations } from './preferenceOperations.js'
import { openSystemActionsRuntime } from './runtime.js'
export function makeAuthorizeSystemActor(runner: QueryRunner): (actor: SystemActor) => Promise<void> {
  return async actor => {
    if (!/^[1-9][0-9]{0,18}$/.test(actor.userId)) throw new SystemOperationRejected('FORBIDDEN')
    const current = await runner.query<{ role: string }>("SELECT role FROM users WHERE id=$1::bigint AND status='active' AND deleted_at IS NULL", [actor.userId])
    if (current.rows.length !== 1 || current.rows[0]?.role !== actor.role) throw new SystemOperationRejected('FORBIDDEN')
  }
}
export function assembleSystemActions(deps: {
  stateParent: string
  jwtSecret: string | Uint8Array
  firstPartyOrigin: string
  runner: QueryRunner
  identityRepo: ContainerIdentityRepo
  privacySupported(userId: string): Promise<boolean>
}) {
  const authorize = makeAuthorizeSystemActor(deps.runner)
  const registry = new SystemOperationRegistry([
    ...preferenceOperations({ authorize, privacySupported: deps.privacySupported }),
    ...systemReadOperations({ authorize }),
    ...notificationOperations({ authorize }),
  ])
  const runtime = openSystemActionsRuntime({ ...deps, registry })
  return { runtime, handleInternal: makeInternalSystemActionsHandler({ ...deps, service: runtime.service, grants: runtime.grants, track: runtime.track }) }
}
