# 会话与目标
会话支持新建、搜索、历史、重命名、置顶、归档/恢复、移到项目、删除和标已读；消息支持编辑、排队、停止、继续和重新生成；目标有状态与预算。
只读检索限定当前用户及所需范围。创建/编辑/标已读/切换状态/删除/重生成/运行目标都属于系统写或付费动作，应逐次审批。明确删除范围、关联数据、恢复能力；未知是否可恢复时不承诺。
停止操作复用当前运行的真实中断链，不能只释放lease或改状态；任务看板调用其已有业务。目标预算与持续模型调用需说明上限和可能费用。

`sessions.list` supports limit/before/includeArchived. `sessions.search` requires q and supports a project filter; snippets require includeSnippet=true. These fixed own-session reads never preheat a container or return the full transcript.

本人会话改名/置顶：目录包含 `sessions.metadata.update` 时，可用 `oc-system prepare sessions.metadata.update --args '{"sessionId":"目标ID","patch":{"title":"新名称","pinned":true}}' --request-id <本次唯一UUID>` 提议，title/pinned至少一项。只改本人指定会话的名称/置顶，不改消息、模型、项目或运行回合，不收费。服务器冻结目标归属和原版本，必须用原生确认sheet由本人确认；冲突重新审批，不能用旧API/Bash直接写。模型持久化提示与真实模型/费用切换是不同操作，本命令不切模型。实际会话权威非PG时本功能不可用，不读取或修改PG残留副本。
