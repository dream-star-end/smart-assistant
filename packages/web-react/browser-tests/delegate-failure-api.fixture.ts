/** Private loopback browser seam. Original HTTP handler/store/SQLite; identity,
 * lifecycle/native eligibility are explicit fixtures, not production JWT/native E2E. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegateDurableDb } from "../../gateway/src/delegateDurable.js";
import { DelegateJobStore } from "../../gateway/src/delegateJobs.js";
import { handleDelegateUserHttp } from "../../gateway/src/delegateUserHttp.js";
import { DelegateRetryUnavailable, type DelegateRetryActionKey } from "../../gateway/src/delegateRetrySource.js";

export async function createFailureUiServer(html: (path: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "delegate-browser-")), path = join(dir, "jobs.db");
  let now = Date.now() - 3_600_000;
  let db = new DelegateDurableDb(path);
  let jobs = new DelegateJobStore({ sm: true, durable: db, failureInbox: true, ttlMs: 1000, maxJobs: 200, now: () => now });
  const ids: Record<string, string[]> = { alice: [], bob: [] };
  for (const [user, n] of [["alice", 51], ["bob", 3]] as const) for (let i = 0; i < n; i++) {
    const parent = `agent:main:webchat:dm:session-${user}`;
    const made = jobs.create("worker", { queued: true, callback: "none", callbackOriginUserId: user,
      parentSessionKey: parent, sessionKey: `agent:worker:delegate:main:${user}-${i}`,
      retrySource: { version: 1, userId: user, parentSessionKey: parent, originSessionKey: parent,
        parentClientSessionId: `session-${user}`, childSessionKey: `agent:worker:delegate:main:${user}-${i}`,
        targetAgentId: "worker", sourceAgentId: "main", model: "gpt-6-astra", depth: 0 } });
    assert.ok("jobId" in made); ids[user].push(made.jobId);
    assert.equal(jobs.fail(made.jobId, { failureClass: "child_error", detail: "PRIVATE_RAW_SECRET_DETAIL", httpStatus: 500 }), true);
  }
  now += 1001; assert.equal(jobs.sweep(), 54);
  const reopen = () => { jobs.close(); db.close(); db = new DelegateDurableDb(path);
    jobs = new DelegateJobStore({ sm: true, durable: db, failureInbox: true, maxJobs: 200, now: () => now }); };
  reopen();
  let failAck = false, dropRetry = false, unavailable = false, appSessions = false;
  const sessionReads: string[] = [], sessionWrites: string[] = [];
  const retryKeys: DelegateRetryActionKey[] = [], ackCalls: string[] = [];
  const nativeUnavailable = new Set<string>();
  let heldSummary: { started: () => void; release: (() => void) | null; closed: boolean } | null = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const user = req.headers.authorization === "Bearer B" ? "bob" : req.headers.authorization === "Bearer A" ? "alice" : null;
    if (url.pathname.startsWith("/api/delegates/")) {
      if (unavailable) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"private_fault"}'); return; }
      if (url.pathname.endsWith("/ack")) { ackCalls.push(url.pathname); if (failAck) { db.failNextWrite = true; failAck = false; } }
      void handleDelegateUserHttp(req, res, url, {
        user: () => user, store: () => jobs,
        readBody: async r => { let body = ""; for await (const chunk of r) { body += String(chunk); assert.ok(body.length < 8192); } return body; },
        reconcileLifecycle: async () => true,
        retryAvailability: async (uid, rows) => rows.map(row => nativeUnavailable.has(row.jobId)
          ? { available: false, reason: "retry_native_unavailable" }
          : { available: !jobs.hasActiveRetryChild(jobs.getRetrySource(uid, row.jobId, row.generation)?.childSessionKey ?? ""), reason: "retry_child_busy" }),
        retry: async (key, authorize) => {
          authorize(); retryKeys.push(key);
          const previous = jobs.getRetryAction(key);
          if (previous) return { replay: true, action: previous };
          if (nativeUnavailable.has(key.sourceJobId)) throw new DelegateRetryUnavailable(409, "retry_native_unavailable");
          const source = jobs.getRetrySource(key.userId, key.sourceJobId, key.generation);
          if (!source) throw new DelegateRetryUnavailable(409, "retry_source_unavailable");
          const accepted = jobs.acceptRetryAction(key, source, "codex");
          if ("error" in accepted) throw new DelegateRetryUnavailable(409, `retry_${accepted.error}`);
          return { replay: accepted.kind === "replay", action: accepted.action };
        },
        send: (r, status, value) => {
          if (heldSummary && user === "alice" && url.pathname.endsWith("/summary") && status === 200) {
            const held = heldSummary; heldSummary = null;
            const body = JSON.stringify(value);
            r.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
            r.flushHeaders(); r.write(body.slice(0, 1));
            r.on("close", () => { held.closed = true; });
            held.release = () => r.end(body.slice(1)); held.started(); return;
          }
          if (url.pathname.endsWith("/retry") && dropRetry && status === 202) {
            // Commit response headers first: a bare pre-header close can be transparently
            // replayed by Chromium, which is not the ambiguous-body contract under test.
            dropRetry = false; r.writeHead(202, { "content-type": "application/json", "content-length": "9999" });
            r.flushHeaders(); r.write('{"version":'); setTimeout(() => r.destroy(), 10); return;
          }
          r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(value));
        },
      }).catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      let body: unknown = {};
      if (url.pathname === "/api/auth/refresh") body = { access_token: "A", access_exp: Date.now() / 1000 + 3600, remember: true };
      else if (url.pathname === "/api/me") body = { user: { id: "alice", email: "private@example.test", email_verified: true, role: "user", display_name: "Private", credits: "1000" } };
      else if (url.pathname === "/api/public/config") body = { turnstile_bypass: true, require_email_verified: false, allow_registration: true };
      else if (url.pathname === "/api/public/models") body = { models: [{ id: "glm-5.2", display_name: "GLM-5.2", engine: "ccb" }] };
      else if (url.pathname === "/api/me/preferences") body = { prefs: { default_model: "glm-5.2" } };
      else if (url.pathname === "/api/agent/status") body = { runtime_ready: true, container: { id: "private", status: "running" }, subscription: { status: "active" } };
      else if (url.pathname === "/api/sessions/list") body = { sessions: appSessions ? [
        { id: "session-other", title: "另一会话", agentId: "main", updatedAt: now + 1, createdAt: now, lastAt: now + 1, messageCount: 0, modelId: "glm-5.2" },
        { id: "session-alice", title: "失败来源会话", agentId: "main", updatedAt: now, createdAt: now, lastAt: now, messageCount: 0, modelId: "glm-5.2" },
      ] : [] };
      else if (/^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split("/").at(-1)!;
        if (req.method === "GET") { sessionReads.push(id); body = { id, agentId: "main", title: id, messages: [], updatedAt: now }; }
        else { sessionWrites.push(`${req.method}:${id}`); body = { ok: true, updatedAt: now }; }
      }
      else if (url.pathname === "/api/marketplace/my-agents") body = { agents: [{ id: "main", slug: "main", name: "全能助手", installed: true, isDefault: true }] };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html(url.pathname));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ids, ackCalls, retryKeys, reopen, sessionReads, sessionWrites,
    enableAppSessions: () => { appSessions = true; },
    failNextAck: () => { failAck = true; }, dropNextRetry: () => { dropRetry = true; },
    setUnavailable: (v: boolean) => { unavailable = v; },
    setNativeUnavailable: (id: string, value: boolean) => { if (value) nativeUnavailable.add(id); else nativeUnavailable.delete(id); },
    holdNextAliceSummary: () => {
      assert.equal(heldSummary, null);
      let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
      const held = { started, release: null as (() => void) | null, closed: false }; heldSummary = held;
      return { ready, release: () => { assert.ok(held.release); held.release(); }, closed: () => held.closed };
    },
    count: (user: string) => jobs.userSummary(user).unacknowledgedFailures,
    retrySnapshot: () => retryKeys.map(k => ({ state: jobs.getRetryAction(k)?.state, target: jobs.getRetryAction(k)?.targetJobId })),
    retryTargets: () => new Set(retryKeys.flatMap(k => { const id = jobs.getRetryAction(k)?.targetJobId; return id ? [id] : []; })).size,
    finishRetry: () => { const k = retryKeys[0]; assert.ok(k); const a = jobs.getRetryAction(k)!;
      assert.equal(jobs.fail(a.targetJobId, { failureClass: "child_error", detail: "private retry failure", httpStatus: 500 }), true); },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); jobs.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
