# v5 前端版本握手 + 安全点软刷新 + dist 资产保留

日期:2026-07-07 · 分支:feat/v5-web-version-handshake · 背景事故:uid=4 手机长驻旧 bundle,
修复(v5-2a1c24a8)上线后仍撞 CODEX_BILLING_GUARD——前端热修复送达完全依赖用户手动刷新。

## 一类问题

1. **旧前端长驻**:SPA 标签页(尤其移动端)可跑几小时/几天前的代码;dist 一天部署 10+ 次,
   每次都在制造版本偏斜窗口。
2. **部署竞态 404**:`rsync --delete` 秒删旧哈希资产;拿着旧 index.html 的客户端拉 JS 404 白屏
   (07-07 07:31 实测发生)。

## 方案(权威源与机制)

### 版本身份(单一权威 = dist/index.html 的 `<meta name="oc-build">`)
- vite build 插件(仅 build,dev 无 meta → 功能恒 inert):对最终 index.html 内容取
  sha256 前 16 hex,注入 `<meta name="oc-build" content="…">`。内容派生 → 无实质变更的
  重复构建 id 不变,不会造成无谓刷新。
- 服务端读同一个文件:`createFrontendBuildProbe(distDir)`(mtime + 5s TTL 缓存),
  cli launcher 把 webRoot(spa 时)经 `registerCommercial(options.webDistDir)` 注入,
  bridge 收 `getFrontendBuildId`。**不引第二套路径推导**。
- 客户端读自己 DOM 里的同一 meta。

### 握手通道(WS 一条,不加轮询)
- userChatBridge 在 userWs accept 时(auth 前,build id 本就公开)发一帧
  `{type:"sys.frontend_build", build}`。
- 依赖既有纪律:改 dist 必重启 master → 全部 WS 重连 → 全员收到新 id。
  该纪律从"缓存约定"升级为"机制承载",由 deploy-v5.sh --dist 固化。

### 客户端 reload governor(防无限刷新硬机制,缺一不可)
- **G1 目标一次性**:每个 server build 目标,本 tab 只允许一次自动 reload
  (sessionStorage 记录,跨 reload 存活;reload 后仍不匹配 → 只挂手动刷新横幅,永不再自动刷)。
- **G2 全局冷却**:任意两次自动 reload 间隔 ≥ 10min(密集发版只吃最后一版,冷却结束自动重估)。
- **G3 storage 不可用 → 永不自动 reload**(G1 无法持久化时宁可只出横幅)。
- **G4 安全点**:所有 busy 探针为假(无在飞 turn、composer 无草稿/附件)且距最近用户输入
  ≥30s 才 reload;不安全则每 5s 重估,挂起 >5min 出横幅(带「立即刷新/稍后」)。
- **G5 形态校验**:双端 id 均为 8-32 hex 且不相等才动作;dev/meta 缺失恒 inert。
- 不比服务器时钟(全部 Date.now 本地域,遵守 B 类红线)。

### dist 部署收口(deploy-v5.sh --dist)
- vite build → **先** 加法 rsync assets(无 --delete)→ **后** 替换根文件
  (--delete --exclude assets):新 index.html 永远只引用已就位资产,部署窗口内也无竞态。
- GC:assets 下 mtime +14 天(= 14 天未被任何构建重新 ship)删除。
- restart master + smoke:线上 `/` 的 oc-build 必须等于本地构建值,fail-closed。
- 取代 playbook 手敲 rsync,单一部署入口。

## 显式不做(登记债)
- idle-timeout 中断被前端标成"服务重启中断"(server.ts hello 推送硬编码
  `interrupted:'service_restart'`)+ 自动续写未按中断原因分流——涉及 turn outcome 语义
  与计费策略,另开单。触发条件:用户投诉"没让它续它自己续(计费)"或误标文案再被报。

## 生效面
master(cli/commercial/bridge)+ dist(web-react)+ scripts + docs;**不涉容器 runtime image、不涉 egress**。
