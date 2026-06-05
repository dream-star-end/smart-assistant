import * as assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  expandTextWithWechatMediaParts,
  makeWechatOutboundMediaResolver,
} from "../wechat/outboundMedia.js";

describe("WeChat outbound media path expansion", () => {
  test("extracts only safe top-level generated/upload paths", () => {
    const expanded = expandTextWithWechatMediaParts(
      [
        "已生成图片:",
        "`/home/agent/.openclaude/generated/result.png`",
        "危险路径保留: /home/agent/.openclaude/generated/../secret.png",
        "嵌套路径保留: /home/agent/.openclaude/generated/sub/x.png",
      ].join("\n"),
    );
    assert.equal(expanded.media.length, 1);
    assert.equal(expanded.media[0]!.type, "image");
    assert.equal(expanded.media[0]!.filename, "result.png");
    assert.ok(!expanded.text.includes("result.png"));
    assert.match(expanded.text, /\.\.\/secret\.png/);
    assert.match(expanded.text, /sub\/x\.png/);
  });

  test("classifies audio/video/file paths", () => {
    const expanded = expandTextWithWechatMediaParts(
      [
        "/home/agent/.openclaude/generated/movie.mp4",
        "/home/agent/.openclaude/generated/speech.mp3",
        "/home/agent/.openclaude/generated/report.pdf",
      ].join("\n"),
    );
    assert.deepEqual(expanded.media.map((m) => m.type), ["video", "voice", "file"]);
  });

  test("extracts Unicode generated file basenames", () => {
    const expanded = expandTextWithWechatMediaParts(
      "有，generated/ 目录里有：`/home/agent/.openclaude/generated/自媒体运营入门.pptx`。要我发给你吗？",
    );
    assert.equal(expanded.media.length, 1);
    assert.equal(expanded.media[0]!.type, "file");
    assert.equal(expanded.media[0]!.filename, "自媒体运营入门.pptx");
    assert.equal(
      expanded.media[0]!.containerPath,
      "/home/agent/.openclaude/generated/自媒体运营入门.pptx",
    );
    assert.ok(!expanded.text.includes("/home/agent/.openclaude/generated/自媒体运营入门.pptx"));
    assert.match(expanded.text, /有，generated\/ 目录里有：。要我发给你吗？/);
  });
});

describe("WeChat outbound media resolver", () => {
  test("reads current user's local generated file and sniffs image kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-wechat-media-"));
    try {
      const uploads = join(root, "uploads");
      const generated = join(root, "generated");
      await mkdir(generated, { recursive: true });
      await mkdir(uploads, { recursive: true });
      await writeFile(
        join(generated, "img.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const resolve = makeWechatOutboundMediaResolver({
        resolveUserMediaDirs: async (uid) => {
          assert.equal(uid, "c:42");
          return { kind: "ok", uid: 42, uploads, generated };
        },
      });
      const media = await resolve({
        bindingUserId: "42",
        part: {
          type: "file",
          containerPath: "/home/agent/.openclaude/generated/img.png",
          filename: "img.png",
        },
      });
      assert.equal(media.kind, "image");
      assert.equal(media.mimeType, "image/png");
      assert.equal(media.filename, "img.png");
      assert.equal(media.content.length, 8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pulls remote-host media through injected hook", async () => {
    const resolve = makeWechatOutboundMediaResolver({
      resolveUserMediaDirs: async () => ({
        kind: "fail",
        reason: "remote-host",
        uid: 42,
        hostUuid: "host-1",
        uploads: "/remote/uploads",
        generated: "/remote/generated",
        logCtx: {},
      }),
      pullRemoteHostMedia: async ({ hostUuid, remotePath }) => {
        assert.equal(hostUuid, "host-1");
        assert.equal(remotePath, "/remote/generated/report.pdf");
        return Buffer.from("%PDF-1.7");
      },
    });
    const media = await resolve({
      bindingUserId: "c:42",
      part: {
        type: "file",
        containerPath: "/home/agent/.openclaude/generated/report.pdf",
        filename: "report.pdf",
      },
    });
    assert.equal(media.kind, "file");
    assert.equal(media.mimeType, "application/pdf");
  });

  test("reads current user's local generated Unicode filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-wechat-media-"));
    try {
      const uploads = join(root, "uploads");
      const generated = join(root, "generated");
      await mkdir(generated, { recursive: true });
      await mkdir(uploads, { recursive: true });
      await writeFile(join(generated, "自媒体运营入门.pptx"), Buffer.from("pptx bytes"));
      const resolve = makeWechatOutboundMediaResolver({
        resolveUserMediaDirs: async () => ({ kind: "ok", uid: 42, uploads, generated }),
      });
      const media = await resolve({
        bindingUserId: "42",
        part: {
          type: "file",
          containerPath: "/home/agent/.openclaude/generated/自媒体运营入门.pptx",
          filename: "自媒体运营入门.pptx",
        },
      });
      assert.equal(media.kind, "file");
      assert.equal(
        media.mimeType,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
      assert.equal(media.filename, "自媒体运营入门.pptx");
      assert.equal(media.content.toString("utf8"), "pptx bytes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects local symlink media paths instead of following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-wechat-media-"));
    try {
      const uploads = join(root, "uploads");
      const generated = join(root, "generated");
      await mkdir(generated, { recursive: true });
      await mkdir(uploads, { recursive: true });
      await writeFile(join(root, "outside.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await symlink(join(root, "outside.png"), join(generated, "link.png"));
      const resolve = makeWechatOutboundMediaResolver({
        resolveUserMediaDirs: async () => ({ kind: "ok", uid: 42, uploads, generated }),
      });
      await assert.rejects(
        resolve({
          bindingUserId: "42",
          part: {
            type: "image",
            containerPath: "/home/agent/.openclaude/generated/link.png",
            filename: "link.png",
          },
        }),
        /ELOOP|symbolic link/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects uploads/generated directories that are symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-wechat-media-"));
    try {
      const uploads = join(root, "uploads");
      const realGenerated = join(root, "real-generated");
      const generated = join(root, "generated-link");
      await mkdir(uploads, { recursive: true });
      await mkdir(realGenerated, { recursive: true });
      await writeFile(join(realGenerated, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await symlink(realGenerated, generated);
      const resolve = makeWechatOutboundMediaResolver({
        resolveUserMediaDirs: async () => ({ kind: "ok", uid: 42, uploads, generated }),
      });
      await assert.rejects(
        resolve({
          bindingUserId: "42",
          part: {
            type: "image",
            containerPath: "/home/agent/.openclaude/generated/img.png",
            filename: "img.png",
          },
        }),
        /safe directory|symbolic link/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
