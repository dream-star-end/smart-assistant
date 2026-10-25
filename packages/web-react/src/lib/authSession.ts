import type { AuthSession } from "./types";

/** 内存态 token + 单调 epoch 的唯一实现；生产 hook 与测试 fixture 共用同一套 fence 语义。 */
export function createMemoryAuthSession(onExpired: () => void, initialToken = ""): AuthSession {
  let token = initialToken;
  let epoch = 0;
  let accessGeneration = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    accessGeneration += 1;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* An observer must not interrupt identity invalidation or cleanup. */ }
    }
  };
  return {
    snapshot: () => ({ token, epoch }),
    getAccessGeneration: () => accessGeneration,
    subscribeAccessGeneration: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    beginIdentity: () => {
      epoch += 1;
      token = "";
      changed();
      return epoch;
    },
    commitToken: (expectedEpoch, nextToken) => {
      if (epoch !== expectedEpoch) return false;
      if (token !== nextToken) {
        token = nextToken;
        changed();
      }
      return true;
    },
    expire: (expectedEpoch) => {
      if (epoch !== expectedEpoch) return false;
      epoch += 1;
      token = "";
      changed();
      onExpired();
      return true;
    },
  };
}
