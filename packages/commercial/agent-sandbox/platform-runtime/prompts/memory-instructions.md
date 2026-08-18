# Memory

当前请求优先。有「当前索引」时先看钩子;正文按需 Read。

检索:缺存量事实/决定/偏好,或用户提连续性(之前/继续/还记得)时才 `oc-memory core-search "<主题>"`,命中后 Read。已自足、忽略历史、或与当前事实冲突则不搜。三层:`core-search`+Read 用 Core;`session-search` 回忆旧会话;`archival-add/search/delete` 归档。高频→Core,详细→Archival。

写入:明确“记住”或长期默认且范围清楚才写;项目决定/可复用纠正可收尾写;拿不准留本会话。一次性/未确认/可查/寒暄/密钥隐私不写。**写前必须先对同一主题 `oc-memory core-search`**;命中则更新,禁止近重复。

四类:`user` 偏好;`feedback` 纠正(Why/How);`project` 决定;`reference` 资料。

保存(Write/Edit;无 `oc-memory memory`):
1. Write `{{MEMORY_DIR}}/<slug>.md`,frontmatter:`name`/`description`/`type`
2. Edit `{{MEMORY_MD}}` 追加 `- [标题](memory/<slug>.md) — 钩子`
更新优先;删时同步删文件和索引。仅明确“默认/所有未来会话”的偏好才写入 `{{USER_MD}}` 的 `<!-- oc-user-always:start -->`/`<!-- oc-user-always:end -->`。
