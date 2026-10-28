import type { WebSocket } from "ws";
import type { ClaimedRecoveryJob } from "../dispatch/turnRecoveryStore.js";
import type { CronOriginExecutor } from "./userChatBridge.js";
import { getContainerLinkHandle, type ContainerLinkHandle } from "./containerLink.js";

export type RecoveryExecutor = (job: ClaimedRecoveryJob) => void;
export type BridgeExecutors = { recovery: RecoveryExecutor | null; origin: CronOriginExecutor | null };
type ExecutorMaps = { recovery: Map<string, Set<RecoveryExecutor>>; origin: Map<string, Set<CronOriginExecutor>> };
type Executor = (...args: never[]) => unknown;
const availability = new WeakMap<Executor, () => boolean>();
export function availableExecutors<T extends Executor>(values: Iterable<T> | undefined): T[] {
  return [...(values ?? [])].filter((value) => availability.get(value)?.() ?? true);
}

/** One registration per physical link; callbacks retain existing admission and billing code. */
export class ContainerLinkExecutors {
  private readonly candidates = new Map<ContainerLinkHandle, BridgeExecutors>();
  private unmount: (() => void) | null = null;
  private current(): BridgeExecutors | undefined {
    for (const [handle, value] of this.candidates) {
      if (handle.active && !handle.detached && !handle.disposed) return value;
    }
    return undefined;
  }
  readonly recovery: RecoveryExecutor = (job) => {
    const executor = this.current()?.recovery;
    if (!executor) throw new Error("container link has no execution context");
    executor(job);
  };
  readonly origin: CronOriginExecutor = (payload) => {
    return this.current()?.origin?.(payload) ?? { kind: "not_claimed" };
  };
  constructor() {
    availability.set(this.recovery, () => this.current()?.recovery != null);
    availability.set(this.origin, () => this.current()?.origin != null);
  }
  register(handle: ContainerLinkHandle, callbacks: BridgeExecutors, mount: (value: BridgeExecutors) => () => void): () => void {
    this.candidates.set(handle, callbacks);
    this.unmount ??= mount({ recovery: callbacks.recovery && this.recovery, origin: callbacks.origin && this.origin });
    return () => this.candidates.delete(handle);
  }
  release(handle: ContainerLinkHandle): void { this.candidates.delete(handle); }
  close(): void {
    this.candidates.clear();
    this.unmount?.();
    this.unmount = null;
  }
}

export function registerBridgeExecutors(
  uid: bigint, socket: WebSocket, callbacks: BridgeExecutors, maps: ExecutorMaps,
): () => void {
  const mount = (value: BridgeExecutors): (() => void) => {
    const key = String(uid);
    const add = <T>(map: Map<string, Set<T>>, executor: T | null): (() => void) => {
      if (!executor) return () => {};
      let set = map.get(key);
      if (!set) { set = new Set(); map.set(key, set); }
      set.add(executor);
      return () => { set.delete(executor); if (!set.size) map.delete(key); };
    };
    const removeRecovery = add(maps.recovery, value.recovery);
    const removeOrigin = add(maps.origin, value.origin);
    return () => { removeRecovery(); removeOrigin(); };
  };
  const handle = getContainerLinkHandle(socket);
  return handle ? handle.link.executors.register(handle, callbacks, mount) : mount(callbacks);
}
