# OpenClaude 通用 AI 智能体进化路线图

> 版本: v1.1 | 日期: 2026-04-14
> 审查: Claude Opus + OpenAI Codex 联合制定 (两轮审查，7 项修订)

---

## 一、现状评估

### 已有能力 ✅

| 模块 | 能力 | 成熟度 |
|------|------|--------|
| 记忆 | 三层: Core(MD) → Recall(FTS5) → Archival(FTS5) | ⭐⭐⭐⭐ |
| 技能 | YAML+MD 格式, 7 种子 skill, 6h 自动提取 | ⭐⭐⭐⭐ |
| Agent | 异步/同步协作, 多 agent 配置, worktree 隔离 | ⭐⭐⭐⭐ |
| 工具 | 50+ 工具, MCP 生态, Playwright 浏览器 | ⭐⭐⭐⭐ |
| 调度 | Cron(反思/整理/技能/心跳), Webhook | ⭐⭐⭐ |
| 渠道 | WebChat + Telegram | ⭐⭐⭐ |
| Provider | Claude, Codex, MiniMax, DeepSeek | ⭐⭐⭐ |
| API | OpenAI 兼容 /v1/chat/completions | ⭐⭐⭐ |
| 可靠性 | 崩溃恢复, 退避重试, WS 幂等去重 | ⭐⭐⭐ |

### 关键缺失 ❌

| 缺失 | 影响 | 紧迫度 |
|------|------|--------|
| 评测/回归体系 | 无法衡量任何"增强"是否有效 | 🔴 P0 |
| 统一事件模型 | 反馈、学习、可观测都无法闭环 | 🔴 P0 |
| 语义搜索 | 记忆检索仅靠 BM25，召回率低 | 🟡 P1 |
| 持久化执行 | 无 checkpoint/resume/补偿 | 🟡 P1 |
| 共享状态模型 | Agent 间各自为政 | 🟡 P2 |
| 统一 artifact 抽象 | 图片/文件/网页各一套管线 | 🟡 P2 |
| 反馈学习闭环 | 无法从用户行为优化 | 🟢 P3 |

---

## 二、核心设计原则

> 来自 Codex 审查的关键洞察

1. **先闭环，再扩展** — 把现有半成品连成闭环，而非横向铺新概念
2. **评测驱动** — 没有评测集，所有"增强"都是自嗨
3. **统一优先于增加** — 统一状态模型 > 增加新状态存储
4. **工程能力 > 智能能力** — 最缺的不是更多"智能"，而是可靠性和可观测
5. **受约束的优化** — 所有自动优化必须在评测围栏内进行

---

## 三、六阶段路线图

```
P0 可靠性底座 ──→ P1 检索增强 ──→ P2 可恢复执行 ──→ P3 多Agent协作 ──→ P4 学习闭环 ──→ P5 平台扩展
   (2-3周)         (3-4周)         (3-4周)           (4-6周)          (4-6周)        (持续)
```

---

### P0: 可靠性与治理底座

> 目标: 让后续所有增强可衡量、可审计、可回滚

| # | 交付件 | 描述 | 验收标准 |
|---|--------|------|----------|
| 0.1 | **评测集** | 30-50 个代表性任务 (代码/搜索/记忆/多步骤/工具组合) | 可一键运行，输出通过率 |
| 0.2 | **统一事件 Schema** | turn/tool/agent/task/memory-hit/verification 标准化 | 所有事件可 join 查询 |
| 0.3 | **可观测性** | OTLP → OpenTelemetry Collector → Loki+Prometheus | 关键路径有 trace/metrics |
| 0.4 | **验证 Agent** | 激活现有 VerifyPlanExecutionTool，结构化 evidence | 自动验证测试结果/diff/退出码 |
| 0.5 | **基础身份** | session/user/channel identity + 审计日志 + 限流 | API 请求可追溯到用户 |
| 0.6 | **最小模板版本化** | prompt/skill/agent-def 带版本 ID，可追溯、可回滚 | 每次实验结果可归因到具体版本 |
| 0.7 | **统一成本计量** | token/cost usage 事件标准化，按 session/agent/tool 维度 | P3 成本预算有可信数据源 |

**技术选型:**
- 事件: 扩展现有 eventBus，统一 TypeBox schema，**schema 带版本号 + 迁移策略**
- 观测: 项目已有 OTel 基础，走 `OTLP → Collector → Loki+Prometheus`
- 评测: 自定义 YAML 任务定义 + Bun test runner

**风险:** 评测集设计需要领域知识积累，建议边用边补

---

### P1: 检索与上下文增强

> 目标: 记忆系统从"存得下"进化到"找得准"

