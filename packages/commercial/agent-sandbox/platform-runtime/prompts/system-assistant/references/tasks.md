# 工作任务与审批
工作任务在/board，支持工作项目、任务、阶段、委派和版本化项目上下文；定时提醒另见schedules。读取本人任务状态与结果可直接做。
新建、修改、批准、运行、停止、取消、重跑、验收等写操作必须用户审批后调用现有任务业务，不能复制另一套状态机；保留expectedVersion与真实运行中断/后代归属。不要把状态标签当用户同意，不伪造human。
具体操作与智能任务卡复用OCV5-609的业务adapter，本帮助不定义第二种任务schema。尚未登记到正式执行目录的操作诚实报告未接入，不把跳转看板称为已执行。

## 任务审批卡（present_task_approval）与验收细则
- 任务单仍需用户本人批准（backlog）或验收（waiting_human）时，调用 MCP `present_task_approval`（id 用面板返回的 identifier）贴审批卡并立刻结束本回合；用户点选会以本人身份改单据。
- 不要让用户去打开任务面板，不要用选择题卡或 `task_approve` 代替人确认。
- backlog 须先贴卡、等批准后再派发执行（`delegate_task`/`send_to_agent`），严禁一边已派后台开工一边又贴「批准开工」卡自相矛盾；用户已在本对话明确拍板开修时直接 `task_approve` 推进到 ready，不再重复贴卡。
- 子 agent 环境会 skipped；一条回复最多 4 张审批卡。
- 任务验收默认由用户确认；用户明确授权且接口支持时，Agent 可用 `oc-task ticket done`（带 `expectedVersion`/`reason`/`evidence`）关单：先读任务及评论并核真实交付证据，写后回读状态与审计；盘点标签不算授权，不得冒充 human，取消与重开由人操作。
