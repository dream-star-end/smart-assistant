import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Dispatcher } from "undici";

import type { UserMediaLocation } from "../agent-sandbox/userMedia.js";
import {
  downloadQqMedia,
  saveQqMediaToUserUploads,
} from "../qqbot/mediaIngest.js";

const PUBLIC_DNS = {
  async resolve4() {
    return ["8.8.8.8"];
  },
  async resolve6() {
    return [];
  },
};

const FAKE_DISPATCHER = {
  async close() {},
} as unknown as Dispatcher;

test("QQ image first message ensures the container before resolving and saving its volume", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-media-"));
  const uploads = join(root, "uploads");
  const order: string[] = [];
  try {
    const result = await saveQqMediaToUserUploads(
      {
        bindingUserId: "42",
        text: "图里是什么？",
        attachments: [
          {
            content_type: "image/png",
            url: "https://cdn.qq.com/image",
            filename: "截图.png",
          },
        ],
      },
      {
        ensureContainerReady: async (uid) => {
          assert.equal(uid, 42n);
          order.push("ensure");
        },
        resolveUserMediaDirs: async (userId) => {
          assert.equal(userId, "c:42");
          order.push("resolve");
          return {
            kind: "ok",
            uid: 42,
            uploads,
            generated: join(root, "generated"),
          } satisfies UserMediaLocation;
        },
        resolver: PUBLIC_DNS,
        fetchImpl: async () => {
          order.push("fetch");
          return new Response(Buffer.from("png-bytes"), { status: 200 });
        },
        makeDispatcher: () => FAKE_DISPATCHER,
      },
    );

    assert.deepEqual(order, ["ensure", "resolve", "fetch"]);
    assert.equal(result.count, 1);
    assert.equal(result.media[0]?.kind, "image");
    assert.match(result.media[0]?.filename ?? "", /^qq-image-[a-f0-9]{32}\.png$/);
    assert.match(result.promptText, /图里是什么？/);
    assert.match(result.promptText, /oc-vision understand/);
    assert.equal(
      await readFile(join(uploads, result.media[0]!.filename), "utf8"),
      "png-bytes",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QQ voice prefers the server WAV URL and normalizes path and MIME to WAV", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-voice-"));
  const fetched: string[] = [];
  try {
    const result = await saveQqMediaToUserUploads(
      {
        bindingUserId: "c:7",
        attachments: [
          {
            content_type: "voice",
            url: "https://cdn.qq.com/original.silk",
            voice_wav_url: "//cdn.qq.com/converted.wav?signature=ok",
            filename: "原始语音.silk",
            asr_refer_text: "明天下午提醒我",
          },
        ],
      },
      {
        ensureContainerReady: async () => {},
        resolveUserMediaDirs: async () => ({
          kind: "ok",
          uid: 7,
          uploads: join(root, "uploads"),
          generated: join(root, "generated"),
        }),
        resolver: PUBLIC_DNS,
        fetchImpl: async (url) => {
          fetched.push(url);
          return new Response(Buffer.from("wav-bytes"), { status: 200 });
        },
        makeDispatcher: () => FAKE_DISPATCHER,
      },
    );

    assert.deepEqual(fetched, ["https://cdn.qq.com/converted.wav?signature=ok"]);
    assert.match(result.media[0]?.filename ?? "", /\.wav$/);
    assert.equal(result.media[0]?.mimeType, "audio/wav");
    assert.match(result.promptText, /QQ 语音转写: 明天下午提醒我/);
    assert.match(result.promptText, /audio\/wav/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("QQ file can be pushed to a remote user host without a local fallback", async () => {
  const pushed: Array<{ hostUuid: string; remotePath: string; content: Buffer }> = [];
  const result = await saveQqMediaToUserUploads(
    {
      bindingUserId: "9",
      text: "总结这个文件",
      attachments: [
        {
          content_type: "application/pdf",
          url: "https://files.qq.com/report",
          filename: "报告.pdf",
        },
      ],
    },
    {
      ensureContainerReady: async () => {},
      resolveUserMediaDirs: async () => ({
        kind: "fail",
        reason: "remote-host",
        uid: 9,
        hostUuid: "host-1",
        uploads: "/remote/volume/uploads",
        generated: "/remote/volume/generated",
        logCtx: {},
      }),
      pushRemoteHostUpload: async (args) => {
        pushed.push(args);
      },
      resolver: PUBLIC_DNS,
      fetchImpl: async () => new Response(Buffer.from("pdf"), { status: 200 }),
      makeDispatcher: () => FAKE_DISPATCHER,
    },
  );

  assert.equal(result.media[0]?.kind, "file");
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]?.hostUuid, "host-1");
  assert.match(pushed[0]?.remotePath ?? "", /\/qq-file-[a-f0-9]{32}\.pdf$/);
  assert.equal(pushed[0]?.content.toString(), "pdf");
});

test("QQ media redirects are re-resolved and reject a private target before fetching it", async () => {
  const fetched: string[] = [];
  const resolver = {
    async resolve4(hostname: string) {
      return hostname === "cdn.qq.com" ? ["8.8.8.8"] : ["127.0.0.1"];
    },
    async resolve6() {
      return [];
    },
  };

  await assert.rejects(
    downloadQqMedia("https://cdn.qq.com/start", {
      maxBytes: 1024,
      label: "image",
      timeoutMs: 1_000,
      resolver,
      fetchImpl: async (url) => {
        fetched.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "https://private.qq.com/secret" },
        });
      },
      makeDispatcher: () => FAKE_DISPATCHER,
    }),
    /not global unicast/,
  );
  assert.deepEqual(fetched, ["https://cdn.qq.com/start"]);
});