| # | 交付件 | 描述 | 验收标准 |
|---|--------|------|----------|
| 1.1 | **Embedding Provider 抽象** | 统一接口，支持 API (OpenAI/BGE) + 本地推理 | 一行切换 provider |
| 1.2 | **混合检索** | Recall/Archival 支持 BM25 + 向量 + RRF 融合 | 召回率比纯 BM25 提升 >20% |
| 1.3 | **Rerank** | 检索结果二次排序 (BGE-reranker 或 cross-encoder) | Top-5 准确率可衡量提升 |
| 1.4 | **上下文智能装箱** | 基于相关性+token预算动态选择注入内容 | 不超预算前提下最大化相关性 |
| 1.5 | **记忆生命周期** | 访问频率追踪 → 巩固/衰减/归档/清理 | 记忆库不会无限膨胀 |
| 1.6 | **多模态摘要** | 图片/文件 → 文本摘要 → 存入记忆 | "记住这张图"可用 |
| 1.7 | **索引构建与更新流水线** | 文档切分/去重/版本同步/重建策略/删除级联 | Top-5 命中率可稳定复现 |

**技术选型:**
- 向量存储: **SQLite + sqlite-vss** (与现有 FTS5 同库，零额外依赖)
- 嵌入模型: 先 API (OpenAI text-embedding-3-small)，验证效果后考虑本地 BGE-M3
- Rerank: BGE-reranker-v2-m3 (支持中英文)
- 融合: Reciprocal Rank Fusion (RRF)，简单有效

**依赖:** P0.2 (统一事件用于衡量检索质量)

---

### P2: 可恢复执行与工作流

> 目标: 从"一次性执行"进化到"可中断、可恢复、可审批的持久化执行"

| # | 交付件 | 描述 | 验收标准 |
|---|--------|------|----------|
| 2.1 | **Durable State Machine** | 统一 cron + task + workflow stub 为状态机 | 任务有明确的状态转换图 |
| 2.2 | **Checkpoint/Resume** | 长任务支持序列化中间状态并恢复 | 进程重启后可继续 |
| 2.3 | **Human-in-the-Loop** | 工作流中的审批节点，阻塞等待人工确认 | Telegram/Web 都能审批 |
| 2.4 | **失败恢复** | 自动重试 + 补偿 + 超时 + 幂等保证 | 网络闪断不丢任务 |
| 2.5 | **沙箱执行** | Docker rootless 隔离，资源限制 | 不信任代码无法逃逸 |

**技术选型:**
- 状态机: 基于现有 TaskStore 扩展，参考 LangGraph 的 interrupt/resume 设计
- 持久化: SQLite WAL (已有)
- 沙箱: Docker rootless + 只读 FS + 网络白名单 + CPU/内存/时限
- 审批: 复用现有 WebSocket 推送 + Telegram inline keyboard

**依赖:** P0.1 (评测验证恢复正确性), P0.2 (事件追踪执行状态)

**参考:**
- LangGraph durable execution & interrupts 设计模式

---

### P3: 多 Agent 协作增强

> 目标: 从"单兵作战偶尔协作"进化到"有组织的团队协作"

| # | 交付件 | 描述 | 验收标准 |
|---|--------|------|----------|
| 3.1 | **统一状态模型** | 合并 memory/task/scratchpad/team-memory 为统一存储 | 一个查询看到所有状态 |
| 3.2 | **黑板系统** | Agent 间共享知识/中间结果的中心化存储 | Agent A 写入，Agent B 读取 |
| 3.3 | **角色模板** | 3 个核心角色: Coder / Researcher / Reviewer | 模板化创建，有明确职责边界 |
| 3.4 | **协作协议** | 标准化任务分配/状态汇报/冲突解决 | 集成到 workflow 状态机 |
| 3.5 | **成本预算** | Agent fan-out 上限，模型路由，token 预算分配 | 基于 P0.7 计量数据实施控制 |

**技术选型:**
- 黑板: SQLite 表 + eventBus 通知 (简单有效)
- 协议: 基于现有 send_to_agent/delegate_task 扩展 structured message
- 角色: Markdown 模板 (复用现有 Agent 定义格式)

**依赖:** P0.2 (事件 schema), P0.7 (成本计量), P2.1 (工作流状态机), P2.2 (checkpoint/resume), P2.4 (失败恢复/幂等)

**暂缓:** 动态团队组建 — 先验证固定角色效果

---

### P4: 学习与进化闭环

> 目标: 从"被动响应"进化到"持续改进"

| # | 交付件 | 描述 | 验收标准 |
|---|--------|------|----------|
| 4.1 | **反馈标签化** | 显式评分 (👍👎) + 隐式信号 (重试/放弃/编辑) | 每次交互有质量信号 |
| 4.2 | **轨迹归因** | 成功/失败与具体 tool/agent/prompt 关联 | 可定位到"哪一步出问题" |
| 4.3 | **Skill 自动提炼** | 成功对话 → 新 Skill; 失败对话 → Anti-pattern | 自动提议，人工审批 |
| 4.4 | **模板版本化** | prompt/skill 版本管理 + 灰度发布 + 回滚 | 改 prompt 不会全量翻车 |

