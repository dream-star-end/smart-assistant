import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import {
  captureVisibleVirtualRowAnchor,
  correctToVisibleVirtualRowAnchor,
  correctedScrollTop,
  loadedArchivedMetrics,
  planLoadMore,
  restoreVisibleVirtualRowAnchor,
} from "./archivePaging";

function row(seq?: number): Pick<ChatMessage, "_seq"> {
  return seq === undefined ? {} : { _seq: seq };
}

describe("loadedArchivedMetrics", () => {
  test("无水位(0/负)→ 恒 0(无归档会话)", () => {
    expect(loadedArchivedMetrics([row(1), row(2)], 0)).toEqual({ rows: 0, anchors: 0 });
    expect(loadedArchivedMetrics([row(1)], -5)).toEqual({ rows: 0, anchors: 0 });
  });

  test("只数 _seq ≤ 水位的行;尾巴(> 水位)与本地无 _seq 行不计", () => {
    const msgs = [row(3), row(4), row(10), row(11), row()]; // 水位=5:seq 3,4 是已拉归档
    expect(loadedArchivedMetrics(msgs, 5)).toEqual({ rows: 2, anchors: 2 });
  });

  test("边界 _seq === 水位 计入(≤)", () => {
    expect(loadedArchivedMetrics([row(5), row(6)], 5)).toEqual({ rows: 1, anchors: 1 });
  });

  test("全是尾巴(无归档拉回)→ 0", () => {
    expect(loadedArchivedMetrics([row(100), row(101), row()], 5)).toEqual({ rows: 0, anchors: 0 });
  });

  test("同一 tape anchor 展开多条可见行:rows 全计、anchors 按共享 _seq 去重", () => {
    expect(loadedArchivedMetrics([row(3), row(3), row(3), row(4), row(10)], 5)).toEqual({
      rows: 4,
      anchors: 2,
    });
  });

  test("新行以 _orderSeq 判水位，内容 patch 后的高 _seq 不会伪装成热尾巴", () => {
    expect(loadedArchivedMetrics([
      { _seq: 99, _orderSeq: 3 },
      { _seq: 4, _orderSeq: 10 },
    ], 5)).toEqual({ rows: 1, anchors: 1 });
  });
});

describe("correctedScrollTop", () => {
  test("把前插前后的高度差全部计入 → 视口锚定原位置", () => {
    // 插入前高度 1000、scrollTop 0;插入 600px 旧内容后高度 1600 → scrollTop 应顶回 600。
    expect(correctedScrollTop(1000, 1600, 0)).toBe(600);
  });
  test("保留原有偏移量", () => {
    expect(correctedScrollTop(1000, 1600, 120)).toBe(720);
  });
  test("高度未变 → scrollTop 不动", () => {
    expect(correctedScrollTop(1000, 1000, 300)).toBe(300);
  });
});

describe("visible virtual row anchor", () => {
  test("只校正顶部前插造成的行位移，不把底部 live answer 增长算进去", () => {
    const scroller = document.createElement("div");
    const rowElement = document.createElement("div");
    rowElement.setAttribute("data-chat-virtual-key", "stable-row");
    scroller.appendChild(rowElement);
    Object.defineProperty(scroller, "scrollTop", { value: 100, writable: true });
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600,
      x: 0, y: 0, toJSON: () => ({}),
    });
    let rowTop = 120;
    rowElement.getBoundingClientRect = () => ({
      top: rowTop, bottom: rowTop + 40, left: 0, right: 800, width: 800, height: 40,
      x: 0, y: rowTop, toJSON: () => ({}),
    });

    const anchor = captureVisibleVirtualRowAnchor(scroller)!;
    expect(anchor).toEqual({ key: "stable-row", top: 120 });
    // 顶部归档新增 200px；同时底部 live answer 可增长任意高度，但稳定行只下移 200px。
    rowTop = 320;
    expect(correctToVisibleVirtualRowAnchor(scroller, anchor)).toBe(true);
    expect(scroller.scrollTop).toBe(300);
  });

  test("首帧校正后用户滚动会取消后续帧，不再把视口拽回", async () => {
    const scroller = document.createElement("div");
    const rowElement = document.createElement("div");
    rowElement.setAttribute("data-chat-virtual-key", "stable-row");
    scroller.appendChild(rowElement);
    Object.defineProperty(scroller, "scrollTop", { value: 100, writable: true });
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600,
      x: 0, y: 0, toJSON: () => ({}),
    });
    rowElement.getBoundingClientRect = () => ({
      top: 320, bottom: 360, left: 0, right: 800, width: 800, height: 40,
      x: 0, y: 320, toJSON: () => ({}),
    });
    const frames: Array<() => void> = [];
    let cancelled = false;
    const restoring = restoreVisibleVirtualRowAnchor(
      scroller,
      { key: "stable-row", top: 120 },
      () => cancelled,
      (callback) => frames.push(callback),
    );

    frames.shift()!();
    expect(scroller.scrollTop).toBe(300);
    scroller.scrollTop = 250;
    cancelled = true;
    frames.shift()!();
    await restoring;
    expect(scroller.scrollTop).toBe(250);
    expect(frames).toHaveLength(0);
  });
});

