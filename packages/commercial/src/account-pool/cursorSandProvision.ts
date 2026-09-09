/** Official account control plane + the account's authenticated Box gateway.
 * All bearer material stays in this request scope, never in the preparation journal. */
import { randomBytes } from "node:crypto";
import { cursorSessionChecksum } from "@openclaude/protocol";
import { sandHash } from "./cursorSandState.js";

export class SandProvisionError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) { super(code); this.name = "SandProvisionError"; }
}
export interface SandGatewayConnection { gatewayUrl: string; gatewayToken: string; networkToken: string }
export interface SandRelayProbe { moduleHash: string; active: number; maxConcurrent: number }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const RELAY_PATH = "/sand-stream-relay/aiserver.v1.InferenceService/Stream";
const BOX_METHODS = new Set(["listAgents", "getHostStatus", "createAgent", "sendPrompt", "promptAcceptanceStatus", "getAgentTranscript"]);

function bearer(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(value)) throw new SandProvisionError("DESCRIPTOR_INVALID");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandProvisionError("RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

export function sandPrincipal(token: string, kind: "api_key" | "session", now = Date.now()): { subjectHash: string; expiresAt: number } {
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))); }
  catch { throw new SandProvisionError("ACCOUNT_IDENTITY_INVALID"); }
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 512
    || typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp * 1000 <= now + 60_000
    || (kind === "session" && payload.type !== "session")) throw new SandProvisionError("ACCOUNT_IDENTITY_INVALID");
  return { subjectHash: sandHash(payload.sub), expiresAt: payload.exp * 1000 };
}

