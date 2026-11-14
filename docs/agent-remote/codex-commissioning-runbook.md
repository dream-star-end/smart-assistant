# OCV5-746 自用版 Codex 远端上线手册

> 实现补齐版 · 2026-11-08 UTC · 基线 f743ce76d + 本轮 commissioning 提交（精确 SHA 见 commissioning-result）。本轮不部署、不写生产库、不修改节点。工具已实现，**仍须上线新 master/runtime 后真实跑成功、独立 apply --confirm 才能启用**；测试包不能冒充真机包。

索引（按执行顺序）：0范围/变量 → 1CC兼容 → 2迁移结论 → 3节点安装/钥匙/资源 → 4唯一登录迁移 → 5发布列车 → 6容器更新 → 7probe/验收/manifest/上架 → 8业务验收/回退 → 9用户决策。

未写完整目录的Python文件均在 `scripts/agent-remote/`；未写完整目录的 `remoteBrainPool.ts`、`codexRemoteProfile.ts` 均在 `packages/commercial/src/account-pool/`；其余TS路径默认相对 `packages/commercial/src/`，`gateway/src/`指 `packages/gateway/src/`。行号固定于上述SHA。shell块中的变量均有明确来源或 `:?` 停止门；不要把多台机器的块串成一次脚本运行。

## 0. 执行范围、固定值与硬停止条件

**源码锚点**：`f743ce76d4d76298d87725342c8b9e587d0764bb`，旧代码锚点以该基线为准；新增工具锚点见各节。本轮在同一工作树补齐实现，精确提交见交付结果。**现场信息来自主控本次只读核实**：live 为 rel-a505ddb15、库到0333、节点136.86.253.46/box、CC guard 保留两个旧摘要且已追加 fcfb1424…、执行钥匙目录、原登录0775。用户更新：节点已升级 e2-standard-2（2核7934MiB），IP已静态化，指纹不变。本编写回合没有再登录节点/查询生产库，执行人须在开工时复核，漂移则停。

- `[H]` = 自用版宿主 root shell；容器里需经 `host '…'`，不要把容器 `/opt/openclaude` 快照当宿主仓库。
- `[N]` = **节点管理员 root shell**（由已批准管理钥匙登录 ocadmin 后 sudo）。强制命令执行钥匙不能用于安装/传文件。主控已指定 ocadmin 管理通道；不假设 root SSH 已开。
- `[A]` = 自用版管理员 Bearer access token；不能用 gateway token、容器 secret 或自行伪造 JWT。token只在私密 shell/0600配置中使用，不写报告。
- 所有写命令均是**未来获授权后执行**；本文不代表上线、迁登录或写库授权。

[H] 设置（不输出凭据）：
```bash
set -euo pipefail
export SRC=/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-746-codex-remote
export SHA=$(git -c safe.directory='*' -C "$SRC" rev-parse HEAD)
# 必须与 commissioning-result 的已审提交一致；不是任意后续 HEAD。
export CANON=/opt/openclaude/openclaude-v5-selfhost
export NODE_HOST=136.86.253.46 NODE_USER=box NODE_PORT=22
export KEY_ID=oc-rpool-7ba0f86e
export EXEC_DIR=/etc/openclaude/remote-pool-keys/oc-rpool-7ba0f86e-exec
export CC_SHA=fcfb142422cb605363a44c606f1a0b049aca667ad8eeda3a9c547d978369177b
export CODEX_SHA=3412245a1944933e6a7d0a4d64b7bc8c4122024b7ccdf84a1058787e71fc4f66
export HOSTD_SHA=f1e019dc2c65b1332155df0553ffbed913c010f458fa25215241aaf2edaffc14
export BUNDLE=/opt/openclaude/codex-remote/$CODEX_SHA
export OPS=/root/ocv5-746-deploy-$SHA
install -d -m 700 "$OPS"
test "$(git -c safe.directory='*' -C "$SRC" rev-parse HEAD)" = "$SHA"
test -z "$(git -c safe.directory='*' -C "$SRC" status --porcelain)"
(cd "$SRC"; sha256sum scripts/agent-remote/{cc5-host-controller.py,codex-host-controller.py,oc-remote-hostd.py,remote-engine-resources.py})
```
以上摘要必须完全相符；resource模块应为 `b3d05e9215e1e232fd959dd94580e9bc4371b2a5098d6634a460a3af0ae66a14`。**不要运行 sync 脚本再生成另一套未经审计字节。**

[H] 开工只读复核与后续DB助手（沿用正式脚本的env读取方式，不输出DATABASE_URL；本手册中的db命令都只用于自用版）：
```bash
DATABASE_URL=$(grep -E '^DATABASE_URL=' /etc/openclaude/commercial-v5-selfhost.env | tail -n1 | cut -d= -f2-)
test -n "$DATABASE_URL"
db() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }
test "$(db -Atc 'SELECT current_database()')" = openclaude_v5_selfhost
date -u +%FT%TZ
readlink -f /opt/openclaude/openclaude-v5-selfhost-live
db -v key_id="$KEY_ID" <<'SQL'
BEGIN READ ONLY;
SELECT version,applied_at FROM schema_migrations ORDER BY version DESC LIMIT 6;
SELECT id,label,ssh_host,ssh_port,ssh_user,key_id,controller_sha256,status
 FROM remote_agent_nodes WHERE key_id=:'key_id';
COMMIT;
SQL
```
必须恰好对应cc5-us/136.86.253.46/box/22；`key_id`不是从目录名随便猜的。现状与主控提供的0333/live/hash不符时先停下协调，不按旧现场继续。源码路径：`deploy-v5-selfhost.sh:60,75-82,1440-1442`；`remoteBrainPool.ts:786-808`。

上线总顺序：CC guard追加→节点bundle/资源/管理与probe通道→登录目录一次迁移→合并并推主线→列车迁移/切流/runtime更新→真实probe→独立真实验收→受审manifest落库→offer发布→正式业务验收。任何停止证明unknown、旧lane未排空、E2E证据缺失均不得通过删锁、改released、随填64位hash放行。

## 1. 发布前保持 CC 新旧兼容

### 1.1 三个不同摘要，不能混写

- CC controller `fcfb1424…` 是运行时通过SSH内联传输的完整源码摘要；CC guard `controllerSha256` **数组**核它（`scripts/agent-remote/cc5-ssh-guard.py:86-87,133-154`）。`1a50680c…`是R1之前段4旧字节，**不能替代本次hash**。
- Codex controller `3412245a…` 同时决定bundle目录、Codex guard和execution snapshot（`remoteBrainPool.ts:938-950`，下文未带目录名的 remoteBrainPool 均在 `packages/commercial/src/account-pool/`）。
- `remote_agent_nodes.controller_sha256=47d26c41…` 是**hostd探针摘要**，不是CC controller。`getRemoteHostdSha256()`读hostd文件（`remoteBrainPool.ts:205-225`），probe接受库中旧值或当前代码hostd值（`:1243-1253`），成功后回写实际hostd摘要（`:1266-1271,1400-1408`）。**不要把它改成fcfb/ad62**；真实新probe成功后应自然成为`f1e019dc…`，不需提前手工UPDATE。

### 1.2 只追加，不替换旧允许项

**主控已完成追加。本节写命令只在执行前核实确实缺少新hash时使用；已存在则跳过，不重写。**

