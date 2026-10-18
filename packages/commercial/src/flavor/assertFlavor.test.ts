import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FlavorIdentityError,
  assertAllows,
  assertFlavorForMigrate,
  assertFlavorIdentity,
  parseFlavorManifest,
} from "./assertFlavor.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

type Case = {
  name: string;
  manifest: string;
  hostname: string;
  installRoot: string;
  dbName: string;
  env: Record<string, string>;
  sidecar18992?: boolean;
  expect: "pass" | "fail";
  errorContains?: string;
};

const cases = JSON.parse(readFileSync(path.join(fixtures, "cases.json"), "utf8")) as Case[];

function writeFixture(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flavor-case-"));
  const manifestPath = path.join(dir, "flavor.manifest.json");
  writeFileSync(manifestPath, readFileSync(path.join(fixtures, name)));
  return manifestPath;
}

describe("parseFlavorManifest", () => {
  test("accepts valid selfhost and commercial fixtures", () => {
    parseFlavorManifest(JSON.parse(readFileSync(path.join(fixtures, "valid-selfhost.json"), "utf8")));
    parseFlavorManifest(JSON.parse(readFileSync(path.join(fixtures, "valid-commercial.json"), "utf8")));
  });

  test("rejects cross-builder and missing fields", () => {
    assert.throws(
      () => parseFlavorManifest(JSON.parse(readFileSync(path.join(fixtures, "cross-builder.json"), "utf8"))),
      FlavorIdentityError,
    );
    assert.throws(
      () => parseFlavorManifest(JSON.parse(readFileSync(path.join(fixtures, "missing-field.json"), "utf8"))),
      /missing fields/,
    );
  });
});

describe("assertFlavorIdentity fixtures", () => {
  for (const item of cases) {
    test(item.name, () => {
      const signals = {
        manifestPath: writeFixture(item.manifest),
        hostname: item.hostname,
        installRoot: item.installRoot,
        dbName: item.dbName,
        env: { ...item.env, OC_FLAVOR_DOCKERENV: "0" },
        sidecar18992: item.sidecar18992 === true,
        dockerenv: false,
      };
      if (item.expect === "pass") {
        const got = assertFlavorIdentity(signals);
        assert.equal(got.status, "ok");
      } else {
        assert.throws(
          () => assertFlavorIdentity(signals),
          (err: unknown) => {
            assert.ok(err instanceof FlavorIdentityError, String(err));
            if (item.errorContains) assert.match((err as Error).message, new RegExp(item.errorContains));
            return true;
          },
        );
      }
    });
  }
});

describe("commercial mainland host cj-volc-gz", () => {
  test("commercial manifest on cj-volc-gz passes identity", () => {
    const got = assertFlavorIdentity({
      manifestPath: writeFixture("valid-commercial.json"),
      hostname: "cj-volc-gz",
      installRoot: "/opt/openclaude/openclaude-v5",
      dbName: "openclaude",
      env: { OC_FLAVOR_DOCKERENV: "0" },
      dockerenv: false,
    });
    assert.equal(got.status, "ok");
  });

  test("selfhost manifest in a container on cj-volc-gz fails as other-flavor host", () => {
    assert.throws(
      () => assertFlavorIdentity({
        manifestPath: writeFixture("valid-selfhost.json"),
        hostname: "cj-volc-gz",
        installRoot: "/opt/openclaude/openclaude-v5-selfhost",
        dbName: "openclaude_v5_selfhost",
        dockerenv: true,
        env: {},
      }),
      /belongs to the other flavor/,
    );
  });
});

describe("missing manifest", () => {
  test("skips when no manifest is present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-none-"));
    const got = assertFlavorIdentity({
      manifestPath: path.join(dir, "flavor.manifest.json"),
      hostname: "kl-mirror",
      installRoot: "/opt/openclaude/openclaude-v5",
      env: {},
      dockerenv: false,
    });
    assert.equal(got.status, "skipped");
  });

  test("fail-closed when required", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-req-"));
    assert.throws(
      () => assertFlavorIdentity({
        manifestPath: path.join(dir, "flavor.manifest.json"),
        hostname: "kl-mirror",
        installRoot: "/opt/openclaude/openclaude-v5",
        env: { OC_FLAVOR_GUARD_REQUIRED: "1" },
        required: true,
        dockerenv: false,
      }),
      /missing/,
    );
  });
});

