# V5 runtime 镜像内容上移 / 热生效改造方案(P0/P1/P2)

日期:2026-07-12 · 分支:feat/v5-runtime-hotcfg · 状态:R3(吸收 Codex R1×5B9M + R2×2B7M3m)

## 0. 问题与目标

runtime 镜像把三种性质不同的东西绑在同一生效面:①工具链(低频,天然属镜像);
②个人版源码树(近 30 天 300+ commit,tsx 直跑零构建,重建主驱动);③配置型内容
(entrypoint.ts 月改 23 次、oc-* 薄壳、codex 配置、seed 内容)。

目标:镜像收敛为纯工具链面;源码与配置上移到热通道。重建频率从"每个功能批次"降到
"工具链变更时"。

**范围裁定**:本批 = P0 + P1 + P2a(缩) + P2b。两项拆出为独立"模型权威"批次(§6):
- P2c 模型目录 master 下发(R1-B5:破坏 master/容器 engine 同构 = 计费旁路邻接);
- P2a 中 seed agent 的 **model/engine 声明化**(R2-B1:滚动窗口内旧容器按旧 seed
  选 engine、新 master 按新 seed 预检/结算 → 计费分叉;本批 seed 声明只放
  persona/文案/defaults,model/engine 双端继续走现状硬编码同构)。

## 1. 统一机制:runtime tuple 与 platform bundle

### 1.1 激活/回滚原子单元 = runtime tuple(R1-B2, R2-M4/M6)

```
OC_RUNTIME_IMAGE=openclaude/openclaude-runtime:<tag>     # image_ref(拉取/展示用)
OC_RUNTIME_IMAGE_ID=sha256:<immutable id>                # 部署时验证过的 immutable ID
OC_RUNTIME_RELEASE=<releases根>/rel-<digest12>
OC_PLATFORM_BUNDLE=<platform根>/bundles/<bundleRev12>
```

- **stale 判定与容器 label 一律用 image immutable ID**,tag 仅展示(R2-M4:同 tag
  重指新镜像不许漏判)。
- tuple history:`runtime-tuple.history` 每条 = {schemaVer, seq, 时间戳, 四字段,
  checksum},temp+fsync+rename 更新;解析只认 checksum 通过的 committed 条目
  (R2-Minor2)。回滚 = 翻回上一条**已验证完整 tuple**。
- **emergency tuple**(R2-M6):不是"一个永不 GC 的旧镜像",而是一条完整 pinned tuple
  {内嵌源码镜像 ID, release=空, 固定 bundle rev},记录于 env
  `OC_RUNTIME_EMERGENCY_TUPLE`;其引用的镜像与 bundle 进 GC 保护集。**每次破坏兼容性
  的变更(bundle schema/volume 格式/桥协议)必须刷新 emergency tuple 并实跑 smoke**,
  刷新动作进 deploy checklist。瘦身镜像(label `oc.runtime.embed_source=0`)+ 空
  release → supervisor fail-closed 拒 provision(防误配裸奔)。

### 1.2 platform bundle:稳定根 + 版本化 + 原子 current(R1-M1/M2/M9)

```
/var/lib/openclaude-v5/platform/
  bundles/<bundleRev>/       # 不可变(内容 digest 命名)
    bin/ entrypoint/ etc-codex/ codex-skills/ seed/ prompts/ MANIFEST.json
  current -> bundles/<bundleRev>   # 相对 symlink,mv -T 原子翻转
```

- supervisor 挂**稳定根** `→ /run/oc/platform:ro`(挂载源永不变,独立于 master
  蓝绿 release 树);容器经 `/run/oc/platform/current/...` 访问;翻转对存量容器
  原子生效(真热)且零混合版本窗口。
- **单次调用版本自钉**(R2-M5):bin/ 下每个工具入口第一动作
  `SELF_ROOT=$(readlink -f "$(dirname "$(readlink -f "$0")")/..")`,后续一切内部
  引用走 rev-pinned $SELF_ROOT;并以测试固化约束"工具单文件独立,禁相对 sibling
  裸调用"——翻转不会让一次执行混用两版。
