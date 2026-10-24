import { useCallback, useRef } from 'react'
import type { AuthorizeSwitch, ModelSwitchCostClientDeps } from '../lib/modelSwitchCostTypes'
export { SWITCH_COST_WARNING } from '../lib/modelSwitchCostTypes'
export type { AuthorizeSwitch, SwitchAuthorization } from '../lib/modelSwitchCostTypes'

/** Keep quote/summary code out of the first-screen preload closure. */
export function useModelSwitchCost(deps: ModelSwitchCostClientDeps): AuthorizeSwitch {
  const latest = useRef(deps)
  latest.current = deps
  const instance = useRef<Promise<AuthorizeSwitch> | null>(null)
  return useCallback<AuthorizeSwitch>(async (input, opts) => {
    const auth = latest.current.authRef.current
    const epoch = auth.snapshot().epoch
    const current = () =>
      latest.current.authRef.current === auth &&
      auth.snapshot().epoch === epoch &&
      (opts?.isCurrent?.() ?? true)
    try {
      if (!instance.current) {
        const pending = import('../lib/modelSwitchCostClient').then((module) =>
          module.createModelSwitchCostAuthorizer({
            authRef: latest.current.authRef,
            confirmDialog: (options) => latest.current.confirmDialog(options),
            toast: (...args) => latest.current.toast(...args),
          }),
        )
        instance.current = pending
        void pending.catch(() => {
          if (instance.current === pending) instance.current = null
        })
      }
      const authorize = await instance.current
      if (!current()) return null
      return authorize(input, opts)
    } catch (error) {
      if (!current()) return null
      if (opts?.interactive === false) throw error
      if (opts?.allowOfflineQueue) return { requestId: input.requestId, choice: true }
      latest.current.toast('费用确认暂不可用，请恢复网络后重试', 'error')
      return null
    }
  }, [])
}
