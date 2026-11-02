/** In-process trusted runtime hooks; never accepted from tool input or wire JSON. */
export type NativeToolInvocation = { toolUseId: string; name: string; input: unknown }
export interface NativeToolLifecycle {
  /** Includes validation, permission, all pre/post hooks and tool.call. */
  track<T>(
    request: NativeToolInvocation,
    signal: AbortSignal,
    execute: () => Promise<T>,
  ): Promise<T>
  /** Recheck current durable fence immediately before the actual tool.call. */
  invoke<T>(request: NativeToolInvocation, signal: AbortSignal, call: () => Promise<T>): Promise<T>
}
