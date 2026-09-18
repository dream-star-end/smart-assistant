import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProxyAgent, fetch as fetchUndici } from "undici";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { rootLogger } from "../logging/logger.js";
import { getAccount, getCursorTokenSnapshot, getTokenForUse, listAccounts } from "./store.js";
import { resolveAccountEgressDispatcher } from "./egressDispatcher.js";
import { createCursorAuthSyncScheduler, scheduleCursorAuthSync } from "./cursorMaterializer.js";
import { CursorSandProvisionClient, SandProvisionError } from "./cursorSandProvision.js";
import { CursorSandLifecycleCoordinator } from "./cursorSandLifecycle.js";
import { loadCursorSandInstaller } from "./cursorSandInstaller.js";
import { cursorSandLifecycleEnabled, readSandLifecycleState, SAND_STATE_FILE, type SandLifecycleState } from "./cursorSandState.js";

const log = rootLogger.child({ subsys: "cursor-sand-preparation" });
let current: ReturnType<typeof createCursorAuthSyncScheduler> | null = null;
let lastError: string | null = null;
let cache: { key: string; state: SandLifecycleState } | null = null;
export function scheduleCursorSandPreparation(reason: string): void { current?.schedule(reason); }

export function startCursorSandPreparationActor(): { stop: () => Promise<void> } {
  if (!cursorSandLifecycleEnabled() || getRuntimeChannel() !== "v5") return { stop: async () => {} };
  if (current) throw new Error("SAND_PREPARATION_ALREADY_RUNNING");
  const authDir = process.env.OC_V5_CURSOR_AUTH_DIR!.replace(/\/+$/, "");
  const assets = loadCursorSandInstaller();
  let alive = true;
  const coordinator = new CursorSandLifecycleCoordinator({
    authDir, moduleHash: assets.moduleHash, listAccounts, getAccount, getTokenSnapshot: getCursorTokenSnapshot,
    installerPrompt: assets.prompt, canPublish: () => alive,
    onChange: () => { cache = null; scheduleCursorAuthSync("sand.preparation"); },
    clientFor: async (account) => {
      const token = await getTokenForUse(account.id, undefined, { requireActiveStatus: true });
      if (!token) throw new SandProvisionError("ACCOUNT_INACTIVE");
      let egress;
      try {
        egress = await resolveAccountEgressDispatcher(account.id, { egressProxy: token.egress_proxy, egressTarget: token.egress_target, egressProxyId: token.egress_proxy_id, egressHostUuid: token.egress_host_uuid });
      } finally { token.token.fill(0); token.refresh?.fill(0); }
      if (egress.kind === "unavailable") throw new SandProvisionError("ACCOUNT_PROXY_UNAVAILABLE");
      let owned: ProxyAgent | undefined;
      const proxyFile = join(authDir, ".https-proxy");
      const dispatcher = egress.kind === "ready" ? egress.dispatcher : existsSync(proxyFile) ? (owned = new ProxyAgent(readFileSync(proxyFile, "utf8").trim())) : undefined;
      return { client: new CursorSandProvisionClient({ fetchImpl: (url, init) => fetchUndici(url, { ...init, dispatcher } as Parameters<typeof fetchUndici>[1]) as unknown as Promise<Response> }),
        close: async () => { await owned?.destroy(); } };
    },
  });
  const scheduler = createCursorAuthSyncScheduler({ run: async () => { await coordinator.tick(); lastError = null; },
    onError: (error) => { lastError = "PREPARATION_WORKER_FAILED"; log.warn("Sand preparation tick failed", { errorClass: error instanceof Error ? error.name : typeof error }); } });
  current = scheduler;
  scheduler.schedule("boot");
  const timer = setInterval(() => scheduler.schedule("tick"), 10_000); timer.unref();
  return { stop: async () => { alive = false; clearInterval(timer); if (current === scheduler) current = null; await Promise.all([scheduler.stop(), coordinator.stop()]); } };
}

export function cursorSandPublicStatus(account: { id: bigint | string; provider: string; status: string; cursor_sand_enabled: boolean }): { phase: "preparing" | "ready" | "error" | "disabled"; errorCode?: string; updatedAt?: number } | null {
  if (!cursorSandLifecycleEnabled() || account.provider !== "cursor" || !account.cursor_sand_enabled) return null;
  if (account.status !== "active") return { phase: "disabled" };
  if (lastError) return { phase: "error", errorCode: lastError };
  try {
    const dir = process.env.OC_V5_CURSOR_AUTH_DIR!;
    const file = join(dir, SAND_STATE_FILE);
    if (!existsSync(file)) return { phase: "preparing" };
    const st = statSync(file), key = `${dir}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (cache?.key !== key) cache = { key, state: readSandLifecycleState(dir) };
    const a = cache.state.accounts[String(account.id)];
    return a ? { phase: a.readyUntil && a.readyUntil <= Date.now() ? "preparing" : a.phase, ...(a.errorCode ? { errorCode: a.errorCode } : {}), updatedAt: a.updatedAt } : { phase: "preparing" };
  } catch { return { phase: "error", errorCode: "PREPARATION_STATE_UNAVAILABLE" }; }
}