[N] 先备份及记录摘要，然后原子改json；不碰CC authorized_keys行、不更换CC guard脚本、不改CC登录/CLI：
```bash
set -euo pipefail
CC_SHA=fcfb142422cb605363a44c606f1a0b049aca667ad8eeda3a9c547d978369177b
D=/root/ocv5-746-node-backup
install -d -m 700 "$D"
test ! -e "$D/cc5-ssh-guard.json"
cp -a /usr/local/libexec/oc-remote-cc/cc5-ssh-guard.json "$D/"
cp -a /home/box/.ssh/authorized_keys "$D/authorized_keys"
sha256sum /usr/local/libexec/oc-remote-cc/cc5-ssh-guard.py > "$D/cc-guard.sha256"
python3 - "$CC_SHA" <<'PY'
import json,os,sys,tempfile
from pathlib import Path
p=Path('/usr/local/libexec/oc-remote-cc/cc5-ssh-guard.json')
x=json.loads(p.read_text()); old=x['controllerSha256']; assert isinstance(old,list)
h=sys.argv[1]; assert len(h)==64
x['controllerSha256']=list(dict.fromkeys([*old,h])); assert len(x['controllerSha256'])<=8
fd,tmp=tempfile.mkstemp(dir=p.parent,prefix='.guard-746-')
with os.fdopen(fd,'w') as out:
 json.dump(x,out);out.write('\n');out.flush();os.fsync(out.fileno())
os.chown(tmp,0,0);os.chmod(tmp,0o644);os.replace(tmp,p)
PY
```
验证：
```bash
python3 - <<'PY'
import json,runpy
from pathlib import Path
p=Path('/usr/local/libexec/oc-remote-cc/cc5-ssh-guard.json')
a=json.loads(Path('/root/ocv5-746-node-backup/cc5-ssh-guard.json').read_text());b=json.loads(p.read_text())
assert all(v in b['controllerSha256'] for v in a['controllerSha256'])
assert {k:v for k,v in a.items() if k!='controllerSha256'}=={k:v for k,v in b.items() if k!='controllerSha256'}
assert 'fcfb142422cb605363a44c606f1a0b049aca667ad8eeda3a9c547d978369177b' in b['controllerSha256']
runpy.run_path('/usr/local/libexec/oc-remote-cc/cc5-ssh-guard.py')['load_config'](str(p))
print('CC guard old+new allowlist validated')
PY
sha256sum -c /root/ocv5-746-node-backup/cc-guard.sha256
cmp /home/box/.ssh/authorized_keys /root/ocv5-746-node-backup/authorized_keys
```
此时旧CC可继续执行；在旧版本上做一轮短CC对话+容器工具留作正控。追加hash不需重启sshd。**不宣称发布窗口零断流**：它消除hash拒绝；master/container切换仍须等在途会话空闲。

### 1.3 旧lane必须排空，新并发不得与旧无claim lane重叠

从排空开始到切流/新runtime验证完成，主控须维持“不提交新的远端请求”的短维护窗口；只查一次空闲不构成持续纳新栅栏。若无法维持，需另行批准临时暂停相关profile纳新并按原状态恢复，而不是篡改guard或强杀在途。

新资源账本只认识新controller的claim，旧CC lane不能隐形占内存（`docs/agent-remote/codex-node-contract.md:120-125`；`remote-engine-resources.py:152-198`）。先让真实在途会话自然完成，走平台停止/撤销取得独立证明；SQL查询bindings不得以TTL代替proof。若unknown，查停止链修复，不能直接UPDATE released。

[H] 对指定节点回读旧binding（0333已有这些字段，不提前引用0335新列）；应无任何非released行，再做DB快照：
```bash
db -v key_id="$KEY_ID" <<'SQL'
BEGIN READ ONLY;
SELECT b.operation_id,b.uid,b.session_key,b.state,b.updated_at
 FROM remote_agent_bindings b JOIN remote_agent_nodes n ON n.id=b.node_id
 WHERE n.key_id=:'key_id' AND b.state<>'released';
COMMIT;
SQL
# 人核以上结果为空，并确认节点旧CLI任务也已停止；有unknown就停，不执行后续发车。
test ! -e "$OPS/pre-0334.dump"
pg_dump --dbname="$DATABASE_URL" --format=custom --file="$OPS/pre-0334.dump"
pg_restore --list "$OPS/pre-0334.dump" > "$OPS/pre-0334.dump.list"
test -s "$OPS/pre-0334.dump.list"
chmod 600 "$OPS/pre-0334.dump" "$OPS/pre-0334.dump.list"
```
备份I/O/空间需预留。列车的`backup_installed_units_for_cutover`备的是unit/取证文件（`v5-selfhost-master-release-lib.sh:1807-1842`），**不是完整DB备份**，不能把它当pg_dump。普通故障只回代码、不恢复整库；整库恢复会丢备份后交易，必须另行事故审批与恢复演练，不在本手册一键执行。

回退：代码回到旧版后，旧摘要一直保留，通常**保留新hash比删掉更安全**（新lane仍要stop）。只有新lane全部独立证明停止，且回滚代码不再发新hash，才可用备份恢复CC json；不得恢复整份authorized_keys覆盖后来新增他人钥匙。

## 2. 迁移结论与发布门（节点准备完成后才实际发车）

**正式列车会自动应用0334–0337，不要另开一个手工迁移进程。**
- `scripts/v5-selfhost-master-release-lib.sh:1614-1680`：以库schema_migrations与候选requiredMigrations缺口为权威，分类失败则拒绝。
- `scripts/deploy-v5-selfhost.sh:2884-2893,3008-3019`：持同一切流锁、同一窗口先apply，失败不翻live；`:3023-3025`才开始原子切换。
- `scripts/v5-selfhost-master-release-lib.sh:1874-1885`：在封存release里运行 `PGOPTIONS='… -c openclaude.migration_profile=v5-selfhost' DATABASE_URL=… REDIS_URL=… COMMERCIAL_ENABLED=1 COMMERCIAL_AUTO_MIGRATE=1 npx --no-install tsx packages/commercial/src/db/migrate.ts`；不是容器octest，也不是从开发工作树apply。
- master启动另有auto-migrate，但必须 `controlPlaneEnabled && shouldAutoMigrate()`（`packages/commercial/src/index.ts:1394-1412`）；V5默认follower且仅`COMMERCIAL_AUTO_MIGRATE=0`关该开关（`:860-897`）。**不能因为注释写“默认开”就依赖启动迁移，更不能为了迁移临时打开leader。**
- 本批0335依赖0334、0337依赖0336，四份required已登记（`deploy/v5/release-metadata.json:201-204`；各SQL第1行）。保持原编号；本分支仅添加compat注释，无DDL改写。

命令、发车前合并授权、迁移回读及代码回退见第5节；不会提供绕过列车锁的裸生产apply命令，因为本次**确实支持自动迁移**。回退只退代码/runtime，不DROP新增列/表、不删schema_migrations记录（`deploy-v5-selfhost.sh:2878-2882`）。
## 3. 发布前：幂等安装器（宿主执行，先 dry-run）

实现：`scripts/agent-remote/codex-install.py`（参数/钥匙/SSH/oc-bridge打包与dry-run计划），`codex-install-node.py`（`login_layout`/`migrate_login`/`rollback_login` 登录目录迁移、root事务/回退、`managed` 受管文件CAS、oc-bridge树安装）。安装器**只接受 default**。`--dry-run`纯本地读源码，不联网、不读钥匙、不写文件；`--apply`/`--rollback`均需root和`--confirm`。

[H] 管理key应使用宿主实际路径，不把容器路径当宿主路径：
```bash
export ADMIN_KEY=/var/lib/docker/volumes/oc-v5-data-u3/_data/.ssh/gcp_cc5us_admin_ed25519
# 若实际宿主路径不同，用主控已核实的路径替换。安装器要求root属主、0600、无软链。
export KNOWN_HOSTS="$EXEC_DIR/known_hosts"
export PROBE_PUB=/etc/openclaude/remote-pool-keys/oc-rpool-7ba0f86e/id_ed25519.pub
python3 "$SRC/scripts/agent-remote/codex-install.py" --dry-run \
 --admin-key "$ADMIN_KEY" --known-hosts "$KNOWN_HOSTS" > "$OPS/install-plan.json"
jq . "$OPS/install-plan.json"
```
安装器不扫描/接受新指纹、不放宽权限。若现有管理钥匙属主是uid1000，**不要chown用户唯一原件**；主控在宿主受控目录创建仅root可读管理钥匙副本或提供已有root私钥路径，核公钥指纹相同后再用。私钥副本权限变更属于运维授权，不在本实现自动执行。

安装前须确认：Codex所有CLI/探针已停写；没有未证明停止的Codex lane根目录；没有会拒绝执行的`config.toml`/`AGENTS.md`/系统Codex配置；用户systemd/linger与cgroup v2前提满足；probe公钥与CC执行公钥不同。禁止安装器拿执行钥匙绕guard去sudo。

[H] 获得节点变更和停写授权后：
```bash
python3 "$SRC/scripts/agent-remote/codex-install.py" --apply --confirm \
 --host "$NODE_HOST" --admin-key "$ADMIN_KEY" --known-hosts "$KNOWN_HOSTS" \
 --key-dir "$EXEC_DIR" --probe-public-key "$PROBE_PUB" --profile default \
 | tee "$OPS/install-result.json"
```
顺序：root私有事务journal → 校嵌入依赖pin → 不可变bundle → Codex guard → **oc-bridge参考树** → 独立执行钥匙行/probe行 → 登录目录rename。每步保留恢复材料；同参数重跑以before/after CAS识别已执行步骤，不覆盖第三方变更。安装输出/guard/bundle都不含auth正文。

