import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolLike } from "./format";
import { researchToolCard } from "./researchCards";

afterEach(cleanup);

const LIT_JSON = JSON.stringify({
  sources: [
    {
      id: "s1",
      title: "Attention Is All You Need",
      authors: [{ name: "Vaswani" }, { name: "Shazeer" }],
      year: 2017,
      venue: "NeurIPS",
      doi: "10.5555/abc",
      citationCount: 99999,
      oa: { isOA: true, url: "https://arxiv.org/pdf/1706.03762" },
    },
    { id: "s2", title: "已撤稿的研究", authors: [], retracted: true },
  ],
  warnings: ["crossref 暂不可用"],
});

function tool(partial: Partial<ToolLike>): ToolLike {
  return { output: undefined, error: false, ...partial } as ToolLike;
}

describe("researchToolCard 分派", () => {
  test("oc-lit + 合法输出 → 文献检索卡(标题/撤稿/OA/被引/warnings)", () => {
    const node = researchToolCard('oc-lit search "transformer"', tool({ output: LIT_JSON }));
    expect(node).not.toBeNull();
    render(<div>{node}</div>);
    expect(screen.getByText("文献检索")).toBeInTheDocument();
    expect(screen.getByText("2 篇")).toBeInTheDocument();
    expect(screen.getByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText("已撤稿")).toBeInTheDocument();
    expect(screen.getByText("开放获取")).toBeInTheDocument();
    expect(screen.getByText("被引 99999")).toBeInTheDocument();
    expect(screen.getByText(/crossref 暂不可用/)).toBeInTheDocument();
  });

  test("env 前缀 / 绝对路径命令仍命中", () => {
    expect(researchToolCard("FOO=1 oc-lit snowball 10.x", tool({ output: LIT_JSON }))).not.toBeNull();
    expect(researchToolCard("/usr/local/bin/oc-lit search x", tool({ output: LIT_JSON }))).not.toBeNull();
  });

  test("非 oc 工具 → null(回落通用 Bash)", () => {
    expect(researchToolCard("ls -la", tool({ output: LIT_JSON }))).toBeNull();
    expect(researchToolCard("echo oc-lit", tool({ output: LIT_JSON }))).toBeNull();
  });

  test("出错的调用 → null(让用户看到错误)", () => {
    expect(researchToolCard('oc-lit search "x"', tool({ output: LIT_JSON, error: true }))).toBeNull();
  });

  test("输出非 JSON / 空 → null", () => {
    expect(researchToolCard('oc-lit search "x"', tool({ output: "command not found" }))).toBeNull();
    expect(researchToolCard('oc-lit search "x"', tool({ output: undefined }))).toBeNull();
  });

  test("前导日志 + 尾随 JSON 也能宽松解析", () => {
    const noisy = `[info] searching...\n${LIT_JSON}`;
    expect(researchToolCard('oc-lit search "x"', tool({ output: noisy }))).not.toBeNull();
  });
});

