# Aurora Windows design QA（app-shell scope）

final result: passed

范围声明：**本文件的 passed 只覆盖本地可信 shell**（44px app bar、下载/离线 modal、WCO 合同、token）。  
整机对照 Codex 三栏主界面 / 设置页 = `pending web PR`，见 `CODEX_DESKTOP_REWRITE.md` §0 与 §6。不得把下面的 fixture 截图解释成「已经达到 Codex 桌面主界面」。

## Evidence

参考图（用户提供，含生产会话，**不入库**）：

1. 聊天模式三栏：`/Users/dengxuan/.cursor/projects/Users-dengxuan-git-project-openclaude-v3/assets/image-c48a28ef-fd72-4c3f-82f8-afc5a7ba5ea7.png`
2. 文件审阅模式：`/Users/dengxuan/.cursor/projects/Users-dengxuan-git-project-openclaude-v3/assets/image-f0402cd5-6c16-49c1-a125-2b6b04ef1e1a.png`
3. 设置页：`/Users/dengxuan/.cursor/projects/Users-dengxuan-git-project-openclaude-v3/assets/image-237b325c-a3d5-4f71-bebf-40da07bb134d.png`

本轮无账号 fixture：

- `/tmp/aurora-windows.png` — 1280×800，light，下载 modal 打开、product 隐藏
- `/tmp/aurora-windows-toolbar.png` — 1280×44 shell WebContents
- `/tmp/aurora-windows-product.png` — 1280×756 隔离 fixture，不是 V5 产品 UI

macOS smoke 不能启用 WCO；`overlayActive=false`。未截取生产账号。

## Comparison（区域标注）

| 区域 | 对照参考图 | 结论 |
| --- | --- | --- |
| 窗口 chrome / 非浏览器壳 | 内容顶到上沿、无地址栏 | **有差距**：本机仍是系统标题栏叠 44px app bar（WCO 仅 win32）。有意保留 skill 规定的 app bar。 |
| App bar 密度 / hairline / 浅色 | 细线、白底、克制操作 | **已达成（shell）**：Aurora 品牌 + 下载 + More；无后退/前进/刷新。 |
| 下载表面 | Codex 无对等「本机下载抽屉」 | **已达成（shell 自有表面）**：右抽屉、空状态、路径不进 renderer。不是 Codex 抄袭，是 Windows 本机文件职责。 |
| 离线恢复 | 参考图无此态 | **已达成**：居中卡片；已去掉假 220px 侧栏色条。 |
| 左会话栏 / 项目分组 / 底栏账号 | 图 1–2 左栏 | **需要 server-web PR** |
| 中栏消息 / 工具卡 / 输入区 | 图 1–2 中栏 | **需要 server-web PR** |
| 右上下文卡 / 文件树 | 图 1 浮层 vs 图 2 文件树 | **需要 server-web PR** |
| 设置左导航 + 行式控件 | 图 3 | **需要 server-web PR** |

## P0 / P1 / P2（仅 shell）

- P0: 无
- P1: 无（macOS 双层标题栏是平台限制，不在本机修）
- P2: 下载抽屉视觉权重高于 Codex 的「几乎无 chrome」；Windows 真机 WCO 合入后应再截一次 app bar 与 caption 对齐

Windows 10/11 Narrator、高对比、100–200% 缩放、Snap、Alt 菜单焦点、安装后 toast、跨屏 WCO 仍是发布/RDP 门，不是本文件的 passed 含义。

## Verification

- `npm --prefix apps/windows run check` — 78 tests, 0 fail
- dual-view `--smoke-test`：`sendInputEvent`、F6、modal hide/restore、下载焦点、indeterminate、forced-colors、520×360、1366×768、未就绪 overlay 140px 预留、resize 后 chrome 合同
