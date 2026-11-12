import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BOX_EXEC_REJECTION_READ_BYTES, BoxExecTransport, BoxExecTransportError,
  redactBoxExecRejection } from "./boxExecTransport.js";

const target = {
  execUrl: "https://box.example.test/connect.exec.v1.ExecService/Exec",
  execToken: "synthetic-exec-secret",
  networkToken: "synthetic-network-secret",
};
const request = { command: "/usr/bin/python3", args: ["--version"], cwd: "/tmp", environment: {} };
function frame(value: unknown, flag = 0): Buffer {
  const raw = Buffer.from(JSON.stringify(value));
  const out = Buffer.alloc(5 + raw.length);
  out[0] = flag;
  out.writeUInt32BE(raw.length, 1);
  raw.copy(out, 5);
  return out;
}
function streamResponse(...parts: Buffer[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }), { status: 200 });
}
async function code(promise: Promise<unknown>): Promise<BoxExecTransportError> {
  try { await promise; throw new Error("EXPECTED_ERROR"); }
  catch (error) {
    assert.ok(error instanceof BoxExecTransportError);
    assert.ok(!error.message.includes(target.execToken));
    return error;
  }
}

describe("bounded Box Connect Exec transport", () => {
  it("uses official framing/auth once and requires full EOF after exit=0", async () => {
    let guards = 0, calls = 0;
    const data = Buffer.concat([frame({ stdoutEvent: { data: "first" } }),
      frame({ stderrEvent: { data: "warning" } }), frame({ exitEvent: {} }), frame({}, 2)]);
    const transport = new BoxExecTransport(target, async (url, init) => {
      calls++;
      assert.equal(url, target.execUrl);
      assert.equal(init.method, "POST");
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${target.execToken}`);
      assert.equal((init.headers as Record<string, string>)["x-anyrun-network-token"], target.networkToken);
      const encoded = Buffer.from(init.body as Uint8Array);
      assert.equal(encoded[0], 0);
      assert.deepEqual(JSON.parse(encoded.subarray(5).toString("utf8")), request);
      return streamResponse(data.subarray(0, 7), data.subarray(7));
    }, async () => { guards++; });
    const chunks: string[] = [];
    const result = await transport.run(request, { timeoutMs: 2000, onStdout: (part) => chunks.push(part) });
    assert.deepEqual(result, { stdout: "first", stderrBytes: 7, exitCode: 0 });
    assert.deepEqual(chunks, ["first"]);
    assert.equal(calls, 1);
    assert.equal(guards, 1);
  });

  it("does not retry 429/503 or classify absence of terminal frame as success", async () => {
    for (const status of [429, 503]) {
      let calls = 0;
      const transport = new BoxExecTransport(target, async () => {
        calls++;
        return new Response("secret upstream body", { status });
      }, async () => {});
      const error = await code(transport.run(request, { timeoutMs: 2000 }));
      assert.equal(error.code, `BOX_EXEC_HTTP_${status}`);
      assert.equal(error.terminalKnown, false);
      assert.equal(calls, 1);
    }
    const missingExit = new BoxExecTransport(target,
      async () => streamResponse(frame({ stdoutEvent: { data: "text" } })), async () => {});
    const error = await code(missingExit.run(request, { timeoutMs: 2000 }));
    assert.equal(error.code, "BOX_EXEC_INCOMPLETE");
    assert.equal(error.terminalKnown, false);
    const missingConnectEnd = new BoxExecTransport(target,
      async () => streamResponse(frame({ exitEvent: {} })), async () => {});
    const noEnd = await code(missingConnectEnd.run(request, { timeoutMs: 2000 }));
    assert.equal(noEnd.code, "BOX_EXEC_INCOMPLETE");
  });

  it("separates known remote nonzero exit from corrupt/ambiguous transport", async () => {
    const nonzero = new BoxExecTransport(target,
      async () => streamResponse(frame({ exitEvent: { exitCode: 3 } }), frame({}, 2)), async () => {});
    const remote = await code(nonzero.run(request, { timeoutMs: 2000 }));
    assert.equal(remote.code, "BOX_EXEC_REMOTE_EXIT");
    assert.equal(remote.terminalKnown, true);
    assert.equal(remote.remoteExitCode, 3);

    const corrupt = new BoxExecTransport(target,
      async () => streamResponse(frame({ unknownEvent: {} }), frame({ exitEvent: { exitCode: 0 } })),
      async () => {});
    const unknown = await code(corrupt.run(request, { timeoutMs: 2000 }));
    assert.equal(unknown.code, "BOX_EXEC_FRAME_INVALID");
    assert.equal(unknown.terminalKnown, false);
    const connectError = new BoxExecTransport(target,
      async () => streamResponse(frame({ exitEvent: {} }),
        frame({ error: { code: "unavailable" } }, 2)), async () => {});
    const endError = await code(connectError.run(request, { timeoutMs: 2000 }));
    assert.equal(endError.code, "BOX_EXEC_FRAME_INVALID");
    assert.equal(endError.terminalKnown, false);
  });

  it("aborts before network use when caller signal is already cancelled", async () => {
    let called = false;
    const transport = new BoxExecTransport(target, async () => {
      called = true;
      throw new Error("SHOULD_NOT_CALL");
    }, async () => {});
    const abort = new AbortController();
    abort.abort();
    const error = await code(transport.run(request, { timeoutMs: 2000, signal: abort.signal }));
    assert.equal(error.code, "BOX_EXEC_ABORTED");
    assert.equal(called, false);
  });

  it("fails closed and does not send credentials when account guard changes", async () => {
    let called = false;
    const transport = new BoxExecTransport(target, async () => {
      called = true;
      throw new Error("SHOULD_NOT_CALL");
    }, async () => { throw new Error("raw account snapshot changed"); });
    const error = await code(transport.run(request, { timeoutMs: 2000 }));
    assert.equal(error.code, "BOX_EXEC_ACCOUNT_GUARD_FAILED");
    assert.equal(called, false);
  });

  it("bounds the account guard itself and never fetches after its late success", async () => {
    let releaseGuard!: () => void;
    const guard = new Promise<void>((resolve) => { releaseGuard = resolve; });
    let called = false;
    const transport = new BoxExecTransport(target, async () => {
      called = true;
      return streamResponse(frame({ exitEvent: {} }), frame({}, 2));
    }, () => guard);
    const error = await code(transport.run(request, { timeoutMs: 1000 }));
    assert.equal(error.code, "BOX_EXEC_TIMEOUT");
    releaseGuard();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(called, false);
  });

  it("distinguishes a dispatched fetch deadline from caller cancellation without replay", async () => {
    let calls = 0;
    const transport = new BoxExecTransport(target, async () => {
      calls++;
      return new Promise<Response>(() => {});
    }, async () => {});
    const error = await code(transport.run(request, { timeoutMs: 1000 }));
    assert.equal(error.code, "BOX_EXEC_TIMEOUT");
    assert.equal(error.terminalKnown, false);
    assert.equal(calls, 1);
  });

  it("distinguishes a stalled response stream deadline from caller cancellation", async () => {
    const transport = new BoxExecTransport(target, async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
    async () => {});
    const error = await code(transport.run(request, { timeoutMs: 1000 }));
    assert.equal(error.code, "BOX_EXEC_TIMEOUT");
    assert.equal(error.terminalKnown, false);
  });

  it("does not deliver a second same-batch stdout after callback cancellation", async () => {
    const abort = new AbortController();
    const seen: string[] = [];
    const combined = Buffer.concat([frame({ stdoutEvent: { data: "A" } }),
      frame({ stdoutEvent: { data: "B" } }), frame({ exitEvent: {} }), frame({}, 2)]);
    const transport = new BoxExecTransport(target, async () => streamResponse(combined), async () => {});
    const error = await code(transport.run(request, { timeoutMs: 2000, signal: abort.signal,
      onStdout: (chunk) => { seen.push(chunk); if (chunk === "A") abort.abort(); } }));
    assert.equal(error.code, "BOX_EXEC_ABORTED");
    assert.deepEqual(seen, ["A"]);
  });

  it("bounds cleanup of a standard tee'd HTTP error response", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from("error")); },
    });
    const [first, second] = source.tee();
    const transport = new BoxExecTransport(target,
      async () => new Response(first, { status: 503 }), async () => {});
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const error = await Promise.race([
        code(transport.run(request, { timeoutMs: 2000 })),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("CLEANUP_HUNG")), 800); }),
      ]);
      assert.equal(error.code, "BOX_EXEC_HTTP_503");
      assert.equal(error.terminalKnown, false);
    } finally {
      if (timeout) clearTimeout(timeout);
      await second.cancel();
    }
  });

  it("bounds cleanup of a tee'd corrupt frame without changing unknown classification", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(frame({ unknownEvent: {} })); },
    });
    const [first, second] = source.tee();
    const transport = new BoxExecTransport(target,
      async () => new Response(first, { status: 200 }), async () => {});
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const error = await Promise.race([
        code(transport.run(request, { timeoutMs: 2000 })),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("CLEANUP_HUNG")), 800); }),
      ]);
      assert.equal(error.code, "BOX_EXEC_FRAME_INVALID");
      assert.equal(error.terminalKnown, false);
    } finally {
      if (timeout) clearTimeout(timeout);
      await second.cancel();
    }
  });
});

describe("OCV5-762 Exec 417: refresh the descriptor before the next call", () => {
  const fresh = {
    execUrl: "https://box2.example.test/agent.v1.ControlService/Exec",
    execToken: "synthetic-fresh-exec-secret",
    networkToken: "synthetic-fresh-network-secret",
  };
  const ok = () => streamResponse(frame({ stdoutEvent: { data: "ok" } }), frame({ exitEvent: {} }), frame({}, 2));
  const refused = () => new Response(JSON.stringify({ code: "failed_precondition",
    message: "exec session expectation failed",
    detail: `Bearer ${target.execToken} ${target.networkToken} eyJhbGciOi.eyJzdWIiOiJ4.c2ln https://api2.cursor.sh/x?token=abc ${"f".repeat(40)}` }),
  { status: 417 });

  it("a 417 is not retried by the transport; the next call uses a refreshed descriptor", async () => {
    const seen: Array<{ url: string; auth: string; network: string }> = [];
    let refreshes = 0;
    const rejections: Array<{ status: number; bodyBytes: number; excerpt: string }> = [];
    const transport = new BoxExecTransport(target, async (url, init) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ url, auth: headers.authorization!, network: headers["x-anyrun-network-token"]! });
      return seen.length === 1 ? refused() : ok();
    }, async () => {}, { refreshTarget: async () => { refreshes++; return fresh; },
      onRejected: (rejection) => rejections.push(rejection) });
    const error = await code(transport.run(request, { timeoutMs: 2000 }));
    assert.equal(error.code, "BOX_EXEC_HTTP_417");
    assert.equal(seen.length, 1);
    assert.equal(refreshes, 0);
    assert.equal(rejections.length, 1);
    const excerpt = rejections[0]!.excerpt;
    assert.match(excerpt, /exec session expectation failed/);
    for (const secret of [target.execToken, target.networkToken, fresh.execToken, "eyJhbGciOi", "token=abc", "f".repeat(40)]) {
      assert.ok(!excerpt.includes(secret), secret);
    }
    assert.ok(excerpt.length <= 301);
    assert.deepEqual(await transport.run(request, { timeoutMs: 2000 }), { stdout: "ok", stderrBytes: 0, exitCode: 0 });
    assert.equal(refreshes, 1);
    assert.deepEqual(seen[1], { url: fresh.execUrl, auth: `Bearer ${fresh.execToken}`, network: fresh.networkToken });
    await transport.run(request, { timeoutMs: 2000 });
    assert.equal(refreshes, 1, "a successful refresh is not repeated");
    assert.equal(seen[2]!.url, fresh.execUrl);
  });

  it("a failed or invalid refresh sends nothing and is BOX_EXEC_REFRESH_FAILED", async () => {
    for (const refreshTarget of [async () => { throw new Error(`denied ${target.execToken}`); },
      async () => ({ ...fresh, execUrl: "http://box2.example.test/Exec" }),
      async () => ({ ...fresh, execToken: "" })]) {
      let calls = 0;
      const transport = new BoxExecTransport(target, async () => { calls++; return refused(); },
        async () => {}, { refreshTarget });
      assert.equal((await code(transport.run(request, { timeoutMs: 2000 }))).code, "BOX_EXEC_HTTP_417");
      assert.equal((await code(transport.run(request, { timeoutMs: 2000 }))).code, "BOX_EXEC_REFRESH_FAILED");
      assert.equal(calls, 1);
    }
  });

  it("a hung refresh fails on its own deadline and the next call refreshes again", async () => {
    let calls = 0;
    let refreshes = 0;
    let firstAborted = false;
    const transport = new BoxExecTransport(target, async () => { calls++; return calls === 1 ? refused() : ok(); },
      async () => {}, { refreshTimeoutMs: 200, refreshTarget: (signal) => {
        refreshes++;
        if (refreshes > 1) return Promise.resolve(fresh);
        return new Promise((_, reject) => signal.addEventListener("abort", () => {
          firstAborted = true;
          reject(new Error("aborted"));
        }, { once: true }));
      } });
    assert.equal((await code(transport.run(request, { timeoutMs: 2000 }))).code, "BOX_EXEC_HTTP_417");
    assert.equal((await code(transport.run(request, { timeoutMs: 2000 }))).code, "BOX_EXEC_REFRESH_FAILED");
    assert.ok(firstAborted, "the hung refresh is aborted at its deadline");
    assert.equal(calls, 1);
    assert.deepEqual(await transport.run(request, { timeoutMs: 2000 }), { stdout: "ok", stderrBytes: 0, exitCode: 0 });
    assert.equal(refreshes, 2);
  });

  it("running out of time during a refresh is BOX_EXEC_REFRESH_FAILED; a caller abort stays ABORTED", async () => {
    let calls = 0;
    const transport = new BoxExecTransport(target, async () => { calls++; return refused(); },
      async () => {}, { refreshTimeoutMs: 1300, refreshTarget: (signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }) });
    assert.equal((await code(transport.run(request, { timeoutMs: 2000 }))).code, "BOX_EXEC_HTTP_417");
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 50);
    assert.equal((await code(transport.run(request, { timeoutMs: 2000, signal: caller.signal }))).code, "BOX_EXEC_ABORTED");
    assert.equal((await code(transport.run(request, { timeoutMs: 1000 }))).code, "BOX_EXEC_REFRESH_FAILED");
    assert.equal(calls, 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it("the account guard runs again after a refresh, before anything is sent", async () => {
    let calls = 0;
    let guards = 0;
    const transport = new BoxExecTransport(target, async () => { calls++; return refused(); },
      async () => { guards++; if (guards === 3) throw new Error("credential changed"); },
      { refreshTarget: async () => fresh });
    assert.equal((await code(transport.run(request, { timeoutMs: 2000 }))).code, "BOX_EXEC_HTTP_417");
    assert.equal((await code(transport.run(request, { timeoutMs: 2000 }))).code, "BOX_EXEC_ACCOUNT_GUARD_FAILED");
    assert.equal(guards, 3);
    assert.equal(calls, 1);
  });

  it("other HTTP failures never refresh, and without a refresher a 417 keeps the descriptor", async () => {
    let refreshes = 0;
    const urls: string[] = [];
    const statuses = [503, 200];
    const t1 = new BoxExecTransport(target, async (url) => {
      urls.push(url);
      const status = statuses.shift()!;
      return status === 200 ? ok() : new Response("busy", { status });
    }, async () => {}, { refreshTarget: async () => { refreshes++; return fresh; } });
    assert.equal((await code(t1.run(request, { timeoutMs: 2000 }))).code, "BOX_EXEC_HTTP_503");
    await t1.run(request, { timeoutMs: 2000 });
    assert.equal(refreshes, 0);
    assert.deepEqual(urls, [target.execUrl, target.execUrl]);
    let calls = 0;
    const t2 = new BoxExecTransport(target, async (url) => {
      calls++;
      assert.equal(url, target.execUrl);
      return calls === 1 ? refused() : ok();
    }, async () => {});
    assert.equal((await code(t2.run(request, { timeoutMs: 2000 }))).code, "BOX_EXEC_HTTP_417");
    await t2.run(request, { timeoutMs: 2000 });
  });

  it("the rejection excerpt is bounded and reads at most 2048 body bytes", () => {
    const body = Buffer.from(`${"word ".repeat(1000)}\u0000\u0007 Bearer abc.def ${"x".repeat(5000)}`);
    const excerpt = redactBoxExecRejection(body);
    assert.ok(excerpt.length <= 301);
    assert.ok(Array.from(excerpt).every((ch) => (ch.codePointAt(0) ?? 0) >= 0x20), "no control characters");
    assert.equal(redactBoxExecRejection(Buffer.from("plain short reason")), "plain short reason");
    assert.equal(redactBoxExecRejection(Buffer.from("use synthetic-secret here"), ["synthetic-secret"]),
      "use <redacted> here");
    assert.equal(BOX_EXEC_REJECTION_READ_BYTES, 2048);
  });
});
