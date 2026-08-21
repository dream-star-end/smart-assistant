/**
 * Hosted ZCode relay: identity/route plus direct egress dispatcher.
 * No live api.z.ai traffic.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/internalZcodeRelay.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { getGlobalDispatcher } from "undici";

import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";
import { hashSecret, type ContainerIdentityRepo } from "../auth/containerIdentity.js";
import {
  _resetZcodeRelayRoutesForTests,
  mintZcodeRelayRoute,
} from "../billing/zcodeRouteContext.js";
import { STATIC_PROVIDER_META } from "../http/proxy/staticProviderMeta.js";
import {
  _resetZcodeRelayStreamJournalsForTests,
  ZCODE_OFFICIAL_UPSTREAM,
  ZCODE_RELAY_PREFIX,
  makeZcodeRelayHandler,
} from "../http/internalZcodeRelay.js";

const SECRET = "b".repeat(64);
const CONTAINER_TOKEN = `oc-v3.11.${SECRET}`;
const CTX = { hostUuid: "host-self", boundIp: "172.30.0.11" };
const REQUEST_ID = "d".repeat(32);

function repo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null;
      return {
        id: 11,
        user_id: 42,
        bound_ip: CTX.boundIp,
        host_uuid: CTX.hostUuid,
        secret_hash: hashSecret(SECRET),
      };
    },
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

async function mintRoute(): Promise<string> {
  _resetZcodeRelayRoutesForTests();
  const minted = await mintZcodeRelayRoute({
    containerId: 11,
    userId: 42,
    requestId: REQUEST_ID,
    modelId: "zcode-experimental",
    relayPort: 18789,
  });
  return minted.token;
}

describe("internal ZCode relay dispatcher", () => {
  test("zai metadata stays direct and matches the hosted relay singleton", () => {
    assert.equal(STATIC_PROVIDER_META.zai.egress, "direct");
    assert.equal(directEgressDispatcher(), directEgressDispatcher());
  });

  test("passes directEgressDispatcher even when the global dispatcher would ECONNRESET", async () => {
    const token = await mintRoute();
    const captured: { dispatcher?: unknown; url?: string; auth?: string } = {};
    const handler = makeZcodeRelayHandler({
      identityRepo: repo(),
      codingPlanKey: "not-a-real-key",
      requestFn: (async (_url: unknown, init: { dispatcher?: unknown; headers?: HeadersInit }) => {
        captured.dispatcher = init.dispatcher;
        captured.url = String(_url);
        captured.auth = new Headers(init.headers).get("authorization") ?? "";
        if (!init.dispatcher || init.dispatcher === getGlobalDispatcher()) {
          const err = new Error("simulated proxy ECONNRESET");
          (err as Error & { code?: string }).code = "ECONNRESET";
          throw err;
        }
        return {
          statusCode: 200,
          headers: { "content-type": "application/json", connection: "close" },
          body: Readable.from(['{"ok":true}']),
        };
      }) as never,
    });
    const server = createServer((req, res) => {
      void handler(req, res, CTX);
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}${ZCODE_RELAY_PREFIX}/route/${token}/v1/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${CONTAINER_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "attacker-model", messages: [] }),
        },
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"ok":true}');
      assert.equal(captured.url, ZCODE_OFFICIAL_UPSTREAM);
      assert.strictEqual(captured.dispatcher, directEgressDispatcher());
      assert.notEqual(captured.dispatcher, getGlobalDispatcher());
      assert.equal(captured.auth, "Bearer not-a-real-key");
    } finally {
      await close(server);
    }
  });

  test("taps Anthropic SSE deltas into a container-authenticated live journal", async () => {
    const token = await mintRoute();
    _resetZcodeRelayStreamJournalsForTests();
    const sse = [
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想"}}\n\n',
      'event: content_block_delta\r\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"第一段"}}\r\n\r\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"第二段"}}\n\n',
    ];
    const encodedSse = Buffer.from(sse.join(""), "utf8");
    const splitAt = encodedSse.indexOf(Buffer.from("第一段", "utf8")) + 1;
    const chunks = [encodedSse.subarray(0, splitAt), encodedSse.subarray(splitAt)];
    const handler = makeZcodeRelayHandler({
      identityRepo: repo(),
      codingPlanKey: "not-a-real-key",
      requestFn: (async () => ({
        statusCode: 200,
        headers: { "content-type": "text/event-stream", connection: "close" },
        body: Readable.from(chunks),
      })) as never,
    });
    const server = createServer((req, res) => { void handler(req, res, CTX); });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}${ZCODE_RELAY_PREFIX}/route/${token}/v1/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${CONTAINER_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "ignored", messages: [] }),
        },
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), encodedSse.toString("utf8"));
      const eventsResponse = await fetch(
        `http://127.0.0.1:${port}${ZCODE_RELAY_PREFIX}/route/${token}/events?after=0`,
        { headers: { authorization: `Bearer ${CONTAINER_TOKEN}` } },
      );
      assert.equal(eventsResponse.status, 200);
      assert.deepEqual(await eventsResponse.json(), {
        events: [
          { seq: 1, kind: "thinking", text: "先想" },
          { seq: 2, kind: "text", text: "第一段" },
          { seq: 3, kind: "text", text: "第二段" },
        ],
        next: 3,
        done: true,
      });
      const tail = await fetch(
        `http://127.0.0.1:${port}${ZCODE_RELAY_PREFIX}/route/${token}/events?after=2`,
        { headers: { authorization: `Bearer ${CONTAINER_TOKEN}` } },
      );
      assert.deepEqual(await tail.json(), {
        events: [{ seq: 3, kind: "text", text: "第二段" }],
        next: 3,
        done: true,
      });
      const denied = await fetch(
        `http://127.0.0.1:${port}${ZCODE_RELAY_PREFIX}/route/${token}/events?after=0`,
        { headers: { authorization: `Bearer oc-v3.11.${"c".repeat(64)}` } },
      );
      assert.equal(denied.status, 401);
    } finally {
      _resetZcodeRelayStreamJournalsForTests();
      await close(server);
    }
  });

  test("maps upstream failures to a generic 503 and never echoes the error", async () => {
    const token = await mintRoute();
    const leak = "https://api.z.ai/api/anthropic/v1/messages authorization=Bearer sk-leak-fixture";
    const handler = makeZcodeRelayHandler({
      identityRepo: repo(),
      codingPlanKey: "not-a-real-key",
      requestFn: (async () => {
        const err = new Error(leak);
        (err as Error & { code?: string }).code = "ECONNRESET";
        throw err;
      }) as never,
    });
    const server = createServer((req, res) => {
      void handler(req, res, CTX);
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}${ZCODE_RELAY_PREFIX}/route/${token}/v1/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${CONTAINER_TOKEN}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      const text = await response.text();
      assert.equal(response.status, 503);
      const json = JSON.parse(text) as { error?: { code?: string; message?: string } };
      assert.equal(json.error?.code, "ZCODE_UPSTREAM_UNAVAILABLE");
      assert.equal(json.error?.message, "zcode relay unavailable");
      assert.equal(text.includes("sk-leak-fixture"), false);
      assert.equal(text.includes("api.z.ai"), false);
      assert.equal(text.includes("ECONNRESET"), false);
      assert.equal(text.includes("not-a-real-key"), false);
    } finally {
      await close(server);
    }
  });
});