describe("其余 oc-* 卡片", () => {
  test("oc-cite verify → 引用核验卡(已接地/未命中/撤稿)", () => {
    const out = JSON.stringify({
      verdicts: [
        { identifier: "doi:10.x", resolved: true, retracted: false, gbt7714: "张三. 标题[J]. 2020." },
        { identifier: "doi:10.bad", resolved: false, retracted: null },
        { identifier: "doi:10.ret", resolved: true, retracted: true },
      ],
    });
    render(<div>{researchToolCard("oc-cite verify doi:10.x", tool({ output: out }))}</div>);
    expect(screen.getByText("引用核验")).toBeInTheDocument();
    expect(screen.getByText("未命中可信记录")).toBeInTheDocument();
    expect(screen.getByText("已撤稿")).toBeInTheDocument();
  });

  test("oc-cite check → 接地校验卡(verified/unsupported + 原文)", () => {
    const out = JSON.stringify({
      claims: [
        { id: "c1", text: "X 提升了 5%", status: "verified", supports: [{ quoteId: "q1" }] },
        { id: "c2", text: "Y 是最好的", status: "unsupported" },
      ],
      quotes: [{ id: "q1", text: "实验显示 X 提升 5%" }],
    });
    render(<div>{researchToolCard("oc-cite check --manifest m.json", tool({ output: out }))}</div>);
    expect(screen.getByText("引用接地校验")).toBeInTheDocument();
    expect(screen.getByText("未支撑")).toBeInTheDocument();
    expect(screen.getByText(/实验显示 X 提升 5%/)).toBeInTheDocument();
  });

  test("oc-ingest → 入库卡 + needsOcr 警告", () => {
    render(
      <div>
        {researchToolCard(
          "oc-ingest parse f.pdf",
          tool({ output: JSON.stringify({ docId: "doc_abc", title: "论文", lang: "zh", spanCount: 42 }) }),
        )}
      </div>,
    );
    expect(screen.getByText("文档已入库")).toBeInTheDocument();
    expect(screen.getByText("doc_abc")).toBeInTheDocument();
    cleanup();
    render(
      <div>
        {researchToolCard(
          "oc-ingest parse scan.pdf",
          tool({ output: JSON.stringify({ needsOcr: true, reason: "无文本层" }) }),
        )}
      </div>,
    );
    expect(screen.getByText(/需要 OCR/)).toBeInTheDocument();
  });

  test("oc-litrag → 片段卡", () => {
    const out = JSON.stringify({ quotes: [{ id: "q1", text: "关键原文片段", sourceId: "doc_x" }], missing: [] });
    render(<div>{researchToolCard('oc-litrag query "问题" --docs doc_x', tool({ output: out }))}</div>);
    expect(screen.getByText("原文片段定位")).toBeInTheDocument();
    expect(screen.getByText(/关键原文片段/)).toBeInTheDocument();
  });

  test("oc-report → 产物卡(参考文献数 + 红标)", () => {
    const out = JSON.stringify({ output: "/tmp/report.pdf", references: 12, warnings: ["第3段未接地"] });
    render(<div>{researchToolCard("oc-report --schema s --manifest m", tool({ output: out }))}</div>);
    expect(screen.getByText("报告已生成")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText(/未接地\/红标/)).toBeInTheDocument();
  });

  test("oc-rank → 排名卡(Elo)", () => {
    const out = JSON.stringify({ ranked: [{ id: "方案A", rating: 1532.7, wins: 3, losses: 1, draws: 0 }] });
    render(<div>{researchToolCard("oc-rank elo --matches m.json", tool({ output: out }))}</div>);
    expect(screen.getByText("候选排名")).toBeInTheDocument();
    expect(screen.getByText("Elo 1533")).toBeInTheDocument();
  });

  test("oc-docx → 文档卡(从命令解析文件名,无需 JSON 输出)", () => {
    render(<div>{researchToolCard("oc-docx report.md -o /home/agent/x.docx", tool({ output: "[pandoc] ok" }))}</div>);
    expect(screen.getByText("Word 文档已生成")).toBeInTheDocument();
    expect(screen.getByText("x.docx")).toBeInTheDocument();
  });

  test("oc-market search → 技能市场卡(数组输出)", () => {
    const out = JSON.stringify([
      { slug: "research-assistant", name: "科研助手", kind: "agent", description: "端到端科研" },
      { slug: "pptx", name: "PPTX", kind: "skill", description: "做幻灯" },
    ]);
    render(<div>{researchToolCard("oc-market search 科研", tool({ output: out }))}</div>);
    expect(screen.getByText("技能市场")).toBeInTheDocument();
    expect(screen.getByText("科研助手")).toBeInTheDocument();
    expect(screen.getByText("智能体")).toBeInTheDocument();
  });

  test("oc-market install(非 list 输出)→ null 回落", () => {
    expect(researchToolCard("oc-market install x", tool({ output: '{"ok":true}' }))).toBeNull();
  });

  test("畸形数组([null]/基本类型项)不崩,被过滤", () => {
    // sources/verdicts/ranked/results 里混 null 或基本类型 —— 渲染不得抛。
    const bad = (cmd: string, out: string) =>
      expect(() => render(<div>{researchToolCard(cmd, tool({ output: out }))}</div>)).not.toThrow();
    bad('oc-lit search "x"', '{"sources":[null,1,{"title":"真的"}],"warnings":[]}');
    bad("oc-cite verify x", '{"verdicts":[null,{"identifier":"doi:1","resolved":true}]}');
    bad("oc-cite check m", '{"claims":[null,{"text":"c","status":"verified"}],"quotes":[null]}');
    bad("oc-rank elo m", '{"ranked":[null,{"id":"a","rating":1500}]}');
    bad("oc-market search x", "[null, 7, {\"name\":\"X\",\"kind\":\"skill\"}]");
    bad('oc-litrag query "q" --docs d', '{"quotes":[null,{"text":"片段"}],"missing":[]}');
    // 嵌套畸形:authors 非数组 / 元素是裸字符串。
    bad('oc-lit search "x"', '{"sources":[{"title":"a","authors":"坏数据"}]}');
    bad('oc-lit search "x"', '{"sources":[{"title":"b","authors":["张三",null,{"name":"李四"}]}]}');
    cleanup();
    // 过滤后仍能渲染有效项。
    render(<div>{researchToolCard('oc-lit search "x"', tool({ output: '{"sources":[null,{"title":"真的"}]}' }))}</div>);
    expect(screen.getByText("真的")).toBeInTheDocument();
  });
});

