/**
 * 逐条响应评价卡（👍/👎 + 就地展开标签/评论）三态与提交契约测试。
 * Harness 复刻 App 侧「乐观更新 Map」的单一权威语义（submit → 同步更新 ratings）。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import {
  type RatingEntry,
  type RatingSubmitInput,
  ResponseRatingCard,
  ResponseRatingProvider,
} from "./ResponseRating";

const friction = vi.hoisted(() =>
  vi.fn((_signal: Record<string, unknown>, _token?: string | null) => "rating-flow"),
);
vi.mock("../../lib/clientFriction", () => ({ reportClientFriction: friction }));

afterEach(cleanup);

function Harness({
  initial,
  onSubmit,
  nudgeId,
}: {
  initial?: Map<string, RatingEntry>;
  onSubmit?: (i: RatingSubmitInput) => void;
  nudgeId?: string | null;
}) {
  const [ratings, setRatings] = useState<Map<string, RatingEntry>>(initial ?? new Map());
  const submit = (input: RatingSubmitInput) => {
    onSubmit?.(input);
    setRatings((prev) => {
      const next = new Map(prev);
      const prevEntry = next.get(input.messageId);
      const tags = input.tags ?? (prevEntry?.rating === input.rating ? prevEntry.tags : []);
      next.set(input.messageId, { rating: input.rating, tags });
      return next;
    });
  };
  return (
    <ResponseRatingProvider
      value={{ ratings, submit, nudgeId, sessionId: "session-1", getToken: () => "token" }}
    >
      <ResponseRatingCard messageId="m1" traceId="t1" />
    </ResponseRatingProvider>
  );
}

describe("ResponseRatingCard", () => {
  test("默认收起态：一行小字 + 两个 thumb 按钮，无标签区", () => {
    render(<Harness />);
    expect(screen.getByText("这条回复怎么样?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "点赞" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "点踩" })).toBeInTheDocument();
    // 未评 → 标签未展开
    expect(screen.queryByRole("button", { name: "不准确" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存补充" })).not.toBeInTheDocument();
  });

  test("点 👍：立即静默提交(只带 rating)，保持单行并显示谢谢反馈", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "点赞" }));
    expect(onSubmit).toHaveBeenCalledWith({ messageId: "m1", rating: "up", traceId: "t1" });
    expect(screen.getByText("谢谢反馈")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "不准确" })).not.toBeInTheDocument();
    // 选中态：点赞 thumb aria-pressed
    expect(screen.getByRole("button", { name: "点赞" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "点踩" })).toHaveAttribute("aria-pressed", "false");
  });

  test("点 👎：就地展开问题标签集", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "点踩" }));
    expect(screen.getByText("已记录，可选补充原因")).toBeInTheDocument();
    for (const t of [
      "不准确",
      "没完成",
      "没按要求",
      "工具失败",
      "太慢",
      "太啰嗦",
      "格式问题",
      "其他",
    ]) {
      expect(screen.getByRole("button", { name: t })).toBeInTheDocument();
    }
  });

  test("选标签 + 点保存补充 → 同一 POST 覆盖(带 tags)，随后收起", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "点踩" }));
    fireEvent.click(screen.getByRole("button", { name: "不准确" }));
    fireEvent.click(screen.getByRole("button", { name: "保存补充" }));
    // 第二次提交带上标签
    expect(onSubmit).toHaveBeenLastCalledWith({
      messageId: "m1",
      rating: "down",
      traceId: "t1",
      tags: ["不准确"],
      comment: undefined,
    });
    // 提交后收起标签区
    expect(screen.queryByRole("button", { name: "保存补充" })).not.toBeInTheDocument();
    // 已评态保留：文案「谢谢反馈」+ 点踩选中
    expect(screen.getByText("谢谢反馈")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "点踩" })).toHaveAttribute("aria-pressed", "true");
  });

  test("已评回读态：初始 Map 有条目 → 高亮选中 thumb + 文案谢谢反馈", () => {
    const initial = new Map<string, RatingEntry>([["m1", { rating: "up", tags: ["有帮助"] }]]);
    render(<Harness initial={initial} />);
    expect(screen.getByText("谢谢反馈")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "点赞" })).toHaveAttribute("aria-pressed", "true");
  });

  test("nudgeId 命中未评消息 → 外层带 oc-rating-nudge 脉冲类（方案 a 引导）", () => {
    const { container } = render(<Harness nudgeId="m1" />);
    expect(container.querySelector(".oc-rating-nudge")).not.toBeNull();
    // 高亮只是视觉引导，不得渲染成已选态：thumb 仍未按下、文案仍是未评。
    expect(screen.getByText("这条回复怎么样?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "点赞" })).toHaveAttribute("aria-pressed", "false");
  });

  test("nudgeId 命中已评消息 → 不加脉冲类（不打扰已表态用户）", () => {
    const initial = new Map<string, RatingEntry>([["m1", { rating: "up", tags: [] }]]);
    const { container } = render(<Harness initial={initial} nudgeId="m1" />);
    expect(container.querySelector(".oc-rating-nudge")).toBeNull();
  });

  test("nudgeId 未命中本卡 → 不加脉冲类", () => {
    const { container } = render(<Harness nudgeId="other-id" />);
    expect(container.querySelector(".oc-rating-nudge")).toBeNull();
  });

  test("Context 为 null(demo/未登录) → 整卡不渲染", () => {
    const { container } = render(
      <ResponseRatingProvider value={null}>
        <ResponseRatingCard messageId="m1" traceId={null} />
      </ResponseRatingProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("点赞与差评补充使用固定无文本遥测 stage/code", () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "点赞" }));
    expect(friction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: "rating_clicked",
        code: "RATING_UP",
        traceId: "t1",
        sessionId: "session-1",
      }),
      "token",
    );
    unmount();

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "点踩" }));
    fireEvent.click(screen.getByRole("button", { name: "保存补充" }));
    expect(friction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventId: "rating-flow",
        stage: "rating_detail_saved",
        code: "RATING_DETAIL_SAVED",
      }),
      "token",
    );
  });
});
