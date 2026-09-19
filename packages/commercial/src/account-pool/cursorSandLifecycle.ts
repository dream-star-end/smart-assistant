/** Bounded preparation coordinator. No account writes, inference calls, or cloud deletion. */
import { randomBytes } from "node:crypto";
import type { AccountRow, CursorTokenSnapshot, ListAccountsOptions } from "./store.js";
import { listAllCursorAccounts } from "./cursorMaterializer.js";
import { CursorSandProvisionClient, SandProvisionError, sandPrincipal } from "./cursorSandProvision.js";
import { readSandLifecycleState, writeSandJsonAtomic, sandHash, SAND_STATE_FILE, type SandLifecycleState, type SandAccountPreparation } from "./cursorSandState.js";

export interface SandLifecycleDeps {
  authDir: string;
  moduleHash: string;
  listAccounts: (options?: ListAccountsOptions) => Promise<AccountRow[]>;
  getAccount: (id: string) => Promise<AccountRow | null>;
  getTokenSnapshot: (id: string) => Promise<CursorTokenSnapshot | null>;
  clientFor: (account: AccountRow) => Promise<{ client: CursorSandProvisionClient; close?: () => Promise<void> }>;
  installerPrompt: (args: { nonce: string; hostPid: number; agentId: string; moduleHash: string }) => string;
  onChange: () => void;
  now?: () => number;
  canPublish?: () => boolean;
  budgetMs?: number;
  maxAccountsPerTick?: number;
}
const nonce = (): string => "oc-sand-" + randomBytes(16).toString("hex");
function active(row: AccountRow | null): row is AccountRow {
  return row !== null && row.provider === "cursor" && row.status === "active" && row.cursor_sand_enabled === true && row.runtime_channel === "v5";
}
function agentList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some((x) => !x || typeof x !== "object" || typeof x.id !== "string")) throw new SandProvisionError("AGENT_LIST_INVALID");
  return value as Array<Record<string, unknown>>;
}
function markerOf(agent: Record<string, unknown>): string {
  const profile = agent.profile as { description?: unknown } | undefined;
  return typeof agent.description === "string" ? agent.description : typeof profile?.description === "string" ? profile.description : "";
}