oc-bridge 步骤：安装器从源码树 `packages/gateway/box-bridge-mod/oc-bridge` 打包**与 master `loadBoxBridgeMod()` 相同的文件集/摘要**（跳过 `.claude-plugin/types`、`*.test.ts`、`tsconfig.json`），落到 `/opt/openclaude/box-bridge-mod/oc-bridge`，文件 root:root 0644、目录 root:root 0755、全部非组/其他写。缺少它时 hostd `compute_oc_bridge_digest()` 返回空，probe 以 `REMOTE_CC_BRIDGE_MOD_REQUIRED` 拒绝。dry-run 的 `ocBridge` 段列出目标、文件数与 sha256；apply 先校验收到字节的摘要与 packet 一致再落盘，重跑按 CAS 幂等。落盘后还按 hostd 同一规则重算**磁盘实际整棵树**并比对 packet 摘要：其他 master 版本残留的多余文件会改变 `compute_oc_bridge_digest`，此时安装以 `oc-bridge tree drift` 明确失败，须先人工清掉残留文件再装，不静默带病上线。

安装结果：
- `/opt/openclaude/codex-remote/<Codex controller sha>/`内恰有controller、hostd、fixed MCP、socket MCP、**remote-engine-resources.py**；文件root0644、目录root0755、全部祖先root-owned非组/其他写、无软链。已有bundle同名不同字节拒绝。
- `/usr/local/libexec/oc-remote-codex/codex-ssh-guard.{py,json}`；JSON字段`version,user,sourceIps,sshPort,rootPrefix,controllers`。最新controller在第一项，旧项仅供stop/proof。**CC guard脚本/JSON与CC authorized_keys执行行完全不动**。
- 宿主生成或复用`$EXEC_DIR/codex_id_ed25519`（root0600），不覆盖CC `id_ed25519`；节点新增`from="38.55.252.217",restrict,command="/usr/bin/python3 -I -B /usr/local/libexec/oc-remote-codex/codex-ssh-guard.py" ssh-ed25519 … oc-codex-commissioning-exec`。
- probe专用公钥的forced-command改为新bundle的`oc-remote-hostd.py --serve-mux`，不改CC执行行。旧probe仍CC-only时无法发现Codex，**只装Codex guard不够**。
- `/opt/openclaude/box-bridge-mod/oc-bridge`：完整 oc-bridge 参考树，root:root、文件0644/目录0755、非组/其他写；其摘要必须等于 packet 的 `ocBridge.sha256`（同 master `loadBoxBridgeMod` 与 hostd `compute_oc_bridge_digest`）。已存在的第三方不同字节会被 CAS 拒绝。
- root事务journal：`/var/lib/openclaude-codex-install/<controller sha>.json`。仅保存配置/公钥before摘要与恢复字节，不保存登录token。oc-bridge 每个文件也按 before/after 记入同一 journal，回退时恢复原字节或删除本事务新建的文件；本事务新建的空目录保留（无内容、无权限风险）。例外是 `~/.codex` 稳态空目录：它在同父目录以临时名创建，journal 在 mkdir 前记下临时名、mkdir 后立即记下该目录的 dev/ino，然后 chown/chmod、fsync 父目录并原子 rename 发布；apply/rollback 只接管、改属主或删除 journal 记录了创建者本人 dev/ino 的目录（含临时目录）。**归属证据只有 journaled dev/ino**：路径、形状（root 属主/0700/空目录）、`loginLayout`/`loginIntent` 或旧版 journal 文本一律不算归属——旧版安装器正是在检查默认目录之前就写下了 `loginLayout`，所以它的「正常拒绝预存 root 目录」与「mkdir 后中断」在磁盘上不可区分，两者都拒绝自动接管、保留目录并报错要求人工确认（不虚报成功）。其他 `.oc-codex-plain-*` 条目、以及 `mkdir` 与 dev/ino 落盘之间中断留下的临时目录同理：报错并点名具体路径，由运维确认后手工清理空目录再重跑，绝不按名字删除。

[N] 验证（用管理通道执行，非执行钥匙）：
```bash
sudo stat -c '%U %a %n' /opt/openclaude/codex-remote/*/codex-host-controller.py \
 /opt/openclaude/codex-remote/*/remote-engine-resources.py /usr/local/libexec/oc-remote-codex/*
sudo sha256sum /opt/openclaude/codex-remote/*/{codex-host-controller.py,oc-remote-hostd.py,remote-engine-resources.py}
sudo find /opt/openclaude/box-bridge-mod/oc-bridge -type f -printf '%u %m %p\n'
sudo python3 -m json.tool /usr/local/libexec/oc-remote-codex/codex-ssh-guard.json
sudo grep 'oc-rpool-7ba0f86e-exec' /home/box/.ssh/authorized_keys
```
最后一行必须仍是原CC forced-command，from仍38.55.252.217；对照安装前公钥/配置留档。之后§7必须live probe成功，不能仅以文件存在判已可执行。

### 3.1 资源预算：当前8G节点，保留默认 MemTotal−768MiB

`/etc/openclaude/remote-engine-resources.json`**不是必需**；安装器不创建、不覆盖它。没有覆盖项时节点总硬预算为`MemTotal−768MiB`（7934MiB现场约7166MiB），`MemAvailable`另作当前压力门，不能简单相加。实现：`remote-engine-resources.py:27-48,151-173`。已有配置中的`NODE_MEMORY_BUDGET`会覆盖默认；上线前只读检查，有旧2G预算则主控明确批准移除该覆盖，不能以安装器成功假定默认已生效。

默认CC/Codex各自aggregate slice仍1536MiB，Codex每lane app448+socket32MiB；扩大物理机不会自动放大slice。默认能容纳同账号2并发，逻辑上限5不是内存保证，4/5条可能按aggregate预算拒新。这是保守首发设置；调整slice会影响已存活scope，另行排空与批准。拒新要保留`REMOTE_NODE_MEMORY_EXHAUSTED`/`REMOTE_NODE_TASKS_EXHAUSTED`首因，不重试风暴。

[N] 验证：
```bash
awk '/MemTotal|MemAvailable/{print}' /proc/meminfo
sudo test ! -f /etc/openclaude/remote-engine-resources.json || sudo cat /etc/openclaude/remote-engine-resources.json
```

## 4. 唯一登录目录与安装器回退

§3安装已完成本节，不再手动重复mv。真实路径是`/home/box/.oc-remote-codex/profiles/default/codex-home`（box0700，auth常规文件0600）。`/home/box/.codex`是**真实 0700 目录（box 属主、非软链、不含 auth）**——hostd Gate G 拒绝任何软链或组/其他可写的凭据路径，旧安装器留下的 `~/.codex -> canonical` 兼容软链会在安装时被转换为该空目录。**canonical反过来指向旧目录不接受**。同文件系统rename不复制auth；Codex续期`auth.tmp→auth.json`发生在同一真实目录，所有会话观察同一个最新文件。配置源门仍有效，不能把私有config搬过去绕门。

hostd 的版本探测（`codex --version`）使用一次性 `HOME`/`CODEX_HOME`，运行后立即删除，绝不在真实 `~/.codex` 里创建 `tmp/arg0-linux`；这正是现场 Gate G 被版本查询污染的首因。安装器重跑对已修复现场（无软链 + 0700 空目录 + canonical auth）是幂等 no-op。

源码：`codex-host-controller.py:89-93,129-135,462-478`（canonical真实目录/并发只锁lane writer）；`oc-remote-hostd.py:680-755`（managed default与配置门）；安装器`migrate_login`/`rollback_login`。

[N] 验证（不输出token）：
```bash
sudo stat -c '%U %a %n' /home/box/.oc-remote-codex/profiles/default/codex-home \
 /home/box/.oc-remote-codex/profiles/default/codex-home/auth.json /home/box/.codex
# 期望：~/.codex 为目录、属主 box、模式 0700；下面命令必须无输出（不是软链）
sudo find /home/box/.codex -maxdepth 1 -type l -print
```

回退先撤ready/禁Codex纳新、取得所有lane及probe停止证明。安装器遇到`oc-codexremote-*`根目录拒回退；已停止历史根也须先由主控核**正式fence-stop/prove-stopped**原始证明并归档移出这个前缀，不能删除未证明停止的root/claim。

