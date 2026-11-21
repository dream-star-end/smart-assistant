# `deploy/` — v3 商用版 ⚠️

**v3 商用版 deploy entry 是 [`scripts/deploy-v3.sh`](../scripts/deploy-v3.sh),不在本目录。**

## 当前内容

- `v5/`、`v5-selfhost/` — v5 商用版与个人自托管版部署配置、systemd unit 与发布清单。
- 原 `legacy-master/`（45.32 master 早期个人版 deploy 资产）已于 OCV5-829 清理移除，历史记录保留在 git 中。

## 注意

- `packages/commercial/agent-sandbox/build-image.sh` 的 rsync 已 `--exclude='/deploy/'`,本目录任何内容**都不会进 v3 runtime 容器镜像**。
- 历史上 `packages/commercial/src/agent-sandbox/types.ts` 注释里提到 `deploy/commercial/agent-runtime/agent_seccomp.json`(T-51 seccomp profile),那条路径**当前并不存在**(commercial/ 子目录从未建立),只是计划性引用。
- 如果某天要把 v3 deploy 相关脚本归口此目录,请新建 `deploy/v3/` 而非平铺顶层,避免再混进个人版资产。