**技术选型:**
- 反馈存储: 扩展现有 sessionsDb
- 归因: 基于 P0.2 的统一事件 join
- Skill 提炼: 复用现有 6h 自动提取 cron，增加质量过滤

**依赖:** P0 全部 (评测+事件+可观测), P1.2 (检索历史轨迹)

**明确不做:**
- ❌ Prompt 自改写 (风险太高，改为人工审批版本发布)
- ❌ 知识蒸馏 (单人项目 ROI 极低)

---

### P5: 平台能力扩展

> 目标: 从"个人工具"进化到"可共享的平台"

| # | 交付件 | 描述 | 验收标准 |
|---|--------|------|----------|
| 5.1 | **渠道适配器** | 统一 ChannelAdapter 接口 + 飞书/Slack | 新渠道只需实现接口 |
| 5.2 | **多用户** | 用户级会话隔离 + 记忆隔离 | 用户 A 看不到用户 B 的数据 |
| 5.3 | **API 自动集成** | OpenAPI/JSON Schema → 工具定义自动生成 | 给 spec 文件即可注册工具 |
| 5.4 | **工具组合** | 多个工具组合为复合工具 | Agent 可创建并复用组合工具 |

**暂缓到更远期:**
- ❌ 插件市场 (需 auth + sandbox + 签名 + 审核 + 版本治理)
- ❌ 知识图谱 (等混合检索跑顺)
- ❌ 动态工具自动安装 (安全风险高)
- ❌ 微信渠道 (审核门槛高，ROI 低)

---

## 四、技术选型速查

| 领域 | 选型 | 理由 |
|------|------|------|
| 向量存储 | SQLite + sqlite-vss | 零额外依赖，与 FTS5 同库 |
| 嵌入模型 | OpenAI text-embedding-3-small → BGE-M3 | 先 API 验证，后本地化 |
| Rerank | BGE-reranker-v2-m3 | 中英文支持好 |
| 工作流 | 自研轻量状态机 (参考 LangGraph) | 避免重框架依赖 |
| 观测 | OTLP → OTel Collector → Loki+Prometheus | 已有基础 |
| 沙箱 | Docker rootless | 安全 + 轻量 |
| 渠道 | 统一 ChannelAdapter | 已有 plugin-sdk 接口 |
| 评测 | 自定义 YAML + Bun test | 简单灵活 |

---

## 五、参考项目与论文

| 项目/论文 | 借鉴点 |
|-----------|--------|
| **LangGraph** (LangChain) | 有向图工作流、durable execution、interrupt/resume |
| **OpenHands** (原 OpenDevin) | 沙箱隔离、Agent-Computer Interface、事件流架构 |
| **CrewAI** | 角色定义、任务分配、协作协议 |
| **MemGPT / Letta** | 分层记忆、自管理上下文窗口 (已部分借鉴) |
| **AutoGPT** | 自主规划循环、工具组合 |
| **Manus** | 多模态交互、浏览器自动化 |
| **Semantic Kernel** (Microsoft) | Plugin 抽象、Planner 模式 |
| **"A Survey on LLM-based Agents"** | Agent 能力分类框架 |
| **ReAct (Yao et al.)** | 推理+行动交替模式 |
| **Reflexion (Shinn et al.)** | 自反思改进循环 |
| **Voyager (NVIDIA)** | 技能库自动积累、课程学习 |
| **RAISE** | 记忆驱动的 Agent 架构 |

---

## 六、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 评测集设计偏差 | 优化方向错误 | 边用边补，每月 review |
| 向量检索延迟 | 用户体验下降 | 异步预计算 + 缓存 |
| Agent 成本爆炸 | 账单失控 | token 预算 + fan-out 上限 |
| Prompt 自优化翻车 | 全量故障 | 版本化 + 灰度 + 回滚 |
| 单人开发瓶颈 | 进度缓慢 | 严格优先级，每阶段只做最小可用集 |

---

## 七、成功标准

一个**强大的通用 AI 智能体**应该在以下维度可衡量地超越"纯 LLM 聊天":

1. **任务完成率**: 固定评测集 + 固定判定脚本，按阶段分 slice，通过率 >= 80%
2. **记忆召回准确率**: 基于标注查询集 (区分短期/长期记忆)，Top-5 命中率 >= 70%
3. **Skill 质量**: 新增 Skill 中 30 天内复用次数 >= 2 的占比 >= 50% (质量优于数量)
4. **可恢复性**: 在已定义故障注入场景下，从最近 checkpoint 恢复成功率 >= 95%，重复副作用数 = 0
5. **协作效率**: 在质量不下降、单任务成本增幅 <= 30% 的前提下，p50/p95 完成时延改善 >= 20%
6. **用户满意度**: 显式反馈样本量 N >= 50 时，正面反馈率 >= 85% (排除无效会话)
