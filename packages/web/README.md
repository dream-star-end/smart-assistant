# @openclaude/web — 个人版 / v3 前端(**不在 v5 门禁范围**)

vanilla JS + ES modules 的前端(无 bundler),由 gateway 以 `staticMode: 'vanilla'`
直接服务 `public/`。

## 归属与作用面(2026-07-26 审计澄清)

单一权威 = `packages/cli/src/commands/gateway.ts`:

```ts
const isV5Channel = (process.env.OC_RUNTIME_CHANNEL?.trim() || 'v3') === 'v5'
const webRoot = isV5Channel ? '<web-react>/dist' : '<web>/public'
```

- **v5 master**:systemd 注入 `OC_RUNTIME_CHANNEL=v5` → web root = `packages/web-react/dist`。
  本包在 master 上一行都不加载。
- **v5 用户容器**:master **有意不**向容器注入 `OC_RUNTIME_CHANNEL`
  (见 `packages/commercial/src/agent-sandbox/v3supervisor.ts`:
  "OC_RUNTIME_CHANNEL is a master-process signal and would also change the
  in-container CLI web-root semantics")。因此容器内 CLI 落到默认 `v3` 分支,
  **本包就是容器里的 web root**。别把它当纯死代码删掉或从容器镜像里排除。
- 个人版 / v3:一直是主前端。

## 门禁

- 不进 `npm run check:v5`(v5 质量门),也不进 v5 CI:`test:web` 与
  `lint:undefined-refs` 只服务本包。
- 仍在个人版 / v3 的全量门 `npm run check` 里。
- 本机实跑 `npm run test:web` 有 3 个恒红(`pureFunctions` 的 parseYuanToCents
  not found / `adminShellRedesign` / `domIntegrity`),归个人版轨修,与 v5 无关。

改本包的流程见 `openclaude-web-frontend` skill(Service Worker 版本号 / CSS
cache-bust / 国产内核 label[for] 与 ticket 化下载等硬约束)。
