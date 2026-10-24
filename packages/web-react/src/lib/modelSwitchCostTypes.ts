import type {
  ModelSwitchCostRequest,
  ModelSwitchCostAuthorization,
} from '@openclaude/protocol/browser'
import type { ConfirmOpts, ConfirmChoice } from '../components/ui/ConfirmDialog'
import type { AuthSession } from './types'
import type { ToastFn } from '../components/ui/Toast'
export const SWITCH_COST_WARNING = '切换后首次会话将重建全部上下文，价格较高'
export type SwitchAuthorization = ModelSwitchCostAuthorization & { choice: ConfirmChoice }
export type AuthorizeSwitch = (
  input: ModelSwitchCostRequest,
  opts?: {
    interactive?: boolean
    notice?: ConfirmOpts
    primeNextTurn?: boolean
    allowOfflineQueue?: boolean
    useCachedRequestId?: boolean
    consent?: string
    isCurrent?: () => boolean
  },
) => Promise<SwitchAuthorization | null>
export interface ModelSwitchCostClientDeps {
  authRef: React.RefObject<AuthSession>
  confirmDialog: (o: ConfirmOpts) => Promise<ConfirmChoice>
  toast: ToastFn
}