[H] 使用与安装完全相同源码/参数：
```bash
python3 "$SRC/scripts/agent-remote/codex-install.py" --rollback --confirm \
 --host "$NODE_HOST" --admin-key "$ADMIN_KEY" --known-hosts "$KNOWN_HOSTS" \
 --key-dir "$EXEC_DIR" --probe-public-key "$PROBE_PUB" --profile default \
 | tee "$OPS/install-rollback.json"
```
回退识别本事务before/after，第三方漂移拒绝；重复/中断后可重入：所有前置校验（布局、身份inode、非空目录）都在第一次写journal之前完成，被拒绝的回退不改journal；回退已完成或apply在rename前中断时，重入按磁盘布局收口journal（不重复搬auth）；rename后、journal提交前中断，重入同样能识别已恢复布局并收口。恢复公钥/guard/probe配置与 oc-bridge 文件（本事务新建的删除、原有字节恢复），恢复的是**最新canonical目录**而非旧token备份。登录回退按本事务记录的原始布局处理三种现场：
- 原布局是真实目录（首次迁移）：`~/.codex` 的 0700 空目录被移走，canonical 目录整体 rename 回 `~/.codex`；若现场已删除该空目录，直接 rename，不误报“已恢复”。
- 原布局是旧版兼容软链：先移除空目录，再恢复原软链（忠实回退旧状态，Gate G 会再次不过，需重新安装）。
- 现场已是修复后稳态（无软链 + 0700 空目录 + canonical auth）：本事务没有移动 auth，回退登录步骤不声称移动过 token；安装前既有的 0700 空目录保留，仅删除本事务创建的目录及其临时中间态。
`~/.codex` 若被第三方写入非空内容，回退拒绝覆盖并报错。**`~/.codex` 是 root 属主且 journal 没有记录该目录 dev/ino 时，apply 与 rollback 都报 `manual inspection required` 并保持原样**（旧版安装器正常拒绝与 mkdir 中断不可区分）；人工确认它是空目录后删除该路径，再重跑同一 apply/rollback 即可收敛，不要绕过报错改写 journal。同理，moved 布局下回退时 `/home/box/.codex` 即使是 box 属主，只要 inode 与 journal 记录不符（例如被同名重建），也报 `manual inspection required` 并保留该目录——「box 属主」不是归属证据。中断在 `mkdir` 与 dev/ino 落盘之间的临时目录（报错点名 `.oc-codex-plain-*` 具体路径）同样先人工确认空目录再删除。保留不可变bundle和宿主Codex私钥用于取证/后续受控清理；不删除CC行。回退不自动撤数据库ready，必须先走§7.3；不自动结束模型/工具进程。

## 5. 获准后合入主线、正式列车迁移与切流

**上线前硬门**：前三片审计仅覆盖固定树，不替代真机commissioning；第7.2节提供本轮实现的签发入口，但真机收据必须在新master/runtime上线后实际产生。若要求“这次发布后立即开放Codex”，必须先执行并审核该真实验收；可以经用户批准先发代码、保持Codex未ready/未上架，但不能宣称功能已上线可用。

### 5.1 精确树进入发布主线

源码：`scripts/oc-lease.sh:63-69`拒绝不在`origin/feat/v5-selfhost`上的SHA；`deploy-v5-selfhost.sh:585-587`冻结列车target。先在发布single-writer窗口、获得用户合并/出网授权后执行[H]：
```bash
cd "$SRC"
git -c safe.directory='*' fetch origin feat/v5-selfhost
git -c safe.directory='*' merge-base --is-ancestor origin/feat/v5-selfhost "$SHA"
# 上一条非0：停！上游已分叉，要另造固定集成树并增量审查，不能force-push/硬reset。
git -c safe.directory='*' push origin "$SHA":refs/heads/feat/v5-selfhost
cd "$CANON"
test -z "$(git status --porcelain)"
test "$(git branch --show-current)" = feat/v5-selfhost
git fetch origin feat/v5-selfhost
test "$(git rev-parse origin/feat/v5-selfhost)" = "$SHA"
git merge --ff-only "$SHA"
test "$(git rev-parse HEAD)" = "$SHA"
bash scripts/deploy-v5-selfhost.sh --preflight
bash scripts/oc-lease.sh register --resource deploy:selfhost --mode ride \
  --sha "$SHA" --ticket OCV5-746 --uid 3 --callback none --owner ocv5-746-codex
```
不是另起`--deploy`与列车竞争，不用`--allow-inflight`、`--allow-dirty`、跳门环境变量。登记成功不等于部署成功；worker后台构建/等锁/等空闲。`oc-lease.sh:32-36`默认wait，在途忙则等待/超时退出，旧live不变；严格遵守用户“等其它对话空闲再切流”。登记后结束发车回合，由主控后续回读，不占长工具等待。

### 5.2 迁移自动执行，精确回读

第2节已核实现：0334–0337由列车在封存release、同锁同窗apply，然后切流。**不需要手工命令补迁移**。本次一并含0334注册IP、0336Muse迁移；都是required列表的一部分，不可只选0335/0337。源码：`deploy/v5/release-metadata.json:201-204` requiredMigrations；`packages/commercial/src/db/migrations/0334_users_registration_ip.sql:7-11`、`0335_codex_remote_native.sql:1-41`、`0336_commercial_muse_durable.sql:1`、`0337_remote_engine_concurrency.sql:1-12`。

[H] 稍后回读（`V5_ENV`真实路径来自`deploy-v5-selfhost.sh:60`，DB名来自`:75-82`；不是商业版DB）：
```bash
cd "$CANON"
bash scripts/oc-lease.sh status --resource deploy:selfhost --json | tee "$OPS/lease-status.json"
bash scripts/deploy-v5-selfhost.sh --status | tee "$OPS/deploy-status.txt"
# 复用§0的db助手；本连接仅指向自用版，若不是此库，立即停下。
test "$(db -Atc 'SELECT current_database()')" = openclaude_v5_selfhost
db <<'SQL' | tee "$OPS/migrations-and-runtime.txt"
BEGIN READ ONLY;
SELECT version,applied_at FROM schema_migrations
 WHERE version IN ('0334_users_registration_ip','0335_codex_remote_native',
                   '0336_commercial_muse_durable','0337_remote_engine_concurrency') ORDER BY version;
SELECT column_name,data_type,column_default FROM information_schema.columns
 WHERE table_schema='public' AND table_name='remote_agent_profiles'
 AND column_name IN ('probe_snapshot','execution_manifest','execution_ready','auth_epoch','max_concurrent_lanes')
 ORDER BY column_name;
SELECT key,value FROM model_authority_deploy_state WHERE key='cutover';
COMMIT;
SQL
bash scripts/deploy-v5-selfhost.sh --smoke | tee "$OPS/smoke.txt"
```
应见四条migration（不是仅“最大编号0337”）、列/表到位，列车committed及sourceCommit指向批准树。**`model_authority_deploy_state`的cutover是首次安全切换的历史证据，不是每次发布的当前版本指针**；已有marker不会重写（`deploy-v5-selfhost.sh:2622-2632`），不能要求它变成本次SHA，更不能改marker。当前master以live `.complete`+列车committed/`--status`核对；runtime以环境四元组+不可变MANIFEST+容器实际挂载核对（`scripts/v5-lease-lib.sh:206-223`）：
```bash
LIVE=$(readlink -f /opt/openclaude/openclaude-v5-selfhost-live)
jq -e --arg sha "$SHA" '.sourceCommit==$sha' "$LIVE/.complete"
RUNTIME_RELEASE=$(grep -E '^OC_RUNTIME_RELEASE=' /etc/openclaude/commercial-v5-selfhost.env | tail -n1 | cut -d= -f2-)
test -n "$RUNTIME_RELEASE"
jq -e --arg sha "$SHA" '.sourceCommit==$sha' "$RUNTIME_RELEASE/MANIFEST.json"
```
若列车、当前env tuple、实际进程/容器版本不一致，保持未上架并排查；历史marker老SHA本身不是失败。

**回退**：先按第8节冻结Codex并排空/证明停止，再[H]：
```bash
cd "$CANON"
bash scripts/deploy-v5-selfhost.sh --rollback --dry-run | tee "$OPS/rollback-plan.txt"
# 人核目标确为本次上一版（预期rel-a505ddb15，若其它列车已前进必须停），取得回退授权后：
bash scripts/deploy-v5-selfhost.sh --rollback
bash scripts/deploy-v5-selfhost.sh --status
bash scripts/deploy-v5-selfhost.sh --smoke
```
这是一次一步的`.prev-release`+runtime四元组回退，不删0334–0337、不倒迁schema，不自动回退节点登录或key。脚本有兼容/血缘/制品门，拒绝就停，不能手改live软链逃门。CC allowlist保留旧hash即可兼容旧码。

## 6. 容器侧必须换release绑定；只重启进程不能吃到新源码