export class CursorSandProvisionClient {
  private readonly apiBase: string;
  private accountGuard: (() => Promise<void>) | undefined;
  setAccountGuard(guard: () => Promise<void>): void { this.accountGuard = guard; }
  constructor(private readonly options: {
    fetchImpl: Fetcher;
    apiBase?: string;
    allowTestLoopback?: boolean;
    timeoutMs?: number;
    now?: () => number;
  }) {
    this.apiBase = options.apiBase ?? "https://api2.cursor.sh";
    const u = new URL(this.apiBase);
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/"
      || !(u.href === "https://api2.cursor.sh/" || (options.allowTestLoopback && u.protocol === "http:" && u.hostname === "127.0.0.1"))) throw new SandProvisionError("CONTROL_URL_INVALID");
    this.apiBase = u.origin;
  }

  private async request(url: string, init: RequestInit, parent: AbortSignal, maxBytes = 64 * 1024): Promise<{ status: number; contentType: string; value: unknown }> {
    await this.accountGuard?.();
    if (parent.aborted) throw new SandProvisionError("OWNER_STOPPED");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.options.timeoutMs ?? 15_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = (): void => { void reader?.cancel().catch(() => {}); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await this.options.fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
      if (controller.signal.aborted) throw new SandProvisionError("REQUEST_ABORTED");
      const chunks: Buffer[] = []; let bytes = 0;
      reader = response.body?.getReader();
      if (reader) for (;;) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new SandProvisionError("REQUEST_ABORTED");
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new SandProvisionError("RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(chunk.value));
      }
      const contentType = response.headers.get("content-type") ?? "";
      let value: unknown = null;
      if (/application\/json/i.test(contentType)) {
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new SandProvisionError("RESPONSE_INVALID"); }
      }
      return { status: response.status, contentType, value };
    } catch (error) {
      if (error instanceof SandProvisionError) throw error;
      throw new SandProvisionError(controller.signal.aborted ? "REQUEST_ABORTED" : "REQUEST_FAILED");
    } finally {
      clearTimeout(timer); parent.removeEventListener("abort", abort);
      controller.abort(); controller.signal.removeEventListener("abort", cancel); reader?.releaseLock();
    }
  }

  async accessToken(credential: string, kind: "api_key" | "session", signal: AbortSignal): Promise<string> {
    if (kind === "session") { sandPrincipal(credential, kind, this.options.now?.()); return credential; }
    const r = await this.request(`${this.apiBase}/auth/exchange_user_api_key`, {
      method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: "{}",
    }, signal);
    if (r.status !== 200) throw new SandProvisionError("ACCOUNT_EXCHANGE_FAILED", r.status);
    const value = object(r.value); const token = bearer(value.accessToken ?? value.access_token);
    sandPrincipal(token, kind, this.options.now?.()); return token;
  }

  private async control(method: "GetSandBoxRunState" | "EnsureSandBox", token: string, machine: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!/^[a-z0-9]{16,64}$/.test(machine)) throw new SandProvisionError("MACHINE_INVALID");
    const r = await this.request(`${this.apiBase}/aiserver.v1.GrokBotService/${method}`, {
      method: "POST", body: "{}", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json", "connect-protocol-version": "1",
        "x-cursor-client-type": "sand", "x-cursor-client-source": "sand-desktop", "x-cursor-client-version": "0.44.0",
        "x-sand-box-namespace": "prod", "x-ghost-mode": "true", "x-cursor-checksum": cursorSessionChecksum(machine, this.options.now?.()),
      },
    }, signal);
    if (r.status !== 200) throw new SandProvisionError(r.status === 401 || r.status === 403 ? "ACCOUNT_CONTROL_REJECTED" : "BOX_CONTROL_PENDING", r.status);
    return object(r.value);
  }

  async connect(token: string, machine: string, signal: AbortSignal): Promise<SandGatewayConnection> {
    // Every attempt begins with state. An ambiguous Ensure response is never
    // immediately repeated, force/recreate are never used. The next tick reads state again.
    const state = await this.control("GetSandBoxRunState", token, machine, signal);
    if (typeof state.state !== "string" || !state.state.startsWith("SAND_BOX_RUN_STATE_")) throw new SandProvisionError("BOX_STATE_INVALID");
    const value = await this.control("EnsureSandBox", token, machine, signal);
    if (typeof value.gatewayUrl !== "string" || value.gatewayUrl.length > 2048) throw new SandProvisionError("DESCRIPTOR_INVALID");
    const u = new URL(value.gatewayUrl);
    if (u.username || u.password || u.search || u.hash
      || !((u.protocol === "https:" && u.hostname.endsWith(".cursorvm.com"))
        || (this.options.allowTestLoopback && u.protocol === "http:" && u.hostname === "127.0.0.1"))) throw new SandProvisionError("DESCRIPTOR_INVALID");
    return { gatewayUrl: u.href.replace(/\/+$/, ""), gatewayToken: bearer(value.gatewayToken), networkToken: bearer(value.networkToken) };
  }

  private headers(c: SandGatewayConnection): Record<string, string> {
    return { authorization: `Bearer ${c.gatewayToken}`, "x-anyrun-network-token": c.networkToken, "content-type": "application/json" };
  }
  async box(method: string, c: SandGatewayConnection, data: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!BOX_METHODS.has(method)) throw new SandProvisionError("BOX_METHOD_INVALID");
    const r = await this.request(`${c.gatewayUrl}/api/${method}`, { method: "POST", headers: this.headers(c), body: JSON.stringify(data) }, signal, 4 * 1024 * 1024);
    if (r.status !== 200) throw new SandProvisionError("BOX_GATEWAY_REJECTED", r.status);
    return r.value;
  }
  async health(c: SandGatewayConnection, signal: AbortSignal): Promise<{ pid: number; isBusy: boolean }> {
    const r = await this.request(`${c.gatewayUrl}/health`, { method: "GET", headers: this.headers(c) }, signal);
    const v = object(r.value);
    if (r.status !== 200 || v.ok !== true || !Number.isSafeInteger(v.pid) || Number(v.pid) <= 0 || typeof v.isBusy !== "boolean") throw new SandProvisionError("BOX_HEALTH_INVALID");
    return { pid: Number(v.pid), isBusy: v.isBusy };
  }
  async probe(c: SandGatewayConnection, signal: AbortSignal): Promise<SandRelayProbe | null> {
    const nonce = randomBytes(16).toString("hex");
    const r = await this.request(`${c.gatewayUrl}${RELAY_PATH}`, { method: "POST", body: "", headers: {
      ...this.headers(c), "content-type": "application/connect+proto", "connect-protocol-version": "1",
      "x-oc-sand-box-probe": "1", "x-oc-sand-box-probe-nonce": nonce,
    } }, signal);
    if (r.status === 404 || (r.status === 200 && !/application\/json/i.test(r.contentType))) return null;
    if (r.status !== 200) throw new SandProvisionError("BOX_PROBE_PENDING", r.status);
    const v = object(r.value);
    if (v.protocol !== "oc-sand-relay-v2" || v.nonce !== nonce || typeof v.moduleSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.moduleSha256)
      || !Number.isSafeInteger(v.active) || Number(v.active) < 0 || !Number.isSafeInteger(v.maxConcurrent) || Number(v.maxConcurrent) < 1) throw new SandProvisionError("BOX_PROBE_INVALID");
    return { moduleHash: v.moduleSha256, active: Number(v.active), maxConcurrent: Number(v.maxConcurrent) };
  }
}
