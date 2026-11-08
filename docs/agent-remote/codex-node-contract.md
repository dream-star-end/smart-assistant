# Codex 远端节点接口 v1（OCV5-746 · 段 1–4）

状态：代码实现契约；不代表已部署或 executionReady。段4改变 CC controller hash，原生 CLI hash 和旧协议不变；须由主控重新安装 guard。
基线 codex-cli 0.167.0；P0 节点事实高于旧设计。不得使用不存在的 environments:[]。

## 入口与部署

独立 `codex-host-controller.py <role> <generation-root>`；角色 `provision`、`launch`、
`tool-socket`、`stop`、`fence-stop`、`prove-stopped`。新 SSH guard 单独授权，不能把新版 source 塞进旧 cc guard。
所有 argv 为 `/usr/bin/python3 -I -B <已安装controller绝对路径> <role> <root>`，精确shell单引号序列化；
guard配置由root拥有，controllers数组记录path/sha256，完整bundle祖先路径必须root-owned且非组/全局可写。
只接受第一个版本的新执行，旧版本仅stop/fence-stop/prove-stopped；不接受任意命令/env。
主控负责安装 bundle、准备稳定 profile 与登录授权、更新 guard；本段不手动安装正式节点文件。
实验仅 /tmp/oc-codex-*。不得开启 SSH ControlMaster。launch 必须在 master 准入/扣费放行后调用。

provision stdin 为单行 JSON：manifest + catalog（tools）+ modelList（model/list 全分页结果）+
modelCatalog（CLI models_cache 原料）。目录只取 modelList 真实出现的 upstream model，不能 cache 兜底。
manifest 绑定 operationId/runId/generation/profileId/authEpoch/model/nativeThreadId、CLI artifact digests。
稳定 CODEX_HOME 由受管 registry 指向；不从请求自由指定用户项目；本段不提供登录/迁移/自动刷新回写工具。
同账号多个 app-server 直接共用同一 CODEX_HOME；无账号级 AUTH 独占、认证复制或额外续期。
各 generation 的 APP/SOCKET writer 与停止 fence 保留；master 按 (node,engine,profile) 独立默认5槽。

## 输出与工具通道

launch stdout 为 JSONL 包络，`version:1,engine:"codex",kind,seq,operationId,runId,generation`。
kind=`ready|stdout|stderr|error`；stdout payload 是原始 app-server JSON 对象，不能改成 Claude 帧。
READY：stderr `CODEX_REMOTE_READY protocol=1` + ready 包络（cli/catalog/policy/argv hashes）。
READY 仅表明受限进程域已准备；原生 initialize/thread/start 成功仍由调用者验证，不能提前派 turn。
stdin 为原生 JSONL；只准 initialize/initialized、model/list、account/read、MCP 状态、thread/start/resume、
turn/start/interrupt、thread/read；模型/只读/never/cwd 固定，threadId 只接受已绑定原生线程。
不透传 config/write、command/exec、shell、dynamicTools、额外 MCP、任意 provider/config override。

固定 MCP server=`ocbridge`。独立 tool-socket stdout v3 JSONL：
`{version:3,engine:"codex",kind:"tool-request",seq,body:<base64 JSON>}`；response 同 seq/status/body。
请求保留 operationId/runId/generation、nativeThreadId/nativeTurnId、callId、rpcId、server、name、arguments、inputSha256。
`_meta.callId == item/started(mcpToolCall).item.id`；不是 _meta.itemId，也不是 MCP rpcId。
必须同时匹配 thread/turn/server/tool/canonical arguments SHA256；节点 observation 门不替代 master 独立观察门。
master 未观察/未授权时绝不能发送执行成功响应。尝试先 O_EXCL+fsync；未知或重复绝不重试。
响应必须回显全部身份、version=3/engine=codex、ok=true、result={content,isError}；资源list为空/read拒绝。

## 策略与停止证明