结论：**需要重建旧用户容器，不一定需要重建Docker镜像**。发布产生新runtime source release；旧容器`/opt/openclaude`绑定的是旧release的真实不可变路径，不是跟随宿主live链接。`docker restart`、容器内重启Node/网关均保持原bind，仍跑旧码，不能作为本次runtime更新。不存在本分支用于替换该只读release绑定的受支持“只重启进程”入口。

依据：`packages/commercial/src/agent-sandbox/v3supervisor.ts:3214-3218`；`platformBundle.ts:56-60`；`v3ensureRunning.ts:448-527,652-707,775-795`。其中syntheticEvalOverlay是评测容器分类，stale仍走回收，不是一般runtime热替换。默认ensureRunning发现release变更会先drain，busy延期，空闲才stop/remove/reprovision；用户volume保留，但容器系统层临时安装的软件会丢。

推荐：切流后等当前用户所有会话空闲，再重新连接Web会话触发ensureRunning；回读挂载/label证明新容器已就位。若需管理员显式操作，调用平台API而非直接docker rm：`admin/containers.ts:571-606`的v3 restart实际是drain后stop/remove，下次用户WS重建；HTTP入口`http/admin/containers.ts:234-274`。

[H/A] 建立本地管理员API助手（后续第7节复用；token来自本人管理员正常登录，要求access类型、active admin DB复核：`http/auth.ts:31-48`、`admin/requireAdmin.ts:31-75`）：
```bash
BASE=http://127.0.0.1:18790
umask 077
read -r -s -p '自用版管理员access token: ' ADMIN_TOKEN; printf '\n'
[[ "$ADMIN_TOKEN" =~ ^[A-Za-z0-9._-]+$ ]]
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" > "$OPS/admin-curl.conf"
unset ADMIN_TOKEN
api() { curl --silent --show-error --fail-with-body --config "$OPS/admin-curl.conf" "$@"; }
api "$BASE/api/admin/agent-containers?limit=500" > "$OPS/containers-before.json"
jq '.rows[] | select((.user_id|tostring)=="3") | {id,docker_id,state,row_kind,workspace_volume,home_volume}' "$OPS/containers-before.json"
# 人工核对属于uid3的当前v3容器；不是Docker id，而是数据库行id。
: "${CONTAINER_ROW_ID:?填上面确认的当前容器行id}"
# 仅空闲且获准重建后执行；有busy错误就等待，不force。
api -X POST "$BASE/api/admin/agent-containers/$CONTAINER_ROW_ID/restart"
# 此时由用户重新连接Web；不要对消失旧行反复restart。
```
验证：[H]重新GET上面列表，取新running行`docker_id`为`CID`，执行：
```bash
: "${CID:?填新running容器的docker_id}"
docker inspect "$CID" --format '{{.Id}} {{index .Config.Labels "com.openclaude.runtime.release"}}'
docker inspect "$CID" --format '{{json .Mounts}}' | jq '.[] | select(.Destination=="/opt/openclaude") | {Source,Destination,RW}'
```
label及Mount.Source必须匹配第5节新runtime tuple，RW=false，用户home/workspace仍用原volume。容器内源码hash或相关构建标记也应指向本次release。回退代码后亦需以同样drain/reprovision流程换回旧runtime bind；仅重启进程不构成回退。
## 7. 新代码/runtime就位后：probe → 真实验收 → manifest → offer

### 7.1 用管理员live probe落库，不能提交伪造probe JSON

依据：`packages/commercial/src/http/admin/remotePool.ts:26-43,82-104`，`remoteBrainPool.ts:1200-1322,1400-1477,1530-1542`。API不读probe请求body，必须通过现有节点key实际跑hostd。probe会创建短期scope/锁/claim，有资源与进程副作用，执行前确保足够预算，不能在两路Codex正跑时拿probe失败判登录失效。

单次SSH probe超时现在是`REMOTE_SSH_PROBE_TIMEOUT_MS=45_000`（`remoteBrainPool.ts`，两条probe路径共用）：现场冷启动首次probe超过旧硬编码15s、热probe约8s，15s会误报`REMOTE_SSH_PROBE_TIMEOUT`。45s覆盖冷启动且仍有界（SSH连接本身每次尝试仍10s封顶）。再遇到超时应看节点负载/进程，而不是无上限调大。

[H/A] 第6节api函数与DB函数就位后：
```bash
api "$BASE/api/admin/remote-pool" > "$OPS/pool-before.json"
NODE_ID=$(jq -er '[.nodes[] | select(.label=="cc5-us" and .ssh_host=="136.86.253.46" and .ssh_user=="box")]|if length==1 then .[0].id else error("node非唯一") end' "$OPS/pool-before.json")
api -X POST "$BASE/api/admin/remote-pool/nodes/$NODE_ID/probe" > "$OPS/probe.json"
PROFILE_ID=$(jq -er '[.profiles[] | select(.engine=="codex" and .profile_name=="default")]|if length==1 then .[0].id else error("default profile非唯一/未发现") end' "$OPS/probe.json")
jq -e --arg h "$HOSTD_SHA" --arg c "$CODEX_SHA" '
 .node.controller_sha256==$h and
 ([.profiles[] | select(.engine=="codex" and .profile_name=="default")][0] |
  .runner_mode=="app-server" and (.cli_version|test("(^|[^0-9])0[.]167[.]0($|[^0-9.])")) and
  .probe_snapshot.probe_schema_version==2 and
  .probe_snapshot.source=="codex-app-server:model/list" and .probe_snapshot.freshness=="cli-observed" and
  .probe_snapshot.auth_present==true and .probe_snapshot.account_observed==true and
  .probe_snapshot.models_observed==true and .probe_snapshot.error_code==null and
  .probe_snapshot.execution_snapshot.controllerSha256==$c and
  (.probe_snapshot.execution_snapshot.modelList|length)>0)' "$OPS/probe.json"
# fresh首次部署应execution_ready=false；旧snapshot已合法验收时可能保留true，不能盲改。
jq '.profiles[] | select(.engine=="codex") | {id,profile_name,cli_version,runner_mode,execution_ready,discovered_models}' "$OPS/probe.json"
db -At -v profile_id="$PROFILE_ID" <<'SQL' > "$OPS/profile-before-ready.json"
SELECT jsonb_build_object('id',id,'node_id',node_id,'profile_name',profile_name,
 'account_fingerprint',account_fingerprint,'auth_epoch',auth_epoch,
 'execution_ready',execution_ready,'execution_manifest',execution_manifest,'probe_snapshot',probe_snapshot)
FROM remote_agent_profiles WHERE id=:'profile_id'::uuid AND engine='codex';
SQL
jq -e --arg n "$NODE_ID" '.node_id==$n and .profile_name=="default" and .probe_snapshot!=null' "$OPS/profile-before-ready.json"
```
注意CLI版本字符串为 `--version` **原始首行**，通常是 `codex-cli 0.167.0`，不是保证纯 `0.167.0`（`oc-remote-hostd.py:636-649`）；上面以版本边界匹配，不把真实原文改写。`probe.json`中的controller_sha256应304f…；数据库字段47d26…通过这一真实probe自然更新，而非预先手填。

失败处理：确认probe钥匙不是CC fallback、bundle同目录依赖完整、auth目录真实0700、配置源门、user systemd、gate_g、资源余量、CLI/native路径。master SSH probe超时15s（`remoteBrainPool.ts:1030-1066`），单profile app-server探针上限20s（`oc-remote-hostd.py:297`）；慢启动/多profile可能超时。**无“上传结果替代live probe”的HTTP入口**，不得把旧报告或手工JSON塞入DB假装本轮成功。失败如实保留并修复，不连续重试掩盖首因。停止/unknown未证明则不能删PROBE_ACTIVE/claim。

### 7.2 管理员显式真机 commissioning：profile保持未ready

工具：`scripts/agent-remote/codex-commission.py`。入口仅selfhost master、有效uid3 admin JWT+DB复核；不是容器secret，不自行签JWT。源码：`http/admin/codexCommissioning.ts:6`；`account-pool/codexCommissioning.ts:84,108`；`codexCommissioningStore.ts:57`。首次profile必须`execution_ready=false`且当前probe为成功真实观察。

独立准入只派生本次私有`gpt-6-luna-remote`目录视图，真实价格取active `gpt-6-luna`；每次fence读live epoch、源型号deny/授权、profile snapshot与auth状态，不公开INSERT model_catalog、不发布offer、不临时设ready。仍走生产签名authority、dispatch、preCheck、receipt v3、usage与ledger扣费（不是免费/跳过计费的测试账号）。固定gpt-6-luna effort low，最多10分钟、一次Write；不会改型号回退。

