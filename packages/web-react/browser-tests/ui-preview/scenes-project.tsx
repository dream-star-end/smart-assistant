/**
 * 项目主页场景（OCV5-358）：「项目空间」入口格 + 产出列表 + 产出查看器（Markdown / 图片 / 压缩包详情）。
 * 真组件 + 真 CSS；网络边界只有两处打桩：api（场景表）与媒体签名 —— 签名把资产路径换成
 * data: URL，fetch 对 data: 放行（harness 默认把所有 fetch 兜成 204）。
 */
import type { ReactNode } from "react";
import { MediaSignProvider } from "../../src/components/chat/media";
import { OutputViewer } from "../../src/components/project/OutputViewer";
import { ProjectHome } from "../../src/components/project/ProjectHome";
import { createMemoryAuthSession } from "../../src/lib/authSession";
import type { ChatProject, ProjectAsset, Session } from "../../src/lib/types";
import type { Scene } from "./types";

// 模块求值早于 harness 覆盖 window.fetch，这里拿到的是真 fetch（只用它读 data: URL）。
const realFetch = typeof window !== "undefined" ? window.fetch.bind(window) : undefined;

const auth = createMemoryAuthSession(() => {}, "preview-token");
const now = Date.now();

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

const WEEKLY_MD = `# 第 41 周项目周报

## 本周完成
- 侧栏搜索交互改版，移动端命中区统一到 44px
- 产出页支持直接预览 Markdown、代码、图片与 PDF

## 进行中
- 离线安装包（amd64）体积优化：**1.2 GB → 860 MB**

| 项 | 状态 |
| --- | --- |
| 内网部署手册 | 草稿 |
| 回归测试 | 通过 |

\`\`\`bash
./install.sh --offline --arch amd64
\`\`\`
`;

const MAIN_TS = `import { createServer } from "node:http";

export function start(port = 8080) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  server.listen(port);
  return server;
}
`;

const CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c6cf2"/><stop offset="1" stop-color="#c7befa"/></linearGradient></defs>
<rect width="960" height="600" fill="#f7f7fb"/>
<g fill="url(#g)">${[120, 220, 180, 300, 260, 380, 340, 450]
  .map((h, i) => `<rect x="${80 + i * 105}" y="${540 - h}" width="64" height="${h}" rx="8"/>`)
  .join("")}</g>
