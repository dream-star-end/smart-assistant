# `deploy/` — v3 商用版 ⚠️

**v3 商用版 deploy entry 是 [`scripts/deploy-v3.sh`](../scripts/deploy-v3.sh),不在本目录。**

## 当前内容

- `legacy-master/` — 个人版(45.32 master / `openclaude`)早期 deploy 资产,2026-04-20 导入后无人维护。**与 v3 商用版无关**,归档在此仅保留 git 历史,后续也许会迁去个人版仓。

## 注意

- `packages/commercial/agent-sandbox/build-image.sh` 的 rsync 已 `--exclude='/deploy/'`,本目录任何内容**都不会进 v3 runtime 容器镜像**。
- 历史上 `packages/commercial/src/agent-sandbox/types.ts` 注释里提到 `deploy/commercial/agent-runtime/agent_seccomp.json`(T-51 seccomp profile),那条路径**当前并不存在**(commercial/ 子目录从未建立),只是计划性引用。
- 如果某天要把 v3 deploy 相关脚本归口此目录,请新建 `deploy/v3/` 而非平铺顶层,避免再混进个人版资产。
