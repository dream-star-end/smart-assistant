import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import type { ChatMessage } from "./chat/model";
import type { ProjectAsset } from "./types";
import {
  HTML_EMBED_SANDBOX,
  MAX_TUTORIAL_ARTIFACT_BYTES,
  TUTORIAL_STRIPPED_ROLES,
  blobToBase64,
  communityTutorialShareUrl,
  htmlEmbedSandboxIsSafe,
  inferTutorialArtifactMime,
  isAllowedTutorialArtifactMime,
  isSafeTutorialMediaUrl,
  isStrippedTutorialRole,
  publicSnapshotMessages,
  serializeSnapshotMessages,
  sessionOutputAssets,
  snapshotMessagesFromUnknown,
  snapshotPublishGate,
  tutorialArtifactGuardError,
  tutorialKindOf,
  tutorialPublishErrorMessage,
  canWithdrawCommunityTutorial,
  deriveTutorialArtifacts,
  fetchSnapshotPageMessages,
  parseTutorialEvalMaterialsJson,
  parseTutorialEvalRubricJson,
} from "./tutorialStudio";

function msg(role: ChatMessage["role"], id = role): ChatMessage {
  return { id, role, text: id, ts: 1 };
}

function asset(partial: Partial<ProjectAsset> & Pick<ProjectAsset, "id" | "name">): ProjectAsset {
  return {
    projectId: "p1",
    source: "output",
    sessionId: "s1",
    url: "/files/a",
    containerPath: "/out/a",
    mime: "text/plain",
    sizeBytes: 12,
    excerpt: null,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("snapshotPublishGate", () => {
  it("未登录优先于其它条件", () => {
    expect(snapshotPublishGate({ authed: false, sending: true, messageCount: 0 })).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("发送中不可发布", () => {
    expect(snapshotPublishGate({ authed: true, sending: true, messageCount: 3 })).toEqual({
      ok: false,
      reason: "sending",
    });
  });

  it("空会话不可发布", () => {
    expect(snapshotPublishGate({ authed: true, sending: false, messageCount: 0 })).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("非空且已结束可发布", () => {
    expect(snapshotPublishGate({ authed: true, sending: false, messageCount: 2 })).toEqual({ ok: true });
  });
});

describe("public snapshot roles", () => {
  it("剥离内部角色并保留公开轨迹", () => {
    const messages = [
      msg("user"),
      msg("system"),
      msg("assistant"),
      msg("permission"),
      msg("tool"),
      msg("runtime-event"),
      msg("delegate-progress"),
      msg("thinking"),
    ];
    expect(publicSnapshotMessages(messages).map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "thinking",
    ]);
    for (const role of TUTORIAL_STRIPPED_ROLES) {
      expect(isStrippedTutorialRole(role)).toBe(true);
    }
  });

  it("未知结构不会进入公开轨迹", () => {
    expect(snapshotMessagesFromUnknown([{ role: "user" }, msg("assistant")])).toEqual([msg("assistant")]);
  });
});

describe("session output assets", () => {
  it("只保留当前会话的 output，默认不带上传资料", () => {
    const assets = [
      asset({ id: "1", name: "keep.txt", source: "output", sessionId: "s1" }),
      asset({ id: "2", name: "other.txt", source: "output", sessionId: "s2" }),
      asset({ id: "3", name: "upload.txt", source: "upload", sessionId: "s1" }),
    ];
    expect(sessionOutputAssets(assets, "s1").map((item) => item.id)).toEqual(["1"]);
  });
});

describe("artifact mime/size guards", () => {
  it("允许约定类型并禁止 SVG", () => {
    expect(isAllowedTutorialArtifactMime("text/markdown")).toBe(true);
    expect(isAllowedTutorialArtifactMime("application/json")).toBe(true);
    expect(isAllowedTutorialArtifactMime("image/png")).toBe(true);
    expect(isAllowedTutorialArtifactMime("video/webm")).toBe(true);
    expect(isAllowedTutorialArtifactMime("audio/mpeg")).toBe(true);
    expect(isAllowedTutorialArtifactMime("application/pdf")).toBe(true);
    expect(isAllowedTutorialArtifactMime("image/svg+xml")).toBe(false);
    expect(tutorialArtifactGuardError("image/svg+xml", 10)).toBe("svg");
    expect(inferTutorialArtifactMime({ name: "chart.svg", mime: null })).toBe("image/svg+xml");
  });

  it("单件和总量超限被拒绝", () => {
    expect(tutorialArtifactGuardError("text/plain", MAX_TUTORIAL_ARTIFACT_BYTES + 1)).toBe("too-large");
    expect(
      tutorialArtifactGuardError("text/plain", 8, { selectedBytes: 32 * 1024 * 1024 - 1 }),
    ).toBe("total-too-large");
  });
});

describe("safe media urls and html sandbox", () => {
  it("只接受同源教程 embed/blob 路径", () => {
    expect(isSafeTutorialMediaUrl("/api/tutorial-embeds/abc")).toBe(true);
    expect(isSafeTutorialMediaUrl("/api/tutorial-blobs/abc")).toBe(true);
    expect(isSafeTutorialMediaUrl("https://evil.test/page.html")).toBe(false);
    expect(isSafeTutorialMediaUrl("/api/media-signed?x=1")).toBe(false);
  });

  it("HTML sandbox 只允许 allow-scripts", () => {
    expect(htmlEmbedSandboxIsSafe(HTML_EMBED_SANDBOX)).toBe(true);
    expect(htmlEmbedSandboxIsSafe("allow-scripts allow-same-origin")).toBe(false);
    expect(htmlEmbedSandboxIsSafe("allow-scripts allow-forms")).toBe(false);
    expect(htmlEmbedSandboxIsSafe("allow-scripts allow-popups")).toBe(false);
    expect(htmlEmbedSandboxIsSafe("allow-scripts allow-top-navigation")).toBe(false);
  });
});

describe("serializeSnapshotMessages", () => {
  it("只保留公开角色的 id/role/text/ts", () => {
    const messages = [
      msg("user"),
      msg("system"),
      { ...msg("assistant"), _retryMedia: [] },
    ];
    expect(serializeSnapshotMessages(messages)).toEqual([
      { id: "user", role: "user", text: "user", ts: 1 },
      { id: "assistant", role: "assistant", text: "assistant", ts: 1 },
    ]);
  });
});

describe("share url and kind", () => {
  it("生成社区教程分享链接", () => {
    expect(communityTutorialShareUrl("abc", "https://claudeai.chat")).toBe(
      "https://claudeai.chat/?panel=help&community=abc",
    );
  });

  it("缺省 kind 视为 markdown", () => {
    expect(tutorialKindOf({})).toBe("markdown");
    expect(tutorialKindOf({ kind: "snapshot" })).toBe("snapshot");
  });
});

describe("withdraw contract and leak report", () => {
  it("draft/pending/approved 可撤，takedown 不可", () => {
    expect(canWithdrawCommunityTutorial("draft")).toBe(true);
    expect(canWithdrawCommunityTutorial("pending")).toBe(true);
    expect(canWithdrawCommunityTutorial("approved")).toBe(true);
    expect(canWithdrawCommunityTutorial("takedown")).toBe(false);
    expect(canWithdrawCommunityTutorial("withdrawn")).toBe(false);
    expect(canWithdrawCommunityTutorial("rejected")).toBe(false);
  });

  it("从 ApiError.body.leakReport 拼出规则字段", () => {
    const err = new ApiError({
      status: 400,
      message: "会话快照未通过安全扫描",
      code: "LEAKS_FOUND",
      body: { leakReport: { leaks: [{ rule: "private_field", field: "messages[0]" }] } },
    });
    expect(tutorialPublishErrorMessage(err, "发布快照失败")).toBe(
      "会话快照未通过安全扫描：private_field（messages[0]）",
    );
  });
});

describe("deriveTutorialArtifacts", () => {
  it("HTML/图片/音视频/PDF 用 embed，文本只用 blob 下载", () => {
    const artifacts = deriveTutorialArtifacts({
      artifacts: [
        { sha256: "html1", name: "a.html", mime: "text/html", bytes: 10, embedUrl: "/api/tutorial-blobs/html1", downloadUrl: "/api/tutorial-blobs/html1" },
        { sha256: "img1", name: "a.png", mime: "image/png", bytes: 10 },
        { sha256: "txt1", name: "a.md", mime: "text/markdown", bytes: 10, embedUrl: "/api/tutorial-blobs/txt1" },
      ],
    });
    expect(artifacts[0]?.embedUrl).toBe("/api/tutorial-embeds/html1");
    expect(artifacts[0]?.downloadUrl).toBe("/api/tutorial-blobs/html1");
    expect(artifacts[1]?.embedUrl).toBe("/api/tutorial-embeds/img1");
    expect(artifacts[2]?.embedUrl).toBeNull();
    expect(artifacts[2]?.downloadUrl).toBe("/api/tutorial-blobs/txt1");
  });
});

describe("eval JSON parsers", () => {
  it("材料必须是 items 数组，rubric.checks 必须非空", () => {
    expect(parseTutorialEvalMaterialsJson('{"items":[]}')).toEqual({ items: [] });
    expect(() => parseTutorialEvalMaterialsJson('"zip"')).toThrow(/items/);
    expect(parseTutorialEvalRubricJson(JSON.stringify({
      checks: [{ id: "c1", method: "manual", passCriterion: "可见结论" }],
    })).checks).toHaveLength(1);
    expect(() => parseTutorialEvalRubricJson('{"checks":[]}')).toThrow(/非空/);
  });
});

describe("fetchSnapshotPageMessages", () => {
  it("按清单顺序串行拉取并保持跨页消息顺序", async () => {
    const fetcher = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        messages: [{
          id: url.endsWith("p1") ? "m1" : "m2",
          role: url.endsWith("p1") ? "user" : "assistant",
          text: url.endsWith("p1") ? "one" : "two",
          ts: url.endsWith("p1") ? 1 : 2,
        }],
      }),
    }));
    const messages = await fetchSnapshotPageMessages(
      ["/api/tutorial-blobs/p1", "/api/tutorial-blobs/p2"],
      fetcher as unknown as typeof fetch,
    );
    expect(messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/tutorial-blobs/p1",
      "/api/tutorial-blobs/p2",
    ]);
  });

  it("HTTP 失败或非法 JSON 明确抛错", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("p1")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            messages: [{ id: "m1", role: "user", text: "one", ts: 1 }],
          }),
        };
      }
      return { ok: false, status: 500, text: async () => "" };
    });
    await expect(
      fetchSnapshotPageMessages(["/api/tutorial-blobs/p1", "/api/tutorial-blobs/p2"], fetcher as unknown as typeof fetch),
    ).rejects.toThrow(/snapshot page 500/);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/tutorial-blobs/p1",
      "/api/tutorial-blobs/p2",
    ]);

    await expect(
      fetchSnapshotPageMessages(
        ["/api/tutorial-blobs/bad"],
        (async () => ({ ok: true, status: 200, text: async () => "not-json" })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/valid JSON/);
  });
});

describe("blobToBase64", () => {
  it("编码二进制为标准 base64", async () => {
    const blob = new Blob([new Uint8Array([104, 105])], { type: "text/plain" });
    expect(await blobToBase64(blob)).toBe(btoa("hi"));
  });
});
