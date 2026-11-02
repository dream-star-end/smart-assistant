/** Injected financial boundary for the pinned native worker. No commercial imports. */
import type { Cc5BridgeBinding } from './cc5BridgePort.js'

export interface Cc5NativeUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Produced only at the pinned host stdout boundary from one complete native result. */
export interface Cc5NativeTerminalReceipt {
  readonly version: 1
  readonly backendKind: 'cc5-interactive-v1'
  readonly uid: string
  readonly containerDbId: string
  readonly dockerId: string
  readonly operationId: string
  readonly runId: string
  readonly sessionKey: string
  readonly nativeSessionId: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly resultSha256: string
  readonly status: 'success' | 'error'
  readonly usage: Cc5NativeUsage
}

export type Cc5FinanceTerminalOutcome =
  | { readonly state: 'proven'; readonly requestId: string }
  | { readonly state: 'pending' }

export interface Cc5FinanceTurn {
  /** Durable potentially billable-effect marker, strictly before host.start(). */
  beforeHostStart(): Promise<void>
  /** Durable input-effect marker, strictly before writing a user frame to the host. */
  beforeDispatch(input: { readonly sequence: number; readonly inputSha256: string }): Promise<void>
  /** Prove the existing settlement before any original terminal bytes reach the browser. */
  terminal(receipt: Cc5NativeTerminalReceipt): Promise<Cc5FinanceTerminalOutcome>
  stop(input: {
    readonly hostStartAttempted: boolean
    readonly userSubmitted: boolean
    readonly remoteStopped: boolean
  }): Promise<void>
}

export interface Cc5FinancePort {
  admit(input: {
    readonly binding: Readonly<Cc5BridgeBinding>
    readonly authorityEnvelope: string
    readonly leaseEnvelope: string
    readonly turnKey: string
    readonly sessionKey: string
  }): Promise<Cc5FinanceTurn>
}

export type Cc5FinanceFactory = (binding: Readonly<Cc5BridgeBinding>) => Cc5FinancePort | undefined
