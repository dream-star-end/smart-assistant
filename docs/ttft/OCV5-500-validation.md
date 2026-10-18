# OCV5-500 非Codex链路首字计时

在可见process文本的双rAF提交处补首字paint；按probe对象WeakSet去重，取消不提前认领，原trace/cmid/active闸与持久化过滤不变。引擎/CCB代理/原生relay增加只读阶段时钟，所有进程回调绑定冻结trace与generation，不额外读取流、不改system/tools/messages/cache_control。Grok relay只记录HTTP请求ID/slot，不把无法关联的平台trace猜成已关联；AG relay首byte取现有唯一reader；两原生relay不伪造first_text或ready。

预期直接TTFT节省0秒，本步用于定位。风险是少量CPU/日志开销和前端paint时序，采用真实MessageList、取消/remount、晚到probe、分块SSE/UTF8、backpressure与usage不变测试。计划独立审查通过；相关web与backend测试通过，最终typecheck/relay回归、全diff独立审查、托管CI继续运行。

缓存硬门：base与候选真实cached-token比例尚待同账号合法对照，N/A不记0，不宣称通过。真实网页candidate仅拟用单浏览器静态GET资产覆盖，不改API/WS/Origin或现网配置；此方式只能验前端，不得冒称候选后端已上线。PR保持草稿，不合并不发布。商业版未操作。

证据：H/g500-ttft-approved-20261018/step1 与 paid-evidence；H=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308。
