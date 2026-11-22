import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { makeForwarder } from "../egress/forwarder.js";

function listenHttp(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
      server.closeAllConnections?.();
    } catch {
      resolve();
    }
  });
}

async function reserveUnusedPort(): Promise<number> {
  const probe = createNetServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function sendRequest(opts: {
  port: number;
  method: string;
  path: string;
  body?: Buffer | string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

test("egress forwarder retries ECONNREFUSED during master VIP handoff and preserves POST body", async () => {
  const upstreamPort = await reserveUnusedPort();
  const forward = makeForwarder({
    controlBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    retryBudgetMs: 2_500,
    retryDelaysMs: [50, 100, 150],
  });
  const egressServer = createServer((req, res) => forward(req, res, "172.31.0.2"));
  const egressPort = await listenHttp(egressServer);

  let receivedBody = "";
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      receivedBody = Buffer.concat(chunks).toString("utf8");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, echoed: receivedBody }));
    });
  });

  // Delay upstream bind by 180ms to simulate VIP cutover gap
  const startTimer = setTimeout(() => {
    void listenHttp(upstream, upstreamPort);
  }, 180);

  try {
    const payload = JSON.stringify({ query: "cutover-test", n: 42 });
    const resp = await sendRequest({
      port: egressPort,
      method: "POST",
      path: "/internal/v3/project-search",
      body: payload,
      headers: { "content-type": "application/json" },
    });
    assert.equal(resp.status, 200);
    assert.equal(receivedBody, payload);
    assert.deepEqual(JSON.parse(resp.body), { ok: true, echoed: payload });
  } finally {
    clearTimeout(startTimer);
    await closeServer(upstream);
    await closeServer(egressServer);
  }
});

test("egress forwarder retries pre-header ECONNRESET and succeeds on next attempt", async () => {
  let attempts = 0;
  const upstream = createServer((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      req.socket.destroy();
      return;
    }
    res.statusCode = 200;
    res.end("recovered");
  });
  const upstreamPort = await listenHttp(upstream);
  const forward = makeForwarder({
    controlBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    retryBudgetMs: 2_000,
    retryDelaysMs: [30, 60],
  });
  const egressServer = createServer((req, res) => forward(req, res, "172.31.0.2"));
  const egressPort = await listenHttp(egressServer);

  try {
    const resp = await sendRequest({
      port: egressPort,
      method: "GET",
      path: "/internal/v3/project-search?q=hi",
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.body, "recovered");
    assert.equal(attempts, 2);
  } finally {
    await closeServer(upstream);
    await closeServer(egressServer);
  }
});

test("B09: egress forwarder NEVER replays non-idempotent POST on post-connect ECONNRESET", async () => {
  let sideEffectCount = 0;
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      sideEffectCount += 1;
      // Simulate upstream executing side effect (e.g., Muse job / delegate route mint)
      // and resetting socket before writing response headers.
      req.socket.destroy();
      void res;
    });
  });
  const upstreamPort = await listenHttp(upstream);
  const forward = makeForwarder({
    controlBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    retryBudgetMs: 2_000,
    retryDelaysMs: [30, 60],
  });
  const egressServer = createServer((req, res) => forward(req, res, "172.31.0.2"));
  const egressPort = await listenHttp(egressServer);

  try {
    const resp = await sendRequest({
      port: egressPort,
      method: "POST",
      path: "/internal/v3/muse-media/jobs",
      body: JSON.stringify({ kind: "image", prompt: "cat" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(resp.status, 503);
    const parsed = JSON.parse(resp.body) as { error?: { code?: string } };
    assert.equal(parsed.error?.code, "EGRESS_UPSTREAM_DOWN");
    assert.equal(sideEffectCount, 1, "non-idempotent POST must execute at most once");
  } finally {
    await closeServer(upstream);
    await closeServer(egressServer);
  }
});

test("B09: egress forwarder NEVER replays POST even with explicit Idempotency-Key on post-connect ECONNRESET", async () => {
  let sideEffectCount = 0;
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      sideEffectCount += 1;
      req.socket.destroy();
      void res;
    });
  });
  const upstreamPort = await listenHttp(upstream);
  const forward = makeForwarder({
    controlBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    retryBudgetMs: 2_000,
    retryDelaysMs: [30, 60],
  });
  const egressServer = createServer((req, res) => forward(req, res, "172.31.0.2"));
  const egressPort = await listenHttp(egressServer);

  try {
    const resp = await sendRequest({
      port: egressPort,
      method: "POST",
      path: "/internal/v3/idempotent-action",
      body: JSON.stringify({ k: 1 }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-abc-123",
      },
    });
    assert.equal(resp.status, 503);
    const parsed = JSON.parse(resp.body) as { error?: { code?: string } };
    assert.equal(parsed.error?.code, "EGRESS_UPSTREAM_DOWN");
    assert.equal(
      sideEffectCount,
      1,
      "non-safe POST with Idempotency-Key must NEVER replay after TCP connect",
    );
  } finally {
    await closeServer(upstream);
    await closeServer(egressServer);
  }
});

test("egress forwarder returns 503 EGRESS_UPSTREAM_DOWN when retry budget is exhausted", async () => {
  const deadPort = await reserveUnusedPort();
  const forward = makeForwarder({
    controlBaseUrl: `http://127.0.0.1:${deadPort}`,
    retryBudgetMs: 180,
    retryDelaysMs: [40, 60],
  });
  const egressServer = createServer((req, res) => forward(req, res, "172.31.0.2"));
  const egressPort = await listenHttp(egressServer);

  try {
    const resp = await sendRequest({
      port: egressPort,
      method: "GET",
      path: "/internal/v3/project-search",
    });
    assert.equal(resp.status, 503);
    const parsed = JSON.parse(resp.body) as { error?: { code?: string } };
    assert.equal(parsed.error?.code, "EGRESS_UPSTREAM_DOWN");
  } finally {
    await closeServer(egressServer);
  }
});

test("egress forwarder streams bodies exceeding maxRetryBodyBytes without buffering", async () => {
  const deadPort = await reserveUnusedPort();
  const forward = makeForwarder({
    controlBaseUrl: `http://127.0.0.1:${deadPort}`,
    retryBudgetMs: 2_000,
    retryDelaysMs: [500],
    maxRetryBodyBytes: 64,
  });
  const egressServer = createServer((req, res) => forward(req, res, "172.31.0.2"));
  const egressPort = await listenHttp(egressServer);

  try {
    const started = Date.now();
    const bigBody = Buffer.alloc(256, 0x61);
    const resp = await sendRequest({
      port: egressPort,
      method: "POST",
      path: "/internal/v3/server-authored-message",
      body: bigBody,
    });
    assert.equal(resp.status, 503);
    // Must fail fast (direct stream, no 2000ms retry loop)
    assert.ok(Date.now() - started < 1_000, "large body should bypass retry buffer and fail fast");
  } finally {
    await closeServer(egressServer);
  }
});

test("egress forwarder cancels retry promptly when client aborts", async () => {
  const deadPort = await reserveUnusedPort();
  const forward = makeForwarder({
    controlBaseUrl: `http://127.0.0.1:${deadPort}`,
    retryBudgetMs: 3_000,
    retryDelaysMs: [50, 100],
  });
  const egressServer = createServer((req, res) => forward(req, res, "172.31.0.2"));
  const egressPort = await listenHttp(egressServer);

  try {
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: egressPort,
        method: "GET",
        path: "/internal/v3/project-search",
      });
      req.on("error", () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 80);
    });
    // Give close handlers a tick to settle; closeServer completes cleanly with no hanging sockets
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await closeServer(egressServer);
  }
});
