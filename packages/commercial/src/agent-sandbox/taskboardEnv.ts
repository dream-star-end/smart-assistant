/**
 * 容器 env `OC_TASKBOARD_ENABLED` 的单一决策点(master → 容器 gateway 单向下发)。
 *
 * 背景(INC-20260906-COMMERCIAL-TASKBOARD-DIGEST):商业版只用 VITE_TASKBOARD_ENABLED=0
 * 隐藏了任务面板 UI,容器 gateway 的巡检引擎 + 简报通知却无条件启动,新容器第一次
 * tick 就给用户写"任务面板每日简报(0/0/0)"站内信,刚注册的用户一分钟内就收到。
 *
 * 决策顺序:
 *   1. master 进程 env 显式给了 `OC_TASKBOARD_ENABLED=0|1` → 原样透传(运维开关)。
 *   2. flavor.manifest 判定为 commercial → 注入 `=0`。
 *   3. flavor 判定抛错(身份不明) → fail-closed 注入 `=0`:身份都证不出来就不该跑自动化。
 *   4. selfhost / 无 manifest(dev、测试) → 不注入,容器行为与旧版完全一致(启用)。
 *
 * 消费方:packages/gateway/src/taskboard/feature.ts::isTaskboardEnabled。
 */

import {
  type FlavorIdentity,
  FlavorIdentityError,
  resolveFlavorIdentity,
} from "../flavor/assertFlavor.js";

export const TASKBOARD_ENABLED_ENV = "OC_TASKBOARD_ENABLED";

export interface TaskboardEnvOpts {
  env?: NodeJS.ProcessEnv;
  /** 测试注入;生产用真实 resolveFlavorIdentity。 */
  identity?: () => FlavorIdentity;
}

export function taskboardContainerEnv(opts: TaskboardEnvOpts = {}): string[] {
  const env = opts.env ?? process.env;
  const explicit = env[TASKBOARD_ENABLED_ENV];
  if (explicit === "0" || explicit === "1") return [`${TASKBOARD_ENABLED_ENV}=${explicit}`];

  let identity: FlavorIdentity;
  try {
    identity = (opts.identity ?? resolveFlavorIdentity)();
  } catch (err) {
    if (err instanceof FlavorIdentityError) return [`${TASKBOARD_ENABLED_ENV}=0`];
    throw err;
  }
  if (identity.status === "ok" && identity.flavor === "commercial") {
    return [`${TASKBOARD_ENABLED_ENV}=0`];
  }
  return [];
}
