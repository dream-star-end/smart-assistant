# Plan v2: v3 能力型 MCP 收敛为 skill+CLI(scansci / web-context;browser→daemon)

## 范围(boss 已定)
- **转**:`scansci-pdf`(22 工具)、`web-context`(3 工具)→ 退出常驻 MCP,改 skill 文档化的 CLI。
- **browser**(7 工具)→ 有状态 daemon + 瘦 CLI。
- **不动**:`openclaude-vision`(嵌得最深、转了不省上下文,保留 MCP)、`openclaude-memory`(14 控制面/加载器,保留 MCP)。

## 关键事实(已核实,塑造本方案)
1. 容器单租户、Bash 全开、`bypassPermissions`;`scansci-pdf` 二进制已在 PATH,模型今天就能直调 → **不存在"靠 MCP 不暴露"的安全边界**。
2. grep 确认**无任何按套餐/按用户的能力安全门禁**(`agentToolsets = agent.toolsets ?? defaults`,只按 agent 角色)。→ 故**不建 entitlement 强制系统**(防不存在的威胁=过度工程)。gating 退化为 **skill seed 范围**(决定哪个 teammate 看见某能力,纯 UX/上下文)。
3. web-context 的编排+安全(`webContextSafety.ts`:SSRF/DNS/重定向/压缩后体积/并发/输出 cap + path allowlist)在 `mcpWebContextServer.ts`;`extractUrl/parseFile/healthCheck` 当前是 **未 export 的 `async function`**(Codex 纠正,我原写"已 export"是错的)→ 第一步**先 export** 这三个函数,MCP handler 与新 CLI main **共用同一份**,零安全重写。`oc-web-context` 是底层 python parser,不含编排安全。
4. web-context 也由 **Codex 路径**(`codexLaunchOverrides.ts:162/181`)引用 parser helper;promptSlots(`:82/155-157`)主动指挥模型调 `web_context_*`。两处必须同步迁移。
5. vision 不动 → 不触碰 proxy 图剥离契约 / promptSlots vision 槽 / codexLaunchOverrides vision 注入 / 微信图链路。**迁移面因此大幅缩小。**

## 设计
### A. scansci-pdf → skill-only
- 删除 `entrypoint.ts` 的 `cloneScanSciPdfMcpServer` 注入 + `research` toolset 里的 scansci。
- 新增 **research skill**,文档化已存在的 `scansci-pdf` 子命令(search/download/batch/citation/zotero/vpnsci 等),并提示敏感 `config get` 含凭据、按需谨慎用。
- 不做 `oc pdf` 包装层(scansci-pdf 是成熟 CLI,thin passthrough=无价值的转发;skill 直接引用)。
- **迁移 `paperIntentHint.ts:21`**(Codex 补):现提示"若当前工具列表含 `scansci_pdf_*` 工具"→ 改为"优先按 research skill 用 `scansci-pdf` CLI",否则模型会被引向 WebSearch/WebFetch,削弱可发现性。

### B. web-context → `oc-web` CLI(复用已 export 的 core)
- 在 `mcpWebContextServer.ts` 同模块加 CLI main:`oc-web extract <url> [--json] [--max-chars]` / `oc-web parse <file>` / `oc-web health`,dispatch 到现有 `extractUrl/parseFile/healthCheck`(安全全在里面)。打进镜像 `/usr/local/bin/oc-web`。
- 删除 `web-context` MCP 注入(`entrypoint.ts` clone+toolsets research/web_context;`codexLaunchOverrides.ts` web-context 注入)。
- 改写 `promptSlots.ts:82/155-157`:把"调 `web_context_*` 工具"改为"跑 `oc-web extract/parse`";`availableMcpTools.some(web_context_)` 门改为"web skill 可用"判定。
- 新增 **web skill** 文档化 `oc-web`。

### C. browser → daemon + 瘦 CLI
- 常驻 playwright daemon(替 per-call `npx @playwright/mcp`),unix socket IPC;`oc-browser navigate|snapshot|click|type|press-key|screenshot|wait-for` 瘦客户端。
- 懒启动 + idle 回收;per-agent profile `/tmp/openclaude-browser-<agentId>`;单 context 串行。
- 镜像**预装 playwright+chromium**。
- 删除 browser MCP 注入 + `browser` toolset;新增 **browser skill**。
- daemon handler 校验 agent id(单租户内仍做 hygiene,非安全边界)。

