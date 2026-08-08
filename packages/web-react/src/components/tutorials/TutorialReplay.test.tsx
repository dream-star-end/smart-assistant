import "@testing-library/jest-dom/vitest";
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import type { TutorialCase, TutorialCaseId } from "../../lib/tutorialCaseCatalog";
import { TutorialReplay } from "./TutorialReplay";

vi.mock("../MessageRenderer", () => ({
  MessageList: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="replay-messages">
      {messages.map((message) => <p key={message.id}>{message.text}</p>)}
    </div>
  ),
}));

beforeEach(() => {
  vi.stubGlobal("crypto", {
    subtle: {
      digest: async (_algorithm: string, data: ArrayBuffer) => {
        const hash = createHash("sha256").update(new Uint8Array(data)).digest();
        return Uint8Array.from(hash).buffer;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const CASE_ID: TutorialCaseId = "research-bike-demand";
const MANIFEST_PATH = `/tutorials/cases/${CASE_ID}/messages-manifest.json`;

type VerifiedReplay = Extract<TutorialCase["replay"], { status: "verified" }>;

type Fixture = {
  replay: VerifiedReplay;
  manifestText: string;
  pageTexts: string[];
  pagePaths: string[];
};

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fixture(
  pages: ChatMessage[][],
  options?: { caseId?: TutorialCaseId; manifestPath?: string },
): Fixture {
  const caseId = options?.caseId ?? CASE_ID;
  const manifestPath = options?.manifestPath ?? `/tutorials/cases/${caseId}/messages-manifest.json`;
  let startOrdinal = 0;
  const pageTexts = pages.map((messages, pageIndex) => JSON.stringify({
    schemaVersion: 1,
    caseId,
    pageIndex,
    startOrdinal: pages.slice(0, pageIndex).reduce((sum, page) => sum + page.length, 0),
    messages,
  }));
  const pagePaths = pages.map(
    (_messages, index) => `/tutorials/cases/${caseId}/messages-${String(index + 1).padStart(4, "0")}.json`,
  );
  const descriptors = pages.map((messages, index) => {
    const descriptor = {
      path: pagePaths[index],
      sha256: digest(pageTexts[index]),
      bytes: new TextEncoder().encode(pageTexts[index]).byteLength,
      messageCount: messages.length,
      startOrdinal,
    };
    startOrdinal += messages.length;
    return descriptor;
  });
  const manifestText = JSON.stringify({
    schemaVersion: 1,
    caseId,
    messageCount: startOrdinal,
    pages: descriptors,
  });
  return {
    manifestText,
    pageTexts,
    pagePaths,
    replay: {
      status: "verified",
      disclosure: "测试用脱敏轨迹",
      messagesPath: manifestPath,
      provenance: {
        capturedAt: "2026-08-08T00:00:00.000Z",
        release: "test-release",
        runIds: ["run-1", "run-2", "run-3"],
        inputSha256: "1".repeat(64),
        messagesSha256: digest(manifestText),
        messageCount: startOrdinal,
        bytes: new TextEncoder().encode(manifestText).byteLength,
        repeatRuns: 3,
        agentId: "research-assistant",
        modelId: "deepseek-v4-pro",
        engine: "ccb",
      },
      checkReport: `/tutorials/cases/${caseId}/checks.json`,
      actualArtifacts: [
        {
          title: "结果表",
          path: `/tutorials/cases/${caseId}/artifacts/result.csv`,
          sha256: "2".repeat(64),
          bytes: 128,
          mimeType: "text/csv",
        },
      ],
    },
  };
}

function message(id: string, text: string, ts: number): ChatMessage {
  return { id, role: "assistant", text, ts };
}

function response(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
}

function installFixtureFetch(data: Fixture) {
  const byPath = new Map<string, string>([
    [data.replay.messagesPath, data.manifestText],
    ...data.pagePaths.map((path, index) => [path, data.pageTexts[index]] as const),
  ]);
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const text = byPath.get(String(input));
    return text === undefined ? new Response("not found", { status: 404 }) : response(text);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("TutorialReplay", () => {
  it("verified 先取 manifest 和第一页，用户操作后才逐页追加", async () => {
    const data = fixture([
      [message("msg-page-one", "第一页过程", 1)],
      [message("msg-page-two", "第二页过程", 2)],
    ]);
    const fetchMock = installFixtureFetch(data);
    render(<TutorialReplay caseId={CASE_ID} replay={data.replay} />);

    fireEvent.click(screen.getByRole("button", { name: /加载真实完整过程/ }));
    expect(await screen.findByText("第一页过程")).toBeInTheDocument();
    expect(screen.queryByText("第二页过程")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      MANIFEST_PATH,
      data.pagePaths[0],
    ]);

    fireEvent.click(screen.getByRole("button", { name: /加载下一页/ }));
    expect(await screen.findByText("第二页过程")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      MANIFEST_PATH,
      data.pagePaths[0],
      data.pagePaths[1],
    ]);
  });

  it("切换案例会中止旧身份，迟到的旧响应不能覆盖新案例", async () => {
    const oldData = fixture([[message("msg-old", "旧案例过程", 1)]]);
    const newCase: TutorialCaseId = "coding-swe-bench-fix";
    const newData = fixture([[message("msg-new", "新案例过程", 2)]], { caseId: newCase });
    let resolveOld: ((value: Response) => void) | undefined;
    const oldManifest = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const byPath = new Map<string, string>([
      [newData.replay.messagesPath, newData.manifestText],
      [newData.pagePaths[0], newData.pageTexts[0]],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === oldData.replay.messagesPath) return oldManifest;
      const text = byPath.get(path);
      return text === undefined ? new Response("not found", { status: 404 }) : response(text);
    }));

    const view = render(<TutorialReplay caseId={CASE_ID} replay={oldData.replay} />);
    fireEvent.click(screen.getByRole("button", { name: /加载真实完整过程/ }));
    view.rerender(<TutorialReplay caseId={newCase} replay={newData.replay} />);
    fireEvent.click(screen.getByRole("button", { name: /加载真实完整过程/ }));
    expect(await screen.findByText("新案例过程")).toBeInTheDocument();

    await act(async () => {
      resolveOld?.(response(oldData.manifestText));
      await Promise.resolve();
    });
    expect(screen.queryByText("旧案例过程")).not.toBeInTheDocument();
    expect(screen.getByText("新案例过程")).toBeInTheDocument();
  });

  it("manifest 或消息结构畸形时 fail-closed 显示错误而不渲染轨迹", async () => {
    const malformed = message("msg-private", "不应展示", 1) as ChatMessage & { traceId: string };
    malformed.traceId = "private-request-id";
    const data = fixture([[malformed]]);
    installFixtureFetch(data);
    render(<TutorialReplay caseId={CASE_ID} replay={data.replay} />);

    fireEvent.click(screen.getByRole("button", { name: /加载真实完整过程/ }));
    expect(await screen.findByText(/包含禁止的隐私身份字段/)).toBeInTheDocument();
    expect(screen.queryByText("不应展示")).not.toBeInTheDocument();
  });

  it("pending 不请求网络并明确说明尚未真实采集", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <TutorialReplay
        caseId={CASE_ID}
        replay={{ status: "pending_capture", disclosure: "尚未采集" }}
      />,
    );
    expect(screen.getByText(/待真实运行采集/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /加载真实完整过程/ })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("manifest 的案例路径或分页序号不合法时不读取任何页面", async () => {
    const data = fixture([[message("msg-one", "不应展示", 1)]]);
    const invalid = JSON.parse(data.manifestText) as { pages: Array<{ path: string }> };
    invalid.pages[0].path = "/tutorials/cases/other/messages-0001.json";
    data.manifestText = JSON.stringify(invalid);
    data.replay.provenance.messagesSha256 = digest(data.manifestText);
    data.replay.provenance.bytes = new TextEncoder().encode(data.manifestText).byteLength;
    const fetchMock = installFixtureFetch(data);
    render(<TutorialReplay caseId={CASE_ID} replay={data.replay} />);

    fireEvent.click(screen.getByRole("button", { name: /加载真实完整过程/ }));
    expect(await screen.findByText(/路径未与案例绑定/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
