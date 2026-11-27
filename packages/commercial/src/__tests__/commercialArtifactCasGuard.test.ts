import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ARTIFACT_BLOB_INTERNAL_PREFIX } from "@openclaude/protocol";
import {
  ARTIFACT_CAS_ENABLED_ENV,
  CAPSULE_RUNTIME_ENABLED_ENV,
  capsuleRuntimeContainerEnv,
  isMasterArtifactCasEnabled,
} from "../agent-sandbox/artifactCasEnv.js";
import { maybeCreateMasterArtifactBlobStore } from "../agent-sandbox/artifactBlobRuntime.js";
import {
  FlavorIdentityError,
  type FlavorIdentity,
  type FlavorManifest,
} from "../flavor/assertFlavor.js";
import { makeInternalArtifactBlobsHandler } from "../http/internalArtifactBlobs.js";
import type { PgTransactionPool } from "../db/threeLayerStateStore.js";

function okFlavor(flavor: "commercial" | "selfhost"): FlavorIdentity {
  const manifest: FlavorManifest = {
    schema: 1,
    flavor,
    sourceCommit: "0".repeat(40),
    builder: flavor === "commercial" ? "deploy-v5.sh" : "deploy-v5-selfhost.sh",
    expectedHosts: ["fixture"],
    expectedRoots: ["/srv/fixture"],
    expectedDbNames: ["openclaude_fixture"],
    guardGeneration: 1,
  };
  return { status: "ok", flavor, manifest, manifestPath: "/srv/fixture/flavor.manifest.json" };
}

describe("OCV5-913 T2 B2: commercial fail-closed gate for master CAS blob writes & container capsule runtime", () => {
  const servers: Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("disables master CAS and injects OC_CAPSULE_RUNTIME_ENABLED=0 on commercial flavor and FlavorIdentityError", () => {
    assert.equal(isMasterArtifactCasEnabled({ env: {}, identity: () => okFlavor("commercial") }), false);
    assert.equal(
      isMasterArtifactCasEnabled({
        env: {},
        identity: () => {
          throw new FlavorIdentityError("invalid manifest");
        },
      }),
      false,
    );
    assert.deepEqual(
      capsuleRuntimeContainerEnv({ env: {}, identity: () => okFlavor("commercial") }),
      [`${CAPSULE_RUNTIME_ENABLED_ENV}=0`],
    );
    assert.deepEqual(
      capsuleRuntimeContainerEnv({
        env: {},
        identity: () => {
          throw new FlavorIdentityError("invalid manifest");
        },
      }),
      [`${CAPSULE_RUNTIME_ENABLED_ENV}=0`],
    );
  });

  it("keeps selfhost/dev enabled by default and honors explicit OC_ARTIFACT_CAS_ENABLED overrides", () => {
    assert.equal(isMasterArtifactCasEnabled({ env: {}, identity: () => okFlavor("selfhost") }), true);
    assert.equal(
      isMasterArtifactCasEnabled({
        env: {},
        identity: () => ({ status: "skipped", reason: "no-manifest" }),
      }),
      true,
    );
    assert.deepEqual(capsuleRuntimeContainerEnv({ env: {}, identity: () => okFlavor("selfhost") }), []);
    assert.equal(
      isMasterArtifactCasEnabled({
        env: { [ARTIFACT_CAS_ENABLED_ENV]: "1" },
        identity: () => okFlavor("commercial"),
      }),
      true,
    );
    assert.equal(
      isMasterArtifactCasEnabled({
        env: { [ARTIFACT_CAS_ENABLED_ENV]: "0" },
        identity: () => okFlavor("selfhost"),
      }),
      false,
    );
  });

  it("leaves CAS store uninitialized on commercial so /internal/v3/artifact-blobs/* rejects writes with 503 and 0 disk bytes", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "ocv5-913-b2-"));
    tempDirs.push(home);
    const created = maybeCreateMasterArtifactBlobStore({
      openClaudeHome: home,
      pgPool: {} as PgTransactionPool,
      bridgeSecret: "fixture-secret",
      env: {},
      identity: () => okFlavor("commercial"),
    });
    assert.equal(created, undefined);
    assert.equal(existsSync(path.join(home, "artifact-cas")), false);

    const handler = makeInternalArtifactBlobsHandler({
      getStore: () => undefined,
      verify: async () => ({ userId: 7 }),
    });
    const server = createServer((req, res) => {
      void handler(req, res, { hostUuid: "self", boundIp: "127.0.0.1" });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}${ARTIFACT_BLOB_INTERNAL_PREFIX}`;

    const putRes = await fetch(`${base}put`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-blob-kind": "capsule_file",
      },
      body: Buffer.from("should-never-touch-disk", "utf8"),
    });
    assert.equal(putRes.status, 503);
    const putBody = (await putRes.json()) as { error?: { code?: string } };
    assert.equal(putBody.error?.code, "ARTIFACT_BLOB_STORE_UNAVAILABLE");

    const uploadRes = await fetch(`${base}uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "capsule_file",
        filename: "rollout.jsonl",
        mimeType: "application/x-ndjson",
        expectedSizeBytes: 1024,
      }),
    });
    assert.equal(uploadRes.status, 503);
    assert.equal(existsSync(path.join(home, "artifact-cas")), false);
  });
});
