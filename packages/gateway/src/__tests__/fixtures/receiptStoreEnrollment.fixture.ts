/** Private model-test enrollment, never a production admission switch. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DelegateDurableDb } from '../../delegateDurable.js'
import { DelegateJobStore, type DelegateJobStoreOptions } from '../../delegateJobs.js'
import type { Gateway } from '../../server.js'

type StoreInternals = Required<Pick<DelegateJobStoreOptions,
  'ttlMs' | 'maxJobs' | 'now' | 'sleep' | 'sm' | 'bootId' | 'leaseMs'>> &
  Pick<DelegateJobStoreOptions, 'onTerminal' | 'onDrop'> & {
    durable: DelegateDurableDb
    jobs: Map<string, unknown>
    runners: Map<string, unknown>
    freezeHolders: Map<string, unknown>
  }
type GatewayInternals = {
  _ensureDelegateJobStore(): DelegateJobStore
  _delegateJobs: DelegateJobStore
  _delegateReapTimer?: ReturnType<typeof setInterval>
  _delegateReconcileTimer?: ReturnType<typeof setTimeout>
  _armDelegateReaper(store: DelegateJobStore): void
}

/**
 * Only replace an entirely empty, private factory-created store, synchronously
 * before any model or HTTP work. Reuse its actual callbacks and durable handle;
 * calling old.close() would close that shared handle. Never fake capability getters.
 */
export function enrollPrivateReceiptStore(gateway: Gateway, privateHome: string): DelegateJobStore {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.OPENCLAUDE_HOME, privateHome)
  const gw = gateway as unknown as GatewayInternals
  const old = gw._ensureDelegateJobStore()
  const opts = old as unknown as StoreInternals
  assert.equal(old.acceptsDeliveryReceipts, false)
  assert.equal(old.acceptsNewFailureSources, false)
  assert.ok(opts.durable instanceof DelegateDurableDb)
  assert.equal(opts.durable.path, join(privateHome, 'delegate-jobs.db'))
  assert.equal(opts.durable.minimumConsumer, 1, 'fresh fixture must start before irreversible seal')
  assert.equal(opts.jobs.size, 0)
  assert.equal(opts.durable.loadAll().length, 0)
  assert.equal(opts.runners.size, 0)
  assert.equal(opts.freezeHolders.size, 0)
  assert.equal(gw._delegateReconcileTimer, undefined, 'no pending boot recovery may be discarded')
  assert.equal(typeof opts.onTerminal, 'function')
  assert.equal(typeof opts.onDrop, 'function')
  const store = new DelegateJobStore({
    ttlMs: opts.ttlMs, maxJobs: opts.maxJobs, now: opts.now, sleep: opts.sleep,
    sm: opts.sm, bootId: opts.bootId, leaseMs: opts.leaseMs, durable: opts.durable,
    onTerminal: opts.onTerminal, onDrop: opts.onDrop, deliveryReceipts: true,
  })
  assert.equal(opts.durable.minimumConsumer, 2, 'real constructor seals before publishing admission')
  assert.equal(store.acceptsDeliveryReceipts, true)
  assert.equal(store.acceptsNewFailureSources, true)
  assert.equal((store as unknown as StoreInternals).onTerminal, opts.onTerminal)
  assert.equal((store as unknown as StoreInternals).onDrop, opts.onDrop)
  // The original reaper captures its store argument. The original notify and
  // reconcile schedulers read gw._delegateJobs; neither is replaced or duplicated.
  if (gw._delegateReapTimer) clearInterval(gw._delegateReapTimer)
  gw._delegateReapTimer = undefined
  gw._delegateJobs = store
  gw._armDelegateReaper(store)
  assert.ok(gw._delegateReapTimer)
  assert.equal(gw._ensureDelegateJobStore(), store)
  return store
}
