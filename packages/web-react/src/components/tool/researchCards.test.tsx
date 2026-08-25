import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MediaSignProvider } from "../chat/media";
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
  return { output: undefined, error: false, _completed: true, ...partial } as ToolLike;
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
    expect(
      researchToolCard("FOO=1 oc-lit snowball 10.x", tool({ output: LIT_JSON })),
    ).not.toBeNull();
    expect(
      researchToolCard("/usr/local/bin/oc-lit search x", tool({ output: LIT_JSON })),
    ).not.toBeNull();
  });

  test("非 oc 工具 → null(回落通用 Bash)", () => {
    expect(researchToolCard("ls -la", tool({ output: LIT_JSON }))).toBeNull();
    expect(researchToolCard("echo oc-lit", tool({ output: LIT_JSON }))).toBeNull();
  });

  test("出错的调用 → 通用错误正文(danger,外层状态由 ToolCard 统一承载)", () => {
    const node = researchToolCard(
      'oc-lit search "x"',
      tool({ output: "boom: quota exceeded", error: true }),
    );
    expect(node).not.toBeNull();
    const { container } = render(<div>{node}</div>);
    expect(screen.getByText("boom: quota exceeded")).toHaveClass("text-danger");
    // 命令本身不出现在语义正文内。
    expect(container.textContent).not.toContain("oc-lit search");
    expect(container.textContent).not.toContain("$ ");
  });

  test("输出非 JSON / 空 → 友好正文兜底(不回落裸终端,不泄漏命令)", () => {
    const n1 = researchToolCard('oc-lit search "x"', tool({ output: "command not found" }));
    expect(n1).not.toBeNull();
    const { container } = render(<div>{n1}</div>);
    expect(screen.getByText("command not found")).toBeInTheDocument();
    expect(container.textContent).not.toContain("oc-lit search");
    cleanup();
    const n2 = researchToolCard('oc-lit search "x"', tool({ output: undefined }));
    expect(n2).not.toBeNull();
    render(<div>{n2}</div>);
    expect(screen.getByText("操作已完成。")).toBeInTheDocument();
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
        {
          identifier: "doi:10.x",
          resolved: true,
          retracted: false,
          gbt7714: "张三. 标题[J]. 2020.",
        },
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

  test("oc-cite format → 引用格式化卡(record + 可复制引用串)", () => {
    const out = JSON.stringify({
      verdict: {
        identifier: "doi:10.1093/nsr/nwx110",
        resolved: true,
        retracted: null,
        record: {
          title: "Deep learning for NLP",
          authors: [{ name: "Hang Li" }],
          year: 2017,
          venue: "NSR",
          doi: "10.1093/nsr/nwx110",
        },
        bibtex: "@article{li2017, title={Deep learning for NLP}}",
      },
    });
    render(
      <div>
        {researchToolCard(
          "oc-cite format 10.1093/nsr/nwx110 --style bibtex",
          tool({ output: out }),
        )}
      </div>,
    );
    expect(screen.getByText("引用格式化")).toBeInTheDocument();
    expect(screen.getByText("Deep learning for NLP")).toBeInTheDocument();
    expect(screen.getByText("已接地")).toBeInTheDocument();
    expect(screen.getByText(/@article\{li2017/)).toBeInTheDocument(); // 格式化引用串可见
  });

  test("oc-cite check/fix → claims/quotes 嵌在 manifest 下也能渲染", () => {
    const out = JSON.stringify({
      manifest: {
        sources: [],
        quotes: [{ id: "q1", text: "原文证据片段" }],
        claims: [{ id: "c1", text: "断言一", status: "verified", supports: [{ quoteId: "q1" }] }],
        coverage: { verifiedClaims: 1, totalClaims: 1 },
      },
    });
    render(
      <div>
        {researchToolCard("oc-cite fix --manifest m.json --docs d", tool({ output: out }))}
      </div>,
    );
    expect(screen.getByText("引用接地校验")).toBeInTheDocument();
    expect(screen.getByText("断言一")).toBeInTheDocument();
    expect(screen.getByText(/原文证据片段/)).toBeInTheDocument();
    expect(screen.getByText(/1 已接地/)).toBeInTheDocument(); // 用 coverage
  });

  test("oc-ingest → 入库卡 + needsOcr 警告", () => {
    render(
      <div>
        {researchToolCard(
          "oc-ingest parse f.pdf",
          tool({
            output: JSON.stringify({ docId: "doc_abc", title: "论文", lang: "zh", spanCount: 42 }),
          }),
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
    const out = JSON.stringify({
      quotes: [{ id: "q1", text: "关键原文片段", sourceId: "doc_x" }],
      missing: [],
    });
    render(
      <div>{researchToolCard('oc-litrag query "问题" --docs doc_x', tool({ output: out }))}</div>,
    );
    expect(screen.getByText("原文片段定位")).toBeInTheDocument();
    expect(screen.getByText(/关键原文片段/)).toBeInTheDocument();
  });

  test("oc-report → 产物卡(参考文献数 + 红标 + 下载)", () => {
    const out = JSON.stringify({
      output: "/tmp/report.pdf",
      references: 12,
      warnings: ["第3段未接地"],
    });
    render(
      <div>{researchToolCard("oc-report --schema s --manifest m", tool({ output: out }))}</div>,
    );
    expect(screen.getByText("报告已生成")).toBeInTheDocument();
    // 标题副标 + 下载卡都会显示文件名 → 至少出现一次(下载入口存在)。
    expect(screen.getAllByText("report.pdf").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/未接地\/红标/)).toBeInTheDocument();
  });

  test("oc-report → 引用接地详情区(manifest sidecar + coverage 徽章,默认折叠不取数)", () => {
    const out = JSON.stringify({
      output: "/tmp/report.pdf",
      manifestPath: "/tmp/report.manifest.json",
      coverage: { verifiedClaims: 1, totalClaims: 2 },
      references: 3,
      warnings: [],
    });
    render(
      <div>{researchToolCard("oc-report --schema s --manifest m", tool({ output: out }))}</div>,
    );
    expect(screen.getByText("引用接地详情")).toBeInTheDocument();
    expect(screen.getByText("接地 1/2")).toBeInTheDocument();
  });

  test("oc-report 引用接地详情:拒绝恶意 manifestPath scheme(不渲染详情区)", () => {
    const out = JSON.stringify({
      output: "/tmp/report.pdf",
      manifestPath: "javascript:alert(1)//m.json",
    });
    render(
      <div>{researchToolCard("oc-report --schema s --manifest m", tool({ output: out }))}</div>,
    );
    expect(screen.getByText("报告已生成")).toBeInTheDocument();
    expect(screen.queryByText("引用接地详情")).toBeNull();
  });

  test("oc-report 产物卡:拒绝恶意 output scheme(不产出可点 href)", () => {
    const out = JSON.stringify({ output: "javascript:alert(1)//.pdf" });
    const { container } = render(
      <div>{researchToolCard("oc-report --schema s", tool({ output: out }))}</div>,
    );
    expect(screen.getByText("报告已生成")).toBeInTheDocument(); // 卡仍渲染
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull(); // 无 javascript href
    expect(container.querySelector("a")).toBeNull(); // 不安全 src → 不渲染下载/预览链接
  });

  test("oc-rank → 排名卡(Elo)", () => {
    const out = JSON.stringify({
      ranked: [{ id: "方案A", rating: 1532.7, wins: 3, losses: 1, draws: 0 }],
    });
    render(<div>{researchToolCard("oc-rank elo --matches m.json", tool({ output: out }))}</div>);
    expect(screen.getByText("候选排名")).toBeInTheDocument();
    expect(screen.getByText("Elo 1533")).toBeInTheDocument();
  });

  test("oc-docx → 文档卡(从命令解析文件名,无需 JSON 输出;绝对路径 → 下载卡)", () => {
    render(
      <div>
        {researchToolCard(
          "oc-docx report.md -o /home/agent/x.docx",
          tool({ output: "[pandoc] ok" }),
        )}
      </div>,
    );
    expect(screen.getByText("Word 文档已生成")).toBeInTheDocument();
    // 标题副标 + 签名下载卡都显示文件名 → 至少出现一次(下载入口存在)。
    expect(screen.getAllByText("x.docx").length).toBeGreaterThanOrEqual(2);
  });

  test("oc-docx render → 逐页质检卡,不把输出目录误报成 DOCX", () => {
    render(
      <div>
        {researchToolCard(
          "oc-docx render /home/agent/x.docx -o /home/agent/.openclaude/generated/x-qa",
          tool({ output: '{"pages":["page-1.png"]}' }),
        )}
      </div>,
    );
    expect(screen.getByText("Word 页面已渲染")).toBeInTheDocument();
    expect(screen.queryByText("Word 文档已生成")).toBeNull();
  });

  test("oc-docx inspect/scrub → 分别显示结构检查与清理后的 DOCX 卡", () => {
    const { rerender } = render(
      <div>
        {researchToolCard(
          "oc-docx inspect /home/agent/x.docx",
          tool({ output: '{"zip_integrity_ok":true}' }),
        )}
      </div>,
    );
    expect(screen.getByText("Word 结构检查完成")).toBeInTheDocument();

    rerender(
      <div>
        {researchToolCard(
          "oc-docx scrub /home/agent/x.docx -o /home/agent/.openclaude/generated/x-clean.docx --keep-title",
          tool({ output: "/home/agent/.openclaude/generated/x-clean.docx" }),
        )}
      </div>,
    );
    expect(screen.getByText("Word 文档已清理")).toBeInTheDocument();
    expect(screen.getAllByText("x-clean.docx").length).toBeGreaterThanOrEqual(2);
  });

  test("oc-pdf 绝对路径 -o → 产物卡 + 签名下载/预览链接(与 oc-report 体验对齐)", async () => {
    const sign = async (paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, `/api/media?sig=x&path=${encodeURIComponent(p)}`]));
    const { container } = render(
      <MediaSignProvider sign={sign}>
        {researchToolCard(
          "oc-pdf paper.qmd -o /home/agent/out/paper.pdf",
          tool({ output: "[quarto] Output created: paper.pdf" }),
        )}
      </MediaSignProvider>,
    );
    expect(screen.getByText("PDF 文档已生成")).toBeInTheDocument();
    expect(screen.getAllByText("paper.pdf").length).toBeGreaterThanOrEqual(1);
    // 签名解析完成后出现真正可点的下载 <a download> 与「预览」链接(pdf 可预览)。
    await waitFor(() => expect(container.querySelector("a[download]")).not.toBeNull());
    expect(screen.getByText("预览")).toBeInTheDocument();
  });

  test("oc-xlsx 相对路径 → 退回提示文案(无任何可点链接)", () => {
    const { container } = render(
      <div>
        {researchToolCard(
          "oc-xlsx build data.json -o 结果.xlsx",
          tool({ output: "[oc-xlsx] wrote 结果.xlsx" }),
        )}
      </div>,
    );
    expect(screen.getByText("Excel 表格已生成")).toBeInTheDocument();
    expect(screen.getByText("结果.xlsx")).toBeInTheDocument(); // 副标仍显示文件名
    expect(screen.getByText(/可在文件区下载/)).toBeInTheDocument();
    expect(container.querySelector("a")).toBeNull();
  });

  test("oc-pdf 恶意 scheme 输出路径 → 不产生可点 href", () => {
    const { container } = render(
      <div>
        {researchToolCard("oc-pdf x.qmd -o javascript:alert(1)//x.pdf", tool({ output: "ok" }))}
      </div>,
    );
    expect(screen.getByText("PDF 文档已生成")).toBeInTheDocument(); // 卡仍渲染
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector("a")).toBeNull(); // 不安全 src → 无下载/预览链接
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

  test("oc-market install(非 list 输出)→ 动作化市场反馈(不泄漏命令)", () => {
    const node = researchToolCard("oc-market install x", tool({ output: '{"ok":true}' }));
    expect(node).not.toBeNull();
    const { container } = render(<div>{node}</div>);
    expect(screen.getByText("安装市场能力")).toBeInTheDocument();
    expect(screen.getByText("已完成对「x」的操作。")).toBeInTheDocument();
    expect(container.textContent).not.toContain("oc-market install");
  });

  test("畸形数组([null]/基本类型项)不崩,被过滤", () => {
    // sources/verdicts/ranked/results 里混 null 或基本类型 —— 渲染不得抛。
    const bad = (cmd: string, out: string) =>
      expect(() => render(<div>{researchToolCard(cmd, tool({ output: out }))}</div>)).not.toThrow();
    bad('oc-lit search "x"', '{"sources":[null,1,{"title":"真的"}],"warnings":[]}');
    bad("oc-cite verify x", '{"verdicts":[null,{"identifier":"doi:1","resolved":true}]}');
    bad("oc-cite check m", '{"claims":[null,{"text":"c","status":"verified"}],"quotes":[null]}');
    bad("oc-rank elo m", '{"ranked":[null,{"id":"a","rating":1500}]}');
    bad("oc-market search x", '[null, 7, {"name":"X","kind":"skill"}]');
    bad('oc-litrag query "q" --docs d', '{"quotes":[null,{"text":"片段"}],"missing":[]}');
    // 嵌套畸形:authors 非数组 / 元素是裸字符串。
    bad('oc-lit search "x"', '{"sources":[{"title":"a","authors":"坏数据"}]}');
    bad('oc-lit search "x"', '{"sources":[{"title":"b","authors":["张三",null,{"name":"李四"}]}]}');
    cleanup();
    // 过滤后仍能渲染有效项。
    render(
      <div>
        {researchToolCard(
          'oc-lit search "x"',
          tool({ output: '{"sources":[null,{"title":"真的"}]}' }),
        )}
      </div>,
    );
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
    expect(screen.getByText('a } { tricky " brace')).toBeInTheDocument();
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

  test("连第一条都没完整 → 保留已加载文本兜底(不回落裸终端泄漏命令)", () => {
    const truncated = '{"sources":[{"id":"s1","title":"only partial obj no close';
    const node = researchToolCard('oc-lit search "x"', tool({ output: truncated }));
    expect(node).not.toBeNull();
    render(<div>{node}</div>);
    expect(screen.getByText(truncated)).toBeInTheDocument();
  });

  test("未截断输出不显示部分加载提示", () => {
    render(<div>{researchToolCard('oc-lit search "x"', tool({ output: LIT_JSON }))}</div>);
    expect(screen.queryByText(/仅展示已加载的前/)).toBeNull();
    expect(screen.getByText("2 篇")).toBeInTheDocument();
  });
});

describe("兜底反转:oc-* 绝不泄漏原始命令", () => {
  test("未注册 body 的 oc-*(oc-web-context)→ 友好正文兜底,不裸露命令", () => {
    const node = researchToolCard(
      "oc-web-context extract https://x.com",
      tool({ output: "some helper output" }),
    );
    expect(node).not.toBeNull();
    const { container } = render(<div>{node}</div>);
    expect(screen.getByText("some helper output")).toBeInTheDocument();
    expect(container.textContent).not.toContain("oc-web-context extract");
  });

  test("纯 heredoc 写文件里含 oc-* 内容 → null(交回 BashBody 写文件卡,不误判成 CLI)", () => {
    const cmd = "cat > script.sh <<'EOF'\noc-web extract https://example.com\nEOF";
    expect(researchToolCard(cmd, tool({ output: "" }))).toBeNull();
  });

  test("cd && oc-cite(分隔符后)也命中 → 非 null 卡", () => {
    expect(
      researchToolCard(
        "cd /tmp && oc-rank elo --matches m.json",
        tool({ output: '{"ranked":[]}' }),
      ),
    ).not.toBeNull();
  });
});

describe("4 个新专属卡", () => {
  test("oc-vision → 图片理解卡(问题 + 识图结论,无 $ command)", () => {
    const { container } = render(
      <div>
        {researchToolCard(
          "oc-vision understand /home/agent/uploads/x.png --prompt '这是什么'",
          tool({ output: "图中是一只橘猫,背景是沙发。" }),
        )}
      </div>,
    );
    expect(screen.getByText("图片理解")).toBeInTheDocument();
    expect(screen.getByText("这是什么")).toBeInTheDocument();
    expect(screen.getByText(/橘猫/)).toBeInTheDocument();
    expect(container.textContent).not.toContain("oc-vision understand");
  });

  test("oc-memory memory 子命令已退役 → 干净的兜底正文,不裸露命令", () => {
    // 核心记忆改 memdir 文件写入,memory 子命令后端提示 + exit2;前端 MemoryCliCard 返回 null
    // → researchToolCard 兜底 GenericOcCard(OC_TOOLS['oc-memory'] 标签「记忆」),绝不泄漏原始命令。
    const { container } = render(
      <div>
        {researchToolCard(
          "oc-memory memory --action read --target memory",
          tool({ output: "Core 记忆已改为直接编辑文件" }),
        )}
      </div>,
    );
    expect(screen.getByText("Core 记忆已改为直接编辑文件")).toBeInTheDocument();
    expect(container.textContent).not.toContain("oc-memory memory");
    expect(container.textContent).not.toContain("--action");
  });

  test("oc-memory delegate 失败 → 人话超时，不摊 Command/Exit Code", () => {
    const { container } = render(
      <div>
        {researchToolCard(
          "oc-memory delegate --goal '查一下记忆工具'",
          tool({
            error: true,
            output: JSON.stringify({
              command:
                "export HOME=/home/agent OPENCLAUDE_SESSION_KEY=agent:main:x oc-memory delegate --goal x",
              exitCode: 1,
              stderr: "oc-memory: delegate client timeout after 45s",
              stdout: "",
              workingDirectory: "/home/agent",
              signal: null,
            }),
          }),
        )}
      </div>,
    );
    expect(container.textContent).toMatch(/委派还在等待子任务完成/);
    expect(container.textContent).not.toContain("export HOME");
    expect(container.textContent).not.toMatch(
      /Exit Code|exitCode|WorkingDirectory|workingDirectory/i,
    );
    expect(container.textContent).not.toContain("delegate client timeout after 45s");
  });

  test("oc-memory delegate 成功 → stdout markdown，不渲 Cursor 信封字段网格", () => {
    const envelope = JSON.stringify({
      success: {
        command: "oc-memory delegate --goal '修卡片'",
        workingDirectory: "/home/agent",
        exitCode: 0,
        signal: null,
        stdout: "✅ 委派完成 (agent: coding-assistant)\n\n子任务已交付。",
        stderr: "",
        pid: 4242,
        interrupted: false,
        executionTimeMs: 12,
        backgrounded: false,
        isHot: false,
        localExecution: true,
      },
      isBackground: false,
    });
    const { container } = render(
      <div>
        {researchToolCard("oc-memory delegate --goal '修卡片'", tool({ output: envelope }))}
      </div>,
    );
    expect(container.textContent).toMatch(/委派完成 \(agent: coding-assistant\)/);
    expect(container.textContent).toContain("子任务已交付。");
    expect(container.textContent).not.toMatch(/个字段/);
    expect(container.textContent).not.toContain("isBackground");
    expect(container.textContent).not.toContain("export HOME");
  });

  test("oc-memory delegate 信封失败 → stderr 首段，不渲字段网格", () => {
    const envelope = JSON.stringify({
      success: {
        command: "oc-memory delegate --help",
        workingDirectory: "/home/agent",
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr:
          'oc-memory: delegate requires --goal "<text>" (or a positional goal)\nusage: oc-memory delegate ...',
        pid: 7,
        interrupted: false,
      },
      isBackground: false,
    });
    const { container } = render(
      <div>{researchToolCard("oc-memory delegate --help", tool({ output: envelope }))}</div>,
    );
    expect(container.textContent).toContain('oc-memory: delegate requires --goal "<text>"');
    expect(container.textContent).not.toMatch(/个字段/);
    expect(container.textContent).not.toContain("isBackground");
  });

  test("Cursor shell 信封在 GenericOcCard 路径 unwrap 后显示 stdout", () => {
    const envelope = JSON.stringify({
      success: {
        command: "oc-memory memory --action read",
        workingDirectory: "/home/agent",
        exitCode: 0,
        stdout: "Core 记忆已改为直接编辑文件",
        stderr: "",
        signal: null,
        pid: 1,
        interrupted: false,
        executionTimeMs: 3,
        backgrounded: false,
        isHot: false,
        localExecution: true,
      },
      isBackground: false,
    });
    const { container } = render(
      <div>
        {researchToolCard(
          "oc-memory memory --action read --target memory",
          tool({ output: envelope }),
        )}
      </div>,
    );
    expect(container.textContent).toContain("Core 记忆已改为直接编辑文件");
    expect(container.textContent).not.toMatch(/个字段/);
    expect(container.textContent).not.toContain("isBackground");
  });

  test("oc-memory session-search → 历史检索卡(查询 + 结果,不裸露命令)", () => {
    const { container } = render(
      <div>
        {researchToolCard(
          "oc-memory session-search '上次讨论的方案'",
          tool({ output: "1. 2026-07-01 讨论了架构\n2. 2026-07-02 定了方案" }),
        )}
      </div>,
    );
    expect(screen.getByText("历史检索")).toBeInTheDocument();
    expect(screen.getByText("上次讨论的方案")).toBeInTheDocument();
    expect(container.textContent).not.toContain("oc-memory session-search");
  });

  test("oc-minimax image 绝对路径 → 图片生成卡 + 缩略图签名", async () => {
    const sign = async (paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, `/api/media?sig=x&path=${encodeURIComponent(p)}`]));
    const { container } = render(
      <MediaSignProvider sign={sign}>
        {researchToolCard(
          "mmx image generate '一只橘猫' -o /home/agent/out/cat.png",
          tool({ output: "/home/agent/out/cat.png\nbilling: 12 credits-cents" }),
        )}
      </MediaSignProvider>,
    );
    expect(screen.getByText("图片生成")).toBeInTheDocument();
    expect(screen.getByText("一只橘猫")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    // billing 行不外露。
    expect(container.textContent).not.toContain("billing:");
  });

  test("oc-minimax video 未 wait → 任务号提示(无产物)", () => {
    render(
      <div>
        {researchToolCard(
          "mmx video generate -p '海浪'",
          tool({ output: "task_id: abc123\nbilling: 30 credits-cents" }),
        )}
      </div>,
    );
    expect(screen.getByText("视频生成")).toBeInTheDocument();
    expect(screen.getByText(/任务号 abc123/)).toBeInTheDocument();
  });

  test("oc-browser open → 打开网页语义正文(URL 链接,无原始 stdout)", () => {
    const { container } = render(
      <div>
        {researchToolCard(
          "oc-browser open https://example.com",
          tool({ output: "- Ran Playwright code\n- Page snapshot: huge a11y tree ..." }),
        )}
      </div>,
    );
    expect(screen.getByText("打开网页")).toBeInTheDocument();
    expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();
    // open 不展示原始 a11y dump。
    expect(container.textContent).not.toContain("huge a11y tree");
  });

  test("oc-browser screenshot 绝对路径 → 截图缩略图", async () => {
    const sign = async (paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, `/api/media?sig=x&path=${encodeURIComponent(p)}`]));
    const { container } = render(
      <MediaSignProvider sign={sign}>
        {researchToolCard(
          "oc-browser screenshot --filename=/home/agent/shot.png",
          tool({ output: "Saved screenshot" }),
        )}
      </MediaSignProvider>,
    );
    expect(screen.getByText("截图")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  });
});

describe("BrowserCliCard 复合命令 + 失败原因", () => {
  // 官方 Playwright CLI 成功输出形状(open 后的 markdown)。
  const PLAYWRIGHT_OK = [
    "### Ran Playwright code",
    "```js",
    "await page.goto('https://example.com');",
    "```",
    "### Page",
    "- Page URL: https://example.com/",
    "- Page Title: Example Domain",
    "### Snapshot",
    "- generic [ref=e1]: huge a11y tree ...",
  ].join("\n");

  // 官方 CLI 的失败由 Bash 非零退出码标记；正文保留首个 Error 行。
  const BROWSER_ERR = [
    "Error: Browser 'browser' is not open.",
    "Run oc-browser open to start the browser session.",
  ].join("\n");

  test("open && snapshot 复合命令 → 动作序列标题 + 快照折叠", () => {
    const { container } = render(
      <div>
        {researchToolCard(
          "oc-browser open https://example.com && oc-browser snapshot",
          tool({ output: PLAYWRIGHT_OK }),
        )}
      </div>,
    );
    expect(screen.getByText("打开网页 · 页面快照")).toBeInTheDocument();
    expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();
    // 任一 verb 为 snapshot → 快照折叠区可见。
    expect(screen.getByText("查看页面快照")).toBeInTheDocument();
  });

  test("open 成功 → 从输出提取 Page Title 一行标题,其余 markdown 照旧隐藏", () => {
    render(
      <div>
        {researchToolCard("oc-browser open https://example.com", tool({ output: PLAYWRIGHT_OK }))}
      </div>,
    );
    expect(screen.getByText("Example Domain")).toBeInTheDocument();
    // 纯 open 无折叠详情 → 原始 markdown 不进 DOM。
    expect(screen.queryByText(/Ran Playwright code/)).toBeNull();
    expect(screen.queryByText(/huge a11y tree/)).toBeNull();
  });

  test("tool.error → 仍走浏览器专属正文:首个 Error 行 danger + 完整输出折叠", () => {
    render(
      <div>
        {researchToolCard(
          "oc-browser screenshot --filename=/home/agent/.openclaude/generated/tool-card-example.png",
          tool({ output: BROWSER_ERR, error: true }),
        )}
      </div>,
    );
    expect(screen.getByText("截图")).toBeInTheDocument();
    const reason = screen.getAllByText(/^Error: Browser/)[0];
    expect(reason.className).toContain("text-danger");
    expect(reason.textContent).not.toContain("### Error");
    expect(screen.getByText("错误详情")).toBeInTheDocument(); // 完整输出进折叠区
  });

  test("输出含 Error 时即使上层漏标 error 也不给绿色完成", () => {
    render(
      <div>
        {researchToolCard("oc-browser open https://bad.example", tool({ output: BROWSER_ERR }))}
      </div>,
    );
    expect(screen.getAllByText(/^Error: Browser/)[0].className).toContain("text-danger");
  });

  test("非 oc-browser 的失败仍走通用错误正文(不受 error-aware 白名单影响)", () => {
    const node = researchToolCard('oc-lit search "x"', tool({ output: "boom", error: true }));
    render(<div>{node}</div>);
    expect(screen.getByText("boom")).toHaveClass("text-danger");
  });
});
