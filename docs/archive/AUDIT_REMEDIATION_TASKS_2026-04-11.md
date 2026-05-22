# OpenClaude 整改任务清单

更新时间：2026-04-11

适用范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\web`
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\gateway`
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\storage`

目的：
- 给其它 AI 或开发者一个可直接执行的整改 backlog。
- 优先处理安全、错误行为、可用性和性能问题。
- 修完后可基于本清单再次做回归审计。

执行原则：
1. 先做 `P0`，未完成前不要推进大规模 UI 重构。
2. 每个任务都要带最小验证，不接受“代码看起来没问题”。
3. 涉及协议、鉴权、文件读写、富文本预览的改动，必须补测试。
4. 前端重构不允许只改样式，必须同时处理状态管理和可访问性。

---

## 一、总优先级

### P0：必须先修
- T01 收紧 `/api/file` 和 `/api/media` 的鉴权与授权边界
- T02 移除 query token 传递，替换为安全的鉴权方案
- T03 禁用或隔离高风险 `htmlpreview`
- T04 为上传链路增加服务端限制和配额保护

### P1：高优先级
- T05 修复全局 `sendingInFlight` 导致的跨会话错误
- T06 修复“加载更早消息”顺序错误
- T07 优化流式渲染和侧边栏刷新策略
- T08 修复 Windows 路径预览兼容性
- T09 为高风险路径补自动化测试

### P2：重要但可排后
- T10 提升会话列表、模态框、菜单的可访问性
- T11 改造登录和通知授权流程
- T12 拆分单文件前端，降低维护成本
- T13 本地化关键前端依赖，移除运行时 CDN 强依赖
- T14 建立 lint/test 质量门禁

### P3：体验增强
- T15 优化搜索、虚拟化和大会话渲染
- T16 优化长任务反馈、失败恢复和后台任务面板

---

## 二、任务清单

### T01 收紧 `/api/file` 和 `/api/media` 的鉴权与授权边界

优先级：`P0`

问题：
- 当前 `packages/gateway/src/server.ts` 中，`/api/file` 和 `/api/media` 被排除在鉴权之外。
- `/api/file` 还允许访问 `paths.home`，存在读取配置、凭据、memory、session 日志的风险。

目标：
- 任何文件读取接口都必须经过鉴权。
- 只能读取明确允许的产物目录，不能直接读取整个 home。

修改范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\gateway\src\server.ts`
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\storage\src\paths.ts`

实施要求：
- 调整 `needsAuth` 判定，不再豁免 `/api/file` 和 `/api/media`。
- 为 `/api/file` 增加更严格的 allowlist。
- 默认只允许：
  - `uploadsDir`
  - `generatedDir`
  - 明确约定的只读导出目录
- 禁止直接暴露：
  - `paths.home`
  - `credentialsDir`
  - `config`
  - `agents/*/MEMORY.md`
  - `agents/*/USER.md`
  - session 日志
- 如果确实需要访问 agent 生成的本地文件，改为：
  - 显式导出到安全目录，或
  - 签发短期有效的临时 token / signed URL

验收标准：
- 未带 token 时访问 `/api/file`、`/api/media` 返回 `401`。
- 访问敏感路径返回 `403`。
- 上传目录和生成目录中的合法文件仍可被已登录前端访问。
- 不再能通过接口读取 `~/.openclaude/openclaude.json`。

建议验证：
- 手工请求：
  - `GET /api/file?path=...`
  - `GET /api/media/...`
- 自动化测试覆盖：
  - 无 token
  - 非白名单目录
  - 白名单目录
  - 路径穿越

---

### T02 移除 query token 传递，替换为安全的鉴权方案

优先级：`P0`

问题：
- 前端 HTTP API 通过 `?token=` 传 token。
- token 还被长期存储在 `localStorage`。

目标：
- token 不再出现在 URL、日志、历史记录中。
- 降低 token 被脚本读取的风险。

修改范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\web\public\index.html`
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\gateway\src\server.ts`
- 如需要，补充新的会话鉴权接口

实施要求：
- HTTP 请求统一改为 `Authorization: Bearer <token>`。
- `apiGet` / `apiJson` 删除 query token 拼接。
- 评估并实现以下之一：
  - `HttpOnly` cookie
  - 仅内存态保存 token
  - 短期 session token + refresh 机制
- 至少不要在 `localStorage` 长期保存高权限网关 token。
- WebSocket 保留 subprotocol 传 token可以接受，但要统一文档和校验逻辑。

验收标准：
- 浏览器地址栏、network URL 中不再出现 token。
- 所有 `/api/*` 调用仍可正常工作。
- 页面刷新后的登录体验有明确设计：
  - 要么要求重新登录
  - 要么由安全 cookie 自动恢复

建议验证：
- 浏览器开发者工具检查 request URL。
- 检查登录、加载 agents、配置读取、上传、OAuth 流程。

---

### T03 禁用或隔离高风险 `htmlpreview`

优先级：`P0`

问题：
- `htmlpreview` 通过 `iframe.srcdoc` 注入模型输出。
- 当前 sandbox 包含 `allow-scripts allow-same-origin`，风险过高。

目标：
- 杜绝模型输出脚本获得同源权限。
- 保留预览能力时，必须有明确安全边界。

修改范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\web\public\index.html`

实施要求：
- 最低要求：
  - 去掉 `allow-same-origin`
  - 默认禁止执行任意脚本
- 更稳妥的方案：
  - 直接关闭 `htmlpreview` 功能
  - 或迁移到独立 origin 的 preview 服务
- 如果继续保留脚本能力：
  - 必须证明无法读取主站 `localStorage`
  - 必须证明无法调用内部 API
  - 必须证明无法操控 parent

验收标准：
- preview 中的 HTML 不能访问主页面 token、状态或 API。
- 恶意 `fetch('/api/config')`、`localStorage.getItem(...)` 不可用。
- 普通静态 HTML 预览仍能工作，或被明确降级为“查看源码”。

建议验证：
- 用恶意样例验证：
  - 读取 `localStorage`
  - 调主站 API
  - `parent.postMessage` 滥用
  - DOM 注入

---

### T04 为上传链路增加服务端限制和配额保护

优先级：`P0`

问题：
- 上传大小限制只在前端。
- 服务端先 parse 整个 WS JSON，再写入文件。
- 缺少配额、MIME allowlist、单用户限流。

目标：
- 阻断恶意大包、伪造 MIME、磁盘打满、内存打爆。

修改范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\gateway\src\server.ts`
- 如需要，新增上传配置项

实施要求：
- 在服务端校验：
  - 单文件大小
  - 单消息总附件大小
  - 允许的 MIME / 扩展名
  - 单会话或单 token 的频率限制
- 超限时返回结构化错误，不继续落盘。
- 如果现有 WS 结构难以安全处理大文件，评估改为单独上传接口。
- 为上传目录增加清理策略或配额统计。

验收标准：
- 伪造超大 payload 会被拒绝。
- 异常 MIME 不会被落盘。
- 附件上传失败时，前端能看到明确错误，不会卡住当前会话。

建议验证：
- 5MB、25MB、超限文件
- MIME 欺骗
- 多文件并发
- 中断上传

---

### T05 修复全局 `sendingInFlight` 导致的跨会话错误

优先级：`P1`

问题：
- 当前发送状态是全局变量，不是 session 级别。
- 切换会话时，停止/发送状态可能污染另一个会话。

目标：
- 每个会话独立维护：
  - 是否在生成
  - typing indicator
  - stop 控制
  - 离线队列关联

修改范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\web\public\index.html`

实施要求：
- 将 `sendingInFlight` 从全局状态迁移到 session state。
- `stopCurrentTurn()` 必须只影响当前 session。
- agent 切换、会话切换、断线重连都不能串状态。
- 更新 `updateSendEnabled()` 逻辑，按当前会话判断按钮状态。

验收标准：
- 会话 A 生成中时，会话 B 仍可独立发送，除非产品明确不允许并有 UI 说明。
- 在 A 中点击 stop，不会终止 B。
- 切换 agent 不会残留上一个 agent 的流式状态。

建议验证：
- 双会话并行
- 切换会话后 stop
- 断线重连后恢复

---

### T06 修复“加载更早消息”顺序错误

优先级：`P1`

问题：
- 当前加载旧消息时直接 append，消息顺序错误。

目标：
- 保证消息顺序始终从旧到新。

修改范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\web\public\index.html`

实施要求：
- 修正 `renderMessages()` 和 `loadMore` 逻辑。
- 旧消息应 prepend 到顶部，或按 slice 完整重渲染。
- 保持滚动位置稳定，不能出现跳动。

验收标准：
- 超过 100 条消息的会话：
  - 初始显示最新窗口
  - 点击“加载更早消息”后顺序正确
  - 滚动位置合理

建议验证：
- 构造 150-300 条消息样本做人工回归。

---

### T07 优化流式渲染和侧边栏刷新策略

优先级：`P1`

问题：
- 每个 block 都会重跑 Markdown、DOMPurify、富内容处理。
- 每次输出都会触发 `renderSidebar()`。

目标：
- 长回答、工具流、子 agent 输出时不明显掉帧。

修改范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\web\public\index.html`

实施要求：
- 对流式文本更新做节流：
  - `requestAnimationFrame`
  - 或 50-100ms 批量 flush
- 只更新当前 message DOM，不整条重建相关区域。
- sidebar 改为低频刷新：
  - 仅标题变化
  - 会话切换
  - final 完成
  - 搜索输入
- `processRichBlocks()` 只处理新增块，不全量扫。

验收标准：
- 长文本流式输出明显更平滑。
- CPU 占用和页面抖动下降。
- 子 agent 卡片和 tool block 更新不再频繁触发整侧边栏重建。

建议验证：
- 生成 5k-20k 字长回复
- 大量 tool_use/tool_result
- 多个 Mermaid/Chart block

---

### T08 修复 Windows 路径预览兼容性

优先级：`P1`

问题：
- 当前本地路径预览主要按 Unix 路径处理。
- 在 Windows 环境下 `C:\...` 这类路径无法正常 inline preview。

目标：
- 支持 Windows 本地路径和跨平台路径规范化。

修改范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\web\public\index.html`
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\gateway\src\server.ts`

实施要求：
- 前端 media path 检测支持：
  - `C:\...`
  - `D:\...`
  - 可能的 UNC 路径
- `/api/file` 的 path 校验支持 Windows 绝对路径。
- 不要因为支持 Windows 而重新引入路径穿越风险。

验收标准：
- 在 Windows 上，agent 输出的本地图片、音频、视频、PDF 路径可以被正确预览。
- 非法路径仍被拒绝。

建议验证：
- 本机 Windows 路径样例
- URL 编码后的 Windows 路径

---

### T09 为高风险路径补自动化测试

优先级：`P1`

问题：
- 当前 `openclaude/packages` 基本没有有效测试覆盖。

目标：
- 给安全和关键流程建立最小可回归测试集。

建议新增测试范围：
- 网关鉴权
- 文件访问授权
- 上传限制
- session 状态隔离
- 加载旧消息顺序

建议位置：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\gateway\src\__tests__`
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\web\...` 或单独引入前端测试目录

最低验收：
- 至少覆盖 T01-T06 的 happy path 和关键失败路径。
- 测试可以在 CI 或本地一键执行。

---

### T10 提升会话列表、模态框、菜单的可访问性

优先级：`P2`

问题：
- 会话项和菜单项大量使用可点击 `div`。
- modal 缺少完整语义和焦点管理。

目标：
- 基本达到键盘可操作、屏幕阅读器可识别的水平。

修改范围：
- `D:\code\git_project\claudeOpenclaw\openclaude\packages\web\public\index.html`

实施要求：
- 会话项改成 button 或语义化列表项。
- modal 增加：
  - `role="dialog"`
  - `aria-modal="true"`
  - 关联标题
  - 真正的 focus trap
- context menu / settings dropdown 支持键盘导航。
- 为搜索框、按钮、图标按钮补齐 label。

验收标准：
- 全流程支持键盘操作：
  - 会话切换
  - 新建会话
  - 打开/关闭 modal
  - 菜单选择
- Escape、Tab、Shift+Tab 行为正确。

---

### T11 改造登录和通知授权流程

优先级：`P2`

问题：
- 登录依赖人工复制 gateway token。
- 登录后固定 3 秒请求通知权限，时机粗暴。

目标：
- 降低首次使用门槛，减少无意义权限弹窗。

实施要求：
- 设计更合理的登录方式：
  - pairing code
  - 一次性配对链接
  - 本地引导页
- 通知权限改成用户触发：
  - 开启后台任务提醒时申请
  - 或首次最小化/离焦提醒时解释后申请

验收标准：
- 新用户不需要去服务器配置文件里 grep token。
- 通知权限不再在登录后立即弹出。

---

### T12 拆分单文件前端，降低维护成本

优先级：`P2`

问题：
- 当前 Web 端几乎全部逻辑集中在一个 `public/index.html`，约 200KB。

目标：
- 降低耦合，便于并行修改和测试。

实施要求：
- 至少拆为：
  - `state`
  - `api/ws`
  - `render/messages`
  - `render/sidebar`
  - `uploads`
  - `modals`
  - `markdown/preview`
- 样式与脚本分离。
- 不要求一次迁移到大型框架，但必须去掉“单 HTML 承载全部应用逻辑”的结构。

验收标准：
- `index.html` 只保留骨架和入口。
- 主要业务逻辑被拆成独立文件。
- 不出现功能回退。

---

### T13 本地化关键前端依赖，移除运行时 CDN 强依赖

优先级：`P2`

问题：
- `marked`、`DOMPurify`、`Chart.js`、`mermaid`、`highlight.js` 全靠 CDN。

目标：
- 运行环境不受外部 CDN 可用性影响。
- 安全组件不是“加载不到就降级”。

实施要求：
- 将依赖纳入本地构建产物。
- `DOMPurify` 缺失时不要继续允许危险 fallback。
- 明确版本锁定和更新策略。

验收标准：
- 离线或内网环境仍可正常运行核心富文本渲染能力。
- 不再依赖 jsDelivr。

---

### T14 建立 lint/test 质量门禁

优先级：`P2`

问题：
- `tsc` 通过，但 `npm run lint` 当前有大量错误。
- 缺少测试门禁。

目标：
- 至少保证：
  - lint 通过
  - 类型检查通过
  - 核心测试通过

实施要求：
- 修复现有 Biome 报错。
- 新增测试脚本并写入文档。
- 在提交前执行：
  - `npm run lint`
  - `npx tsc -p packages\\protocol\\tsconfig.json --noEmit`
  - `npx tsc -p packages\\storage\\tsconfig.json --noEmit`
  - `npx tsc -p packages\\gateway\\tsconfig.json --noEmit`
  - `npx tsc -p packages\\cli\\tsconfig.json --noEmit`
  - 新增测试命令

验收标准：
- 本地完整检查通过。
- 新增任务不会继续堆积静态问题。

---

### T15 优化搜索、虚拟化和大会话渲染

优先级：`P3`

目标：
- 大量 session、大量消息时仍然可用。

实施要求：
- 为 sidebar search 增加 debounce。
- 构建轻量 search index 或缓存字段。
- 评估消息列表虚拟化。
- 避免在每次输入时全文扫描所有消息。

验收标准：
- 100+ sessions、单会话 500+ messages 时仍可基本流畅。

---

### T16 优化长任务反馈、失败恢复和后台任务面板

优先级：`P3`

目标：
- 用户能理解系统当前状态，失败可恢复。

实施要求：
- 明确展示：
  - 当前正在运行的会话
  - 当前 agent
  - stop 是否成功
  - 重试状态
  - 断线队列状态
- 背景任务与普通对话状态要分离。
- 子 agent 卡片的完成/失败反馈更可读。

验收标准：
- 长任务、重试、断线重连、stop 都有清晰 UI 状态。

---

## 三、推荐执行顺序

### 第 1 批
- T01
- T02
- T03
- T04

### 第 2 批
- T05
- T06
- T07
- T08
- T09

### 第 3 批
- T10
- T11
- T12
- T13
- T14

### 第 4 批
- T15
- T16

---

## 四、交付要求

每个任务完成后，提交内容至少包含：
- 修改说明
- 影响范围
- 风险点
- 验证结果
- 若有 UI 改动，附截图或录屏

每个任务完成后，开发者或 AI 需要在回复中明确写出：
- 修了什么
- 没修什么
- 是否存在已知残留风险

---

## 五、回归审计前的最低完成条件

在重新找我做审计之前，至少应满足：
- T01-T09 已完成
- `lint` 通过
- `tsc` 通过
- 核心测试可跑
- 能提供一版实际运行截图或录屏

---

## 六、建议给其它 AI 的执行提示

可以把下面这段直接发给其它 AI：

```text
请按仓库中的 AUDIT_REMEDIATION_TASKS_2026-04-11.md 执行整改。
要求：
1. 严格按优先级从 P0 开始，不要跳过。
2. 每完成一个任务，给出变更文件、实现说明、验收结果。
3. 涉及安全边界、鉴权、文件读取、上传、html preview 的修改，必须补测试。
4. 不接受只改表面文案或样式的“伪修复”。
5. 每一批任务结束后，输出待人工复核的风险列表。
```
