# v5 codex 官方 OAuth 数据面强制代理转发 — 帧 / override 形状(feat/v5-codex-oauth-egress)

方案:/root/openclaude-scratch/v5-codex-oauth-egress-plan-2026-07-03.md(A1-A3d/B4-B6)。
本文是 `__oc_codex_route` 帧字段与容器侧 override 的形状权威(B4 要求)。

## 1. 帧字段 `__oc_codex_route`(master-owned,bridge 注入)

`inbound.message` 帧上的私有路由字段。**client 提供的同名字段在 bridge sanitize
阶段强制剥离**(userChatBridge.ts CLIENT_PRIVATE_FIELDS),只有 master
(userChatBridge codex 分支)可以写入。两种形状:

### official_oauth(v5 主通道)

```json
{ "kind": "official_oauth" }
```

- **exact-shape marker**:恰好一个 key。带任何多余字段 → 消费端拒绝(null)。
- bridge 侧来源:createCommercialCodexRoute 判定选中 official_oauth 组
  (userChatBridge.ts codexRouteFrame 构造,本分支未改动 —— 既有形状即为 v5 形状)。
- **v5 语义与 v3 不同**:v3 把它消费成"空 override 哨兵"(抑制 env、直连官方);
  v5 把它消费成 **loopback relay override**(见 §2),数据面强制走
  容器 loopback relay → master egress 账号绑定代理。

### api_relay(v3 兼容;v5 DB 无启用行,不会出现)

```json
{
  "baseUrl": "http://127.0.0.1:18789/internal/v3/codex-relay/route/<64hex>",
  "modelProvider": "api111",
  "providerName": "Yunwu",
  "wireApi": "responses",
  "preferredAuthMethod": "apikey",
  "disableResponseStorage": true
}
```

## 2. 容器侧消费链(gateway,A1)

```
dispatchInbound (server.ts)
  → _buildSafeCodexRouteOverride({ agent, model, rawRoute, officialRelayPort })
  → sessionManager.submit(..., opts.codexRoute)      // 每 turn 显式 set;缺省 = null 清除
  → runner.setCodexRoute(route)                       // CodexAdapter → CodexAppServerRunner stash
  → runTurn 比对 route 签名 → 变化则 shutdown + respawn
  → ensureSpawned: buildCodexProviderConfigArgs(process.env, route) 拼 -c argv
```

`_buildSafeCodexRouteOverride` 校验(安全面,写严):

- 门控:`resolveEngine(model, agent) === 'codex'`(单点收口;v5 任何 agent 可骑 codex 底座)。
- official marker:exact-shape,否则 null。
- api_relay:未知字段即拒;baseUrl ≤ 512 字符、仅 `http://127.0.0.1` +
  `/internal/v3/codex-relay/route/` 前缀;modelProvider `^[A-Za-z0-9_-]{1,64}$`;
  providerName ≤ 128。
- 任何拒绝 → null = 本 turn 无 override(v5 部署 env 无 OC_CODEX_* 六键,
  容器亦无任何上游凭证,等价 fail-closed)。

### official_oauth 消费产物(CodexProviderConfigOverride)

```ts
{
  modelProvider: 'oc_chatgpt_official',          // CODEX_OFFICIAL_RELAY_PROVIDER_ID
  baseUrl: `http://127.0.0.1:${gatewayPort}/internal/v3/codex-relay/backend-api/codex`,
  providerName: 'OpenAI (OpenClaude relay)',
  wireApi: 'responses',
  preferredAuthMethod: 'chatgpt',                // auth.json chatgptAuthTokens 供 token
  disableResponseStorage: true,
  requiresOpenaiAuth: true,                      // → -c model_providers.<id>.requires_openai_auth=true
}
```

生成 argv(buildCodexProviderConfigArgs):

```
-c model_provider="oc_chatgpt_official"
-c model_providers.oc_chatgpt_official.name="OpenAI (OpenClaude relay)"
-c model_providers.oc_chatgpt_official.base_url="http://127.0.0.1:18789/internal/v3/codex-relay/backend-api/codex"
-c model_providers.oc_chatgpt_official.wire_api="responses"
-c model_providers.oc_chatgpt_official.requires_openai_auth=true
-c preferred_auth_method="chatgpt"
-c disable_response_storage=true
```

codex CLI 对 requires_openai_auth=true 的自定义 provider 用 auth.json 的
ChatGPT access token 发 `Authorization: Bearer …` → 发到 **loopback relay**,
不直连 chatgpt.com。

## 3. relay 数据面(B5)

```
codex CLI → 容器 gateway /internal/v3/codex-relay/backend-api/codex/responses
  (v3CodexRelay.ts:Authorization → x-openclaude-upstream-authorization,
   容器 token 认证到 master)
  → master/egress internalCodexRelay 非 route 路径
     - 容器身份校验 + agent_containers.codex_account_id 绑定账号
     - resolveCodexAccountEgressDispatcher fail-closed(无绑定/无代理/账号非 active → 503)
     - 路径映射:CODEX_OFFICIAL_UPSTREAM_BASE_URL = https://chatgpt.com/backend-api/codex
       (代码内常量;env base 仅 v3 api_relay 兼容,relay base path 撞 official 时 official 赢)
  → 账号绑定 egress 代理 → chatgpt.com
```

Authorization 语义(非 route 路径):

- 容器带了上游 Authorization → 原样转发;上游 401 → 记
  `upstream_401_container_auth_fail_closed` 日志 + 401 透传,**绝不静默改用 DB token 重试**。
- 容器没带 → fallback 代注:按绑定账号 DB 读当前 access token(`auth_fallback_injected`);
  读不到 / 解密失败 → 503 `CODEX_ACCOUNT_TOKEN_UNAVAILABLE`。

## 4. supervisor(B6)

v5 channel(`OC_RUNTIME_CHANNEL=v5`)本地 provision:codex 账号绑定失败 /
codex_account_id=NULL 时**不挂** legacy 共享 codexContainerDir(v3 channel 行为不动)。
容器内 `$CODEX_HOME/auth.json` symlink dangling = 干净未授权,gpt-5.5 fail-closed。
