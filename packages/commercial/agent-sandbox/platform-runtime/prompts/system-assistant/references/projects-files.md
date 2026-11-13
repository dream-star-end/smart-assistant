# 项目、工作区与文件
项目支持创建、名称/颜色/指令编辑、置顶排序、归档/恢复、删除/30日恢复、工作项目绑定；未分类组有专门限制，不当普通项目操作。
文件支持上传、搜索、预览、下载、常用共享背景、版本历史/恢复与删除。只取当前请求需要的目录或摘录，不扫描所有文件。上传需本人选择文件或明确现有文件引用。
所有改变系统资源的动作先审批，展示目标、项目/会话范围、文件数量、删除与定时任务关联。项目上下文绑定保留expectedVersion；遇并发变化重新预览，不覆写。普通开发任务的工作区源码/成果编辑不等同平台系统设置写，沿用当前任务授权。

`projects.list`, `projects.get`, `projects.deleted.list`, `project.assets.list` and `sessions.workspace-policy.get` are own-resource PG reads. Project instructions require includeInstructions=true; asset listing omits URLs, file paths and excerpts. They do not create board projects or repair file state.