- 消费侧(prompts/seed)LKG 快照语义:按 resolved rev 整套读入+校验,一次性替换
  内存快照;失败保留 last-known-good 并告警;TTL 轮询 rev 变化触发重载,不订阅
  散乱 fs 事件(R1-M9)。
- MANIFEST.json:文件表(**不含自身**,R2-Minor1)+ 每文件 sha256 + boot_hash 预计算
  + 构建源 commit。

### 1.3 结构校验 schema(R1-M3)

`resolvePlatformBundleMount` 有界递归校验,每级沿用 assertBaselineLeaf 不变量
(owner=root / 非 group-other 可写 / realpath 不逃逸),并加:顶层目录白名单、
类型白名单(regular/dir,拒 symlink/device/socket/FIFO/nlink>1)、扩展名白名单
(.sh/.py/.ts/.toml/.md/.yaml/.json)、单文件 ≤1MB、总量 ≤32MB、深度 ≤6、条目 ≤512
(**超限拒绝而非截断放行**)、敏感名 denylist(.env*/id_rsa*/*.pem/*.key/.npmrc/.netrc)、
祖先目录 owner/权限校验、MANIFEST 与实际条目/sha256 逐一相符。
fail-closed:v5 校验失败拒 provision;v3 warn+跳过(退役休眠);dev 逃生
`OC_PLATFORM_BUNDLE_OPTIONAL=1`(生产禁)。
supervisor 另断言 **current resolved path == OC_PLATFORM_BUNDLE**(R2-M1 配套),
不一致 = 激活中间态 → 拒 provision(短暂窗口,前端 retry 兜底)。

### 1.4 容器 labels 与 runtimeStale 泛化(R1-M5/M7, R2-M4/M7)

- create 时打 channel-neutral labels:`com.openclaude.runtime.image_id` /
  `.release` / `.bundle_rev` / `.boot_hash`。
- boot_hash = bundle 内 boot 子集(entrypoint/ + seed/)内容 hash(MANIFEST 预计算);
  纯 bin/prompts/etc-codex 翻新不改 boot_hash → 不触发无意义回收。
- `V3ContainerStatus` 契约扩展回传 Labels(本地 + node-agent inspect 同步纳入;
  desired 非空 + label 缺失 → 视为 stale)。
- `imageStale` 泛化为 `runtimeStale` = image_id ≠ ∨ release ≠ ∨ boot_hash ≠,
  任一命中走既有 v5 drain/最近活跃延迟/回收状态机(状态机不动,只换判定输入)。
- GC 保护集(R1-B1, R2-M2/M7):{最近 N 条已验证 tuple 引用} ∪ {emergency tuple 引用}
  ∪ {current/上一 tuple} ∪ {全部 managed 容器 label 引用的 release 与 bundle_rev
  (inspect 失败 → 本轮放弃 GC)} ∪ {staging}。history 全文只作审计,**不**整体进
  保护集(否则永不回收);被回收条目标 `artifact_retired_at`。

### 1.5 激活 saga(R2-M1)

deploy-v5.sh 在既有全局 flock 内按序:
1. **prepare**:构建 release + bundle(staging,无可见变化)→ 校验(schema/MANIFEST/
   digest 一致)→ mv -T 落正式目录;
2. **activation**:trap 恢复现场(旧 env + 旧 current + 重启旧 master)后——写 env
   tuple → 翻 current → restart master → smoke;任一步失败自动回滚整个 tuple;
3. **commit**:smoke 过 → history 追加 committed 条目 → GC。
中间态(env 与 current 短暂不一致,约等于 restart 时长)由 §1.3 的 supervisor 断言
fail-closed 兜底,新 provision 短暂拒绝 + 前端 retry,与今日 restart 窗口同量级。

## 2. P0:平台配置上移(bundle 内容)

`agent-sandbox/runtime/` 中除 entrypoint.sh(镜像必需薄壳)与构建期文件外全部
`git mv` 到 `agent-sandbox/platform-runtime/`(bundle 源目录):

- **bin/**:全部 oc-*.sh/.py。镜像 `ENV PATH` 在 `~/.local/bin` 后插
  `/run/oc/platform/current/bin`;镜像保留 dev fallback 副本(挂载缺席才生效,允许
  滞后,非第二权威源)。`OPENCLAUDE_WEB_CONTEXT_BIN` 由 supervisor 注入指向 bundle。
  → oc-* 改动**真热**。
- **entrypoint/entrypoint.ts**:entrypoint.sh 分流(bundle 有则 exec,否则镜像
  fallback)。→ 温(boot_hash stale 保证送达)。
- **etc-codex/**:实现期探针取证 codex managed_config 路径可配性;不可配则该文件
  仍走镜像面,bundle 内副本仅作 staging 源(不承诺热)。
- **codex-skills/**:entrypoint 镜像 seed 后叠加 bundle 平台 skill,hash 不一致即
  覆写(修 skip-if-exists 缺陷)。
- **seed/skills/scientist/**:SCIENTIST_SKILL_SEEDS ~300 行 TS 常量外置为文件,
  entrypoint 只留 seed 机制;per-agent 语义不变。

## 3. P1:源码树 release 化 + ro 挂载

### 3.1 release 构建(deploy-v5.sh 新阶段)

- **源钉死**(R2-Minor3):从本次 deploy 捕获的 full SHA `git archive`(或同批 master
  蓝绿 immutable release 目录)取源,禁止从可翻转 symlink/live 树 rsync;
- excludes 单一权威 `agent-sandbox/runtime-src-excludes.txt`(build-image.sh 同用
  `--exclude-from`)+ 产物阶段敏感文件扫描;
- 依赖安装(R1-B3):root 与 ccb 两套均在目标 runtime 镜像一次性容器内
  `docker run --rm --entrypoint /bin/sh --user 0:0 -v <staging>:/build -w /build
  <image_id> -c 'npm ci …'`;**npm ci 为准**(本批先修平 lock 提交);缓存键 =
  {root lock hash, ccb lock hash, image immutable ID, arch} 全同才 cp -al 复用,
  否则全新 ci;缓存键入 MANIFEST;
- ccb dist:host bun build(纯 JS bundling)产物 bytes 计入最终 digest(R2-M3),
  bun 版本记入 MANIFEST;
- **release ID = 组装完成后对最终只读产物树(含 node_modules 与 ccb dist)求
  content digest**(R2-M3),然后 `mv -T releases/rel-<digest12>`;同 digest 已存在
  → 跳过(幂等,只改 master/前端/docs 的 deploy 不产新 release、零容器 churn);
- MANIFEST.json:digest、缓存键、bun 版本、文件数、构建时间、源 commit。

### 3.2 挂载、瘦身与工作目录

- supervisor 校验(fail-closed,v5):realpath 在 releases 根下 / root-owned /
  非 group-other 可写 / MANIFEST digest 与目录名一致 → bind resolved realpath
  `→ /opt/openclaude:ro`(绝不挂 symlink 本身)。
- 旧镜像 + release 挂载兼容(bind shadow 内嵌源码)→ 上线顺序解耦。
- Dockerfile `ARG OC_EMBED_SOURCE=1`;v5 生产传 0(跳 COPY+npm install,留空挂载点,
  label `oc.runtime.embed_source=0`)。镜像 ~3.5GB → ~1GB+。
- **默认工作目录**(R1-M6, R2-B2):`OPENCLAUDE_DEFAULT_WORKSPACE=
  /home/agent/.openclaude/workspace`(**在 data named volume 内**,容器重建后文件
  仍在;R2 抓出 /home/agent/workspace 落 writable layer 回收即丢的错误);entrypoint
  mkdir,gateway sessionManager 缺省 cwd 读该 env(未设=现状,个人版零变化)。
  **测试必须覆盖"容器删除重建后文件仍存在"**,不只是同容器可写。
  实现期取证:grep gateway/ccb 全部 process.cwd()/仓库树内写路径逐一分类。
- 多机硬门(R1-M8):`OC_RUNTIME_RELEASE` 非空 + placement 非 self-host → 调度前
  明确拒绝 + 告警(带测试);分发登记为债(触发=新增 compute host)。

## 4. P2a(缩)/P2b

### 4.1 P2a seed 声明化 —— 仅 persona/文案/defaults(R2-B1 裁减)

- `seed/platform-seed.yaml`:仅 persona 文件引用、非计费 defaults(permissionMode、
  toolsets 等)、seed skill 清单;**schema 显式拒绝 model/engine/provider 键**
  (出现即校验失败,防止绕道回潮)。
- model/engine 权威不动:entrypoint 常量与 master agentModelAuthority 硬编码继续
  双端同构;其声明化并入"模型权威"独立批次(与 P2c 同批,以 versioned snapshot +
  bridge 按容器实际 revision 推导计费,见 §6)。
- persona/defaults 变更 → bundle rev 变 → boot_hash 变 → 容器滚动;无计费面。
- dev(OPTIONAL)容器回落最小可启动集(仅 main,dev-only 日志)。

### 4.2 P2b 平台静态 prompt 文案文件化

- 迁 `prompts/`:promptSlots 的 `# Platform capabilities`、`# Memory` 段、
  `CODEX_PREAMBLE`。gateway 读 env `OPENCLAUDE_PLATFORM_PROMPTS_DIR=
  /run/oc/platform/current/prompts`(supervisor 注入),LKG 快照语义(§1.2);
  env 未设(个人版)回落代码内文案。→ 商业版文案**真热**。
- 边界:per-model/随计费配置 → master DB slot(现状);平台静态守则/能力文案 →
  bundle 文件。两通道不重叠。
- 有意不迁:DEFAULT_JOBS cron prompt(商业版不 seed;P1 后已是热路径)。

## 5. 生效语义总表(改造后)

| 类别 | 通道 | 语义 |
|---|---|---|
| oc-* 工具、平台 prompt、baseline skills | bundle current 原子翻转 | 真热 |
| 市场、计费路由、模型目录(权威批次前=protocol 常量) | master 权威 | 真热 |
| 源码树 | release + runtimeStale 滚动 | 温(重连秒级/idle≤30min) |
| entrypoint/seed(persona/defaults)/种子技能 | bundle + boot_hash 滚动 | 温 |
| 注入 env | provision 快照 | 温 |
| 工具链/pin/安全布局/etc-codex(探针未证可配前) | 镜像 | 冷(有意) |

## 6. 测试、上线、债

- 测试:bundle/release 校验权限矩阵与 schema 超限拒绝、GC 保护集(含 drain 延期
  容器、label 引用、inspect 失败放弃)、runtimeStale 三维组合+回滚+同 tag 换镜像
  按 ID 判定、激活 saga 失败自动恢复、LKG 半套不生效、npm ci 缓存键翻转、
  工具自钉 SELF_ROOT 翻转期一致性、`sudo mount -o remount,rw /opt/openclaude`
  必须失败(canary 断言)、workspace **容器删除重建持久性**、platform-seed schema
  拒 model 键。四层测试 + commercial 基线 diff ⊆。
- 上线顺序(tuple 记账,每步独立回滚):①合并+deploy(master+bundle 首发)→
  ②重建镜像(PATH/分流/labels,EMBED=1)canary P0 → ③首个 release+tuple 激活,
  canary ro+workspace 全链路 → ④瘦身镜像(EMBED=0)+ emergency tuple 记账 → 稳态。
- playbook 生效面矩阵同批重写:runtime source release / platform bundle /
  image toolchain / master / dist / env / 迁移。
- 债登记:①远端 host release/bundle 分发(触发=新增 compute host);②**模型权威
  独立批次** = P2c ModelExecutionCatalog(master 生成规范化 revision,bridge 授权/
  engine 分类/计费编排/容器执行消费同一快照,per-uid 过滤,enabled=false fail-closed
  不回落宽集合)+ seed model/engine 声明化(bridge 按容器实际 seed revision 推导
  agent model,GC 保护运行容器引用 rev)。
