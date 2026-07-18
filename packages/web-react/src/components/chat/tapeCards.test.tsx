/**
 * §9 折叠卷卡(CollapseCard)+ 截断工具卡尾部组件断言。
 * MessageRenderer 对 `_tapeCollapsed` 的拦截、折叠/展开两态渲染、点击展开回调、截断"查看完整"抓取。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { messageSignature } from "../../lib/chat/render";
import { MessageRenderer } from "../MessageRenderer";
import type { CardCallbacks } from "./cards";

afterEach(cleanup);
beforeAll(async () => {
  await import("../MarkdownImpl");
});

function renderMsg(message: ChatMessage, cb: CardCallbacks = {}) {
  return render(
    <MessageRenderer
      message={message}
      sig={messageSignature(message, { isLast: true, sending: false })}
      isLast
      sending={false}
      inActiveTurn
      cb={cb}
      onRespondPermission={() => {}}
    />,
  );
}

function collapsedAnchor(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "srv-a-t1-s0",
    role: "assistant",
    text: "",
    ts: 1000,
    _source: "server",
    _tapeCollapsed: true,
    _tapeTotalBytes: 192 * 1024 * 1024,
    _dispatchOutcome: "completed",
    _turnTapeId: "tape-1",
    _turnTapeSha256: "sha-1",
    _clientMessageId: "cm-1",
    ...over,
  };
}

describe("CollapseCard 折叠卡 (RFC §9.1)", () => {
  test("折叠态:渲染「本轮完整输出 N MB，点击加载」,点击触发 onExpandTape(anchorId, tapeId, null)", async () => {
    const onExpandTape = vi.fn().mockResolvedValue({ ok: true, nextCursor: 2 });
    renderMsg(collapsedAnchor(), { onExpandTape });
    expect(screen.getByText(/本轮完整输出 192\.0 MB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onExpandTape).toHaveBeenCalledWith("srv-a-t1-s0", "tape-1", null));
  });

  test("折叠 anchor 走 CollapseCard 而非 AssistantCard:即便带 usage 也不渲染评分/MetaRow", () => {
    // 折叠 anchor 给正文 + usage(若误走 AssistantCard 会出评分/成本尾注)。
    renderMsg(collapsedAnchor({ text: "本应折叠的摘要", usage: { traceId: "t1", costCredits: "9" } }), {});
    // 未展开 → 只有折叠入口文案,无 markdown 正文气泡、无请求 ID 尾注。
    expect(screen.getByText(/本轮完整输出/)).toBeInTheDocument();
    expect(screen.queryByText("本应折叠的摘要")).not.toBeInTheDocument();
  });

  test("未接线 onExpandTape(demo/只读)→ 静态摘要,按钮禁用", () => {
    renderMsg(collapsedAnchor(), {});
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(screen.getByText(/本轮完整输出 192\.0 MB$/)).toBeInTheDocument(); // 无"，点击加载"后缀
  });

  test("展开态:渲染「已展开」+ 继续加载(游标非 null)+ 收起", () => {
    const onCollapseTape = vi.fn();
    renderMsg(collapsedAnchor({ _tapeExpanded: true, _tapeExpandCursor: 3 }), {
      onExpandTape: vi.fn().mockResolvedValue({ ok: true }),
      onCollapseTape,
    });
    expect(screen.getByText(/已展开/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /继续加载更多/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(onCollapseTape).toHaveBeenCalledWith("srv-a-t1-s0");
  });

  test("展开态已拉全(游标 null)→ 无「继续加载」", () => {
    renderMsg(collapsedAnchor({ _tapeExpanded: true, _tapeExpandCursor: null }), {
      onCollapseTape: vi.fn(),
    });
    expect(screen.getByText(/已展开/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /继续加载/ })).not.toBeInTheDocument();
  });

  test("卷级投影截断 → 展开头提示部分省略", () => {
    renderMsg(collapsedAnchor({ _tapeExpanded: true, _tapeExpandCursor: null, _projectionTruncated: true }), {
      onCollapseTape: vi.fn(),
    });
    expect(screen.getByText(/部分记录已省略/)).toBeInTheDocument();
  });
});

describe("截断工具卡尾部 (RFC §9.1)", () => {
  function truncatedTool(over: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: "rec-7",
      role: "tool",
      text: "",
      ts: 1000,
      _source: "server",
      toolName: "Bash",
      _completed: true,
      output: "已截断的前 64KB 输出…",
      _fullBytes: 5 * 1024 * 1024,
      _turnTapeId: "tape-1",
      ...over,
    };
  }

  test("展开工具卡 → 尾部显示「输出已截断（共 N MB）」+ 查看完整;点击抓取并显示更完整内容", async () => {
    const onFetchTapeRecords = vi
      .fn()
      .mockResolvedValue({ records: [{ id: "rec-7", role: "tool", text: "", output: "更完整的输出内容" }], nextCursor: null, total: 1 });
    renderMsg(truncatedTool(), { onFetchTapeRecords });
    // 工具卡默认折叠(completed),点击卡头展开卡体。
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getByText(/输出已截断（共 5\.0 MB）/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /查看完整/ }));
    await waitFor(() => expect(screen.getByText("更完整的输出内容")).toBeInTheDocument());
    expect(onFetchTapeRecords).toHaveBeenCalledWith("tape-1", null);
  });

  test("未截断的工具记录(无 _fullBytes)→ 无截断尾部", () => {
    renderMsg(truncatedTool({ _fullBytes: undefined }), { onFetchTapeRecords: vi.fn() });
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.queryByText(/输出已截断/)).not.toBeInTheDocument();
  });

  // ── M6①(R3):截断记录携 `_recordOrdinal` → 走按记录分块拉取真通路(前端零改动即通)。 ──
  test("M6① 携 _recordOrdinal → 点击查看完整走 onFetchTapeRecordChunk(按 recordOrdinal 分块)", async () => {
    const onFetchTapeRecordChunk = vi
      .fn()
      .mockResolvedValueOnce({ chunk: "分块A", nextOffset: 5, totalBytes: 10 })
      .mockResolvedValueOnce({ chunk: "分块B", nextOffset: null, totalBytes: 10 });
    renderMsg(truncatedTool({ _recordOrdinal: 3 }), { onFetchTapeRecordChunk });
    fireEvent.click(screen.getAllByRole("button")[0]); // 展开工具卡
    fireEvent.click(screen.getByRole("button", { name: /查看完整/ }));
    await waitFor(() => expect(screen.getByText("分块A分块B")).toBeInTheDocument());
    // 关键:按 `_recordOrdinal`(=3)分块拉取,不走老 page-scan。
    expect(onFetchTapeRecordChunk).toHaveBeenCalledWith("tape-1", 3, 0);
    expect(onFetchTapeRecordChunk).toHaveBeenCalledWith("tape-1", 3, 5);
  });

  // ── M6②(R3):分块中途拿不到块(限频/瞬态)→ 显式「内容加载不完整」,绝不把半截冒充完整。 ──
  test("M6② 中途 null → partial 提示「内容加载不完整」,不冒充完整", async () => {
    const onFetchTapeRecordChunk = vi
      .fn()
      .mockResolvedValueOnce({ chunk: "前半段", nextOffset: 5, totalBytes: 20 })
      .mockResolvedValueOnce(null); // 第 2 块限频/失败
    renderMsg(truncatedTool({ _recordOrdinal: 1 }), { onFetchTapeRecordChunk });
    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /查看完整/ }));
    await waitFor(() => expect(screen.getByText(/内容加载不完整，请稍后重试/)).toBeInTheDocument());
    // 已拉到的半截仍展示,但明确标不完整(不显示为完整、无 error 误报)。
    expect(screen.getByText("前半段")).toBeInTheDocument();
    expect(screen.queryByText(/未能加载完整内容/)).not.toBeInTheDocument();
  });

  // ── M6③(R3):4MB 上限按 UTF-8 字节(TextEncoder),非 JS 字符数。 ──
  test("M6③ 上限按 UTF-8 字节:多字节内容字节超 4MB(字符数未超)→ overflow「内容过大」", async () => {
    // 每块 700k 个「中」= 700k JS 字符 / 2.1MB UTF-8 字节。两块 = 1.4M 字符(<4M 字符)但 4.2MB 字节(>4MB)。
    // 旧口径按 acc.length(字符)→ 不 overflow;新口径按字节 → 第 2 块并入前越限 → overflow。
    const block = "中".repeat(700_000);
    const onFetchTapeRecordChunk = vi
      .fn()
      .mockResolvedValueOnce({ chunk: block, nextOffset: 1, totalBytes: 99 })
      .mockResolvedValueOnce({ chunk: block, nextOffset: 2, totalBytes: 99 })
      .mockResolvedValue({ chunk: block, nextOffset: null, totalBytes: 99 });
    renderMsg(truncatedTool({ _recordOrdinal: 2 }), { onFetchTapeRecordChunk });
    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /查看完整/ }));
    await waitFor(() => expect(screen.getByText(/内容过大，已展示前 4MB/)).toBeInTheDocument());
    // 只并入了 1 块(2.1MB ≤ 4MB),第 2 块并入会越 4MB 字节 → 停在整块边界。
    expect(onFetchTapeRecordChunk).toHaveBeenCalledTimes(2);
  });
});