五字段固定：tool_mode=direct，multi_agent_version=disabled，experimental_supported_tools=[]，
apply_patch_tool_type=null，supports_search_tool=false；目录/argv/策略摘要写 journal。
never + read-only + web_search disabled；固定 MCP required=true/default_tools_approval_mode=approve。
禁用 shell_tool/unified_exec/view_image/image_generation/multi_agent/multi_agent_v2/apps/plugins/
browser_use/computer_use/in_app_browser/sleep_tool/skill_search/tool_suggest/goals/hooks/skill_mcp_dependency_install；
启用已核验的skip_host_skill_discovery，禁节点技能自动发现（不禁code_mode_host，避免破坏MCP）。
0.167.0 实测无 --ignore-user-config：以空隔离 HOME/XDG/cwd、无用户/祖先/系统配置来源的预检替代；
存在不可确认的 config/AGENTS/hooks/skills 来源时拒绝，不删除用户配置。strict-config 仍必须使用。

item 白名单：agentMessage/reasoning/userMessage/contextCompaction，以及固定server的mcpToolCall。
白名单外 item 或任何 server→client request（本期 request_user_input 也拒绝）立即 fence tools、
尝试 interrupt、停止全 scope、错误终态。源头去工具是主防线，事件守卫仅第二道。

stop/prove-stopped 输出 version=1/engine=codex，绑定 operation/run/generation/profile/authEpoch/bootId、
每个 scope 的名字/cgroup/初始 inode 与 stopped 事实。仅 systemd 终态及已记录 cgroup 域为空/销毁、
writer 已释放、socket 无监听时 `remoteStopped:true`。缺生命周期、boot 变化、超时均 unknown，不能释放租约。
工具 socket 也有独立 scope；控制通道不占模型槽。远端 proof 不代表容器工具已停。

错误标签：CODEX_POLICY_REJECTED、CODEX_PROFILE_BUSY、CODEX_CLI_MISMATCH、CODEX_MODEL_LIST_FAILED、
CODEX_NATIVE_ITEM_REJECTED、CODEX_SERVER_REQUEST_REJECTED、CODEX_RPC_REJECTED、CODEX_STOP_UNKNOWN。
错误仅输出固定标签，不反射凭据/任意 stderr 内容。usage 原帧保留；段 2 按轮末 total 差值计费，禁止 last 相加。

## hostd 探针交接

Codex runner_mode=app-server，probe_schema_version=2，source=codex-app-server:model/list，
account_observed/models_observed/auth_present 分离；freshness=cli-observed；execution_ready 永远 false。
全分页完整成功才返回模型，保留 effort/default/modalities/service tiers 原值（缺失不补）。
profile 精确 CODEX_HOME（default/.codex、.codex-name、accounts/x/.codex 或 accounts/y）；
失败 profile 保留错误原因与空目录，不借 cache、auth.available_models 或小启动器硬编码兜底。
model/list/account/read 不证明实时上游授权。不上架、不过账，段 2/3 另行验收。

## 崩溃与准入持久门

runtime 的持久资源 claim 按 generation root 隔离；父进程被杀不会释放资格。
runtime 占用仅独立 stop/prove-stopped 核同 root/operation/run/generation 后解除。
probe 使用独立 PROBE-CLAIM.lock / PROBE_ACTIVE.json，不持有运行账号锁；下次同 profile 探针校验owner身份记录及boot，
先持久 unit.revoked，再停止旧scope，拿到 PROBE-LAUNCH 门并证明停止才清 claim；未知仍隔离。
scope 内 exec 前门检查同 unit claim/revocation，已排队的旧 worker 不能迟到启动 CLI。
人工不得靠TTL/删除claim恢复；boot变化先隔离待主控reconciliation，不在本段自动释放。

## 已验与尚未接线

