import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CCB_BASELINE_TARGETS,
  classifyBaselineMounts,
  type MountLike,
} from "../lib/v5BaselineMounts.js";
import {
  acquireSafeRemovalTarget,
  assertContainerLabels,
  assertLocalCensusHost,
  assertNamedVolumesPreserved,
  hasExpectedRuntimeLabels,
  loadBridgeSecretReadOnly,
  remountTargets,
  type SafeRemovalTarget,
  verifyPlatformCliLinks,
} from "../v5-remount-ccb-baseline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const sources: Record<string, string> = Object.fromEntries(
  CCB_BASELINE_TARGETS.map((target, index) => [target, `/trusted/baseline/source-${index}`]),
);
const runtimeLabels = { "com.openclaude.runtime.release": "rel-current" };

function completeMounts(): MountLike[] {
  return CCB_BASELINE_TARGETS.map((destination) => ({
    Type: "bind",
    Source: sources[destination],
    Destination: destination,
    RW: false,
  }));
}

describe("V5 CCB baseline remount classification", () => {
  test("accepts exactly one trusted read-only bind for every baseline target", () => {
    assert.deepEqual(classifyBaselineMounts(completeMounts(), sources), {
      complete: true,
      missing: [],
    });
  });

  test("rejects a missing, writable, wrong-source, or duplicate baseline bind", () => {
    const cases: MountLike[][] = [
      completeMounts().slice(1),
      completeMounts().map((mount, index) => index === 1 ? { ...mount, RW: true } : mount),
      completeMounts().map((mount, index) => index === 2 ? { ...mount, Source: "/wrong" } : mount),
      [...completeMounts(), { ...completeMounts()[0] }],
    ];
    for (const mounts of cases) {
      const result = classifyBaselineMounts(mounts, sources);
      assert.equal(result.complete, false);
      assert.ok(result.missing.length >= 1);
    }
  });

  test("locks the production remount lane to authenticated non-forced V5 cleanup", async () => {
    const [source, deploySource, packageSource, workflow] = await Promise.all([
      readFile(path.join(root, "scripts/v5-remount-ccb-baseline.ts"), "utf8"),
      readFile(path.join(root, "scripts/deploy-v5.sh"), "utf8"),
      readFile(path.join(root, "package.json"), "utf8"),
      readFile(path.join(root, ".github/workflows/v5-ci.yml"), "utf8"),
    ]);
    assert.match(source, /runtime_channel='v5'/);
    assert.match(source, /state\.phase !== "stable"/);
    assert.match(source, /state\.candidate_slot !== null/);
    assert.match(source, /OC_V3_CCB_BASELINE_DIR does not belong to the active V5 slot/);
    assert.match(source, /assertLocalCensusHost\(row\.host_uuid, selfHost\.id\)/);
    assert.match(source, /requestRuntimeRecycleDrain\(deps, status\)/);
    assert.match(source, /result === "accepted"/);
    assert.match(source, /AuthorityKeyringReader\.open\(\)/);
    assert.doesNotMatch(source, /AuthoritySigner/);
    assert.match(source, /OC_V5_DEPLOY_LOCK_HELD !== "1"/);
    assert.match(source, /loadBridgeSecretReadOnly\(\)/);
    assert.doesNotMatch(source, /loadOrCreateBridgeSecret/);
    assert.match(source, /requireNoOpenMigration: true/);
    assert.match(source, /assertNamedVolumesPreserved/);
    assert.doesNotMatch(source, /force\s*:\s*true/);
    assert.match(deploySource, /--census-ccb-baseline\) MODE="baseline-census"/);
    assert.match(deploySource, /--remount-ccb-baseline\) MODE="baseline-remount"/);
    assert.match(deploySource, /export OC_V5_DEPLOY_LOCK_HELD=1/);
    assert.match(deploySource, /baseline-remount\) run_ccb_baseline_remount remount/);
    assert.match(deploySource, /MODE" != "baseline-census"/);
    assert.match(packageSource, /"test:v5:ops"/);
    assert.match(packageSource, /"check:v5"[^\n]*test:v5:ops/);
    assert.match(workflow, /name: v5-ops[\s\S]*?run: \|[\s\S]*?npm run test:v5:ops/);
  });

  test("census requires exact local host ownership and rejects null legacy rows", () => {
    assert.doesNotThrow(() => assertLocalCensusHost("host-local", "host-local"));
    assert.throws(
      () => assertLocalCensusHost(null, "host-local"),
      /without exact local host ownership/,
    );
    assert.throws(
      () => assertLocalCensusHost("host-remote", "host-local"),
      /without exact local host ownership/,
    );
  });

  test("dry-run bridge-secret loading is strictly read-only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "v5-remount-secret-"));
    try {
      const missing = path.join(dir, "missing-secret");
      assert.throws(() => loadBridgeSecretReadOnly(missing), /ENOENT/);
      await assert.rejects(access(missing));

      const valid = path.join(dir, "valid-secret");
      await writeFile(valid, `${"a".repeat(64)}\n`);
      assert.equal(loadBridgeSecretReadOnly(valid), "a".repeat(64));
      await writeFile(valid, "damaged\n");
      assert.throws(() => loadBridgeSecretReadOnly(valid), /refuses to rotate/);
      assert.equal(await readFile(valid, "utf8"), "damaged\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-inspects drain state, retries busy/failed, and skips concurrent convergence", async () => {
    const running = {
      state: "running",
      dockerContainerId: "docker-1",
      containerId: 101,
      hostId: null,
    };
    const drains = ["busy", "failed", "accepted"];
    let sleeps = 0;
    const acquired = await acquireSafeRemovalTarget(
      {} as never,
      {} as never,
      1n,
      sources,
      runtimeLabels,
      10_000,
      {
        getStatus: async () => running as never,
        inspect: async () => ({ Mounts: [] }),
        requestDrain: async () => drains.shift() as never,
        now: () => 0,
        sleep: async () => { sleeps += 1; },
      },
    );
    assert.equal(acquired?.status.dockerContainerId, "docker-1");
    assert.equal(sleeps, 2);
    assert.deepEqual(drains, []);

    let drainCalled = false;
    const converged = await acquireSafeRemovalTarget(
      {} as never,
      {} as never,
      1n,
      sources,
      runtimeLabels,
      10_000,
      {
        getStatus: async () => running as never,
        inspect: async () => ({ Mounts: completeMounts(), Config: { Labels: runtimeLabels } }),
        requestDrain: async () => { drainCalled = true; return "accepted" as never; },
        now: () => 0,
        sleep: async () => undefined,
      },
    );
    assert.equal(converged, null);
    assert.equal(drainCalled, false);

    const staleRuntime = await acquireSafeRemovalTarget(
      {} as never,
      {} as never,
      1n,
      sources,
      runtimeLabels,
      10_000,
      {
        getStatus: async () => running as never,
        inspect: async () => ({
          Mounts: completeMounts(),
          Config: { Labels: { "com.openclaude.runtime.release": "rel-old" } },
        }),
        requestDrain: async () => "accepted" as never,
        now: () => 0,
        sleep: async () => undefined,
      },
    );
    assert.equal(staleRuntime?.status.dockerContainerId, "docker-1");

    await assert.rejects(
      acquireSafeRemovalTarget(
        { selfHostId: "host-local" } as never,
        {} as never,
        1n,
        sources,
        runtimeLabels,
        10_000,
        {
          getStatus: async () => ({ ...running, hostId: null }) as never,
          inspect: async () => ({ Mounts: completeMounts() }),
          requestDrain: async () => "accepted" as never,
          now: () => 0,
          sleep: async () => undefined,
        },
      ),
      /without exact local host ownership/,
    );

    let now = 0;
    await assert.rejects(
      acquireSafeRemovalTarget(
        {} as never,
        {} as never,
        1n,
        sources,
        runtimeLabels,
        50,
        {
          getStatus: async () => ({ state: "provisioning" }) as never,
          inspect: async () => ({ Mounts: [] }),
          requestDrain: async () => "failed" as never,
          now: () => now,
          sleep: async () => { now = 50; },
        },
      ),
      /global remount timeout reached/,
    );

    now = 49;
    let drainAfterDeadline = 0;
    await assert.rejects(
      acquireSafeRemovalTarget(
        {} as never,
        {} as never,
        1n,
        sources,
        runtimeLabels,
        50,
        {
          getStatus: async () => running as never,
          inspect: async () => { now = 50; return { Mounts: [] }; },
          requestDrain: async () => { drainAfterDeadline += 1; return "accepted" as never; },
          now: () => now,
          sleep: async () => undefined,
        },
      ),
      /global remount timeout reached/,
    );
    assert.equal(drainAfterDeadline, 0);
  });

  test("destructive orchestration honors migration barriers and bounded reprovision retries", async () => {
    const target = {
      status: {
        state: "running",
        dockerContainerId: "docker-2",
        containerId: 102,
        hostId: null,
      },
      beforeVolumes: new Map([["/home/agent/.openclaude", "oc-v5-data-u2"]]),
    } as unknown as SafeRemovalTarget;

    let ensureAttempts = 0;
    let verified = 0;
    const progress: Array<[number, number]> = [];
    const remounted = await remountTargets([1n, 2n], 10_000, {
      acquire: async (uid) => uid === 1n ? null : target,
      remove: async () => true,
      ensure: async () => {
        ensureAttempts += 1;
        if (ensureAttempts < 3) throw new Error("transient reprovision failure");
      },
      verify: async () => { verified += 1; },
      now: () => 0,
      sleep: async () => undefined,
      progress: (completed, total) => progress.push([completed, total]),
    });
    assert.equal(remounted, 1);
    assert.equal(ensureAttempts, 3);
    assert.equal(verified, 1);
    assert.deepEqual(progress, [[1, 2]]);

    let ensureAfterBarrier = false;
    await assert.rejects(
      remountTargets([2n], 10_000, {
        acquire: async () => target,
        remove: async () => false,
        ensure: async () => { ensureAfterBarrier = true; },
        verify: async () => undefined,
        now: () => 0,
        sleep: async () => undefined,
        progress: () => undefined,
      }),
      /ineligible for safe removal/,
    );
    assert.equal(ensureAfterBarrier, false);

    await assert.rejects(
      remountTargets([2n], 10_000, {
        acquire: async () => target,
        remove: async () => true,
        ensure: async () => { throw new Error("permanent reprovision failure"); },
        verify: async () => { throw new Error("verify must not run"); },
        now: () => 0,
        sleep: async () => undefined,
        progress: () => undefined,
      }),
      /permanent reprovision failure/,
    );

    await assert.rejects(
      remountTargets([2n], 10_000, {
        acquire: async () => { throw new Error("acquire must not run"); },
        remove: async () => true,
        ensure: async () => undefined,
        verify: async () => undefined,
        now: () => 10_000,
        sleep: async () => undefined,
        progress: () => undefined,
      }),
      /global remount timeout reached/,
    );

    let now = 49;
    let removeCalls = 0;
    await assert.rejects(
      remountTargets([2n], 50, {
        acquire: (uid, deadlineMs) => acquireSafeRemovalTarget(
          {} as never,
          {} as never,
          uid,
          sources,
          runtimeLabels,
          deadlineMs,
          {
            getStatus: async () => target.status,
            inspect: async () => ({ Mounts: [] }),
            requestDrain: async () => "busy" as never,
            now: () => now,
            sleep: async () => { now = 50; },
          },
        ),
        remove: async () => { removeCalls += 1; return true; },
        ensure: async () => undefined,
        verify: async () => undefined,
        now: () => now,
        sleep: async () => undefined,
        progress: () => undefined,
      }),
      /global remount timeout reached/,
    );
    assert.equal(removeCalls, 0);
  });

  test("post-reprovision verification preserves volumes and all identity/runtime labels", () => {
    const before = new Map([["/data", "volume-a"], ["/projects", "volume-b"]]);
    assert.doesNotThrow(() => assertNamedVolumesPreserved(before, new Map(before)));
    assert.throws(
      () => assertNamedVolumesPreserved(before, new Map([["/data", "volume-a"]])),
      /named volume changed/,
    );

    const runtime = runtimeLabels;
    const labels = {
      "com.openclaude.v3.managed": "1",
      "com.openclaude.v3.uid": "7",
      "com.openclaude.runtime_channel": "v5",
      ...runtime,
    };
    assert.doesNotThrow(() => assertContainerLabels(labels, 7n, runtime));
    assert.equal(hasExpectedRuntimeLabels(labels, runtime), true);
    assert.equal(
      hasExpectedRuntimeLabels(
        { ...labels, "com.openclaude.runtime.release": "rel-old" },
        runtime,
      ),
      false,
    );
    for (const key of [
      "com.openclaude.v3.managed",
      "com.openclaude.v3.uid",
      "com.openclaude.runtime_channel",
      "com.openclaude.runtime.release",
    ]) {
      const broken = { ...labels };
      delete broken[key as keyof typeof broken];
      assert.throws(() => assertContainerLabels(broken, 7n, runtime), new RegExp(key.replaceAll(".", "\\.")));
    }
  });

  test("official remount fail-loud verifies every bundle-only CLI PATH link inside the rebuilt container", async () => {
    let command = "";
    const container = {
      exec: async (options: { Cmd?: string[] }) => {
        command = options.Cmd?.[2] ?? "";
        return {
          start: async () => Readable.from([]),
          inspect: async () => ({ ExitCode: 0 }),
        };
      },
    };
    await verifyPlatformCliLinks(container as never);
    assert.match(command, /for name in oc-plugin oc-ocr oc-h3 oc-video oc-cursor/);
    assert.match(command, /\/home\/agent\/\.local\/bin\/\$name/);
    assert.match(command, /\/run\/oc\/platform\/current\/bin\/\$name/);
    assert.match(command, /readlink/);

    await assert.rejects(
      verifyPlatformCliLinks({
        exec: async () => ({
          start: async () => Readable.from([]),
          inspect: async () => ({ ExitCode: 1 }),
        }),
      } as never),
      /platform CLI PATH links are incomplete/,
    );

    const broken = new Readable({
      read() {
        this.destroy(new Error("exec stream failed"));
      },
    });
    await assert.rejects(
      verifyPlatformCliLinks({
        exec: async () => ({
          start: async () => broken,
          inspect: async () => ({ ExitCode: 0 }),
        }),
      } as never),
      /exec stream failed/,
    );
  });
});
