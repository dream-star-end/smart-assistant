import type { UserChatBridgeDeps } from "./userChatBridge.js";
import type { ModelCheckerHandle } from "./userChatBridgeTypes.js";
import type { AgentModelResolver } from "./agentModelAuthority.js";

/** Shared browser/background execution grants. Epoch stamps precede grants reads. */
export async function loadBridgeModelChecker(deps: UserChatBridgeDeps, uid: bigint) {
  const log = deps.logger;
        let modelCheckerHandle: ModelCheckerHandle | null = null;
        if (deps.loadAllowedModelChecker) {
          const loader = deps.loadAllowedModelChecker;

          // grants 快照的 epoch 戳 = **读 grants 之前**观察到的 DB epoch 的保守下界。
          //   · catalog 快照 epoch ≤ DB epoch(单调、只会落后)→ 用它盖戳只会盖低,不会盖高;
          //   · 盖低 = 多做一次重载(安全方向);盖高 = 撤权被永久漏掉(BLOCKER-1 的形态)。
          // 所以取戳**必须发生在 loader() 之前**,绝不能读完 grants 再补一个"当前 epoch"。
          const observeEpoch = (): bigint =>
            deps.modelAuthority?.catalog.peek()?.securityEpoch ?? 0n;

          let inner: (modelId: string) => boolean = () => false; // 载入成功前一律不放行
          let checkerEpoch = 0n;
          const applyLoad = (stamp: bigint, next: (modelId: string) => boolean): void => {
            // 迟到的旧班车(stamp 更小)不得把新快照换回旧的。
            if (stamp < checkerEpoch) return;
            inner = next;
            checkerEpoch = stamp;
          };
          let loadInflight: { minEpoch: bigint; p: Promise<void> } | null = null;
          const startLoad = (minEpoch: bigint): Promise<void> => {
            const entry: { minEpoch: bigint; p: Promise<void> } = { minEpoch, p: Promise.resolve() };
            entry.p = (async () => {
              const next = await loader(uid, minEpoch === 0n ? undefined : minEpoch);
              applyLoad(minEpoch, next);
            })().finally(() => {
              if (loadInflight === entry) loadInflight = null;
            });
            loadInflight = entry;
            return entry.p;
          };

          await startLoad(observeEpoch());

          modelCheckerHandle = {
            isAllowed: (modelId) => inner(modelId),
            epoch: () => checkerEpoch,
            refresh: async () => {
              try {
                await startLoad(observeEpoch());
              } catch (err) {
                // 不切 inner —— 保留上次成功 checker。详见 GRANTS_REFRESH_INTERVAL_MS 注释。
                // (这是**放宽面**的兜底:新授权晚 30s 生效可以忍;**收窄面**由
                //  reloadAtLeast 的 fail-closed 路径接管,不共用这条 keep-LKG。)
                log?.warn("user-chat-bridge: modelChecker refresh failed (keep last good)", {
                  uid: uid.toString(),
                  err,
                });
              }
            },
            reloadAtLeast: async (want) => {
              if (checkerEpoch >= want) return;
              // 只搭「启动时刻已观察到 epoch ≥ want」的车 —— 更早启动的那班可能读的是
              // 撤权之前的 grants,搭上去等于把撤权漏掉。否则自己开一班(grants 是一条
              // 轻 SELECT,多几班的代价远低于把安全结论押在别人的时序上)。
              const cur = loadInflight;
              await (cur !== null && cur.minEpoch >= want ? cur.p : startLoad(want));
              if (checkerEpoch < want) {
                throw new Error(
                  `grants snapshot did not reach epoch ${want} (at ${checkerEpoch})`,
                );
              }
            },
          };
        }

  return modelCheckerHandle;
}

export async function loadBridgeAgentResolver(deps: UserChatBridgeDeps, uid: bigint, bundleRev?: string) {
  const log = deps.logger;
        const connectionBundleRev = bundleRev;
        let agentModelResolverHandle:
          | {
              resolve: (agentId: string) => string | null;
              isRuntimeDenied: (agentId: string) => boolean;
              isIdentityRegistered: (agentId: string) => boolean;
              authorizeExecution: NonNullable<AgentModelResolver["authorizeExecution"]>;
              refresh: () => Promise<void>;
            }
          | null = null;
        if (deps.loadAgentModelResolver) {
          const loadResolver = deps.loadAgentModelResolver;
          const resolverOpts: { bundleRev?: string } = connectionBundleRev !== undefined
            ? { bundleRev: connectionBundleRev }
            : {};
          let innerResolve: AgentModelResolver;
          innerResolve = await loadResolver(uid, resolverOpts);
          // refresh 去重:miss 补触发 + 周期 timer 可能并发,同一时刻只放一个在飞
          // (DB 查询很轻,但没必要放大;后到的直接搭前一班车)。
          // 注意:此处刻意不写 `finally { }` 块 —— userChatBridge.test.ts 的
          // tryAutoRebindFlush 源码 tripwire 以「文件内第一个 `finally {`」定位
          // 目标块,在它之前新增 finally 块会让 tripwire 锚错。.finally() 等价。
          let refreshInflight: Promise<void> | null = null;
          agentModelResolverHandle = {
            resolve: (agentId) => innerResolve(agentId),
            isRuntimeDenied: (agentId) => innerResolve.isRuntimeDenied?.(agentId) === true,
            isIdentityRegistered: (agentId) => innerResolve.isIdentityRegistered?.(agentId) ?? false,
            authorizeExecution: async (agentId) => {
              // Capture the resolver for this frame: periodic refresh must not
              // replace a successful execution snapshot after its await.
              const current = innerResolve;
              return current.authorizeExecution
                ? current.authorizeExecution(agentId)
                : { identity: { requestedId: agentId, executionAgentId: agentId, status: "no-registration" as const }, model: current(agentId) };
            },
            refresh: async () => {
              if (refreshInflight !== null) return refreshInflight;
              refreshInflight = (async () => {
                try {
                  // 同一 bundleRev:连接存续期内容器不变 ⇒ seed 声明不变(LRU 命中,零 IO)。
                  const next = await loadResolver(uid, resolverOpts);
                  innerResolve = next;
                } catch (err) {
                  // 保留上次成功快照(与 modelChecker.refresh 同语义)。
                  log?.warn("user-chat-bridge: agentModelResolver refresh failed (keep last good)", {
                    uid: uid.toString(),
                    err,
                  });
                }
              })().finally(() => {
                refreshInflight = null;
              });
              return refreshInflight;
            },
          };
        }

  return agentModelResolverHandle;
}