用例覆盖真实stdin/stdout/AF_UNIX和容器marker副作用；段4须额外验真实同账号双会话、
小slice拒新不伤旧会话、各generation停止证明。CC正式原生双会话按授权留上线后验，新guard未安装。
段2负责master独立原生观测门、准入、收据v3/累计基线和模型目录上架；
段3负责容器真实CCB宿主与adapter。此处测试容器marker桥不是CCB全工具E2E，不宣称收费上线。
正式profile登录迁入仍由主控另行授权；段4临时共享home只读bind原auth（同inode），不复制认证、不改原登录。

独立控制角色失败退出126，stderr为`CODEX_NODE_REJECTED_OR_STOP_UNKNOWN`；没有合法true proof即unknown，
禁止把退出状态/空stdout猜成停止成功。launch已进入流时，具体固定原因在error包络code中。

段2 master契约见 [codex-master-contract.md](codex-master-contract.md)，包括binding v3、relay HTTP、原生观察门、五维收据与停止/财务分离恢复。

段2新增 `fence-stop`：stdin 单行原 manifest，与 provision 从根目录不存在检查到全部发布共享根外
`.根名.create.lock`。对尚不存在/尚未发布 manifest 的根，原子发布 manifest 与耐久 STOPPING 屏障，
再执行原 stop/proof；已有 manifest 必须完整匹配。manifest 经临时文件 fsync + 锁内原子 rename 发布，
崩溃可留未发布临时文件但不能留下半个权威 manifest。迟到 provision/launch 不能越过屏障。
已有坏身份/不可证明的生命周期仍拒绝；空 scopes 的独立 proof 才能证明没有宿主执行。
该新增角色属于 stop-only，不扩大旧版本的 launch/provision 权限；正式 guard/bundle 仍由主控部署。

## 段4资源准入与发布顺序

`remote-engine-resources.py` 为短节点锁下的准入模块，不是登录锁。每 lane 在 socket 启动前
一次性持久预留 app+socket **硬上限**，直至全部 scope 独立证明为空后才释放；probe 也预留预算。
默认每 engine slice MemoryMax=1536 MiB、TasksMax=768；每 scope TasksMax=128。
Codex app=448 MiB（实测约260 MiB，留约1.72倍），CC app=640 MiB，socket=32 MiB，headroom=192 MiB。
节点预算默认 MemTotal−768 MiB（OS/SSH/controller余量），全部未释放claim硬cap总额加新预算/headroom
不得超过此固定预算；同时检查slice承诺额、slice当前用量与MemAvailable。不得用异步resident读数
抵扣承诺额。2G机器因此不保证物理可跑满5槽；不足直接拒绝，不排队、不缩正在跑的slice。
socket内CLI/native校验流式哈希；版本查询直接执行已核hash的native，避免Node启动器占满socket cap。

配置来源：root-owned且不可组/全局写的 `/etc/openclaude/remote-engine-resources.json`，键名
`CODEX_MEMORY_MAX/CC_MEMORY_MAX`、`*_TASKS_MAX`、`*_APP_MEMORY`、`*_SOCKET_MEMORY`、
`*_SLICE`、`*_PROFILE_MAX_LANES`、`NODE_MEMORY_BUDGET`、`HEADROOM`（字节）；实验可用同名
`OC_REMOTE_` 环境变量覆盖。`RESOURCE_ROOT`默认`~/.oc-remote-resources`，必须跨底座共用。
正式guard不接受任意env，所以正式容量配置使用上述root文件。未知claim不得TTL删除。

CC正式通过 `python -I -B -c` 载入：资源模块压缩内嵌在controller，不能依赖`__file__`；
`attach_self`把controller PID移入有界scope后原地exec，保持旧PID/锁/停止语义。
Codex bundle必须同目录包含资源模块，hostd核其digest，controller再核hostd digest。
资源模块每次修改后运行 `python3 scripts/agent-remote/sync-engine-resource-bundle.py` 同步两条pin链。
先安装新bundle/guard、处理旧无资源claim的在途lane并独立证明停止，再开放新并发；不得混跑
无预算旧lane并声称有新资源保护。本任务不安装正式文件、不升级节点、不启用profile。
