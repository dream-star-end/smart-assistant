import type { Cc5FinanceTerminalOutcome, Cc5FinanceTurn } from './cc5Finance.js'
import type { CodexNativeTokens, RemoteBridgeBinding, RemoteNativeTerminalReceipt } from './codexRemoteContract.js'
export interface RemoteFinanceTurn extends Omit<Cc5FinanceTurn, 'terminal'> {
  /** A new thread must have an authenticated thread/start response; resume never guesses zero. */
  bindNativeThread?(nativeThreadId: string, newlyCreated: boolean): Promise<CodexNativeTokens>
  terminal(receipt: RemoteNativeTerminalReceipt): Promise<Cc5FinanceTerminalOutcome>
}
export interface RemoteFinancePort {
  admit(input: { binding: Readonly<RemoteBridgeBinding>; authorityEnvelope: string; leaseEnvelope: string;
    turnKey: string; sessionKey: string }): Promise<RemoteFinanceTurn>
}
export type RemoteFinanceFactory = (binding: Readonly<RemoteBridgeBinding>, lane: { upstreamModel: string }) => RemoteFinancePort | undefined

export * from './codexRemoteContract.js'
