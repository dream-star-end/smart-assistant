/**
 * Internal project-assets: outputs collected in the container land in the
 * master sessions backend, for the verified tenant only, in the project the
 * turn resolved when it started.
 * Run: npx tsx --test packages/commercial/src/__tests__/internalProjectAssets.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import type { ProjectAsset, ProjectAssetCreateInput, ProjectAssetCreateResult } from "@openclaude/storage";
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js";
import {
  PROJECT_ASSETS_REGISTER_PATH,
  makeInternalProjectAssetsHandler,
} from "../http/internalProjectAssets.js";

const HOST = "00000000-0000-0000-0000-000000000001";
const IP = "172.30.1.42";
const OUT = "/home/agent/.openclaude/generated/report.md";

function identity(containerId: number, userId: number) {
  const secretHex = randomBytes(32).toString("hex");
  const secretHash = createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
  return { containerId, userId, secretHex, secretHash };
}

function req(opts: { method?: string; authorization?: string; body?: unknown }): IncomingMessage {
  const raw = opts.body === undefined ? "" : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const r = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  r.method = opts.method ?? "POST";
  r.url = PROJECT_ASSETS_REGISTER_PATH;
  r.headers = opts.authorization ? { authorization: opts.authorization } : {};
  return r;
}

function res() {
  const r = {
    statusCode: 0,
    headersSent: false,
    body: "",
    setHeader() {},
    writeHead(s: number) {
      r.statusCode = s;
      r.headersSent = true;
    },
    end(b?: string) {
      r.body = b ?? "";
      r.headersSent = true;
    },
  };
  return r as unknown as ServerResponse & { statusCode: number; body: string };
}

function asset(over: Partial<ProjectAsset>): ProjectAsset {
  return {
    id: "asset-1",
    projectId: null,
    source: "output",
    sessionId: "s-1",
    name: "report.md",
    url: null,
    containerPath: OUT,
    mime: "text/markdown",
    sizeBytes: 10,
    digest: null,
    excerpt: null,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("internal project-assets", () => {
  const id3 = identity(9, 3);
  const repo: ContainerIdentityRepo = {
    async findActiveByHostAndBoundIp(h, ip) {
      return h === HOST && ip === IP
        ? { id: 9, user_id: 3, host_uuid: HOST, bound_ip: IP, secret_hash: id3.secretHash }
        : null;
    },
  };
  const auth = `Bearer oc-v3.${id3.containerId}.${id3.secretHex}`;
  const ctx = { hostUuid: HOST, boundIp: IP };

  function harness(opts: { state?: "active" | "deleted" | "missing"; ownedProjects?: string[] } = {}) {
    const calls: Array<{ userId: string; input: ProjectAssetCreateInput }> = [];
    const classified: Array<{ sessionId: string; userId: string }> = [];
    const owned = new Set(opts.ownedProjects ?? ["proj-a"]);
    const handler = makeInternalProjectAssetsHandler({
      identityRepo: repo,
      classify: async (refs) => {
        classified.push(...refs);
        return refs.map((r) => ({ ...r, state: opts.state ?? "active" }));
      },
      create: async (userId, input): Promise<ProjectAssetCreateResult> => {
        calls.push({ userId, input });
        const pid = input.projectId;
        if (typeof pid === "string" && !owned.has(pid)) return { ok: false, error: "project_not_found" };
        return {
          ok: true,
          created: true,
          asset: asset({ projectId: typeof pid === "string" ? pid : pid === null ? null : "inferred-proj" }),
        };
      },
    });
    return { handler, calls, classified };
  }

  test("registers into the tenant from the container identity, never from the body", async () => {
    const h = harness();
    const r = res();
    await h.handler(
      req({ authorization: auth, body: { userId: "c:999", sessionId: "s-1", items: [{ containerPath: OUT, name: "report.md" }] } }),
      r,
      ctx,
    );
    assert.equal(r.statusCode, 200);
    assert.deepEqual(h.classified, [{ sessionId: "s-1", userId: "c:3" }]);
    assert.equal(h.calls[0]?.userId, "c:3");
  });

  test("the project frozen at turn start wins over the session's current project", async () => {
    const h = harness();
    const r = res();
    await h.handler(
      req({ authorization: auth, body: { sessionId: "s-1", projectId: "proj-a", items: [{ containerPath: OUT, name: "report.md" }] } }),
      r,
      ctx,
    );
    assert.equal(h.calls[0]?.input.projectId, "proj-a");
    assert.equal(JSON.parse(r.body).results[0].projectId, "proj-a");
  });

  test("absent projectId keeps the old rule; explicit null means ungrouped", async () => {
    const h = harness();
    await h.handler(req({ authorization: auth, body: { sessionId: "s-1", items: [{ containerPath: OUT, name: "a.md" }] } }), res(), ctx);
    assert.equal(Object.hasOwn(h.calls[0]!.input, "projectId"), false);
    await h.handler(
      req({ authorization: auth, body: { sessionId: "s-1", projectId: null, items: [{ containerPath: OUT, name: "a.md" }] } }),
      res(),
      ctx,
    );
    assert.equal(h.calls[1]!.input.projectId, null);
  });

  test("a project deleted since the turn started keeps the output, ungrouped", async () => {
    const h = harness({ ownedProjects: [] });
    const r = res();
    await h.handler(
      req({ authorization: auth, body: { sessionId: "s-1", projectId: "gone", items: [{ containerPath: OUT, name: "r.md" }] } }),
      r,
      ctx,
    );
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1]!.input.projectId, null);
    assert.equal(JSON.parse(r.body).results[0].ok, true);
  });

  test("a deleted, missing or foreign session registers nothing", async () => {
    for (const state of ["deleted", "missing"] as const) {
      const h = harness({ state });
      const r = res();
      await h.handler(req({ authorization: auth, body: { sessionId: "s-x", items: [{ containerPath: OUT, name: "r.md" }] } }), r, ctx);
      assert.equal(r.statusCode, 200);
      assert.equal(h.calls.length, 0);
      assert.equal(JSON.parse(r.body).sessionState, state);
    }
  });

  test("rejects bad identity, uploads paths, path escapes and oversized batches", async () => {
    const h = harness();
    const bad = res();
    await h.handler(req({ authorization: "Bearer oc-v3.9.00", body: {} }), bad, ctx);
    assert.equal(bad.statusCode, 401);
    for (const items of [
      [{ containerPath: "/home/agent/.openclaude/uploads/x.pdf", name: "x.pdf" }],
      [{ containerPath: "/home/agent/.openclaude/generated/../../etc/passwd", name: "p" }],
      Array.from({ length: 21 }, (_, i) => ({ containerPath: `${OUT}${i}`, name: `r${i}` })),
      [],
    ]) {
      const r = res();
      await h.handler(req({ authorization: auth, body: { sessionId: "s-1", items } }), r, ctx);
      assert.equal(r.statusCode, 400, JSON.stringify(items).slice(0, 80));
    }
    assert.equal(h.calls.length, 0);
    const notJson = res();
    await h.handler(req({ authorization: auth, body: "{nope" }), notJson, ctx);
    assert.equal(notJson.statusCode, 400);
    const get = res();
    await h.handler(req({ method: "GET", authorization: auth }), get, ctx);
    assert.equal(get.statusCode, 405);
  });
});