describe("assertAllows", () => {
  test("selfhost unit-install allowed; commercial denied", () => {
    const ok = assertAllows("selfhost-unit-install", {
      manifestPath: writeFixture("valid-selfhost.json"),
      hostname: "v3-dev-sg",
      installRoot: "/opt/openclaude/openclaude-v5-selfhost",
      env: { OC_FLAVOR_DOCKERENV: "0" },
      dockerenv: false,
    });
    assert.equal(ok.status, "ok");
    assert.throws(
      () => assertAllows("selfhost-unit-install", {
        manifestPath: writeFixture("valid-commercial.json"),
        hostname: "kl-mirror",
        installRoot: "/opt/openclaude/openclaude-v5",
        env: { OC_FLAVOR_DOCKERENV: "0" },
        dockerenv: false,
      }),
      /forbidden/,
    );
  });

  test("cursor egress needs explicit flag even on selfhost", () => {
    const selfPath = writeFixture("valid-selfhost.json");
    const base = {
      manifestPath: selfPath,
      hostname: "v3-dev-sg",
      installRoot: "/opt/openclaude/openclaude-v5-selfhost",
      dockerenv: false,
    };
    assert.throws(
      () => assertAllows("selfhost-cursor-egress", { ...base, env: { OC_FLAVOR_DOCKERENV: "0" } }),
      /SELFHOST_CURSOR_EGRESS/,
    );
    const ok = assertAllows("selfhost-cursor-egress", {
      ...base,
      env: { OC_FLAVOR_DOCKERENV: "0", SELFHOST_CURSOR_EGRESS: "1" },
    });
    assert.equal(ok.status, "ok");
  });
});

describe("assertFlavorForMigrate", () => {
  test("commercial + inherited v5-selfhost profile throws before querying DB", async () => {
    let queried = false;
    await assert.rejects(
      () => assertFlavorForMigrate(
        {
          manifestPath: writeFixture("valid-commercial.json"),
          hostname: "kl-mirror",
          installRoot: "/opt/openclaude/openclaude-v5",
          env: {
            OC_FLAVOR_DOCKERENV: "0",
            PGOPTIONS: "-c openclaude.migration_profile=v5-selfhost",
          },
          dockerenv: false,
        },
        async () => {
          queried = true;
          return { dbName: "openclaude", dbProfile: "v5-selfhost" };
        },
      ),
      /cannot be upgraded/,
    );
    assert.equal(queried, false, "must not query current_database after identity fail");
  });

  test("selfhost + expected db + profile is allowed", async () => {
    const got = await assertFlavorForMigrate({
      manifestPath: writeFixture("valid-selfhost.json"),
      hostname: "v3-dev-sg",
      installRoot: "/opt/openclaude/openclaude-v5-selfhost",
      dbName: "openclaude_v5_selfhost",
      dbProfile: "v5-selfhost",
      env: {
        PGOPTIONS: "-c openclaude.migration_profile=v5-selfhost",
      },
      dockerenv: false,
    });
    assert.equal(got.status, "ok");
  });

  test("B4: commercial + DATABASE_URL options profile fails without querying", async () => {
    let queried = false;
    await assert.rejects(
      () => assertFlavorForMigrate(
        {
          manifestPath: writeFixture("valid-commercial.json"),
          hostname: "kl-mirror",
          installRoot: "/opt/openclaude/openclaude-v5",
          dockerenv: false,
          env: {
            DATABASE_URL: "postgres://x@127.0.0.1:5432/openclaude?options=-c%20openclaude.migration_profile%3Dv5-selfhost",
          },
        },
        async () => {
          queried = true;
          return { dbName: "openclaude", dbProfile: "" };
        },
      ),
      /cannot be upgraded/,
    );
    assert.equal(queried, false);
  });

  test("B4: commercial session profile v5-selfhost fails even with clean PGOPTIONS", async () => {
    await assert.rejects(
      () => assertFlavorForMigrate({
        manifestPath: writeFixture("valid-commercial.json"),
        hostname: "kl-mirror",
        installRoot: "/opt/openclaude/openclaude-v5",
        dbName: "openclaude",
        dbProfile: "v5-selfhost",
        dockerenv: false,
        env: {},
      }),
      /v5-selfhost/,
    );
  });
});

describe("adversarial identity", () => {
  test("B1: OC_FLAVOR_HOSTNAME env cannot mint selfhost identity", () => {
    assert.throws(
      () => assertFlavorIdentity({
        manifestPath: writeFixture("valid-selfhost.json"),
        hostname: "not-a-flavor-host",
        installRoot: "/opt/openclaude/openclaude-v5-selfhost",
        dockerenv: false,
        env: { OC_FLAVOR_HOSTNAME: "v3-dev-sg" },
      }),
      /hostname/,
    );
  });

  test("B2: generation=1 missing manifest is fail-closed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-gen-"));
    assert.throws(
      () => assertFlavorIdentity({
        manifestPath: path.join(dir, "flavor.manifest.json"),
        hostname: "kl-mirror",
        installRoot: "/opt/openclaude/openclaude-v5",
        dockerenv: false,
        generation: 1,
      }),
      /guardGeneration/,
    );
  });

  test("B2: commercial .complete generation fail-closes stripped manifest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-complete-gen-"));
    writeFileSync(path.join(dir, ".complete"), JSON.stringify({
      schemaVersion: 2,
      flavorGuardGeneration: 1,
    }));
    assert.throws(
      () => assertFlavorIdentity({
        installRoot: dir,
        hostname: "kl-mirror",
        dockerenv: false,
      }),
      /guardGeneration/,
    );
  });

  test("B3: schema boolean true is rejected", () => {
    assert.throws(
      () => parseFlavorManifest(JSON.parse(readFileSync(path.join(fixtures, "schema-bool-true.json"), "utf8"))),
      /schema must be integer/,
    );
  });
});