<text x="80" y="70" font-family="sans-serif" font-size="32" fill="#1f1f2b">9 月用量</text>
</svg>`;

const DATA: Record<string, string> = {
  "/api/media/weekly": `data:text/markdown;base64,${b64(WEEKLY_MD)}`,
  "/api/media/main": `data:text/plain;base64,${b64(MAIN_TS)}`,
  "/api/media/notes": `data:text/plain;base64,${b64("内网环境：3 台 8C16G，统一走 10.0.0.0/16。\n部署顺序：网关 → 存储 → Web。\n回滚：保留上一版 release 目录。")}`,
  "/api/media/chart": `data:image/svg+xml;base64,${b64(CHART_SVG)}`,
};

function outAsset(over: Partial<ProjectAsset> & Pick<ProjectAsset, "id" | "name">): ProjectAsset {
  return {
    projectId: "p1",
    source: "output",
    sessionId: "s-deploy",
    url: null,
    containerPath: null,
    mime: null,
    sizeBytes: 2048,
    excerpt: null,
    pinned: false,
    createdAt: now - 30 * 60_000,
    updatedAt: now - 30 * 60_000,
    ...over,
  };
}

const OUTPUTS: ProjectAsset[] = [
  outAsset({ id: "zip", name: "v5-offline-all-amd64.zip", url: "/api/media/zip", sizeBytes: 1_210_000_000, versionCount: 3, createdAt: now - 5 * 60_000 }),
  outAsset({ id: "md", name: "第41周项目周报.md", url: "/api/media/weekly", sizeBytes: 1200, sessionId: "s-weekly", createdAt: now - 20 * 60_000 }),
  outAsset({ id: "img", name: "usage-sept.png", url: "/api/media/chart", sizeBytes: 48_000, sessionId: "s-weekly", createdAt: now - 60 * 60_000 }),
  outAsset({ id: "ts", name: "server/main.ts", url: "/api/media/main", sizeBytes: 300, createdAt: now - 2 * 3600_000 }),
  outAsset({ id: "txt", name: "内网部署笔记.txt", url: "/api/media/notes", sizeBytes: 160, createdAt: now - 3 * 3600_000 }),
  outAsset({ id: "pdf", name: "部署手册.pdf", url: "/api/media/pdf", sizeBytes: 2_400_000, createdAt: now - 26 * 3600_000 }),
  outAsset({ id: "xlsx", name: "资源清单.xlsx", url: "/api/media/xlsx", sizeBytes: 38_000, sessionId: null, createdAt: now - 50 * 3600_000 }),
];

const SESSIONS: Session[] = [
  { id: "s-deploy", title: "我准备在我的内网环境部署一套 v5 个人版", ownerUserId: "u", projectId: "p1", lastAt: now - 60_000, updatedAt: new Date(now).toISOString(), messageCount: 12 },
  { id: "s-weekly", title: "生成本周周报", ownerUserId: "u", projectId: "p1", lastAt: now - 36 * 60_000, updatedAt: new Date(now).toISOString(), messageCount: 4 },
  { id: "s-ux", title: "重构 v5 个人版的市场 UI/UX", ownerUserId: "u", projectId: "p1", lastAt: now - 14 * 3600_000, updatedAt: new Date(now).toISOString(), messageCount: 30 },
];

const project: ChatProject = {
  id: "p1",
  name: "test",
  instructions: "中文回答；先给结论再给依据。",
  color: null,
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
  sessionCount: 3,
  boardProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

const sign = async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, DATA[p] ?? p]));

function Media({ children }: { children: ReactNode }) {
  // 渲染期同步换 fetch：子组件 effect 先于任何父级 effect 运行，这里必须在挂载前就绪。
  if (realFetch) {
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("data:")) return realFetch(url, { signal: init?.signal });
      return new Response(null, { status: 204 });
    };
  }
  return (
    <MediaSignProvider sign={sign} authKey="preview">
      {children}
    </MediaSignProvider>
  );
}

const noop = () => {};
const API = {
  listProjectAssets: async () => OUTPUTS,
  listCron: async () => [],
  listProjectAssetVersions: async () => [OUTPUTS[0]],
};

function Home({ tab }: { tab: "overview" | "outputs" }) {
  return (
    <Media>
      <div className="h-screen">
        <ProjectHome
          project={project}
          tab={tab}
          onTabChange={noop}
          sessions={SESSIONS}
          demo={false}
          auth={auth}
          authSession={auth}
          onStart={noop}
          onNewSession={noop}
          onOpenSession={noop}
          onOpenSettings={noop}
          onRename={noop}
          onDelete={noop}
          onOpenMobileNav={noop}
          onPrepareBoard={async () => true}
          onShowSurface={noop}
        />
      </div>
    </Media>
  );
}

function Viewer({ id }: { id: string }) {
  const asset = OUTPUTS.find((a) => a.id === id)!;
  const title = SESSIONS.find((s) => s.id === asset.sessionId)?.title;
  return (
    <Media>
      <OutputViewer asset={asset} sourceTitle={title} onClose={noop} onOpenSession={noop} onShowVersions={noop} />
    </Media>
  );
}

const both: Scene["viewports"] = ["desktop", "mobile"];

export const projectScenes: Scene[] = [
  { id: "project-home-overview", label: "项目主页 · 概览（项目空间入口）", group: "工作区", viewports: both, api: API, render: () => <Home tab="overview" /> },
  { id: "project-home-outputs", label: "项目主页 · 产出列表", group: "工作区", viewports: both, api: API, render: () => <Home tab="outputs" /> },
  { id: "project-output-viewer-md", label: "产出查看器 · Markdown", group: "工作区", viewports: both, api: API, render: () => <Viewer id="md" /> },
  { id: "project-output-viewer-code", label: "产出查看器 · 代码", group: "工作区", viewports: both, api: API, render: () => <Viewer id="ts" /> },
  { id: "project-output-viewer-image", label: "产出查看器 · 图片", group: "工作区", viewports: both, api: API, render: () => <Viewer id="img" /> },
  { id: "project-output-viewer-zip", label: "产出查看器 · 压缩包详情", group: "工作区", viewports: both, api: API, render: () => <Viewer id="zip" /> },
];
