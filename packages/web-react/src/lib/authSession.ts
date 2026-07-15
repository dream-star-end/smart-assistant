import type { AuthSession } from "./types";

/** 内存态 token + 单调 epoch 的唯一实现；生产 hook 与测试 fixture 共用同一套 fence 语义。 */
export function createMemoryAuthSession(onExpired: () => void, initialToken = ""): AuthSession {
  let token = initialToken;
  let epoch = 0;
  return {
    snapshot: () => ({ token, epoch }),
    beginIdentity: () => {
      epoch += 1;
      token = "";
      return epoch;
    },
    commitToken: (expectedEpoch, nextToken) => {
      if (epoch !== expectedEpoch) return false;
      token = nextToken;
      return true;
    },
    expire: (expectedEpoch) => {
      if (epoch !== expectedEpoch) return false;
      epoch += 1;
      token = "";
      onExpired();
      return true;
    },
  };
}
