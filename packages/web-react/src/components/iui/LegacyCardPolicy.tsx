import { createContext, useContext, useMemo, type ReactNode } from 'react'

type LegacyCardPolicy = Readonly<{ readOnly: boolean; live: boolean }>
const Policy = createContext<LegacyCardPolicy>({ readOnly: false, live: false })
export const useLegacyCardPolicy = () => useContext(Policy)

/** A nested renderer may add restrictions, never restore an ancestor's authority. */
export function LegacyCardPolicyProvider({ readOnly = false, live = false, children }: {
  readOnly?: boolean; live?: boolean; children: ReactNode
}) {
  const inherited = useLegacyCardPolicy()
  const value = useMemo(() => ({ readOnly: inherited.readOnly || readOnly, live: inherited.live || live }), [inherited, readOnly, live])
  return <Policy.Provider value={value}>{children}</Policy.Provider>
}