### D. gating = skill seed 范围(无强制)
- `ensureAgentSeedSkill` 按 agent 角色 seed research/web/browser skill(如 researcher 给 research+web,main 给全部)。决定"看不看得见/模型会不会主动用"。
- 不写 entitlement 文件、不做 binary 自校验(无安全边界,过度工程)。**前提(Codex 提醒并采纳):一旦未来出现按 plan/租户的能力边界,必须另做硬门禁,届时 skill seed 不能当权限卖点。**

### F. delegate / toolsets 文案清理(Codex 补)
- `toolsetIntent.ts` 与 `mcp-memory` 的 `delegate_task`/`ask_gpt55_codex` schema 里 `toolsets:["research"/"browser"]` 现描述为"授予平台工具集"。退 MCP 后这不再是授权语义 → 改为"建议目标 agent 使用对应 research/web/browser **skill/CLI**",避免 leader 继续传无效 toolsets。

### E. 保留不动
- `openclaude-vision`(subprocessRunner + codexLaunchOverrides 注入、proxy 图剥离、promptSlots vision 槽、staticKeyProviders supportsVision、微信图链路)**全部原样**。
- `openclaude-memory` 14 工具(含训练态 `skill_propose`)原生 MCP 不动。

## 风险(请 Codex 复审是否还有阻塞)
- R1 可发现性:web 由 promptSlots 改指 `oc-web` 保留(同 vision 机制);browser/scansci 靠 skill description + agent 指令。需 Phase 验真模型会主动调。
- R2 web core 安全:复用已 export 函数即继承全套约束;CLI 入口加测试覆盖 extractUrl/parseFile 的 SSRF/path/size。
- R3 browser daemon 新长驻进程:崩溃/泄漏/僵尸 → supervise+idle 回收+健康检查。
- R4 计费:web/scansci 无模型成本;browser 无模型成本;vision 不动 → 本次无新计费面。
- R5 回滚残留 skill:seed skill 进持久卷,回退到无 `oc-web`/`oc-browser` 老镜像会"看得见跑不了"。**具体(Codex 补):seed 目录按 runtime 版本打 marker(如 `seed-skills/<name>/.runtime-min`),`skill_list/search` 在运行时按当前 runtime 版本过滤;或 entrypoint 在 seed 前按二进制存在性(`command -v oc-web`)决定是否 seed。二选一,Phase 4/5 定。**

## 分阶段(执行顺序:先简单净赢,后 daemon)
1. **web core CLI**(export 三函数 + `oc-web` main + 测试)→ verify: 单测 extract/parse 的 SSRF/path/size 约束;`oc-web extract <url>` 出 markdown。
2. **scansci+web 退 MCP + 同阶段 seed skill + 提示迁移**(promptSlots web 槽 + paperIntentHint + codexLaunchOverrides web 清理 + delegate/toolset 文案)→ verify: 容器内 `scansci-pdf download`/`oc-web extract` 出件;collectAvailableMcpToolNames 不再含 scansci/web;Codex 路径无 web-context 注入;**对应 research/web skill 已 seed**(Codex:退 MCP 与 seed 必须同阶段,避免"能力没了还不可发现"的窗口)。
3. **gating 精细化**:角色→skill 矩阵 + 回归测试(非 seed 本身,seed 已在 Phase 2 落地)。
4. **browser daemon + 瘦 CLI**(独立、最大)→ verify: navigate→snapshot→click 全链路;daemon 崩溃重启;idle 回收。
5. **镜像 rebuild + 部署**(image 改动,走 v3-commercial-deploy image-rebuild + rollout-modes)→ verify: docker exec 跑全 CLI EXIT=0 + CCB stdin 端到端 + 能力型常驻 schema 归零(仅 memory 14 + 条件 vision 1)+ **全文 grep 确认运行时提示/工具描述不再把 `web_context_*`/`scansci_pdf_*` 当"当前可调用 MCP 工具"表达**(Codex 补验收门)。
