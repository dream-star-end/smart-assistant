import { useMemo, type ReactNode } from 'react'
import { ToolCardActionsContext, useToolCardActions } from '../tool/context'

/** History, tutorial and nested process renderers cannot inherit approval authority. */
export function ReadOnlySystemActionsBoundary({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  const inherited = useToolCardActions()
  const actions = useMemo(() => readOnly ? { ...inherited, systemActions: undefined } : inherited, [inherited, readOnly])
  return <ToolCardActionsContext.Provider value={actions}>{children}</ToolCardActionsContext.Provider>
}
