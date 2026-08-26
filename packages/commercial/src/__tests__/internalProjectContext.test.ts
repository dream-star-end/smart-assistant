/**
 * Internal project-context: container identity + user_id isolation + live pins.
 * Run: npx tsx --test packages/commercial/src/__tests__/internalProjectContext.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, test } from "node:test";

import type { ContainerIdentityRepo } from "../auth/containerIdentity.js";
import {
  PROJECT_CONTEXT_PATH,
  makeInternalProjectContextHandler,
  type InternalProjectContextBody,
} from "../http/internalProjectContext.js";

const HOST = "00000000-0000-0000-0000-000000000001";
const IP = "172.30.1.42";
const BOARD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeIdentity(containerId: number, userId: number) {
  const secretHex = randomBytes(32).toString("hex");
  const secretHash = createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
  return { containerId, userId, secretHex, secretHash };
}

function memRepo(
  rows: Array<{
    id: number;
    user_id: number;
    host_uuid: string;
    bound_ip: string;
    secret_hash: Buffer | null;
  }>,
): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(h, ip) {
      return rows.find((r) => r.host_uuid === h && r.bound_ip === ip) ?? null;
    },
  };
}

function makeReq(opts: { method?: string; url?: string; authorization?: string }): IncomingMessage {
  const em = new EventEmitter() as IncomingMessage & EventEmitter;
  em.method = opts.method ?? "GET";
  em.headers = {};
  if (opts.authorization !== undefined) em.headers.authorization = opts.authorization;
  em.url = opts.url ?? PROJECT_CONTEXT_PATH;
  return em;
}

interface MockRes {
  statusCode: number;
  headersSent: boolean;
  headers: Record<string, string>;
  body: string;
  setHeader(k: string, v: string): void;
  writeHead(s: number, h?: Record<string, string>): void;
  end(b?: string): void;
}

function makeRes(): MockRes & ServerResponse {
  const r: MockRes = {
    statusCode: 0,
    headersSent: false,
    headers: {},
    body: "",
    setHeader(k, v) {
      r.headers[k.toLowerCase()] = String(v);
    },
    writeHead(s, h) {
      r.statusCode = s;
      if (h) for (const [k, v] of Object.entries(h)) r.setHeader(k, v);
      r.headersSent = true;
    },
    end(b) {
      r.body = b ?? "";
      r.headersSent = true;
    },
  };
  return r as unknown as MockRes & ServerResponse;
}

describe("internal project-context", () => {
  const id = makeIdentity(9, 3);
  const repo = memRepo([
    { id: 9, user_id: 3, host_uuid: HOST, bound_ip: IP, secret_hash: id.secretHash },
  ]);
  const auth = `Bearer oc-v3.${id.containerId}.${id.secretHex}`;
  const handler = makeInternalProjectContextHandler({
    identityRepo: repo,
    async getBindBySessionId(sessionId) {
      if (sessionId === "sess-other") {
        return {
          userId: "c:99",
          chatProjectId: "chat-other",
          boardProjectId: BOARD,
          name: "secret",
          instructions: "nope",
        };
      }
      if (sessionId === "sess-mine") {
        return {
          userId: "c:3",
          chatProjectId: "chat-mine",
          boardProjectId: BOARD,
          name: "mine",
          instructions: "pg copy",
        };
      }
      return null;
    },
    async getBindByBoardProjectId(userId, board) {
      if (userId === "c:3" && board === BOARD) {
        return {
          userId: "c:3",
          chatProjectId: "chat-mine",
          boardProjectId: BOARD,
          name: "mine",
          instructions: "pg copy",
        };
      }
      return null;
    },
    async listPinned(userId, chatProjectId) {
      if (userId !== "c:3" || chatProjectId !== "chat-mine") return { assets: [], revision: 0 };
      return {
        assets: [
          {
            id: "a1",
            projectId: "chat-mine",
            source: "upload",
            sessionId: null,
            name: "spec.md",
            url: "/api/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md",
            containerPath: "/home/agent/.openclaude/uploads/spec.md",
            mime: "text/markdown",
            sizeBytes: 12,
            digest: "aa",
            excerpt: "hi",
            pinned: true,
            createdAt: 10,
            updatedAt: 42,
          },
        ],
        revision: 42,
      };
    },
  });

  test("401 without identity", async () => {
    const res = makeRes();
    await handler(makeReq({ url: `${PROJECT_CONTEXT_PATH}?sessionId=sess-mine` }), res, {
      hostUuid: HOST,
      boundIp: IP,
    });
    assert.equal(res.statusCode, 401);
  });

  test("foreign session is empty, not leaked", async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: `${PROJECT_CONTEXT_PATH}?sessionId=sess-other`, authorization: auth }),
      res,
      { hostUuid: HOST, boundIp: IP },
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as InternalProjectContextBody;
    assert.equal(body.chatProjectId, null);
    assert.equal(body.pinnedAssets.length, 0);
  });

  test("own session returns live pinned revision", async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: `${PROJECT_CONTEXT_PATH}?sessionId=sess-mine`, authorization: auth }),
      res,
      { hostUuid: HOST, boundIp: IP },
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as InternalProjectContextBody;
    assert.equal(body.chatProjectId, "chat-mine");
    assert.equal(body.boardProjectId, BOARD);
    assert.equal(body.assetsRevision, 42);
    assert.equal(body.pinnedAssets[0]?.name, "spec.md");
    assert.equal(body.pinnedAssets[0]?.pinned, true);
  });

  test("boardProjectId lookup is tenant-scoped", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        url: `${PROJECT_CONTEXT_PATH}?boardProjectId=${BOARD}`,
        authorization: auth,
      }),
      res,
      { hostUuid: HOST, boundIp: IP },
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as InternalProjectContextBody;
    assert.equal(body.userId, "c:3");
    assert.equal(body.chatProjectId, "chat-mine");
  });
});