[H/A] 将当前管理员access JWT写入root0600 `$OPS/admin.jwt`（不写报告），配置`BASE`为自用版HTTPS域名或实际active槽的loopback地址；工具拒绝非loopback HTTP与重定向：
```bash
export TOKEN_FILE="$OPS/admin.jwt"
test "$(stat -c %a "$TOKEN_FILE")" = 600
commission() { python3 "$SRC/scripts/agent-remote/codex-commission.py" \
 --url "$BASE" --token-file "$TOKEN_FILE" "$@"; }
commission run --profile-id "$PROFILE_ID" > "$OPS/commission-start.json"
RUN_ID=$(jq -er .id "$OPS/commission-start.json")
commission status --run-id "$RUN_ID"
```
API立即202返回；在后续独立轮次查询status，直到verified或unknown。后台由新master创建真实`CodexSshHost`/`CodexRemoteRelay`，通过`docker exec --user1000 oc-v5-u3`的**固定受版本校验worker**连接真实CCB ToolHost，随机哨兵在`/home/agent/.openclaude/commissioning/<run>/sentinel.txt`。工具只有Write且路径/正文精确一次校验；节点不获得容器工具凭据。

成功包包含：实际节点帧逐帧摘要、relay持久帧目录摘要、真实v3 receipt及committed账本id/非零扣款、fence-stop与独立prove-stopped的两scope证明、容器supervisor proof及master另一次docker exec独立读marker/核supervisor退出。master私有原件位于`/var/lib/openclaude/remote-native/commissioning/<run>/`，0700/0600；失败/中断/重启后未知不会生成成功包，unknown继续占槽。

```bash
commission artifact --run-id "$RUN_ID" > "$OPS/commission-artifact.json"
E2E_SHA=$(jq -er .e2eReceiptSha256 "$OPS/commission-artifact.json")
jq '{e2eReceiptSha256,execution_manifest,proofs:{billing:.packet.billing,node:.packet.nodeProof,local:.packet.localProof}}' \
 "$OPS/commission-artifact.json"
```
`e2eReceiptSha256`是**服务器原始artifact.json字节**的SHA256，不是格式化CLI输出文件SHA、不等于receipt.resultSha256、不能对自写“ok”JSON做hash。candidate manifest由同一master生成，绑定完整probe/current controller/account/original authEpoch；初次新authEpoch在run内生成，全链使用，apply前不写profile。

`unknown`恢复：不得删binding/改released；先停止相关模型和本地工具并保全日志。现有正式reconciler在remote effect已尝试时要求**原Docker容器整体已停止/移除**才认可本地停止，因此仍有其它对话时必须排期，不能声称自动释放未知commissioning槽。先修具体首因再重跑新run，不上传伪造probe/receipt。

### 7.3 独立、确认式ready CAS与反向操作

`run`不写ready。管理员审核真实包、确认本次实际费用和身份后，单独执行：
```bash
commission apply --run-id "$RUN_ID" --sha256 "$E2E_SHA" --confirm \
 > "$OPS/commission-apply.json"
api "$BASE/api/admin/remote-pool" > "$OPS/pool-after-ready.json"
jq -e --arg p "$PROFILE_ID" '[.profiles[]|select(.id==$p)]|length==1 and .[0].execution_ready==true' "$OPS/pool-after-ready.json"
```
源码：`codexCommissioning.ts:98`再次验证私有包/文件摘要和PG账单；`codexCommissioningStore.ts:111` profile行锁CAS完整probe/账号/原auth/原manifest，无占用lane后才写auth_epoch/manifest/ready。少`--confirm`、sha不符、probe更新、controller变动、auth漂移或并发apply均拒绝。失败必须重核，不手改manifest追快照、不裸SQL置ready。

反向（先禁新；在途可以正常结束，保留账本/manifest）：
```bash
commission revoke --run-id "$RUN_ID" --sha256 "$E2E_SHA" --confirm \
 > "$OPS/commission-revoke.json"
api "$BASE/api/admin/remote-pool" > "$OPS/pool-after-revoke.json"
jq -e --arg p "$PROFILE_ID" '[.profiles[]|select(.id==$p)]|length==1 and .[0].execution_ready==false' "$OPS/pool-after-revoke.json"
```
revoke也是精确manifest CAS，不撤其它验收代际；不杀在途、不抹auth epoch或证据。ready撤销后若目录仍显示该型号，再按§8.3目录disable阻止新增选择；普通placement始终拒绝unready。

### 7.4 offer启用、`<id>-remote` catalog热上架

依据：`remoteBrainPool.ts:1634-1672,1684-1688,1713-1813,1815-1916`。ready、active node/profile、实际观测的model id及**同upstream价格**都必须存在；`OC_REMOTE_POOL_EXECUTION_ENABLED='0'`会阻止执行激活，HTTP body没有allowActivateExecution的合法覆写入口。不要重写运行环境或加“强开”参数绕门。缺价格另走受审定价，不套Claude默认价。

[H/A] 从当前probe真实modelList选一个text模型；不能按本手册硬编码型号。不要顺手把整个modelList全上架：
```bash
jq -r '.profiles[]|select(.engine=="codex" and .profile_name=="default")|.probe_snapshot.execution_snapshot.modelList[]|select(.hidden!=true)|(.model // .id)' "$OPS/probe.json"
: "${UPSTREAM:?填上面经用户批准上架的一项真实model id}"
CANONICAL="$UPSTREAM-remote"
jq -e --arg id "$UPSTREAM" '.profiles[]|select(.engine=="codex" and .profile_name=="default")|any(.probe_snapshot.execution_snapshot.modelList[]; (.model // .id)==$id and .hidden!=true)' "$OPS/probe.json"
db -v upstream="$UPSTREAM" <<'SQL'
BEGIN READ ONLY;
SELECT model_id,input_per_mtok,output_per_mtok,cache_read_per_mtok,cache_write_per_mtok,multiplier,enabled,visibility
 FROM model_pricing WHERE model_id=:'upstream';
COMMIT;
SQL
# 应恰有同名真实价格；不存在则停，不编价格。
jq -n --arg p "$PROFILE_ID" --arg u "$UPSTREAM" --arg c "$CANONICAL" \
 '{profile_id:$p,offers:[{upstream_model_id:$u,canonical_model_id:$c,base_display_name:$u,enabled:true}]}' > "$OPS/offer.json"
api -X POST -H 'Content-Type: application/json' --data-binary @"$OPS/offer.json" \
 "$BASE/api/admin/remote-pool/offers" > "$OPS/offer-response.json"
api "$BASE/api/admin/model-catalog" > "$OPS/catalog-after.json"
jq --arg id "$CANONICAL" '.entries[]|select(.model_id==$id)|{entry_id,model_id,engine,provider_id,upstream_model_id,state,lock_version,capability_profile,has_pricing}' "$OPS/catalog-after.json"
api "$BASE/api/models" > "$OPS/public-models-after.json"
```
发布API在单事务写remote_model_offers、model_pricing与model_catalog；自动选择engine/provider=`codex`、placement=`remote_pool`，不手工拼INSERT model_catalog。有效能力text-only、Fast/vision=false；effort和default取实读（`codexRemoteProfile.ts:34-52`），观察到的vision/tier可留存但不开放未验证功能。

热生效：`http/admin/remotePool.ts:155`提交后触发本进程cache.rebuild；`billing/modelCatalog.ts:954-980,1110-1136`通过catalog/security epoch LISTEN/NOTIFY使其它master收敛，unknown时fail-closed。**不需为模型上架重启master或容器**，但首次代码/runtime升级仍必须第5–6节。API200本身不够：此handler吞rebuild异常，须核catalog.execution_revision非null、公开模型列表实际可见，重新拉取前端模型表，并用真实新对话验收。

若catalog仍disabled：先看是否被管理员明确禁用、node/profile非active、执行总闸为0、snapshot失配；不能SQL强改active。全局管理员禁用不会由probe自动恢复。确需恢复原管理员禁用且获准，可用有乐观锁的目录API（`http/admin/modelCatalog.ts:85-93,132-171`）：
```bash
# 刚回读catalog，选择唯一非retired记录；人工确认恢复禁用的授权后才能执行。
ENTRY_ID=$(jq -er --arg id "$CANONICAL" '[.entries[]|select(.model_id==$id and .state=="disabled")]|if length==1 then .[0].entry_id else error("非唯一disabled记录") end' "$OPS/catalog-after.json")
LOCK_VERSION=$(jq -er --arg e "$ENTRY_ID" '.entries[]|select(.entry_id==$e)|.lock_version' "$OPS/catalog-after.json")
jq -n --argjson v "$LOCK_VERSION" '{lock_version:$v}' > "$OPS/catalog-action.json"
api -X POST -H 'Content-Type: application/json' --data-binary @"$OPS/catalog-action.json" \
 "$BASE/api/admin/model-catalog/$ENTRY_ID/activate"
```
409/422须重新核原因与并发，不机械改锁版本重试。激活API也不能豁免ready/价格/真实执行条件。
## 8. 正式业务验收、财务回读与失败回退

