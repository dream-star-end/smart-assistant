import test from "node:test";
import assert from "node:assert/strict";
import { BOX_CLI_VERSIONS, BoxCliVersionError, BoxCliVersionGate, boxCliNativeResumeVerified,
  gateBoxLaunchResolver, makeBoxCliVersionRead, parseBoxCliVersion } from "./boxCliVersion.js";
import { BoxExecTransport } from "./boxExecTransport.js";

function box(accountId: bigint, versions: Array<string | Error>) {
  let reads = 0, disposed = 0;
  const target = { accountId, exec: { run: async (request: { command: string; args: string[] }) => {
    assert.deepEqual(request, makeBoxCliVersionRead(), "one fixed read-only request");
    const next = versions[Math.min(reads++, versions.length - 1)]!;
    if (next instanceof Error) throw next;
    return { stdout: next, stderrBytes: 0, exitCode: 0 as const };
  } }, dispose: async () => { disposed++; } };
  return { target: target as never, reads: () => reads, disposed: () => disposed,
    cliVersion: () => (target as { cliVersion?: string }).cliVersion };
}

test("the version read is a fixed read-only request and only an exact version line parses", () => {
  const request = makeBoxCliVersionRead();
  assert.equal(request.command, "/usr/bin/python3");
  assert.deepEqual(request.args.slice(0, 2), ["-I", "-c"]);
  assert.equal(request.args.length, 3);
  assert.equal(parseBoxCliVersion("2.1.288\n"), "2.1.288");
  for (const bad of ["2.1.288", "2.1.288 (Claude Code)\n", "v2.1.288\n", "2.1\n", "\n", "2.1.288\n\n",
    "2.1.288\nrm -rf\n"]) assert.equal(parseBoxCliVersion(bad), null, JSON.stringify(bad));
  assert.deepEqual(Object.keys(BOX_CLI_VERSIONS).sort(), ["2.1.280", "2.1.288"]);
  assert.equal(boxCliNativeResumeVerified("2.1.280"), true);
  assert.equal(boxCliNativeResumeVerified("2.1.288"), false);
  assert.equal(boxCliNativeResumeVerified("2.1.999"), false);
  assert.equal(boxCliNativeResumeVerified(undefined), false);
  assert.equal(boxCliNativeResumeVerified("constructor"), false);
});

test("a new launch is refused before anything is admitted unless the installed CLI is supported", async () => {
  const rejected: unknown[] = [];
  const gate = new BoxCliVersionGate({ onRejected: (info) => rejected.push(info) });
  const supported = box(25n, ["2.1.288\n"]);
  const resolve = gateBoxLaunchResolver(async (args: { requiredAccountId?: bigint; box: ReturnType<typeof box> }) =>
    args.box.target, gate);
  const launched = await resolve({ box: supported });
  assert.equal(launched.cliVersion, "2.1.288");
  assert.equal(supported.disposed(), 0);

  const newer = box(26n, ["2.1.300\n"]);
  await assert.rejects(resolve({ box: newer }), (error: unknown) =>
    error instanceof BoxCliVersionError && error.code === "BOX_CLI_VERSION_UNSUPPORTED"
      && error.observed === "2.1.300");
  assert.equal(newer.disposed(), 1, "the unused target is closed");
  assert.equal(newer.cliVersion(), undefined);

  for (const unreadable of [box(27n, ["not a version\n"]), box(28n, [new Error("BOX_EXEC_REMOTE_EXIT")])]) {
    await assert.rejects(resolve({ box: unreadable }), (error: unknown) =>
      error instanceof BoxCliVersionError && error.code === "BOX_CLI_VERSION_UNREADABLE");
    assert.equal(unreadable.disposed(), 1);
  }
  assert.deepEqual(rejected, [
    { accountId: "26", code: "BOX_CLI_VERSION_UNSUPPORTED", observed: "2.1.300" },
    { accountId: "27", code: "BOX_CLI_VERSION_UNREADABLE", observed: "unreadable" },
    { accountId: "28", code: "BOX_CLI_VERSION_UNREADABLE", observed: "unreadable" },
  ]);
});

test("a pinned resolve (continuation, cleanup, stop) is only annotated and never refused", async () => {
  const gate = new BoxCliVersionGate();
  const resolve = gateBoxLaunchResolver(async (args: { requiredAccountId?: bigint; box: ReturnType<typeof box> }) =>
    args.box.target, gate);
  const unsupported = box(30n, ["2.1.300\n"]);
  const pinned = await resolve({ requiredAccountId: 30n, box: unsupported });
  assert.equal(pinned.cliVersion, undefined, "unknown build: no native pointer downstream");
  assert.equal(unsupported.disposed(), 0, "the existing run keeps its target");
  const unreadable = box(31n, [new Error("BOX_EXEC_TIMEOUT")]);
  assert.equal((await resolve({ requiredAccountId: 31n, box: unreadable })).cliVersion, undefined);
  assert.equal(unreadable.disposed(), 0);
  const known = box(32n, ["2.1.280\n"]);
  assert.equal((await resolve({ requiredAccountId: 32n, box: known })).cliVersion, "2.1.280");
});

test("a supported result is cached per account for the TTL; a refusal is never cached", async () => {
  let now = 1_000_000;
  const gate = new BoxCliVersionGate({ ttlMs: 300_000, now: () => now });
  const a = box(25n, ["2.1.288\n", "2.1.300\n"]);
  assert.equal(await gate.read(a.target), "2.1.288");
  now += 299_999;
  assert.equal(await gate.read(a.target), "2.1.288");
  assert.equal(a.reads(), 1, "inside the TTL the Box is not asked again");
  const other = box(26n, ["2.1.280\n"]);
  assert.equal(await gate.read(other.target), "2.1.280", "the cache is per account");
  now += 2;
  await assert.rejects(gate.read(a.target), BoxCliVersionError, "after the TTL the new build is seen");
  assert.equal(a.reads(), 2);
  const flaky = box(27n, [new Error("BOX_EXEC_TIMEOUT"), "2.1.280\n"]);
  await assert.rejects(gate.read(flaky.target), BoxCliVersionError);
  assert.equal(await gate.read(flaky.target), "2.1.280", "a failed read is retried at once");
  assert.equal(flaky.reads(), 2);
});

test("the version read is a request the real Box exec transport sends", async () => {
  // rel-0ee3b3710 asked for a 64-byte response; the transport's floor is 1024,
  // so the read was refused locally and every Box read as unreadable.
  let sent = 0;
  const transport = new BoxExecTransport(
    { execUrl: "https://box.invalid/exec", execToken: "exec", networkToken: "network" },
    (async () => { sent += 1; throw new Error("stop once the request has left"); }) as never,
    async () => {});
  await assert.rejects(() => new BoxCliVersionGate().read({ accountId: 25n, exec: transport } as never),
    (error: unknown) => error instanceof BoxCliVersionError && error.code === "BOX_CLI_VERSION_UNREADABLE");
  assert.equal(sent, 1, "the read passed the transport's own request checks");
});
