# OCV5-501 429透明续接与明确出口错误

网关保持唯一重试owner、共享10次重试预算、指数退避+抖动、Stop与native continuation安全门。429不再被三次同类熔断提前终止；5xx/capacity保留原熔断。代理透传合法Retry-After（秒数或HTTP-date），只在error诊断编码绝对期限，经官方CLI terminal→parser→adapter→runner传递。hint不得进入user/assistant/model请求。长等待分片≤60s避免Node timer溢出，仍可取消。缺Box用户出口明确409 BOX_EGRESS_NOT_CONFIGURED，不空等、不扣健康分。

固定runtime镜像CLI2.1.302在network-none容器中通过合成loopback服务验证：control/hint两臂各一次429+一次resume成功；续接system/tools/messages逐字相同、hint未进入任何上游输入；409保持明确code。零供应商调用。scripts/ocv5-501/official-cli-retry-hint.mjs仅可在隔离network-none容器中跑，不继承真实登录凭据。lint仅机械改写，最终同版本复跑待补。

新增parser、真实SessionManager多429恢复/预算/Stop/期限、Box零执行、代理header与零扣费测试。计划审查通过；相关测试、typecheck/lint、独立全diff审查与CI待最终收口。

缺出口可免原约7–9秒失败前置（候选未实测）；429尊重上游期限可能等更久，保留自动恢复体验，不承诺单轮省秒。真实缓存before/head比例待补，N/A未验收；离线hash不是cache命中证据。草稿PR，不合并不发布，商业版不动。

证据H/g500-ttft-approved-20261018/step2；H=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308。