以下是**验收规程，不是已执行结果**。只有§7.2真实commissioning门已过，才进行上架后的正式验收。每项记录开始/结束时间、源码/runtime SHA、节点/profile、session/operation/run/generation、request/thread/turn；证据保存在管理员私有OPS目录，脱敏副本交主控。不要导出auth.json、访问令牌、SSH私钥或无关用户会话。

### 8.1 执行顺序与通过条件

| 顺序 | 操作/精确测试输入 | 必须看到的真实结果 | 源码锚点 | 失败时动作 |
|---|---|---|---|---|
| A | 旧版发布前、新版发布后各用原CC远端模型做同一短对话，要求容器工具写唯一marker并读回 | 原CC公钥行逐字不变、旧+fcfb摘要均允许；新CC真实模型答复+容器工具成功、账单正常、stop证明完整 | `cc5-ssh-guard.py:65-92,126-154`；`cc5-host-controller.py:938-958`（资源模块内嵌，不依赖Codex软链） | 禁Codex新增；查资源/guard首因，必要走§5代码回退，不能删旧hash |
| B | 单个Codex `<真实id>-remote` 新会话，要求执行下文marker命令；同会话再发一轮读取marker并返回新nonce | 模型真实请求在cc5-us；工具真实在用户容器；第2轮同nativeThreadId、不同nativeTurnId，baseline承接上一total；无本地Codex/其它模型兜底 | `remoteBrainPool.ts:938-965`；`codexRemoteContract.ts:65-90`；`codexRemoteRelay.ts:465-487` | profile禁新，保留首因/原生terminal，停止双方核proof |
| C | B结束且释放lane后，同一default账号两条独立Web会话同时发送下文并发命令 | 两个独立operation/root/app+socket scope同时存活，共同canonical CODEX_HOME、相同账号指纹/authEpoch；都完成，互不抢APP-WRITER，auth不复制 | `codex-host-controller.py:129-134,462-478`；`remoteBrainPool.ts:895-902`；`0337_remote_engine_concurrency.sql:6-12` | 任一登录冲突/互串/假串行均不通过；先停，不通过复制账号目录“修复” |
| D | 按当前真实claim与配置计算首个应超预算的新增会话（默认Codex slice1536MiB、每lane480MiB：无其它因素时第4路；不要内存炸弹） | 超过实际node/slice预算时应明确`REMOTE_NODE_MEMORY_EXHAUSTED`/activeSessions；旧两路不被杀、不中断；新请求无模型/工具副作用、无扣费；节点无OOM | `remote-engine-resources.py:152-176`；`codexRemoteHost.ts:95-102`；`codexRemoteRelay.ts:483-486` | 未拒新/影响旧lane/产生费用均停止上架；不靠减headroom或杀旧任务过关 |
| E | 停止所有验收会话，回读下文DB/scope/claim证据；之后空闲再probe | 双方停止、bindings released；unknown不冒充释放；资源claim回到该次测试前基线；财务唯一请求/receipt完成 | `codexRemoteHost.ts:111-142`；`codexRemoteRelay.ts:474-487`；`remote-engine-resources.py:211-222` | 禁止删claim/DB released；进入独立恢复调查 |
| F | 最后再做一轮CC正控，确认Codex停后CC可用；核catalog公开投影 | CC不退化；Codextext-only，不出现Fast/vision虚假能力；effort与probe一致 | `codexRemoteProfile.ts:34-52` | 保持禁用有问题能力，不扩大声明 |

B的具体用户提示（把RUN替换为本次唯一时间戳，如20261108T123456；不要让模型只复述命令）：
> 使用容器工具执行以下命令，回传命令退出码、文件实际内容和sha256。不要在远端节点直接写文件，也不要模拟结果。
```bash
umask 077
printf '%s\n' 'ocv5-746-RUN-codex-container-marker' > /home/agent/.openclaude/generated/ocv5-746-RUN-marker.txt
cat /home/agent/.openclaude/generated/ocv5-746-RUN-marker.txt
sha256sum /home/agent/.openclaude/generated/ocv5-746-RUN-marker.txt
```
[H] 独立验证 `docker exec "$CID" cat /home/agent/.openclaude/generated/ocv5-746-RUN-marker.txt`；[N]验证该容器绝对路径未被错误建到节点，并对照原生`mcpToolCall`及容器宿主记录。人工事先在容器造同名文件不算通过。

C并发提示：两个会话各用下文同一个唯一RUN目录，A设`ME=A OTHER=B`，B设`ME=B OTHER=A`；都真正执行，不是让主控代做。先前不要预建ready文件。命令需在30秒内都提交，最后sleep保持重叠窗口供D采证。
```bash
ME=A OTHER=B # 会话B改为ME=B OTHER=A
D=/home/agent/.openclaude/generated/ocv5-746-RUN-concurrency
umask 077; mkdir -p "$D"
printf '%s\n' "$ME ready $(date -u +%FT%TZ)" > "$D/$ME.ready"
for i in $(seq 1 30); do test -f "$D/$OTHER.ready" && break; sleep 1; done
test -f "$D/$OTHER.ready" || exit 12
cat "$D/A.ready" "$D/B.ready"
sleep 20
printf '%s\n' "$ME done $(date -u +%FT%TZ)" > "$D/$ME.done"
cat "$D/$ME.done"
```
这是任务内临时并发验收目录，不是微信附件（交付证据另打包到generated根目录）。两路最终都成功还不够，必须采到**真实重叠scope与两个不同operation**。避免两路正在占用时再probe；probe也用448MiB预算。当前8GiB做D时仍需计入CC/探针与每engine slice预算；第3路可能正常成功，不能以固定第3路未拒判失败。实测内存压力若提前拒新，按完整资源证据判容量，不减安全阈值。

### 8.2 节点与DB证据命令

[N] 在两路重叠窗口、全部停止后各运行一次（常规观测不创建scope，不输出auth）：
```bash
BOX_UID=$(id -u box)
sudo -u box env HOME=/home/box XDG_RUNTIME_DIR=/run/user/"$BOX_UID" \
 systemctl --user list-units --all --type=scope --no-pager
sudo -u box env HOME=/home/box XDG_RUNTIME_DIR=/run/user/"$BOX_UID" \
 systemctl --user show oc-cc.slice oc-codex.slice -p MemoryMax -p MemoryCurrent -p TasksMax -p ControlGroup
sudo -u box python3 - <<'PY'
import json
from pathlib import Path
r=Path('/home/box/.oc-remote-resources');boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
rows=[]
for p in r.glob('*.json'):
 x=json.loads(p.read_text())
 if x.get('boot')==boot: rows.append(x)
print(json.dumps(rows,indent=2))
PY
grep -E '^Mem(Total|Available):' /proc/meminfo
journalctl -k --since '-15 min' --no-pager | grep -Ei 'oom|out of memory|killed process' || true
```
验收通过要求不是“grep无字”单独成立，而是资源回执明确拒新、旧scope持续、旧请求最后成功、节点无OOM证据相互印证。

