/**
 * Internal project-search (P5a): the tenant is the verified container
 * identity; the board id resolves to that tenant's chat project; only that
 * project is searched; a foreign or unknown board id is a 404.
 * Run: npx tsx --test packages/commercial/src/__tests__/internalProjectSearch.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import type { ChatProjectRuntimeBind, ProjectAsset, SearchChatProjectAssetsOpts } from "@openclaude/storage";
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js";
import { PROJECT_SEARCH_PATH, makeInternalProjectSearchHandler } from "../http/internalProjectSearch.js";

const HOST = "00000000-0000-0000-0000-000000000001";
const IP = "172.30.1.42";
const BOARD_A = "aaaaaaaa-1111-4222-8333-444444444444";
const BOARD_B = "bbbbbbbb-1111-4222-8333-444444444444";

function identity(containerId: number, userId: number) {
  const secretHex = randomBytes(32).toString("hex");
  const secretHash = createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
  return { containerId, userId, secretHex, secretHash };
}

function req(opts: { method?: string; authorization?: string; query?: Record<string, string> }): IncomingMessage {
  const r = Readable.from([]) as unknown as IncomingMessage;
  r.method = opts.method ?? "GET";
  r.url = `${PROJECT_SEARCH_PATH}?${new URLSearchParams(opts.query ?? {}).toString()}`;
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
    projectId: "chat-a",
    source: "upload",
    sessionId: null,
    name: "合同.pdf",
    url: null,
    containerPath: "/home/agent/.openclaude/uploads/x.pdf",
    mime: "application/pdf",
    sizeBytes: 10,
    digest: null,
    excerpt: "付款期限",
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("internal project-search", () => {
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

  // Tenant c:3 owns board A (chat-a); board B belongs to c:4.
  const binds: ChatProjectRuntimeBind[] = [
    { userId: "c:3", chatProjectId: "chat-a", boardProjectId: BOARD_A, name: "A", instructions: null },
    { userId: "c:4", chatProjectId: "chat-b", boardProjectId: BOARD_B, name: "B", instructions: null },
  ];

  function harness(enabled = true) {
    const lookups: Array<{ userId: string; board: string }> = [];
    const searches: Array<{ userId: string; chatProjectId: string; opts: SearchChatProjectAssetsOpts }> = [];
    const handler = makeInternalProjectSearchHandler({
      identityRepo: repo,
      enabled: () => enabled,
      getBindByBoardProjectId: async (userId, board) => {
        lookups.push({ userId, board });
        return binds.find((b) => b.userId === userId && b.boardProjectId === board) ?? null;
      },
      search: async (userId, chatProjectId, opts) => {
        searches.push({ userId, chatProjectId, opts });
        return [asset({ projectId: chatProjectId })];
      },
    });
    return { handler, lookups, searches };
  }

  test("tenant from the identity; searches only that tenant's project for the board", async () => {
    const h = harness();
    const r = res();
    await h.handler(
      req({ authorization: auth, query: { boardProjectId: BOARD_A, q: "付款", source: "upload", limit: "5", userId: "c:4" } }),
      r,
      ctx,
    );
    assert.equal(r.statusCode, 200);
    assert.deepEqual(h.lookups, [{ userId: "c:3", board: BOARD_A }]);
    assert.deepEqual(h.searches, [{ userId: "c:3", chatProjectId: "chat-a", opts: { q: "付款", source: "upload", limit: 5 } }]);
    const body = JSON.parse(r.body);
    assert.equal(body.chatProjectId, "chat-a");
    assert.equal(body.assets[0].projectId, "chat-a");
  });

  test("a foreign board id (another tenant's) → 404, nothing searched", async () => {
    const h = harness();
    const r = res();
    await h.handler(req({ authorization: auth, query: { boardProjectId: BOARD_B, q: "付款" } }), r, ctx);
    assert.equal(r.statusCode, 404);
    assert.equal(JSON.parse(r.body).error.code, "PROJECT_NOT_FOUND");
    assert.equal(h.searches.length, 0);
  });

  test("an unknown board id → 404", async () => {
    const h = harness();
    const r = res();
    await h.handler(
      req({ authorization: auth, query: { boardProjectId: "cccccccc-1111-4222-8333-444444444444", q: "x" } }),
      r,
      ctx,
    );
    assert.equal(r.statusCode, 404);
    assert.equal(h.searches.length, 0);
  });

  test("bad identity → 401; wrong method → 405; flag off → 404", async () => {
    const h = harness();
    const r1 = res();
    await h.handler(req({ authorization: "Bearer oc-v3.9.deadbeef", query: { boardProjectId: BOARD_A, q: "x" } }), r1, ctx);
    assert.equal(r1.statusCode, 401);
    const r2 = res();
    await h.handler(req({ method: "POST", authorization: auth, query: { boardProjectId: BOARD_A, q: "x" } }), r2, ctx);
    assert.equal(r2.statusCode, 405);
    const off = harness(false);
    const r3 = res();
    await off.handler(req({ authorization: auth, query: { boardProjectId: BOARD_A, q: "x" } }), r3, ctx);
    assert.equal(r3.statusCode, 404);
    assert.equal(off.lookups.length, 0);
  });

  test("bad input → 400 before any lookup", async () => {
    const h = harness();
    const cases: Array<Record<string, string>> = [
      { q: "x" },
      { boardProjectId: "nope", q: "x" },
      { boardProjectId: BOARD_A, q: "" },
      { boardProjectId: BOARD_A, q: "x".repeat(201) },
      { boardProjectId: BOARD_A, q: "x", source: "all" },
    ];
    for (const query of cases) {
      const r = res();
      await h.handler(req({ authorization: auth, query }), r, ctx);
      assert.equal(r.statusCode, 400, JSON.stringify(query));
    }
    assert.equal(h.lookups.length, 0);
  });
});