describe("planLoadMore 按钮三态 + 切片起点", () => {
  test("本地未翻尽 + 无归档 → local,count=本地未挂,slice 藏最老", () => {
    // total 250,visible 100 → 150 未挂;无归档。
    const p = planLoadMore({
      total: 250,
      visible: 100,
      archivedLoadedRows: 0,
      archivedLoadedAnchors: 0,
      archivedCount: 0,
    });
    expect(p.button).toEqual({ mode: "local", count: 150 });
    expect(p.sliceStart).toBe(150);
  });

  test("本地未翻尽 + 有归档未拉 → local,count 含归档未拉(§4 计数含归档数)", () => {
    // 150 本地未挂 + 500 归档未拉 = 650。
    const p = planLoadMore({
      total: 250,
      visible: 100,
      archivedLoadedRows: 0,
      archivedLoadedAnchors: 0,
      archivedCount: 500,
    });
    expect(p.button).toEqual({ mode: "local", count: 650 });
    expect(p.sliceStart).toBe(150);
  });

  test("本地翻尽 + 有归档未拉 → cloud,remaining=归档未拉,slice=0(全挂)", () => {
    // visible ≥ total → 本地翻尽;归档 500 条一条未拉。
    const p = planLoadMore({
      total: 250,
      visible: 300,
      archivedLoadedRows: 0,
      archivedLoadedAnchors: 0,
      archivedCount: 500,
    });
    expect(p.button).toEqual({ mode: "cloud", remaining: 500 });
    expect(p.sliceStart).toBe(0);
  });

  test("本地翻尽 + 无归档 → null(无更早历史)", () => {
    const p = planLoadMore({
      total: 250,
      visible: 300,
      archivedLoadedRows: 0,
      archivedLoadedAnchors: 0,
      archivedCount: 0,
    });
    expect(p.button).toBeNull();
    expect(p.sliceStart).toBe(0);
  });

  test("拉一页归档后不变态:total 与 archivedLoaded 同增 → 仍 cloud、slice 仍 0(刚拉回的行不被再藏)", () => {
    // 拉回 100 条:total 250→350,archivedLoaded 0→100,visible 不变 300。
    const p = planLoadMore({
      total: 350,
      visible: 300,
      archivedLoadedRows: 100,
      archivedLoadedAnchors: 100,
      archivedCount: 500,
    });
    expect(p.sliceStart).toBe(0); // 差 (350-100)=250 ≤ visible 300 → 全挂,含刚拉回的 100
    expect(p.button).toEqual({ mode: "cloud", remaining: 400 }); // 500-100 已拉
  });

  test("归档全部拉尽 → null", () => {
    const p = planLoadMore({
      total: 750,
      visible: 800,
      archivedLoadedRows: 500,
      archivedLoadedAnchors: 500,
      archivedCount: 500,
    });
    expect(p.button).toBeNull();
    expect(p.sliceStart).toBe(0);
  });

  test("tape 展开行数与 anchor 数分离:窗口保留全部展开行,remaining 仅扣 distinct anchor", () => {
    // 尾巴 3 行 + 已加载的 2 个 archive anchors 展开成 120 条可见行。
    const p = planLoadMore({
      total: 123,
      visible: 100,
      archivedLoadedRows: 120,
      archivedLoadedAnchors: 2,
      archivedCount: 10,
    });
    expect(p.sliceStart).toBe(0);
    expect(p.button).toEqual({ mode: "cloud", remaining: 8 });
  });
});