describe("渐进披露:截断输出仍渲染已加载条目", () => {
  test("文献检索:尾部半截对象被丢,前面完整的渲出 + 标注部分加载", () => {
    // 第 3 条被截断(模拟 preview slice 后追加 …);前 2 条完整。
    const truncated =
      '{"sources":[{"id":"s1","title":"Paper One","authors":[{"name":"A"}]},' +
      '{"id":"s2","title":"Paper Two","authors":[{"name":"B"}]},' +
      '{"id":"s3","title":"Paper Thr…';
    const node = researchToolCard('oc-lit search "x"', tool({ output: truncated }));
    expect(node).not.toBeNull();
    render(<div>{node}</div>);
    expect(screen.getByText("Paper One")).toBeInTheDocument();
    expect(screen.getByText("Paper Two")).toBeInTheDocument();
    expect(screen.queryByText("Paper Thr")).toBeNull(); // 半截的不渲染
    expect(screen.getByText("已加载 2 篇")).toBeInTheDocument();
    expect(screen.getByText(/仅展示已加载的前 2 条/)).toBeInTheDocument();
  });

  test("扫描器字符串感知:字符串内的 } { 不破坏对象边界", () => {
    const truncated =
      '{"sources":[{"id":"s1","title":"a } { tricky \\" brace"},{"id":"s2","title":"second"},{"id":"s3","tit';
    render(<div>{researchToolCard('oc-lit search "x"', tool({ output: truncated }))}</div>);
    expect(screen.getByText("a } { tricky \" brace")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.getByText("已加载 2 篇")).toBeInTheDocument();
  });

  test("引用核验:verdicts 截断也走部分加载", () => {
    const truncated =
      '{"verdicts":[{"identifier":"doi:10.a","resolved":true,"gbt7714":"甲. 一[J]. 2020."},' +
      '{"identifier":"doi:10.b","resolved":false},{"identifier":"doi:10.c","reso';
    render(<div>{researchToolCard("oc-cite verify doi:10.a", tool({ output: truncated }))}</div>);
    expect(screen.getByText("引用核验")).toBeInTheDocument();
    expect(screen.getByText(/仅展示已加载的前 2 条/)).toBeInTheDocument();
  });

  test("连第一条都没完整 → null 回落(让通用 Bash 显示原始)", () => {
    const truncated = '{"sources":[{"id":"s1","title":"only partial obj no close';
    expect(researchToolCard('oc-lit search "x"', tool({ output: truncated }))).toBeNull();
  });

  test("未截断输出不显示部分加载提示", () => {
    render(<div>{researchToolCard('oc-lit search "x"', tool({ output: LIT_JSON }))}</div>);
    expect(screen.queryByText(/仅展示已加载的前/)).toBeNull();
    expect(screen.getByText("2 篇")).toBeInTheDocument();
  });
});
