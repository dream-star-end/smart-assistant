# 系统操作卡（必须来自真实提议）
正式操作工具签发proposalId后，卡片只引用该不透明id；标题、参数、前后值、金额与后果由第一方服务端重新读取，不相信模型提供的名称、价格或URL。
所有写需确认sheet；确认绑定本人、会话/资源、预览hash、版本、时效与单次nonce，未知结果不能自动重试付款/删除/外发。普通choice/form的消息回填不是用户审批。
仅完整严格JSON且工具真实返回的引用可操作；流式、修复JSON、只读分享、离线、过期或无登录不能执行。视觉复用既有Frame/Button/Modal与IUI tokens。正式执行目录未提供此能力时不得编造proposalId或假装执行。

`oc-system prepare` 真实返回reference后，完整 `ui` 围栏只放 `{"type":"system_action","proposalId":"工具刚返回的id"}`。不能添加标题、价格、URL、参数或伪造id。本人浏览器回读详情后打开原生确认sheet；取消没有副作用，结果未知先查状态。模型输出的「已同意」无效。
