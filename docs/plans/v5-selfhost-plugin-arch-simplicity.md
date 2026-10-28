# Selfhost 插件：简单连接 + 方便调用

授权：2026-10-27 t1083/t1084/t1085/t1088。仅个人版；禁止商业合入/发布。路径：refactor。

## 缺口与决定

| 现状（基点 8cef119e90c2） | 缺口 | 本次决定 |
| --- | --- | --- |
| v1、声明式、runtime、本机目录分别提供账号/安装/状态 | 单纯藏卡片仍可用旧 ID 安装、绑定、调用 | 启动验证 FlavorIdentity 后配置五件套产品策略；目录、安装、绑定、执行共同检查 |
| DEFAULT_CONNECTORS 包含 Notion/飞书/GitHub | 默认 seed 会重新引入下架插件 | 有效默认集 selfhost 仅 GitHub；历史精确 hash 留作工件身份验证 |
| 浏览器 seed 可独立执行 | 已存在版本可被再次提升 | 下架 seed 在任何 DB / 上游动作前拒绝；通用市场发布与依赖安装同样检查 |
| GitHub 声明式 PAT 卡覆盖 v1 OAuth 卡 | 用户先找 Token，绕远路 | 连接主入口优先平台 OAuth；保留 PAT 和旧账号管理 |
| 已安装插件需先进详情再点连接 | 多一层点击 | 未连接行直接打开原连接/授权流程；市场安装、条款及扫码仍需完成 |
| 管理页 v1 请求失败会挡住其它目录；偏好失败默认空 | 一处故障影响全部，可能误写启用状态 | 独立加载、部分失败提示；偏好未知禁开关并可重试 |
| oc-plugin 无 describe；技能按多套后端分流 | Agent 需猜调用入口和参数 | oc-plugin list → describe → call 共用解析、账号选择、错误指引 |

五件套：`weibo / knowledge-planet / github / ths / literature-db`。产品资格与安装、用户偏好、签名资格互相独立。其它 flavor 的通用驱动保持原行为；请求参数和启用偏好不能放宽 selfhost 产品策略。

## 边界

- 管理目录保留支持插件的失效账号/旧安装恢复入口；执行目录只包含当前可信可执行目标。
- `describe` 使用与执行相同的目标加载、安装/启用/验签资格，仅投影契约，不调用上游。写入开关、账号预授权和逐次确认均保留。
- 同花顺通过本机技能/插件启动器运行，不伪装成远端账号。统一技能说明只教五件套。
- 历史下架账号和凭据不删除；解绑/卸载等清理通道保留。已有启用偏好在读回时去掉下架 opt-in，避免后续合法开关重交旧选择。
- 不自动安装、接受条款或发起第三方写操作。不将本地 fixture 验证称为真实账号授权验收。

## 验证

定向用例覆盖 selfhost 产品资格、历史 pin/显式账号 ID、seed、目录、偏好、统一 describe、GitHub OAuth/PAT、失败恢复。浏览器门 `plugin-connect.node-test.mjs` 在桌面与 390px 手机尺寸用真实点击；同一测试以基点 ConnectorsTab 替代修复后组件时红（找不到直接连接按钮），本次组件绿。

CLI 旧提示中的知乎/B 站断言改为保留的浏览器插件；参数错误提示断言改为统一 oc-plugin describe。原写确认、凭据和多账号断言保留。全量 commercial/gateway/web-react 交给 selfhost 托管 CI；不修改 known-failures、skip 或发布门。

合入前：draft PR + Codex APPROVED + CI 绿；**DO NOT MERGE — 待真 Grok OD**。本任务不发版。
