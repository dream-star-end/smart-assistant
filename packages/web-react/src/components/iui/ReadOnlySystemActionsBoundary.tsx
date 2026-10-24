import { LegacyCardPolicyProvider, useLegacyCardPolicy } from './LegacyCardPolicy'
import { useMemo, type ReactNode } from 'react'
import { ToolCardActionsContext, useToolCardActions } from '../tool/context'

/** History, tutorial and nested process renderers cannot inherit approval authority. */
export function ReadOnlySystemActionsBoundary({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  const inherited = useToolCardActions()
  const restricted = useLegacyCardPolicy().readOnly || readOnly
  const actions = useMemo(() => restricted ? { ...inherited, systemActions: undefined, communityBlog: undefined, connectorConfirm: undefined, taskApproval: undefined } : inherited, [inherited, restricted])
  return <LegacyCardPolicyProvider readOnly={restricted}><ToolCardActionsContext.Provider value={actions}>{children}</ToolCardActionsContext.Provider></LegacyCardPolicyProvider>
}