export class CursorSandLifecycleCoordinator {
  private stopped = false;
  private cursor = 0;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly deps: SandLifecycleDeps) {
    if (!/^[a-f0-9]{64}$/.test(deps.moduleHash)) throw new Error("SAND_MODULE_HASH_INVALID");
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private allowed = (): boolean => !this.stopped && (this.deps.canPublish?.() ?? true);
  private check(): void { if (!this.allowed()) throw new SandProvisionError("OWNER_STOPPED"); }
  private save(state: SandLifecycleState): void { this.check(); writeSandJsonAtomic(this.deps.authDir, SAND_STATE_FILE, state, this.allowed); this.deps.onChange(); }

  /** Validate current account state and credential identity before each remote mutation. */
  private async current(id: string, expectedHash?: string): Promise<{ row: AccountRow; credential: string; kind: "session" | "api_key"; machine: string | null }> {
    this.check();
    const row = await this.deps.getAccount(id); this.check();
    if (!active(row)) throw new SandProvisionError("ACCOUNT_INACTIVE");
    const snap = await this.deps.getTokenSnapshot(id);
    if (!snap) throw new SandProvisionError("ACCOUNT_INACTIVE");
    try {
      this.check();
      const credential = snap.token.toString("utf8").trim();
      if (expectedHash && sandHash(credential) !== expectedHash) throw new SandProvisionError("ACCOUNT_CHANGED");
      const latest = await this.deps.getAccount(id); this.check();
      if (!active(latest)) throw new SandProvisionError("ACCOUNT_INACTIVE");
      return { row: latest, credential, kind: snap.credential_kind, machine: snap.machine_id };
    } finally { snap.token.fill(0); snap.refresh?.fill(0); }
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async stop(): Promise<void> { this.stopped = true; this.controller?.abort(); await this.running; }

  private async run(): Promise<void> {
    this.check();
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.deps.budgetMs ?? 45_000);
    try {
      const all = await listAllCursorAccounts(this.deps.listAccounts, this.allowed); this.check();
      const rows = all.filter(active).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const state = readSandLifecycleState(this.deps.authDir);
      const wanted = new Set(rows.map((r) => String(r.id)));
      let changed = false;
      for (const id of Object.keys(state.accounts)) if (!wanted.has(id)) { delete state.accounts[id]; changed = true; }
      if (changed) this.save(state);
      const limit = Math.min(rows.length, this.deps.maxAccountsPerTick ?? 8);
      for (let i = 0; i < limit && !controller.signal.aborted; i++) {
        this.cursor %= rows.length;
        const row = rows[this.cursor++];
        await this.step(state, String(row.id), controller.signal);
      }
    } finally { clearTimeout(timer); this.controller = null; }
  }

  private async step(state: SandLifecycleState, id: string, signal: AbortSignal): Promise<void> {
    let credential = "", accessToken = "";
    let previousReady: SandAccountPreparation | undefined;
    let resource: Awaited<ReturnType<SandLifecycleDeps["clientFor"]>> | undefined;
    try {
      const source = await this.current(id); credential = source.credential;
      const credentialHash = sandHash(credential), old = state.accounts[id];
      const opBefore = old?.subjectHash ? state.operations[old.subjectHash] : undefined;
      const sameIdentity = old?.credentialHash === credentialHash && (source.kind === "api_key" || old.machineHash === sandHash(source.machine ?? ""));
      if (sameIdentity && opBefore && opBefore.nextAttemptAt > this.now()) return;
      if (sameIdentity && old?.phase === "ready" && old.updatedAt + 300_000 > this.now()
        && opBefore?.moduleHash === this.deps.moduleHash && old.readyUntil! > this.now()) return;
      if (sameIdentity && old?.phase === "ready" && opBefore?.moduleHash === this.deps.moduleHash && old.readyUntil! > this.now()) previousReady = old;
      if (!previousReady) {
        state.accounts[id] = { credentialHash, phase: "preparing", updatedAt: this.now() };
        this.save(state);
      }
      resource = await this.deps.clientFor(source.row); this.check();
      const client = resource.client;
      client.setAccountGuard(async () => { await this.current(id, credentialHash); });
      accessToken = await client.accessToken(credential, source.kind, signal); this.check();
      const principal = sandPrincipal(accessToken, source.kind, this.now());
      let op = state.operations[principal.subjectHash];
      if (!op) op = state.operations[principal.subjectHash] = { nonce: nonce(), moduleHash: this.deps.moduleHash, phase: "idle", startedAt: this.now(), nextAttemptAt: 0 };
      const machine = source.kind === "session" ? source.machine : op.machineId ?? randomBytes(16).toString("hex");
      if (!machine || !/^[a-z0-9]{16,64}$/.test(machine)) throw new SandProvisionError("MACHINE_INVALID");
      if (previousReady && (previousReady.subjectHash !== principal.subjectHash || previousReady.machineHash !== sandHash(machine))) previousReady = undefined;
      if (source.kind === "api_key") op.machineId = machine;
      if (!previousReady) {
        state.accounts[id] = { credentialHash, subjectHash: principal.subjectHash, machineId: machine, machineHash: sandHash(machine), phase: "preparing", updatedAt: this.now() };
        this.save(state);
      }
      if (op.nextAttemptAt > this.now()) return;
      await this.current(id, credentialHash);
      const connection = await client.connect(accessToken, machine, signal); this.check();
      const probe = await client.probe(connection, signal); this.check();
      if (probe?.moduleHash === this.deps.moduleHash && probe.maxConcurrent === 4) {
        await this.current(id, credentialHash);
        state.accounts[id] = { ...state.accounts[id], phase: "ready", updatedAt: this.now(), readyUntil: this.now() + 24 * 3600_000 };
        op.phase = "ready"; op.moduleHash = this.deps.moduleHash; delete op.errorCode;
        this.save(state); return;
      }
      // A conclusive missing/wrong capability, unlike a slow health recheck,
      // withdraws admission before maintenance can begin.
      previousReady = undefined;
      state.accounts[id] = { credentialHash, subjectHash: principal.subjectHash, machineId: machine, machineHash: sandHash(machine), phase: "preparing", updatedAt: this.now() };
      this.save(state);
      if (probe && probe.active > 0) throw new SandProvisionError("BOX_BUSY");
      if (op.moduleHash !== this.deps.moduleHash && !["idle", "ready", "error"].includes(op.phase)) throw new SandProvisionError("INSTALL_VERSION_CHANGED_IN_FLIGHT");
      const call = async (method: string, body: Record<string, unknown>): Promise<unknown> => {
        await this.current(id, credentialHash); return client.box(method, connection, body, signal);
      };
      const agents = agentList(await call("listAgents", {})); this.check();
      if (["create-intent", "install-intent", "submitted"].includes(op.phase)) {
        if (op.phase === "create-intent") {
          const matches = agents.filter((a) => markerOf(a) === `OpenClaude Sand maintenance [${op.agentMarker ?? op.nonce}]`);
          if (matches.length === 1) { op.agentId = String(matches[0].id); op.phase = "created"; this.save(state); }
          else if (matches.length > 1) throw new SandProvisionError("AMBIGUOUS_MAINTENANCE_AGENT");
        }
        if (op.phase !== "created") {
          // Missing acceptance records do not prove a mutation was never accepted.
          // Only an exact installed capability probe can finish an unknown install.
          op.nextAttemptAt = this.now() + 60_000;
          if (this.now() - op.startedAt > 15 * 60_000) throw new SandProvisionError("UNKNOWN_OPERATION_RESULT");
          this.save(state); return;
        }
      }
      if (op.phase === "error") throw new SandProvisionError(op.errorCode ?? "INSTALL_REJECTED");
      const health = await client.health(connection, signal); this.check();
      if (health.isBusy || agents.some((a) => a.isRunning === true)) throw new SandProvisionError("BOX_BUSY");
      if (op.phase === "ready" || op.moduleHash !== this.deps.moduleHash) {
        op = state.operations[principal.subjectHash] = { ...op, nonce: nonce(), phase: "idle", moduleHash: this.deps.moduleHash, startedAt: this.now(), nextAttemptAt: 0 };
      }
      if (!op.agentId) {
        op.agentMarker = op.nonce; op.phase = "create-intent"; this.save(state);
        // Official createAgent returns { agent: summary, transcript }, not a
        // flattened summary. An unknown reply still retains create-intent.
        const created = await call("createAgent", { name: "OpenClaude Sand Relay", description: `OpenClaude Sand maintenance [${op.agentMarker}]`, creationRoute: { kind: "box" }, isIntroductionSuppressed: true, isKickstartRequested: false, clientNonce: op.nonce + "-create" }) as { agent?: { id?: unknown } };
        this.check();
        if (typeof created?.agent?.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(created.agent.id)) throw new SandProvisionError("UNKNOWN_CREATE_RESULT");
        op.agentId = created.agent.id; op.phase = "created"; this.save(state);
      } else {
        const owned = agents.find((a) => a.id === op.agentId);
        if (!owned || markerOf(owned) !== `OpenClaude Sand maintenance [${op.agentMarker ?? op.nonce}]`) throw new SandProvisionError("MAINTENANCE_AGENT_CHANGED");
      }
      await this.current(id, credentialHash);
      const fresh = await client.health(connection, signal);
      if (fresh.isBusy) throw new SandProvisionError("BOX_BUSY");
      const prompt = this.deps.installerPrompt({ nonce: op.nonce, hostPid: fresh.pid, agentId: op.agentId, moduleHash: op.moduleHash });
      op.hostPid = fresh.pid; op.phase = "install-intent"; this.save(state);
      const accepted = await call("sendPrompt", { agentId: op.agentId, prompt, clientNonce: op.nonce + "-install", source: "desktop", sessionId: "" }) as { accepted?: unknown };
      this.check();
      if (accepted?.accepted === true) op.phase = "submitted";
      else { op.phase = "error"; op.errorCode = "INSTALL_REJECTED"; }
      op.nextAttemptAt = this.now() + 60_000; this.save(state);
    } catch (error) {
      if (!this.allowed()) return;
      const code = error instanceof SandProvisionError ? error.code : "PREPARATION_FAILED";
      if (code === "ACCOUNT_INACTIVE" || code === "ACCOUNT_CHANGED") delete state.accounts[id];
      else if (state.accounts[id]) {
        const authRejected = error instanceof SandProvisionError && (error.httpStatus === 401 || error.httpStatus === 403);
        const transient = !authRejected && ["BOX_BUSY", "BOX_CONTROL_PENDING", "ACCOUNT_EXCHANGE_PENDING", "REQUEST_FAILED", "REQUEST_ABORTED", "BOX_PROBE_PENDING"].includes(code);
        state.accounts[id] = previousReady && transient && previousReady.readyUntil! > this.now()
          ? previousReady
          : { ...state.accounts[id], phase: transient ? "preparing" : "error", errorCode: code, updatedAt: this.now() };
        const subject = state.accounts[id].subjectHash;
        if (subject && state.operations[subject]) state.operations[subject].nextAttemptAt = this.now() + 60_000;
      }
      this.save(state);
    } finally { credential = ""; accessToken = ""; await resource?.close?.(); }
  }
}
