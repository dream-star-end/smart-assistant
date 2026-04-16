# OpenClaude 商业化(Commercial)文档

本目录是 **OpenClaude v2 分支商业化改造**的规格驱动开发(SDD)文档集。
所有开发工作严格按照本目录下的文档执行,不超纲、不遗漏。

## 开发方法论

- **SDD (Spec-Driven Development)**:先写清楚做什么、怎么做,再写代码
- **TDD (Test-Driven Development)**:实现每个功能前先写测试,让测试指引实现
- 文档是**开发契约**:API、数据结构、行为都以文档为准,代码与文档不一致时修正代码

## 文档清单

| 文件 | 内容 | 读者 |
|------|------|------|
| [01-SPEC.md](./01-SPEC.md) | 业务需求规格:做什么,不做什么 | 所有人 |
| [02-ARCHITECTURE.md](./02-ARCHITECTURE.md) | 技术架构:模块划分、数据流、部署拓扑 | 开发 |
| [03-DATA-MODEL.md](./03-DATA-MODEL.md) | 数据库 schema:表结构、索引、约束、迁移策略 | 开发 |
| [04-API.md](./04-API.md) | HTTP/WebSocket 接口规范:路径、入参、返回、错误码 | 开发 + 前端 |
| [05-SECURITY.md](./05-SECURITY.md) | 安全设计:认证、加密、反滥用、合规 | 开发 + 运维 |
| [06-TEST-STRATEGY.md](./06-TEST-STRATEGY.md) | 测试策略:单元/集成/E2E 分层,覆盖目标 | 开发 |
| [07-TASKS.md](./07-TASKS.md) | **任务清单**:逐项可执行的开发任务,带依赖和验收标准 | 开发(按此执行) |

## 开发流程

```
  阅读 01-SPEC          ──► 理解要做什么
       │
       ▼
  阅读 02-ARCH / 03-DB / 04-API / 05-SEC  ──► 理解怎么做
       │
       ▼
  打开 07-TASKS,从最靠前的未完成任务开始
       │
       ▼
  对该任务:
    1. 先读该任务引用的 spec / schema / api 条目
    2. 按 TDD:先写测试(06-TEST-STRATEGY 指定的层级)
    3. 实现代码让测试通过
    4. 运行 `npm run check`(lint + typecheck + test)
    5. 更新 07-TASKS 标记完成 + 写简短完成说明
    6. git commit
```

## 目录布局约定

```
/opt/openclaude/openclaude-commercial/
├── docs/commercial/            # 本目录
├── packages/
│   ├── gateway/                # 已有:HTTP/WS 入口,会新增路由
│   ├── storage/                # 已有:会新增商业化数据访问层
│   ├── commercial/             # 新增:商业化核心模块
│   │   ├── auth/               # 用户认证
│   │   ├── billing/            # 积分计费
│   │   ├── payment/            # 虎皮椒对接
│   │   ├── account-pool/       # Claude OAuth 账号池调度
│   │   ├── agent-sandbox/      # Docker 隔离环境编排
│   │   └── admin/              # 超管 API
│   └── web-admin/              # 新增:超管前端(可选,MVP 可复用 web)
└── deploy/
    └── commercial/             # 新增:商业化专用部署脚本与 systemd
```

## 与个人版的边界

- **不动** `packages/gateway/` 现有的 `sessionManager`, `eventBus`, `subprocessRunner`, `ccbMessageParser` 等
- **不动** `packages/storage/` 现有的 `memoryStore`, `taskStore`, `sessionsDb` 等
- **新增**的商业化模块通过 **中间件 + 新路由** 挂进去,不侵入核心逻辑
- Feature flag(`COMMERCIAL_ENABLED=1`)控制商业化模块启用,默认关闭(与个人版共享 v2 代码但运行形态不同)

## 版本与变更

本文档集与代码一起纳入 git,变更走 commit。修改任何设计文档时,必须同步更新 `07-TASKS.md` 中受影响的任务。

Last updated: 2026-04-17