test("QQ media total deadline aborts a stalled response body", async () => {
  let canceled = false;
  const resolver = {
    ...PUBLIC_DNS,
    cancel() {
      canceled = true;
    },
  };
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
  });

  await assert.rejects(
    downloadQqMedia("https://cdn.qq.com/stalled", {
      maxBytes: 1024,
      label: "voice",
      timeoutMs: 20,
      resolver,
      fetchImpl: async () => new Response(stalled, { status: 200 }),
      makeDispatcher: () => FAKE_DISPATCHER,
    }),
    /timed out/,
  );
  assert.equal(canceled, true);
});

test("QQ media total deadline also bounds stalled DNS resolution", async () => {
  let canceled = false;
  const resolver = {
    resolve4: () => new Promise<string[]>(() => {}),
    async resolve6() {
      return [];
    },
    cancel() {
      canceled = true;
    },
  };
  const startedAt = Date.now();

  await assert.rejects(
    downloadQqMedia("https://cdn.qq.com/dns-stall", {
      maxBytes: 1024,
      label: "file",
      timeoutMs: 20,
      resolver,
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
      makeDispatcher: () => FAKE_DISPATCHER,
    }),
    /timed out/,
  );
  assert.equal(canceled, true);
  assert.ok(Date.now() - startedAt < 500);
});

test("QQ media enforces the SDK size contract before downloading", async () => {
  let fetched = false;
  await assert.rejects(
    saveQqMediaToUserUploads(
      {
        bindingUserId: "12",
        attachments: [
          {
            content_type: "image/jpeg",
            url: "https://cdn.qq.com/huge",
            size: 30 * 1024 * 1024 + 1,
          },
        ],
      },
      {
        ensureContainerReady: async () => {},
        resolveUserMediaDirs: async () => ({
          kind: "ok",
          uid: 12,
          uploads: "/tmp/not-used",
          generated: "/tmp/not-used",
        }),
        resolver: PUBLIC_DNS,
        fetchImpl: async () => {
          fetched = true;
          return new Response();
        },
        makeDispatcher: () => FAKE_DISPATCHER,
      },
    ),
    /exceeds size limit/,
  );
  assert.equal(fetched, false);
});