[H] 指定本次测试operation UUID，逐个回读；查询只取该操作不扫其它用户对话：
```bash
: "${OPERATION_ID:?填本次测试operation UUID}"
db -v op="$OPERATION_ID" <<'SQL' | tee "$OPS/acceptance-$OPERATION_ID.txt"
BEGIN READ ONLY;
SELECT operation_id,run_id,uid,session_key,node_id,profile_id,engine,state,generation,
 auth_epoch,native_session_id,remote_start_attempted,no_host_effect_proven,updated_at
 FROM remote_agent_bindings WHERE operation_id=:'op'::uuid;
SELECT native_thread_id,profile_id,auth_epoch,upstream_model,total,last_native_turn_id,pending_request_id
 FROM remote_native_threads WHERE operation_id=:'op'::uuid;
SELECT t.native_thread_id,t.native_turn_id,t.request_id,t.receipt_sha256,
 t.receipt->>'version' AS version,t.receipt->>'backendKind' AS backend,
 t.receipt->>'nativeStatus' AS native_status,t.receipt->>'resultSha256' AS result_sha,
 t.receipt->'baseline' AS baseline,t.receipt->'total' AS total,
 t.receipt->'nativeUsage' AS native_usage,t.receipt->'usage' AS billable_usage,
 u.id AS usage_id,u.status,u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_write_tokens,
 u.cost_credits,u.ledger_id,u.price_snapshot
 FROM remote_native_turns t LEFT JOIN usage_records u ON u.request_id=t.request_id AND u.user_id=t.uid
 WHERE t.operation_id=:'op'::uuid ORDER BY t.created_at;
SELECT request_id,state,usage_id,ledger_id,ctx#>>'{remoteNative,receipt,resultSha256}' AS receipt_sha
 FROM request_finalize_journal WHERE ctx#>>'{remoteNative,scope,operationId}'=:'op';
COMMIT;
SQL
```
财务通过条件（`billing/remoteNativeTurnBilling.ts:108-123,282-350,358-379`；`gateway/src/codexRemoteContract.ts:16-34,52-90`）：
- 每个native turn恰一原始request/receipt，v3/backend/operation/profile/authEpoch/manifest/generation与会话相符；receipt_sha256=resultSha256。业务resultSha不是对漂亮排版JSON直接sha256sum。
- nativeUsage五维=`total−上一已持久化baseline`，不是`last`；input计费扣除cachedInput，reasoningOutput属于output不重复加；cacheWriteInput非零目前拒绝，不能硬清零。
- 成功有输出的消耗按当轮持久化价格计算；失败/中断/无输出无扣费，但已观测boundary推进。缺terminal/total视unknown，不当成0。
- request_finalize_journal committed与usage/ledger原请求一致；线程pending_request_id清空。原生未开始的资源拒新允许无receipt/usage，但不得有扣费；若有journal应已安全终结而非悬挂。
- 两路并发隔离baseline；同线程第二轮不重复计累计total；后续重连不重放工具/模型、不重复扣同turn。

“证明停止”应由正式生命周期执行`fence-stop`→独立`prove-stopped`并等待本地工具停；`codexRemoteHost.ts:134-142`、`codexRemoteRelay.ts:474-487`。**管理API `/bindings/<operation>/revoke`只把未证明的binding标unknown，不会SSH kill/proof，也不能自动释放槽**（`http/admin/remotePool.ts:206-225`、`remoteBrainPool.ts:2076-2112`），不是“一键清理”。用户正常点停止后如仍unknown，暂停发布并恢复调查，不手工UPDATE released。

需要管理员复核节点proof时，可在已由平台停止的准确root上[H]执行如下命令；注意controller的prove-stopped成功后也会清理已证明空scope的claim（`codex-host-controller.py:556-565`），**不是纯只读探测**，须作为授权验收/清理动作，不在本编写任务执行：
```bash
: "${TASK_ROOT:?从该operation的recovery_spec.taskRoot核实准确root，勿猜/填其它会话}"
CMD=$(python3 - "$BUNDLE/codex-host-controller.py" "$TASK_ROOT" <<'PY'
import sys
args=['/usr/bin/python3','-I','-B',sys.argv[1],'prove-stopped',sys.argv[2]]
print(' '.join("'"+x.replace("'","'\\''")+"'" for x in args))
PY
)
ssh -T -p "$NODE_PORT" -i "$EXEC_DIR/codex_id_ed25519" \
 -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o ClearAllForwardings=yes \
 -o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=yes \
 -o UserKnownHostsFile="$EXEC_DIR/known_hosts" box@"$NODE_HOST" "$CMD" > "$OPS/proof-$OPERATION_ID.json"
jq -e '.remoteStopped==true and (.scopes|length)<=2 and all(.scopes[]; .populated==0)' "$OPS/proof-$OPERATION_ID.json"
```
还必须核proof里的identity/bootId/cgroup/dev/inode与该generation元数据逐项一致，并核本地工具停止；仅jq返回0不代表master已安全释放DB槽。未provision过的root可能无manifest，需正式host lifecycle带expected manifest完成fence，不能伪造目录/记录令此命令成功。

### 8.3 故障时按这个次序回退

1. **先禁新Codex，保留CC**：[H/A]
```bash
api -X PATCH -H 'Content-Type: application/json' --data '{"status":"disabled"}' \
 "$BASE/api/admin/remote-pool/profiles/$PROFILE_ID"
api "$BASE/api/admin/remote-pool" > "$OPS/pool-disabled.json"
jq -e --arg p "$PROFILE_ID" '[.profiles[]|select(.id==$p)]|length==1 and .[0].status=="disabled" and .[0].disabled_by=="admin"' "$OPS/pool-disabled.json"
```
   这是禁止新placement，不是杀在途lane，也不保证目录立即隐藏（`remoteBrainPool.ts:1969-1998`）。若该profile仍ready，可将`$OPS/offer.json`所有offers.enabled改false后调用同一publish API；它重新聚合其它可用节点，不能误伤仍服务的其它profile。若已经unready，publish连禁用也会报CODEX_EXECUTION_NOT_READY，改用catalog disable入口禁止该model新增选择（影响此canonical的所有profile，先确认范围）：
```bash
api "$BASE/api/admin/model-catalog" > "$OPS/catalog-disable-before.json"
ENTRY_ID=$(jq -er --arg id "$CANONICAL" '[.entries[]|select(.model_id==$id and .state=="active")]|if length==1 then .[0].entry_id else error("无唯一active条目；先核状态") end' "$OPS/catalog-disable-before.json")
LOCK_VERSION=$(jq -er --arg e "$ENTRY_ID" '.entries[]|select(.entry_id==$e)|.lock_version' "$OPS/catalog-disable-before.json")
jq -n --argjson v "$LOCK_VERSION" '{lock_version:$v}' > "$OPS/catalog-disable.json"
api -X POST -H 'Content-Type: application/json' --data-binary @"$OPS/catalog-disable.json" \
 "$BASE/api/admin/model-catalog/$ENTRY_ID/disable"
api "$BASE/api/models" > "$OPS/public-models-disabled.json"
```
2. **停止在途并保全证据**：由原会话正常停止，核remote+local证明、DB状态和claim。unknown继续占位，不改auth、不删目录、不杀全box进程、不用TTL释放。不把撤销API当proof。
3. **撤ready**：使用§7.3 `commission revoke --run-id "$RUN_ID" --sha256 "$E2E_SHA" --confirm`，不执行裸SQL。manifest不匹配就停下核查是否已有新一代验收，不能用旧包撤别人新ready。
4. **代码/runtime回退**：仅经用户批准走§5的列车rollback，§6容器重建回旧release；四份迁移保留。保持新CC hash供清理、旧hash供旧版工作。
5. **节点回退**：待新lane/probe全部停止后，按§3只恢复probe行/撤新Codex行，旧CC行不动；如需迁回登录按§4移动当前目录。资源配置与bundle仅在无活引用时回退/清理。权限推荐维持0700。
6. **再验CC**：真实对话+工具+财务，确认不是“旧版切回成功但CC已被误改”。管理员token临时配置用完以`unlink "$OPS/admin-curl.conf"`删除并`unset DATABASE_URL`；OPS证据按正常受控留档，不公开秘密。

## 9. 必须由主控/用户确认与交接边界

1. 合并/推主线与切流时间，默认等在途空闲，不打断其它会话；本轮仅提交，不push、不部署。
2. 节点安装与唯一登录停写窗口（已指定ocadmin管理钥匙，若宿主key属主不合要求需主控准备root私有副本；不重登录、不复制auth）。系统配置如触发配置源门，另行决定迁出哪些配置。
3. uid3容器重建窗口；新runtime只读绑定必须生效，普通docker restart无效。
4. 真机commissioning一次实际付费请求、证据审核及独立apply --confirm授权；上架型号仅限probe实读、有真实价格的获准型号。

节点扩到8G、静态IP、CC追加hash已由用户确认，不再重复要求扩容选择。本文默认保守资源参数，不另改slice。仍须主控上线后完成CC不退化、正式Codex对话/工具、同账号2并发、财务收据及内存拒新验收。

## 10. 本轮验证与未执行边界

本轮实现并测试了commissioning准入/CAS与安装器，**没有连接cc5-us、运行真实付费Codex、写生产库或部署**；因此这里不提供伪造的真机e2eReceiptSha256。自动回归的fixture节点只能证明协议/真实容器工具宿主，不冒充上线验收。

完整测试、审查与提交证据见：`/home/agent/.openclaude/generated/ocv5-746-commissioning-result.md`。本手册shell/Python/JSON片段静态检查见`ocv5-746-codex-deploy-runbook-static-check.txt`，静态语法不等于现场执行成功。
