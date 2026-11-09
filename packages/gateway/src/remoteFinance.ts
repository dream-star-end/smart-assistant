import type { Cc5FinanceTerminalOutcome, Cc5FinanceTurn } from './cc5Finance.js'
import type { CodexNativeTokens, RemoteBridgeBinding, RemoteNativeTerminalReceipt } from './codexRemoteContract.js'
export interface RemoteFinanceTurn extends Omit<Cc5FinanceTurn, 'terminal'> {
  /** A new thread must have an authenticated thread/start response; resume never guesses zero. */
  bindNativeThread?(nativeThreadId: string, newlyCreated: boolean): Promise<CodexNativeTokens>
  /**
   * Close this admission when the model turn provably never started: no input frame was written
   * and no terminal receipt exists, so the only durable claims are the journal row (and possibly
   * a bound thread's `pending_request_id`). They are released by identity, never settled as
   * usage. `pending` means the owner could not prove it and the caller must stay closed.
   * `cause` records a platform failure (e.g. a thread unload the node never proved) instead of
   * the default user cancel.
   */
  abandonUndispatched?(cause?: { failureCode: 'INTERNAL_ERROR'; diagnostic: string }): Promise<Cc5FinanceTerminalOutcome>
  terminal(receipt: RemoteNativeTerminalReceipt): Promise<Cc5FinanceTerminalOutcome>
}
export interface RemoteFinancePort {
  admit(input: { binding: Readonly<RemoteBridgeBinding>; authorityEnvelope: string; leaseEnvelope: string;
    turnKey: string; sessionKey: string }): Promise<RemoteFinanceTurn>
}
export type RemoteFinanceFactory = (binding: Readonly<RemoteBridgeBinding>, lane: { upstreamModel: string }) => RemoteFinancePort | undefined

export * from './codexRemoteContract.js'
